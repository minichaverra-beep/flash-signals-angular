/**
 * Tarjeta para compartir una corrida ya terminada.
 * Solo rellena bloques con datos del job/summary. No inventa precios ni escenarios.
 */
import type { EngineSignal, JobStatus, SignalSummary } from '../services/signals-api.service';

export type ShareDirection = 'Alcista' | 'Bajista';

export interface SharePill {
  kicker: string;
  title: string;
  detail?: string;
}

/** Indicador de mesa: tomar la entrada ahora o esperar. Sin texto inventado. */
export interface ShareAction {
  state: 'TOMAR' | 'ESPERAR';
  reason: string | null;
}

export interface ShareLevel {
  label: string;
  value: string;
  tone: 'text' | 'gain' | 'loss';
}

export interface ShareScenario {
  title: string;
  tone: 'gain' | 'loss';
  bullets: string[];
}

/** Barras COMPRA/VENTA. Un solo porcentaje real; el otro lado es el complemento. */
export interface ShareOdds {
  compra: number;
  venta: number;
}

export interface ShareCardModel {
  symbol: string;
  timeframe: string | null;
  tier: string | null;
  price: string | null;
  /** Marca temporal de la última vela, si el summary la trae. No es una duración. */
  asOf: string | null;
  direction: ShareDirection | null;
  odds: ShareOdds | null;
  pills: SharePill[];
  /** Null si el summary no dice si hay que tomar o esperar. */
  action: ShareAction | null;
  levels: ShareLevel[];
  primary: ShareScenario | null;
  pullback: ShareScenario | null;
  footer: string | null;
  /** Puntos de stop de la librería (`plan.risk` = risk_pts). Null si no hay número. */
  risk: number | null;
  /** Posición 0–100 de la barra, la misma escala que «Riesgo en claro». Null si no hay R:R ni % del precio. */
  riskFill: number | null;
  /** Nota al pie de la sección Riesgo. Null si no hay puntos de stop. */
  riskNote: string | null;
  caption: string;
}

export const INSTAGRAM_WEB = 'https://www.instagram.com/';
export const DISCORD_APP = 'https://discord.com/app';
export const MESSENGER_WEB = 'https://www.messenger.com/';

export function whatsAppShareUrl(caption: string): string {
  return `https://wa.me/?text=${encodeURIComponent(caption)}`;
}

/** Texto del caption. `url` solo si ya es una página pública (no se inventa). */
export function telegramShareUrl(caption: string, pageUrl?: string | null): string {
  const u = new URL('https://t.me/share/url');
  const pub = realPublicUrl(pageUrl);
  if (pub) u.searchParams.set('url', pub);
  u.searchParams.set('text', caption);
  return u.toString();
}

/** Intent de X/Twitter. Solo texto: no adjunta el PNG. */
export function twitterShareUrl(caption: string): string {
  const u = new URL('https://twitter.com/intent/tweet');
  u.searchParams.set('text', caption);
  return u.toString();
}

