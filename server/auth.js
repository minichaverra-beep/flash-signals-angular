/**
 * Mini login de administración (solo gestión: wiki + borrados).
 * La app sigue siendo pública; requireAdmin protege únicamente endpoints de gestión.
 *
 * Env:
 *   ADMIN_USER            usuario (default «admin»)
 *   ADMIN_PASSWORD_HASH   scrypt$<saltB64>$<hashB64> (genera con: node auth.js hash <contraseña>)
 *   ADMIN_PASSWORD        contraseña en claro (si no hay hash). Default «admin» + warning.
 *   ADMIN_TOKEN_SECRET    secreto HMAC de tokens; si falta se genera en data/admin-token-secret
 *   ADMIN_TOKEN_TTL_HOURS expiración del token (default 168 = 7 días)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_USER = 'admin';
const DEFAULT_PASSWORD = 'admin'; // NOSONAR S2068 — default documentado, se avisa en consola
const SCRYPT_KEYLEN = 64;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** @returns {{ salt: Buffer, hash: Buffer } | null} */
function parseHash(stored) {
  const parts = String(stored || '').trim().split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  const salt = Buffer.from(parts[1], 'base64');
  const hash = Buffer.from(parts[2], 'base64');
  if (!salt.length || !hash.length) return null;
  return { salt, hash };
}

function verifyPassword(password, parsed) {
  const candidate = crypto.scryptSync(String(password ?? ''), parsed.salt, parsed.hash.length);
  return crypto.timingSafeEqual(candidate, parsed.hash);
}

function safeEqualText(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function loadOrCreateSecret(dataDir, logger) {
  const file = path.join(dataDir, 'admin-token-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* se genera abajo */
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.warn(`[auth] No se pudo persistir ${file} (tokens caducan al reiniciar): ${err.message}`);
  }
  return secret;
}

function bearerFrom(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string, logger?: Pick<Console, 'warn'|'log'>, now?: () => number }} [opts]
 */
function createAdminAuth(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  const now = opts.now || Date.now;
  const dataDir =
    opts.dataDir ||
    env.ADMIN_DATA_DIR ||
    env.HISTORY_DATA_DIR ||
    path.join(__dirname, '..', 'data');

  const username = String(env.ADMIN_USER || '').trim() || DEFAULT_USER;
  let passwordHash = parseHash(env.ADMIN_PASSWORD_HASH);
  let usingDefaultPassword = false;
  if (!passwordHash) {
    if (env.ADMIN_PASSWORD_HASH) {
      logger.warn('[auth] ADMIN_PASSWORD_HASH con formato inválido (esperado scrypt$salt$hash); se ignora.');
    }
    const plain = env.ADMIN_PASSWORD ? String(env.ADMIN_PASSWORD) : DEFAULT_PASSWORD;
    usingDefaultPassword = !env.ADMIN_PASSWORD;
    passwordHash = parseHash(hashPassword(plain));
  }
  if (usingDefaultPassword) {
    logger.warn(
      `[auth] ⚠ Admin «${username}» con contraseña por defecto «${DEFAULT_PASSWORD}». ` +
        'Cámbiala con ADMIN_PASSWORD o ADMIN_PASSWORD_HASH (node auth.js hash <contraseña>).'
    );
  }

  const secret = String(env.ADMIN_TOKEN_SECRET || '').trim() || loadOrCreateSecret(dataDir, logger);
  const ttlHours = Number(env.ADMIN_TOKEN_TTL_HOURS);
  const ttlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 24 * 7) * 3_600_000;

  /** jti → exp (ms) de tokens cerrados con logout. */
  const revoked = new Map();
  /** ip → { count, first } intentos fallidos. */
  const failures = new Map();

  function sign(payloadB64) {
    return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  }

  function issueToken() {
    const iat = now();
    const payload = { sub: username, role: 'admin', iat, exp: iat + ttlMs, jti: crypto.randomUUID() };
    const body = b64url(JSON.stringify(payload));
    return { token: `${body}.${sign(body)}`, payload };
  }

  /** @returns {{ sub: string, role: string, iat: number, exp: number, jti: string } | null} */
  function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return null;
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (payload?.role !== 'admin' || payload.sub !== username) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now()) return null;
    if (revoked.has(payload.jti)) return null;
    return payload;
  }

  function pruneRevoked() {
    const t = now();
    for (const [jti, exp] of revoked) if (exp <= t) revoked.delete(jti);
  }

  /** @returns {number} ms restantes de bloqueo (0 = puede intentar). */
  function lockoutRemaining(ip) {
    const entry = failures.get(ip);
    if (!entry) return 0;
    const elapsed = now() - entry.first;
    if (elapsed >= LOGIN_WINDOW_MS) {
      failures.delete(ip);
      return 0;
    }
    return entry.count >= LOGIN_MAX_FAILURES ? LOGIN_WINDOW_MS - elapsed : 0;
  }

  function recordFailure(ip) {
    const entry = failures.get(ip);
    if (!entry || now() - entry.first >= LOGIN_WINDOW_MS) {
      failures.set(ip, { count: 1, first: now() });
    } else {
      entry.count += 1;
    }
  }

  function requireAdmin(req, res, next) {
    const payload = verifyToken(bearerFrom(req));
    if (!payload) {
      return res.status(401).json({
        error: 'Requiere sesión de administrador',
        code: 'admin_required',
      });
    }
    req.admin = payload;
    next();
  }

  function registerRoutes(app) {
    app.post('/api/auth/login', (req, res) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const wait = lockoutRemaining(ip);
      if (wait > 0) {
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        return res.status(429).json({
          error: `Demasiados intentos. Espera ${Math.ceil(wait / 60_000)} min e inténtalo de nuevo.`,
        });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userOk = safeEqualText(String(body.username ?? '').trim(), username);
      const passOk = verifyPassword(body.password, passwordHash);
      if (!userOk || !passOk) {
        recordFailure(ip);
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }
      failures.delete(ip);
      const { token, payload } = issueToken();
      res.json({
        ok: true,
        token,
        user: { username, role: 'admin' },
        expiresAt: new Date(payload.exp).toISOString(),
      });
    });

    app.post('/api/auth/logout', (req, res) => {
      const payload = verifyToken(bearerFrom(req));
      if (payload) {
        pruneRevoked();
        revoked.set(payload.jti, payload.exp);
      }
      res.json({ ok: true });
    });

    /** Sin token → 200 { authenticated:false }; token inválido/caducado → 401. */
    app.get('/api/auth/me', (req, res) => {
      const token = bearerFrom(req);
      if (!token) return res.json({ authenticated: false });
      const payload = verifyToken(token);
      if (!payload) {
        return res.status(401).json({ authenticated: false, error: 'Sesión caducada o inválida' });
      }
      res.json({
        authenticated: true,
        user: { username: payload.sub, role: 'admin' },
        expiresAt: new Date(payload.exp).toISOString(),
      });
    });
  }

  return { requireAdmin, registerRoutes, verifyToken, issueToken, username, usingDefaultPassword };
}

module.exports = { createAdminAuth, hashPassword, parseHash, verifyPassword };

if (require.main === module) {
  const [cmd, pwd] = process.argv.slice(2);
  if (cmd !== 'hash' || !pwd) {
    console.error('Uso: node auth.js hash <contraseña>');
    process.exit(1);
  }
  console.log(hashPassword(pwd));
}
