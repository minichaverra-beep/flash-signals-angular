/**
 * Tests de auto captura: niveles de la fila, args del script, mismatch y spawn simulado.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  NO_LEVELS_ERROR,
  FILE_BLOCKED_CODE,
  resolveAutoCaptureInput,
  sentNeedsDeals,
  sentPatchFromDeals,
  buildAutoCaptureArgs,
  compareOutcome,
  parseScriptOutput,
  cleanErrorMessage,
  describeScriptError,
  buildScriptEnv,
  readFileWithRetry,
  runAutoCapture,
} = require('./auto-capture');

const AVG_ERROR = "[Errno 13] Permission denied: '\\\\\\\\.\\\\avgMonFltProxy\\\\348fb67027ee185f'";

const ROW = {
  id: 41,
  market: 'xauusd',
  createdAt: '2026-10-01T16:52:34.287Z',
  finishedAt: '2026-10-01T16:52:34.280Z',
  plannedEntry: 4163.9,
  plannedSl: 4157.9,
  plannedTp: 4175.9,
  summary: { price: '4163.90' },
};

describe('resolveAutoCaptureInput', () => {
  it('usa niveles del plan, hora de fin y precio de la señal', () => {
    const r = resolveAutoCaptureInput(ROW);
    assert.equal(r.ok, true);
    assert.deepEqual(r.input, {
      market: 'xauusd',
      signalTime: ROW.finishedAt,
      entry: 4163.9,
      sl: 4157.9,
      tp: 4175.9,
      price: 4163.9,
      real: null,
    });
  });

  it('con ejecución MT5 guardada la pasa al script; incompleta → estimación con velas (null)', () => {
    const real = { ticket: 7, entry: 4162.07, exit: 4178.9, sl: null, openedAt: null, closedAt: '2026-10-01T17:30:02.000Z' };
    assert.deepEqual(resolveAutoCaptureInput({ ...ROW, real }).input.real, real);
    assert.equal(resolveAutoCaptureInput({ ...ROW, real: { ...real, exit: null } }).input.real, null);
  });

  const SENT = {
    at: '2026-10-07T13:49:06.452Z', symbol: 'BTCUSDm', side: 'SHORT', mode: 'pending', order: 687780224,
    price: 83020.95, sl: 83201.72, tp: 82696.33, state: 'closed', profit: -2.42, closeReason: 'manual',
    closePrice: 83069.38, openTime: '2026-10-07T13:50:39.000Z', closeTime: '2026-10-07T14:01:37.000Z',
    duplicate: {
      at: '2026-10-07T13:51:53.742Z', mode: 'market', order: 687789369, price: 83264.38, sl: 83489.76,
      tp: 82522.81, state: 'closed', profit: 11.74, closeReason: 'manual', closePrice: 83029.58,
      openTime: '2026-10-07T13:51:53.000Z', closeTime: '2026-10-07T14:38:55.000Z',
    },
  };

  it('con duplicado pasa las dos operaciones (original y duplicada) con sus horas y PnL', () => {
    const { trades } = resolveAutoCaptureInput(ROW, SENT).input;
    assert.equal(trades.length, 2);
    assert.deepEqual(trades.map((t) => [t.label, t.entry, t.exit, t.pnlUsd]), [
      ['original', 83020.95, 83069.38, -2.42],
      ['duplicada', 83264.38, 83029.58, 11.74],
    ]);
    assert.equal(trades[1].openedAt, '2026-10-07T13:51:53.000Z');
    assert.equal(trades[1].sentAt, SENT.duplicate.at);
    // la suma coincide con combineAnnotations
    assert.equal(Math.round(trades.reduce((s, t) => s + t.pnlUsd, 0) * 100) / 100, 9.32);
    const args = buildAutoCaptureArgs(resolveAutoCaptureInput(ROW, SENT).input, 'o.png');
    assert.deepEqual(JSON.parse(args[args.indexOf('--trades-json') + 1]), trades);
    assert.ok(!args.includes('--real-entry'));
  });

  it('duplicado aún abierto → solo la original cerrada; sin duplicado manda la ejecución de mt5-pnl', () => {
    const open = { ...SENT, duplicate: { ...SENT.duplicate, state: 'open' } };
    assert.deepEqual(resolveAutoCaptureInput(ROW, open).input.trades.map((t) => t.label), ['original']);
    const { duplicate: _d, ...single } = SENT;
    assert.deepEqual(resolveAutoCaptureInput(ROW, single).input.trades.map((t) => t.label), ['']);
    const real = { ticket: 7, entry: 4162.07, exit: 4178.9, sl: null, openedAt: null, closedAt: '2026-10-01T17:30:02.000Z' };
    assert.equal(resolveAutoCaptureInput({ ...ROW, real }, single).input.trades, undefined);
  });

  it('completa precio/horas de cierre desde /deals cuando mt5-sent no los tiene', () => {
    const { executionFromDeals } = require('./mt5');
    const strip = ({ closePrice: _p, openTime: _o, closeTime: _c, ...rest }) => rest;
    const old = { ...strip(SENT), duplicate: strip(SENT.duplicate) };
    assert.equal(sentNeedsDeals(old), true);
    assert.equal(sentNeedsDeals(SENT), false);
    const deals = [
      { position: 687780224, entry: 'in', price: 83020.95, volume: 0.05, time: 1791381039 },
      { position: 687789369, entry: 'in', price: 83264.38, volume: 0.05, time: 1791381113 },
      { position: 687780224, entry: 'out', price: 83069.38, volume: 0.05, time: 1791381697 },
      { position: 687789369, entry: 'out', price: 83029.58, volume: 0.05, time: 1791383935 },
    ];
    const patch = sentPatchFromDeals(old, deals, executionFromDeals);
    assert.equal(patch.closePrice, 83069.38);
    assert.equal(patch.openTime, '2026-10-07T13:50:39.000Z');
    assert.equal(patch.duplicate.closeTime, '2026-10-07T14:38:55.000Z');
    assert.equal(patch.duplicate.order, 687789369);
    assert.equal(sentPatchFromDeals(SENT, deals, executionFromDeals), null);
  });

  it('sin niveles → mensaje en español y code no_levels', () => {
    const r = resolveAutoCaptureInput({ ...ROW, plannedSl: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_levels');
    assert.equal(r.error, NO_LEVELS_ERROR);
  });

  it('fila inexistente o mercado sin pipeline', () => {
    assert.equal(resolveAutoCaptureInput(null).code, 'not_found');
    assert.equal(resolveAutoCaptureInput({ ...ROW, market: 'ukoil' }).code, 'market');
  });
});

describe('buildAutoCaptureArgs', () => {
  it('pasa precio solo si existe', () => {
    const { input } = resolveAutoCaptureInput(ROW);
    const args = buildAutoCaptureArgs(input, 'out.png');
    assert.deepEqual(args.slice(0, 4), ['-m', 'app.views.trade_outcome_chart', '--market', 'xauusd']);
    assert.ok(args.includes('--price'));
    assert.ok(!buildAutoCaptureArgs({ ...input, price: null }, 'o.png').includes('--price'));
    assert.ok(!args.includes('--real-exit'));
  });

  it('añade entrada/salida/hora de cierre reales de MT5', () => {
    const { input } = resolveAutoCaptureInput(ROW);
    const real = { ticket: 7, entry: 4162.07, exit: 4178.9, sl: 4150, openedAt: '2026-10-01T16:52:49.000Z', closedAt: '2026-10-01T17:30:02.000Z' };
    const args = buildAutoCaptureArgs({ ...input, real }, 'o.png');
    const arg = (k) => args[args.indexOf(k) + 1];
    assert.equal(arg('--real-entry'), '4162.07');
    assert.equal(arg('--real-exit'), '4178.9');
    assert.equal(arg('--real-close-time'), real.closedAt);
    assert.equal(arg('--real-open-time'), real.openedAt);
    assert.equal(arg('--real-sl'), '4150');
    assert.equal(arg('--real-ticket'), '7');
  });
});

describe('compareOutcome', () => {
  const tp = { outcome: 'tp', detected: 'ganada', label: 'TP alcanzado', message: '✓ TP alcanzado 17:20 UTC' };
  const sl = { outcome: 'sl', detected: 'perdida', label: 'SL alcanzado', message: '✗ SL alcanzado 17:20 UTC' };

  it('con cierre real de MT5 no avisa por la estimación con velas', () => {
    const open = { outcome: 'open', detected: null, message: 'Sin resolver', closeSource: 'mt5' };
    assert.deepEqual(compareOutcome(open, 'ganada'), { detected: null, mismatch: false, warning: null });
    assert.equal(compareOutcome({ ...sl, closeSource: 'mt5' }, 'ganada').mismatch, false);
  });

  it('coincide → sin aviso', () => {
    assert.deepEqual(compareOutcome(tp, 'ganada'), { detected: 'ganada', mismatch: false, warning: null });
  });

  it('contradice el Resultado → mismatch con aviso, sin cambiarlo', () => {
    const r = compareOutcome(sl, 'ganada');
    assert.equal(r.mismatch, true);
    assert.match(r.warning, /SL alcanzado.*marcaste Ganada/);
  });

  it('no ejecutada / ambiguo / abierto → aviso sin mismatch', () => {
    const nf = { outcome: 'not_filled', detected: null, message: 'Entrada no ejecutada: x' };
    assert.deepEqual(compareOutcome(nf, 'perdida'), {
      detected: null,
      mismatch: false,
      warning: 'Entrada no ejecutada: x',
    });
  });
});

describe('parseScriptOutput', () => {
  it('lee la última línea JSON', () => {
    assert.deepEqual(parseScriptOutput('log\n{"ok": true, "outcome": "tp"}\n'), { ok: true, outcome: 'tp' });
    assert.equal(parseScriptOutput('basura').ok, false);
    assert.equal(parseScriptOutput('"solo texto"').ok, false);
  });
});

describe('cleanErrorMessage', () => {
  it('quita llaves sueltas y volcados JSON/dict', () => {
    assert.equal(cleanErrorMessage("Permission denied: 'x'}"), "Permission denied: 'x'");
    assert.equal(cleanErrorMessage('{"ok": false, "error": "La señal tiene 75 días"}'), 'La señal tiene 75 días');
    assert.equal(cleanErrorMessage({ error: 'boom' }), 'boom');
  });

  it('respeta corchetes balanceados y usa la última línea', () => {
    assert.equal(cleanErrorMessage('[Errno 2] No such file'), '[Errno 2] No such file');
    assert.equal(cleanErrorMessage('Traceback...\n  File x\nValueError: malo\n'), 'ValueError: malo');
    assert.equal(cleanErrorMessage(''), 'No se pudo generar la captura');
  });
});

describe('describeScriptError', () => {
  const ctx = { python: 'C:\\py\\python.exe', workDir: 'D:\\app\\data\\auto-capture' };

  it('bloqueo del antivirus → mensaje en español con python y carpeta a excluir', () => {
    for (const out of [
      { ok: false, code: FILE_BLOCKED_CODE, error: 'El antivirus bloqueó…', detail: AVG_ERROR },
      { ok: false, error: AVG_ERROR },
    ]) {
      const r = describeScriptError(out, ctx);
      assert.equal(r.code, FILE_BLOCKED_CODE);
      assert.match(r.error, /^El antivirus \(AVG\) bloqueó el acceso a un archivo/);
      assert.ok(r.error.includes(ctx.python) && r.error.includes(ctx.workDir));
      assert.match(r.error, /usa Adjuntar\.$/);
      assert.ok(!r.error.includes('}') && !r.error.includes('avgMonFltProxy'));
    }
  });

  it('otros errores pasan limpios y sin code', () => {
    assert.deepEqual(describeScriptError({ ok: false, error: 'La señal tiene 75 días' }, ctx), {
      error: 'La señal tiene 75 días',
    });
  });
});

describe('buildScriptEnv', () => {
  it('cachés y temporales dentro de workDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocap-env-'));
    const env = buildScriptEnv(dir, { PATH: 'x', TEMP: 'C:\\Windows\\Temp' });
    assert.equal(env.MPLCONFIGDIR, path.join(dir, 'mplconfig'));
    assert.equal(env.TEMP, path.join(dir, 'tmp'));
    assert.equal(env.TMP, env.TEMP);
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.PATH, 'x');
    assert.ok(fs.existsSync(env.MPLCONFIGDIR) && fs.existsSync(env.TEMP));
  });
});

describe('readFileWithRetry', () => {
  it('reintenta EBUSY/EPERM y luego lee', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocap-read-'));
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, 'PNG');
    const orig = fs.readFileSync;
    let calls = 0;
    fs.readFileSync = (...a) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EBUSY' : 'EPERM' });
      return orig(...a);
    };
    try {
      assert.equal(String(await readFileWithRetry(file, { delayMs: 1 })), 'PNG');
      assert.equal(calls, 3);
    } finally {
      fs.readFileSync = orig;
    }
  });

  it('ENOENT no se reintenta', async () => {
    await assert.rejects(readFileWithRetry(path.join(os.tmpdir(), 'no-existe-autocap.png'), { delayMs: 1 }), {
      code: 'ENOENT',
    });
  });
});

function fakeSpawn(behaviour) {
  const calls = [];
  const fn = (py, args, opts) => {
    calls.push({ py, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    const out = args[args.indexOf('--out') + 1];
    setImmediate(() => behaviour(child, out, calls.length));
    return child;
  };
  fn.calls = calls;
  return fn;
}

describe('runAutoCapture', () => {
  const { input } = resolveAutoCaptureInput(ROW);
  const mkWorkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autocap-'));

  it('devuelve PNG + outcome, escribe dentro de workDir y borra el temporal', async () => {
    const workDir = mkWorkDir();
    let written;
    const spawnFn = fakeSpawn((child, out) => {
      written = out;
      fs.writeFileSync(out, Buffer.from('PNGDATA-PNGDATA-PNGDATA-PNG'));
      child.stdout.emit('data', JSON.stringify({ ok: true, outcome: 'tp', detected: 'ganada', chart: out }));
      child.emit('close', 0);
    });
    const r = await runAutoCapture({ input, tradingRoot: workDir, spawnFn, workDir });
    assert.equal(r.ok, true);
    assert.equal(r.outcome.outcome, 'tp');
    assert.equal(r.outcome.chart, undefined);
    assert.ok(Buffer.isBuffer(r.buffer));
    assert.ok(written.startsWith(path.join(workDir, 'out')));
    assert.equal(fs.existsSync(written), false);
    const { opts } = spawnFn.calls[0];
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(opts.env.MPLCONFIGDIR, path.join(workDir, 'mplconfig'));
    assert.equal(opts.env.TEMP, path.join(workDir, 'tmp'));
  });

  it('lee el PNG alternativo que reporta el script (fallback *_new.png)', async () => {
    const workDir = mkWorkDir();
    let alt;
    const spawnFn = fakeSpawn((child, out) => {
      alt = out.replace(/\.png$/, '_new.png');
      fs.writeFileSync(alt, 'ALT');
      child.stdout.emit('data', JSON.stringify({ ok: true, outcome: 'open', chart: alt }));
      child.emit('close', 0);
    });
    const r = await runAutoCapture({ input, tradingRoot: workDir, spawnFn, workDir });
    assert.equal(r.ok, true);
    assert.equal(String(r.buffer), 'ALT');
    assert.equal(fs.existsSync(alt), false);
  });

  it('propaga el error del script', async () => {
    const workDir = mkWorkDir();
    const spawnFn = fakeSpawn((child) => {
      child.stdout.emit('data', JSON.stringify({ ok: false, error: 'La señal tiene 75 días' }));
      child.emit('close', 1);
    });
    const r = await runAutoCapture({ input, tradingRoot: workDir, spawnFn, workDir });
    assert.deepEqual(r, { ok: false, error: 'La señal tiene 75 días' });
    assert.equal(spawnFn.calls.length, 1);
  });

  it('bloqueo del antivirus: reintenta el script una vez y luego funciona', async () => {
    const workDir = mkWorkDir();
    const spawnFn = fakeSpawn((child, out, n) => {
      if (n === 1) {
        child.stdout.emit('data', JSON.stringify({ ok: false, code: FILE_BLOCKED_CODE, error: 'x', detail: AVG_ERROR }));
      } else {
        fs.writeFileSync(out, 'PNG2');
        child.stdout.emit('data', JSON.stringify({ ok: true, outcome: 'sl', chart: out }));
      }
      child.emit('close', 0);
    });
    const r = await runAutoCapture({ input, tradingRoot: workDir, spawnFn, workDir, retryDelayMs: 1 });
    assert.equal(r.ok, true);
    assert.equal(String(r.buffer), 'PNG2');
    assert.equal(spawnFn.calls.length, 2);
  });

  it('bloqueo persistente → mensaje claro con code file_blocked', async () => {
    const workDir = mkWorkDir();
    const spawnFn = fakeSpawn((child) => {
      child.stdout.emit('data', JSON.stringify({ ok: false, error: AVG_ERROR }));
      child.emit('close', 1);
    });
    const r = await runAutoCapture({ input, tradingRoot: workDir, spawnFn, workDir, retryDelayMs: 1, python: 'py.exe' });
    assert.equal(r.ok, false);
    assert.equal(r.code, FILE_BLOCKED_CODE);
    assert.match(r.error, /AVG.*py\.exe.*usa Adjuntar/);
    assert.equal(spawnFn.calls.length, 2);
  });

  it('exige workDir explícito', async () => {
    await assert.rejects(runAutoCapture({ input, tradingRoot: '.' }), /workDir/);
  });
});