/** URL http(s) con host público. Localhost y redes privadas no cuentan. */
export function realPublicUrl(pageUrl: string | null | undefined): string | null {
  const raw = String(pageUrl ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return null;
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return null;
  return parsed.toString();
}

/** Imagen de gráfico solo si el job ya trae chartUrl o chartPath. */
export function jobChartSrc(job: (JobStatus & { chartUrl?: string | null; chartPath?: string | null }) | null | undefined): string | null {
  if (!job) return null;
  const url = clean(job.chartUrl);
  const path = clean(job.chartPath);
  if (url && (url.startsWith('/') || /^https?:\/\//i.test(url))) return url;
  if (url || path) {
    const market = job.market || job.summary?.market || 'btc';
    return `/api/signals/chart?market=${encodeURIComponent(market)}`;
  }
  return null;
}

/** Sharer oficial. `quote` lleva el texto; Facebook no recibe el PNG. */
export function facebookShareUrl(pageUrl: string, caption: string): string {
  const u = new URL('https://www.facebook.com/sharer/sharer.php');
  u.searchParams.set('u', pageUrl);
  if (caption.trim()) u.searchParams.set('quote', caption.trim());
  return u.toString();
}

export function sharePngFilename(card: Pick<ShareCardModel, 'symbol' | 'timeframe'>): string {
  const sym = (card.symbol || 'senal').toLowerCase().replaceAll(/[^a-z0-9]+/g, '');
  const tf = card.timeframe ? `-${card.timeframe.toLowerCase()}` : '';
  return `senal-${sym || 'senal'}${tf}.png`;
}

export function buildShareCard(job: JobStatus | null | undefined): ShareCardModel | null {
  if (!job || job.status !== 'done' || !job.summary) return null;
  const s = job.summary;
  if (!summaryHasContent(s)) return null;

  const direction = resolveDirection(job, s);
  const symbol = (s.engine?.asset || s.market || job.market || '').trim().toUpperCase();
  const timeframe = timeframeFromReport(job.reportPath);
  const tier = (s.tier || job.tier || '').trim().toUpperCase() || null;
  const price = clean(s.price) || formatEnginePrice(s.engine?.price);
  const asOf = clean(s.dataAsOf);
  const levels = buildLevels(s);
  const pills = buildPills(s, direction);
  const action = resolveShareAction(s);
  if (action?.state === 'ESPERAR') {
    pills.push({
      kicker: 'Si es Esperar',
      title: '2 velas M5 a favor',
      detail: 'Hay que esperar a que salgan',
    });
  }
  const primary = buildPrimary(s, direction);
  const pullback = buildPullback(s);
  const footer = s.dataStale && clean(s.staleMessage) ? clean(s.staleMessage) : null;

  const hasBody = !!(
    symbol ||
    price ||
    pills.length ||
    levels.length ||
    primary ||
    pullback ||
    footer
  );
  if (!hasBody) return null;

  const risk = shareRisk(s);
  const slMove = risk ? expandSlIfHighRisk(symbol, s, risk.fill) : null;
  if (slMove) {
    const slLevel = levels.find((level) => level.label === 'SL');
    if (slLevel) slLevel.value = slMove.slText;
  }
  const card: ShareCardModel = {
    symbol,
    timeframe,
    tier,
    price,
    asOf: price ? asOf : null,
    direction,
    odds: shareOdds(s, direction),
    pills,
    action,
    levels,
    primary,
    pullback,
    footer,
    risk: risk?.points ?? null,
    riskFill: risk?.fill ?? null,
    riskNote: riskNoteText(risk, slMove),
    caption: '',
  };
  card.caption = buildShareCaption(card);
  return card;
}

/**
 * Puntos de stop que publica la librería (`plan.risk` = risk_pts).
 * 60 pts de BTC no es un 60 %: no se recorta a 0–100.
 */
export function parseRiskPoints(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = /(-?\d+(?:[.,]\d+)?)/.exec(text);
  if (!match) return null;
  const n = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

/** Zona caliente de la barra (igual que «Riesgo en claro»). */
export const HIGH_RISK_FILL = 66;
/** Pips reales más allá del nivel, para que un deslizamiento no saque el stop. Oro: 20 × 0,10 = 2. */
export const SLIPPAGE_PIPS = 20;

/** 1 pip en precio, el de la librería. Oro 0,10; BTC y US30, 1 punto. */
export function realPipSize(market: string | null | undefined): number {
  const key = String(market || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (key.startsWith('XAU') || key === 'GOLD') return 0.1;
  return 1;
}

function riskNoteText(
  risk: { fill: number | null } | null,
  slMove: { kind: 'soporte' | 'resistencia' } | null,
): string | null {
  if (!risk) return null;
  if (slMove) {
    const place = slMove.kind === 'soporte' ? 'el soporte' : 'la resistencia';
    return `Riesgo alto: el SL pasa ${place} para cubrir el slippage`;
  }
  if (risk.fill != null && risk.fill >= HIGH_RISK_FILL) {
    return 'Riesgo alto: no hay soporte o resistencia más allá del SL';
  }
  return 'Si el riesgo es alto, el SL pasa el soporte o la resistencia para cubrir el slippage';
}

/**
 * Compra → pasado el soporte. Venta → pasada la resistencia.
 * El nivel es el de la señal; 20 pips reales más allá cubren el slippage.
 */
export function expandSlIfHighRisk(
  market: string | null | undefined,
  s: SignalSummary,
  fill: number | null,
): { sl: number; slText: string; kind: 'soporte' | 'resistencia' } | null {
  if (fill == null || fill < HIGH_RISK_FILL) return null;
  const entryText = clean(s.planDetails?.entry) || clean(s.entryOptima);
  const slText = clean(s.planDetails?.sl);
  const entry = firstNumber(entryText);
  const sl = firstNumber(slText);
  if (entry == null || sl == null || entry === sl || !slText) return null;
  const buy = sl < entry;
  const levels = structureLevels(s);
  const beyond = (buy ? levels.support : levels.resistance).filter((level) =>
    buy ? level < sl : level > sl,
  );
  if (!beyond.length) return null;
  const level = buy ? Math.max(...beyond) : Math.min(...beyond);
  const pad = SLIPPAGE_PIPS * realPipSize(market);
  const widened = buy ? level - pad : level + pad;
  if (!(widened > 0) || (buy ? widened >= sl : widened <= sl)) return null;
  const decimals = (slText.split('.')[1] || '').length;
  return {
    sl: widened,
    slText: widened.toFixed(decimals),
    kind: buy ? 'soporte' : 'resistencia',
  };
}

/** Rango H1 (mínimo = soporte, máximo = resistencia) y la zona ICT si dice soporte o resistencia. */
function structureLevels(s: SignalSummary): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];
  const detail = engineText(s.engine, 'h1_detail') || '';
  const range = /rango\s+h1\s+([0-9]+(?:[.,][0-9]+)?)\s*[-–]\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(detail);
  if (range) {
    const a = firstNumber(range[1]);
    const b = firstNumber(range[2]);
    if (a != null && b != null && a !== b) {
      support.push(Math.min(a, b));
      resistance.push(Math.max(a, b));
    }
  }
  const scan = ictScan(s);
  const level = firstNumber(scan?.zone_level);
  const kind = String(scan?.zone_type || '').toLowerCase();
  if (level != null && kind.includes('soport')) support.push(level);
  else if (level != null && kind.includes('resist')) resistance.push(level);
  return { support, resistance };
}

function ictScan(s: SignalSummary): { zone_level?: string | number | null; zone_type?: string | number | null } | null {
  const ict = s.engine?.ict as
    | { scan?: { zone_level?: string | number | null; zone_type?: string | number | null } | null }
    | null
    | undefined;
  return ict?.scan ?? null;
}

/**
 * Número de la ficha (puntos) y posición de la barra.
 * La barra usa la misma escala que «Riesgo en claro»: R:R, o si no hay, los puntos frente al precio.
 * Sin esa escala no hay relleno: 60 pts no llenan el 60 %.
 */
export function shareRisk(s: SignalSummary): { points: number; fill: number | null } | null {
  const points = parseRiskPoints(s.planDetails?.risk);
  if (points == null) return null;
  const reward = parseRewardMultiple(s.planDetails?.rr);
  if (reward != null) return { points, fill: heatFromRewardMultiple(reward) };
  const entry = firstNumber(s.planDetails?.entry || s.entryOptima || s.price);
  if (entry != null && entry !== 0) return { points, fill: heatFromPricePct(Math.abs((points / entry) * 100)) };
  return { points, fill: null };
}

/** «1:2», «1/3», «2.5» → múltiplo de recompensa. Misma lectura que la ficha de riesgo. */
function parseRewardMultiple(rr: string | null | undefined): number | null {
  if (!rr) return null;
  const t = String(rr).trim().toLowerCase().replace(',', '.');
  const parts = t.split(/[:/]|(?<=\d)\s*a\s*(?=\d)/);
  if (parts.length >= 2) {
    const a = firstNumber(parts[0]);
    const b = firstNumber(parts[1]);
    if (a != null && b != null && a !== 0) return b >= a ? b / a : a / b;
  }
  const n = firstNumber(t);
  return n != null && n > 0 ? n : null;
}

function firstNumber(raw: string | number | null | undefined): number | null {
  const match = /(-?\d+(?:[.,]\d+)?)/.exec(String(raw ?? ''));
  if (!match) return null;
  const n = Number(match[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Fresco 0–33 · Templado 33–66 · Caliente 66–100. Más premio → más a la izquierda. */
function heatFromRewardMultiple(mult: number): number {
  if (mult >= 2.2) return Math.round(33 - Math.min(1, Math.max(0, (mult - 2.2) / 0.5)) * 25);
  if (mult >= 1.4) return Math.round(33 + ((2.2 - mult) / 0.8) * 33);
  return Math.round(66 + Math.min(1, Math.max(0, (1.4 - mult) / 0.6)) * 34);
}

/** % del precio entre entrada y stop. Más % → más a la derecha. */
function heatFromPricePct(pct: number): number {
  if (pct < 0.35) return Math.round(8 + (Math.max(0, pct) / 0.35) * 25);
  if (pct < 0.9) return Math.round(33 + ((pct - 0.35) / 0.55) * 33);
  return Math.round(66 + Math.min(1, (pct - 0.9) / 0.9) * 34);
}

/** Ancho de la barra: el valor real, recortado a 0–100. */
export function riskFillPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 60.0 se lee como 60; un decimal se conserva. */
export function formatRiskNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

const CAPTION_HEADER = '╭━━━ ✦ 𝙁𝙇𝘼𝙎𝙃 𝙎𝙄𝙂𝙉𝘼𝙇𝙎 ✦ ━━━╮';
const CAPTION_FOOTER = '╰━━ ⌁ ANÁLISIS · ESTRUCTURA · PRECISIÓN ⌁ ━━╯';
const CAPTION_SIGN = '                 BY: SKAYDER';

/** Texto único para las siete redes. No pinta el gráfico. */
export function buildShareCaption(card: Pick<ShareCardModel, 'symbol' | 'direction' | 'price' | 'levels'>): string {
  const symbol = (card.symbol || '').trim().toUpperCase();
  const mark = symbol === 'BTC' || symbol === 'BTCUSDT' ? '₿' : '◈';
  const dir =
    card.direction === 'Alcista' ? '↗️ ALCISTA' : card.direction === 'Bajista' ? '↘️ BAJISTA' : '';
  const head = symbol ? `${mark} ${symbol}` : mark;
  const lines = [CAPTION_HEADER, dir ? `${head}  │  ${dir}` : head, ''];
  const price = clean(card.price);
  if (price) {
    lines.push(`◈ PRECIO ACTUAL: ${price}`, '');
  }
  const entry = levelValue(card.levels, 'Entrada');
  const sl = levelValue(card.levels, 'SL');
  const tp = levelValue(card.levels, 'TP');
  if (entry) {
    const side = card.direction === 'Alcista' ? ' BUY' : card.direction === 'Bajista' ? ' SELL' : '';
    lines.push(`🟣 ◉ ENTRADA${side}: ${entry}`);
  }
  if (sl) lines.push(`🔴 ▼ STOP LOSS: ${sl}`);
  if (tp) lines.push(`💜 ✧ OBJETIVO TP: ${tp}`);
  lines.push('', CAPTION_FOOTER, CAPTION_SIGN);
  return lines.join('\n');
}

export function posterShareFileName(symbol: string): string {
  const sym = (symbol || 'senal').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'senal';
  return `senal-${sym}.png`;
}

/** Carga de navigator.share: el PNG va en `files`. Sin archivo no hay payload. */
export function posterShareData(
  file: File,
  caption: string,
): { files: [File]; text: string; title: 'Flash Signals' } | null {
  if (!file || file.size <= 0) return null;
  return { files: [file], text: caption, title: 'Flash Signals' };
}

function levelValue(levels: ShareLevel[], label: string): string | null {
  return clean(levels.find((level) => level.label === label)?.value);
}

function summaryHasContent(s: SignalSummary): boolean {
  const pd = s.planDetails;
  return !!(
    clean(s.market) ||
    clean(s.price) ||
    clean(s.verdict) ||
    clean(s.bias) ||
    clean(s.setup) ||
    clean(s.plan) ||
    clean(s.entryOptima) ||
    clean(s.twoM5) ||
    clean(s.winrate) ||
    clean(s.dataAsOf) ||
    (s.dataStale && clean(s.staleMessage)) ||
    s.scoreCombined != null ||
    (s.redFlags && s.redFlags.some((f) => !!clean(f))) ||
    clean(pd?.entry) ||
    clean(pd?.sl) ||
    clean(pd?.tp) ||
    clean(pd?.rr) ||
    clean(pd?.risk) ||
    clean(pd?.trigger) ||
    clean(pd?.invalidation) ||
    clean(pd?.confirmation) ||
    clean(s.engine?.asset) ||
    clean(s.engine?.direction) ||
    s.engine?.price != null ||
    s.engine?.probability?.pct != null ||
    engineText(s.engine, 'h1_detail') ||
    engineText(s.engine, 'midpoint')
  );
}

/**
 * Un porcentaje real (motor, score combinado o acierto) asignado al lado de la dirección.
 * El otro lado es 100 − ese valor. Sin porcentaje o sin dirección, no hay barras.
 */
export function shareOdds(s: SignalSummary, direction: ShareDirection | null): ShareOdds | null {
  if (!direction) return null;
  const pct = realProbabilityPct(s);
  if (pct == null) return null;
  const side = Math.round(pct);
  const other = 100 - side;
  if (direction === 'Alcista') return { compra: side, venta: other };
  return { compra: other, venta: side };
}

function realProbabilityPct(s: SignalSummary): number | null {
  const fromEngine = finitePct(s.engine?.probability?.pct);
  if (fromEngine != null) return fromEngine;
  const fromScore = finitePct(s.scoreCombined);
  if (fromScore != null) return fromScore;
  return winratePoint(s.winrate);
}

function finitePct(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

/** Un solo «55%». Un rango (40–60) no es un punto y no se usa. */
function winratePoint(raw: string | null | undefined): number | null {
  const text = clean(raw);
  if (!text || /\d\s*[-–—]\s*\d/.test(text)) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(text);
  if (!m) return null;
  return finitePct(Number(m[1].replace(',', '.')));
}

const WAIT_PHRASE =
  /\b(?:esperar|espera|en espera|wait|waiting)\b|niveles planificados|planned levels|no es entrada activa|retest(?:eo)? pendiente|retest pending|pending retest|fuera de la zona|fuera de zona|outside the zone|fuera de(?: la)? killzone|outside(?: the)? killzone/i;

const TAKE_PHRASE =
  /entrada activa|breakout confirm(?:ed|ado)|ruptura confirmada|continuaci[oó]n confirmad[ao]|continuation confirmed/i;

const ACTIONABLE_VERDICT = /\b(?:OPERAR|ENTRAR|GO|LONG|SHORT|BUY|SELL)\b/;

/** Primera regla que encaja. Si ninguna se puede leer en los campos reales, null. */
export function resolveShareAction(s: SignalSummary): ShareAction | null {
  const fields = actionFields(s);
  for (const text of fields) {
    if (WAIT_PHRASE.test(text)) return { state: 'ESPERAR', reason: actionReason(text) };
  }
  if (killzoneOff(s)) {
    const name = clean(s.zentinel?.killzone) || clean(s.engine?.zentinel?.killzone);
    return { state: 'ESPERAR', reason: name ? actionReason(name) : null };
  }
  for (const text of fields) {
    if (TAKE_PHRASE.test(text)) return { state: 'TOMAR', reason: actionReason(text) };
  }
  const verdict = clean(s.verdict) || clean(s.engine?.verdict);
  if (verdict && actionableVerdict(verdict)) return { state: 'TOMAR', reason: actionReason(verdict) };
  return null;
}

function actionFields(s: SignalSummary): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const text = clean(value);
    if (text) out.push(text);
  };
  push(s.verdict);
  push(s.engine?.verdict);
  push(s.plan);
  push(s.setup);
  push(s.planDetails?.trigger);
  push(s.planDetails?.confirmation);
  push(s.planDetails?.invalidation);
  push(s.twoM5);
  push(s.impulso);
  for (const flag of s.redFlags ?? []) push(flag);
  for (const line of s.engine?.contingencies ?? []) push(line);
  push(s.engine?.ict?.note);
  push(s.engine?.ict?.summary);
  push(s.zentinel?.note);
  return out;
}

function killzoneOff(s: SignalSummary): boolean {
  if (s.zentinel?.kzOn === false) return true;
  return s.engine?.zentinel?.killzoneOn === false;
}

function actionableVerdict(raw: string): boolean {
  const t = raw.toUpperCase().replaceAll(/[_-]+/g, ' ');
  if (WAIT_PHRASE.test(t) || /\bNO OPERAR\b/.test(t)) return false;
  return ACTIONABLE_VERDICT.test(t);
}

/** Sesiones de liquidez en hora local (con horario de verano). */
const MARKET_SESSIONS: { label: string; tz: string; start: number; end: number }[] = [
  { label: 'Sídney', tz: 'Australia/Sydney', start: 8, end: 17 },
  { label: 'Tokio', tz: 'Asia/Tokyo', start: 9, end: 18 },
  { label: 'Londres', tz: 'Europe/London', start: 8, end: 17 },
  { label: 'Nueva York', tz: 'America/New_York', start: 8, end: 17 },
];

function localHour(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour + minute / 60;
}

/** Sesiones abiertas ahora, la que acaba de empezar primero. */
export function runningSessionLabel(now = new Date()): string {
  const open = MARKET_SESSIONS.map((session) => ({
    label: session.label,
    since: localHour(now, session.tz) - session.start,
    length: session.end - session.start,
  }))
    .filter((session) => session.since >= 0 && session.since < session.length)
    .sort((a, b) => a.since - b.since);
  return open.map((session) => session.label).join(' · ');
}

function actionReason(raw: string): string | null {
  const text = localizeBiasWords(raw).replaceAll(/\s+/g, ' ').trim();
  if (!text) return null;
  const bare = text.replaceAll(/[_-]+/g, ' ').trim();
  if (/^(esperar|espera|wait|waiting|tomar|operar|entrar|go|long|short|buy|sell|largo|corto)$/i.test(bare)) {
    return null;
  }
  if (/^FUERA_NY\b/i.test(text)) return runningSessionLabel() || text;
  return text.length > 78 ? `${text.slice(0, 75).trimEnd()}…` : text;
}

function buildPills(s: SignalSummary, direction: ShareDirection | null): SharePill[] {
  const pills: SharePill[] = [];
  if (direction) {
    pills.push({ kicker: 'Tendencia / sesgo', title: direction });
  } else if (biasTone(s.bias) === 'neutral') {
    pills.push({ kicker: 'Tendencia / sesgo', title: 'Neutral' });
  }

  if (s.scoreCombined != null && Number.isFinite(s.scoreCombined)) {
    pills.push({ kicker: 'Probabilidad de éxito', title: `${Math.round(s.scoreCombined)}%` });
  }
  return pills;
}

function buildLevels(s: SignalSummary): ShareLevel[] {
  const pd = s.planDetails;
  const fromPlan = levelsFromPlanText(s.plan);
  const entry = clean(pd?.entry) || clean(s.entryOptima) || fromPlan.entry;
  const sl = clean(pd?.sl) || fromPlan.sl;
  const tp = clean(pd?.tp) || fromPlan.tp;
  const levels: ShareLevel[] = [];
  if (entry) levels.push({ label: 'Entrada', value: entry, tone: 'text' });
  if (sl) levels.push({ label: 'SL', value: sl, tone: 'loss' });
  if (tp) levels.push({ label: 'TP', value: tp, tone: 'gain' });

  const mid = engineText(s.engine, 'midpoint');
  if (mid) levels.push({ label: 'Punto medio', value: mid, tone: 'text' });
  return levels;
}

function buildPrimary(s: SignalSummary, direction: ShareDirection | null): ShareScenario | null {
  const bullets: string[] = [];
  const verdict = verdictLabel(s.verdict);
  if (verdict) bullets.push(`Veredicto: ${verdict}`);
  const trigger = clean(s.planDetails?.trigger);
  if (trigger) bullets.push(`Activación: ${localizeBiasWords(trigger)}`);
  const confirmation = clean(s.planDetails?.confirmation);
  if (confirmation) bullets.push(`Confirmación: ${localizeBiasWords(confirmation)}`);
  if (!bullets.length) return null;
  return {
    title: direction ? `Escenario ${direction.toLowerCase()}` : 'Escenario',
    tone: direction === 'Bajista' ? 'loss' : 'gain',
    bullets,
  };
}

function buildPullback(s: SignalSummary): ShareScenario | null {
  const bullets: string[] = [];
  const invalidation = clean(s.planDetails?.invalidation);
  if (invalidation) bullets.push(`Invalidación: ${localizeBiasWords(invalidation)}`);
  for (const flag of s.redFlags ?? []) {
    const text = clean(flag);
    if (text) bullets.push(localizeBiasWords(text));
  }
  if (!bullets.length) return null;
  return { title: 'Escenario de retroceso', tone: 'loss', bullets: bullets.slice(0, 6) };
}

/** M5/H1/… solo si el nombre del reporte lo trae (`xauusd_m5_high_signal.md`). */
export function timeframeFromReport(reportPath: string | null | undefined): string | null {
  const m = /_(m\d+|h\d+|d1|w1)(?:_|\.)/i.exec(String(reportPath || ''));
  return m ? m[1].toUpperCase() : null;
}

function resolveDirection(job: JobStatus, s: SignalSummary): ShareDirection | null {
  return (
    fromEngineDirection(s.engine?.direction) ||
    fromTone(s.bias) ||
    fromTone(job.trendBias?.flag) ||
    fromTone(job.trendBias?.label) ||
    fromVerdict(s.verdict) ||
    directionFromPlan(s)
  );
}

function fromEngineDirection(dir: string | null | undefined): ShareDirection | null {
  const t = (dir || '').trim().toUpperCase();
  if (t === 'LONG' || t === 'BUY') return 'Alcista';
  if (t === 'SHORT' || t === 'SELL') return 'Bajista';
  return fromTone(dir);
}

function fromTone(value: string | null | undefined): ShareDirection | null {
  const tone = biasTone(value);
  if (tone === 'bullish') return 'Alcista';
  if (tone === 'bearish') return 'Bajista';
  return null;
}

function fromVerdict(v: string | null | undefined): ShareDirection | null {
  const t = String(v || '').toUpperCase();
  if (/NO[_\s-]*OPERAR/.test(t)) return null;
  if (/\bSHORT\b|\bSELL\b|\bBAJISTA\b|\bBEARISH\b/.test(t)) return 'Bajista';
  if (/\bLONG\b|\bBUY\b|\bALCISTA\b|\bBULLISH\b/.test(t)) return 'Alcista';
  return null;
}

function directionFromPlan(s: SignalSummary): ShareDirection | null {
  const pd = s.planDetails;
  const fromPlan = levelsFromPlanText(s.plan);
  const entry = num(clean(pd?.entry) || clean(s.entryOptima) || fromPlan.entry);
  const sl = num(clean(pd?.sl) || fromPlan.sl);
  if (entry == null || sl == null || entry === sl) return null;
  return sl < entry ? 'Alcista' : 'Bajista';
}

/** «Continuación» solo si el setup del summary contiene esa palabra. */
export function scenarioTitle(setup: string | null | undefined, direction: ShareDirection | null): string | null {
  const raw = clean(setup);
  if (!raw) return null;
  const text = localizeBiasWords(raw);
  if (/continuaci/i.test(text)) {
    if (direction && !/alcista|bajista/i.test(text)) return `Continuación ${direction.toLowerCase()}`;
    return 'Continuación';
  }
  return text;
}

export function verdictLabel(v: string | null | undefined): string | null {
  const raw = clean(v);
  if (!raw) return null;
  const t = raw.toUpperCase().replaceAll(/[_-]+/g, ' ');
  if (/\bNO OPERAR\b/.test(t)) return 'No operar';
  if (/\bESPERAR\b|\bWAIT\b/.test(t)) return 'Esperar';
  if (/\bSHORT\b/.test(t)) return 'Corto';
  if (/\bLONG\b/.test(t)) return 'Largo';
  if (/\bOPERAR\b|\bENTRAR\b|\bGO\b/.test(t)) return 'Operar';
  return localizeBiasWords(raw);
}

function planNum(plan: string, label: string): string | null {
  const m = new RegExp(`${label}\\s+\\*?\\*?([0-9]+(?:[.,][0-9]+)?)`, 'i').exec(plan);
  return m?.[1]?.replace(',', '.') ?? null;
}

function levelsFromPlanText(plan: string | null | undefined): { entry: string | null; sl: string | null; tp: string | null } {
  const text = String(plan || '');
  return { entry: planNum(text, 'Entry'), sl: planNum(text, 'SL'), tp: planNum(text, 'TP') };
}

function engineText(engine: EngineSignal | null | undefined, key: string): string | null {
  const bag = engine?.crt;
  if (!bag) return null;
  const v = bag[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    const rounded = Math.round(v * 1000) / 1000;
    return String(rounded);
  }
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function formatEnginePrice(price: number | null | undefined): string | null {
  if (price == null || !Number.isFinite(price)) return null;
  const rounded = Math.round(price * 1000) / 1000;
  return String(rounded);
}

/** Igual que `localizeBiasWords`: Bullish/Bearish → Alcista/Bajista, respetando mayúsculas. */
function localizeBiasWords(text: string): string {
  return text.replaceAll(/\b(bullish|bearish)\b/gi, (word) => {
    const es = word.toLowerCase() === 'bullish' ? 'alcista' : 'bajista';
    if (word === word.toUpperCase()) return es.toUpperCase();
    const head = word.charAt(0);
    const tail = word.slice(1);
    if (head === head.toUpperCase() && tail === tail.toLowerCase()) {
      return es.charAt(0).toUpperCase() + es.slice(1);
    }
    return es;
  });
}

function biasTone(value: string | null | undefined): 'bullish' | 'bearish' | 'neutral' | '' {
  const t = (value || '').trim().toLowerCase();
  if (!t) return '';
  if (/^(auto|neutr(?:al|o)?|sin forzar|none|n\/a|—|-)$/i.test(t)) return 'neutral';
  if (/bearish|bajista|\bbear\b/.test(t)) return 'bearish';
  if (/bullish|alcista|\bbull\b/.test(t)) return 'bullish';
  if (/auto|neutr|sin forzar/.test(t)) return 'neutral';
  return '';
}

function num(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function clean(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim();
  return t || null;
}
