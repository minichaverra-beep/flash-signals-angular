/**
 * Panel «Motor (Cursor Trading)»: lo que el motor ya calcula (JSON schema 1 en summary.engine).
 * Filas sin JSON muestran lo que haya en el summary (probabilidad, volumen, frescura).
 */
import type { EngineSignal, SignalSummary } from '../services/signals-api.service';

/** Igual que localizeBiasWords del visor: solo el texto que se muestra en el panel. */
function localizeBiasWords(text: string): string {
  return text.replace(/\b(bullish|bearish)\b/gi, (word) => {
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

export type EngineTone = 'ok' | 'warn' | 'muted';

export interface EngineLayerRow {
  label: string;
  score: number | null;
  weightPct: number | null;
}

export interface EnginePanelView {
  fromJson: boolean;
  signalId: string | null;
  probability: {
    pct: number | null;
    ci: string | null;
    evR: number | null;
    kellyPct: number | null;
    badge: string;
    tone: EngineTone;
    sample: string | null;
  } | null;
  fusionScore: number | null;
  layers: EngineLayerRow[];
  zentinel: { band: string | null; ratio: number | null; killzone: string | null; kzOn: boolean | null } | null;
  macd: { filter: string; tone: EngineTone; detail: string } | null;
  ict: string[];
  crt: string[];
  staleMessage: string | null;
  contingencies: string[];
}

const LAYERS: ReadonlyArray<[keyof NonNullable<NonNullable<EngineSignal['fusion']>['layers']>, string, string]> = [
  ['rules', 'Reglas E1', 'rules_e1'],
  ['extended', 'Reglas extendidas', 'rules_ext'],
  ['crt', 'CRT coherente', 'crt'],
  ['neural', 'Neural (galería)', 'neural'],
  ['ml', 'ML tabular', 'ml'],
  ['e2', 'E2 turtle soup', 'e2'],
];

const num = (v: unknown): number | null =>
  v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

function text(v: unknown): string | null {
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function probabilityView(engine: EngineSignal | null | undefined, s: SignalSummary) {
  const p = engine?.probability;
  const pct = num(p?.pct) ?? num(s.scoreCombined);
  if (pct == null) return null;
  const calibrated = p ? p.calibrated === true : s.probCalibrated === true;
  const lo = num(p?.ci?.[0]);
  const hi = num(p?.ci?.[1]);
  let badge = 'Heurística';
  let tone: EngineTone = 'muted';
  if (calibrated && p?.hasEdge === false) {
    badge = 'Tasa base (sin ventaja)';
    tone = 'warn';
  } else if (calibrated) {
    badge = 'Calibrada';
    tone = 'ok';
  }
  const kelly = num(p?.kellyFrac);
  const n = num(p?.n);
  const nEff = num(p?.nEff);
  const nEffText = nEff == null ? '' : ' · n_eff ' + nEff;
  return {
    pct,
    ci: lo != null && hi != null ? `${lo.toFixed(0)}–${hi.toFixed(0)}%` : null,
    evR: num(p?.evR),
    kellyPct: kelly == null ? null : Math.round(kelly * 10000) / 100,
    badge,
    tone,
    sample: n == null ? null : `n=${n}${nEffText}`,
  };
}

function layerRows(engine: EngineSignal | null | undefined): EngineLayerRow[] {
  const layers = engine?.fusion?.layers;
  if (!layers) return [];
  const weights = engine?.fusion?.weights || {};
  return LAYERS.map(([key, label, weightKey]) => ({
    label,
    score: num(layers[key]),
    weightPct: num(weights[weightKey]) == null ? null : Math.round(Number(weights[weightKey]) * 1000) / 10,
  })).filter((r) => r.score != null);
}

function zentinelView(engine: EngineSignal | null | undefined, s: SignalSummary) {
  const vol = engine?.zentinel?.volume || {};
  const band = text(vol['band']) ?? text(s.volume?.band) ?? text(s.zentinel?.volBand);
  const ratio = num(vol['ratio']) ?? num(s.volume?.ratio) ?? num(s.zentinel?.volRatio);
  const killzone = text(engine?.zentinel?.killzone) ?? text(s.zentinel?.killzone);
  const kzOn = typeof engine?.zentinel?.killzoneOn === 'boolean' ? engine.zentinel.killzoneOn : s.zentinel?.kzOn ?? null;
  if (band == null && ratio == null && killzone == null) return null;
  return { band, ratio, killzone, kzOn };
}

function macdCross(signal: number | null): string {
  if (signal === 1) return 'cruce BUY';
  if (signal === -1) return 'cruce SELL';
  return 'sin cruce';
}

function macdView(engine: EngineSignal | null | undefined) {
  const mq = engine?.macdQuant;
  if (!mq) return null;
  if (mq['available'] !== true) {
    return { filter: 'n/d', tone: 'muted' as EngineTone, detail: text(mq['note']) ?? 'sin datos H4' };
  }
  const soft = mq['soft_filter_ok'];
  let filter = 'n/d';
  let tone: EngineTone = 'muted';
  if (soft === true) {
    filter = 'Alineado';
    tone = 'ok';
  } else if (soft === false) {
    filter = 'En contra';
    tone = 'warn';
  }
  const hist = num(mq['histogram']);
  const detail = [text(mq['timeframe']) ?? 'H4', macdCross(num(mq['signal'])), hist == null ? null : `hist ${hist.toFixed(2)}`]
    .filter(Boolean)
    .join(' · ');
  return { filter, tone, detail };
}

function ictFacts(engine: EngineSignal | null | undefined): string[] {
  const ict = engine?.ict;
  if (!ict) return [];
  const facts: string[] = [];
  if (ict.refined === true && ict.source) facts.push(localizeBiasWords(`Entrada refinada: ${ict.source}`));
  else if (ict.source) facts.push(localizeBiasWords(ict.source));
  if (ict.summary) facts.push(localizeBiasWords(ict.summary));
  else if (ict.note) facts.push(localizeBiasWords(ict.note));
  return facts.slice(0, 3);
}

function crtFacts(engine: EngineSignal | null | undefined): string[] {
  const crt = engine?.crt;
  if (!crt) return [];
  const facts = [
    crt['h1_state'] ? localizeBiasWords(`H1 ${crt['h1_state']}`) : null,
    crt['pd_reading'] ? localizeBiasWords(`PD ${crt['pd_reading']}`) : null,
    crt['premium_discount'] ? localizeBiasWords(`${crt['premium_discount']}`) : null,
    crt['fakeout_pdh'] === true ? 'Fakeout PDH' : null,
    crt['fakeout_pdl'] === true ? 'Fakeout PDL' : null,
  ];
  return facts.filter((f): f is string => !!f);
}

function staleMessage(engine: EngineSignal | null | undefined, s: SignalSummary): string | null {
  const fresh = engine?.dataFreshness;
  if (fresh?.stale === true) return fresh.message || 'Datos de mercado desactualizados';
  if (fresh?.stale == null && s.dataStale) return s.staleMessage || 'Datos de mercado desactualizados';
  return null;
}

/** Vista del panel; null si no hay nada que mostrar. */
export function enginePanel(s: SignalSummary | null | undefined): EnginePanelView | null {
  if (!s) return null;
  const engine = s.engine?.schemaVersion === 1 ? s.engine : null;
  const view: EnginePanelView = {
    fromJson: !!engine,
    signalId: text(engine?.signalId),
    probability: probabilityView(engine, s),
    fusionScore: num(engine?.fusion?.score),
    layers: layerRows(engine),
    zentinel: zentinelView(engine, s),
    macd: macdView(engine),
    ict: ictFacts(engine),
    crt: crtFacts(engine),
    staleMessage: staleMessage(engine, s),
    contingencies: (engine?.contingencies || []).map(String).slice(0, 6),
  };
  const empty =
    !view.probability && !view.layers.length && !view.zentinel && !view.macd &&
    !view.ict.length && !view.crt.length && !view.staleMessage && !view.contingencies.length;
  return empty ? null : view;
}

/** Tono de barra (mismos cortes que las barras de scores). */
export function engineBarLevel(score: number | null): 'high' | 'mid' | 'lo' {
  if (score != null && score >= 70) return 'high';
  if (score != null && score >= 45) return 'mid';
  return 'lo';
}
