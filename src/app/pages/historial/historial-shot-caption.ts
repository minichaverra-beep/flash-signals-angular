/**
 * Rótulo bajo «Captura detalle» y «Captura»: cuánto dinero dejó la operación y en qué estado está
 * (TP/SL, esperando entrada, en curso, no entró…), para no tener que abrir la imagen.
 */
import type { HistoryResultado, Mt5SentEntry } from '../../services/signals-api.service';

export type ShotCaptionTone = 'pos' | 'neg' | 'wait' | 'muted';

export interface ShotCaption {
  text: string;
  tone: ShotCaptionTone;
}

const REASON_LABELS: Record<string, string> = { tp: 'TP', sl: 'SL' };

function money(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} $`;
}

/** «TP», «SL», «TP + SL» o «cerrada a mano» de la original y la duplicada. */
function closeReasons(sent: Mt5SentEntry | null): string {
  const legs = [sent, sent?.duplicate].filter((s): s is Mt5SentEntry => !!s && s.state === 'closed');
  const reasons = legs.map((s) => REASON_LABELS[(s.closeReason || '').toLowerCase()] || 'cerrada a mano');
  return [...new Set(reasons)].join(' + ');
}

function sentProfit(sent: Mt5SentEntry): number | null {
  const vals = [sent.profit, sent.duplicate?.profit].filter((v): v is number => v != null && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

/** Estado vivo de la orden en MT5 cuando aún no hay resultado. */
function liveCaption(sent: Mt5SentEntry): ShotCaption | null {
  const states = [sent.state, sent.duplicate?.state];
  if (states.includes('open')) {
    const p = sentProfit(sent);
    return { text: p == null ? '▶ En curso' : `▶ En curso · ${money(p)}`, tone: 'wait' };
  }
  if (states.includes('pending')) return { text: '⏳ Esperando entrada', tone: 'wait' };
  if (sent.state === 'expired') return { text: '⌛ Expiró · no entró · 0 $', tone: 'muted' };
  if (sent.state === 'canceled') return { text: '✗ Cancelada · no entró · 0 $', tone: 'muted' };
  if (sent.state === 'closed') {
    const p = sentProfit(sent);
    const reason = closeReasons(sent);
    if (p == null) return { text: `Cerrada${reason ? ' · ' + reason : ''}`, tone: 'muted' };
    return { text: `${money(p)}${reason ? ' · ' + reason : ''}`, tone: p >= 0 ? 'pos' : 'neg' };
  }
  return { text: '⏳ Enviada a MT5', tone: 'wait' };
}

export function shotCaption(
  resultado: HistoryResultado | null | undefined,
  pnlUsd: number | null | undefined,
  sent: Mt5SentEntry | null,
): ShotCaption | null {
  const pnl = pnlUsd != null && Number.isFinite(pnlUsd) ? pnlUsd : null;
  if (resultado === 'ganada' || resultado === 'perdida') {
    const reason = closeReasons(sent);
    const word = resultado === 'ganada' ? '✓ Ganada' : '✗ Perdida';
    const amount = pnl == null ? word : `${money(pnl)} · ${reason || word}`;
    return { text: amount, tone: resultado === 'ganada' ? 'pos' : 'neg' };
  }
  if (resultado === 'no_tomada') return { text: 'No tomada · 0 $', tone: 'muted' };
  if (sent?.order) return liveCaption(sent);
  return null;
}
