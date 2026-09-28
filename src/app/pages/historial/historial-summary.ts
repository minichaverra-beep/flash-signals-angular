/**
 * Vista «Resumido» del historial (estilo historial MT5):
 * Hora · Ticket · Símbolo · Tipo · Precio · S/L · T/P · R:R · Resultado · Beneficio.
 * Helpers puros (sin Angular) para poder testearlos con node --test.
 */

export type SummaryTradeType = 'buy' | 'sell';

export interface SummaryItemLite {
  id: number;
  market: string;
  bias?: string | null;
  entry?: string | null;
  plannedEntry?: number | null;
  plannedSl?: number | null;
  plannedTp?: number | null;
  plannedRr?: string | null;
  resultado?: 'ganada' | 'perdida' | 'no_tomada' | null;
  pnlUsd?: number | null;
  tags?: Array<{ name?: string | null }> | null;
}

export interface SummaryRow {
  type: SummaryTradeType | null;
  typeLabel: string;
  price: string;
  sl: string;
  tp: string;
  rr: string;
  resultLabel: string;
  profit: string;
  profitTone: 'pos' | 'neg' | 'zero' | 'empty';
}

export interface SummaryTotals {
  profit: string;
  profitTone: SummaryRow['profitTone'];
  ganadas: number;
  perdidas: number;
  noTomadas: number;
  pendientes: number;
}

const DASH = '—';

function tradeTypeFromText(text: string | null | undefined): SummaryTradeType | null {
  const t = String(text || '').toLowerCase();
  if (/\b(long|buy|compra|bullish|alcista)\b/.test(t)) return 'buy';
  if (/\b(short|sell|venta|bearish|bajista)\b/.test(t)) return 'sell';
  return null;
}

/** Buy/Sell: primero por niveles del plan (SL bajo entrada = buy), luego Dirección, luego bias. */
export function summaryTradeType(item: SummaryItemLite): SummaryTradeType | null {
  const e = item.plannedEntry;
  const sl = item.plannedSl;
  const tp = item.plannedTp;
  if (e != null && sl != null && sl !== e) return sl < e ? 'buy' : 'sell';
  if (e != null && tp != null && tp !== e) return tp > e ? 'buy' : 'sell';
  for (const tag of item.tags ?? []) {
    const byTag = tradeTypeFromText(tag?.name);
    if (byTag) return byTag;
  }
  return tradeTypeFromText(item.bias);
}

/** Decimales según magnitud: forex 5, índices/oro 2, cripto grande 1–2. */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return value.toFixed(priceDecimals(Math.abs(value)));
}

function priceDecimals(abs: number): number {
  if (abs < 10) return 5;
  if (abs < 1000) return 3;
  return 2;
}

function profitTone(v: number | null | undefined): SummaryRow['profitTone'] {
  if (v == null || !Number.isFinite(v)) return 'empty';
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return 'zero';
}

export function formatProfit(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  let sign = '';
  if (v > 0) sign = '+';
  else if (v < 0) sign = '-';
  return `${sign}${Math.abs(v).toFixed(2)}`;
}

const RESULT_LABEL: Record<string, string> = {
  ganada: 'Ganada',
  perdida: 'Perdida',
  no_tomada: 'No tomada',
};

export function summaryRow(item: SummaryItemLite): SummaryRow {
  const type = summaryTradeType(item);
  const entryFallback = Number(String(item.entry ?? '').replace(',', '.'));
  const price =
    item.plannedEntry ?? (item.entry && Number.isFinite(entryFallback) ? entryFallback : null);
  return {
    type,
    typeLabel: type ?? DASH,
    price: formatPrice(price),
    sl: formatPrice(item.plannedSl),
    tp: formatPrice(item.plannedTp),
    rr: item.plannedRr?.trim() || DASH,
    resultLabel: item.resultado ? RESULT_LABEL[item.resultado] : 'Pendiente',
    profit: item.resultado === 'no_tomada' ? DASH : formatProfit(item.pnlUsd),
    profitTone: item.resultado === 'no_tomada' ? 'empty' : profitTone(item.pnlUsd),
  };
}

/** Pie tipo MT5: beneficio total (sin no tomadas) y conteo por resultado. */
export function summaryTotals(items: SummaryItemLite[]): SummaryTotals {
  let sum = 0;
  let hasPnl = false;
  const out = { ganadas: 0, perdidas: 0, noTomadas: 0, pendientes: 0 };
  for (const it of items) {
    if (it.resultado === 'ganada') out.ganadas++;
    else if (it.resultado === 'perdida') out.perdidas++;
    else if (it.resultado === 'no_tomada') out.noTomadas++;
    else out.pendientes++;
    if (it.resultado !== 'no_tomada' && it.pnlUsd != null && Number.isFinite(it.pnlUsd)) {
      sum += it.pnlUsd;
      hasPnl = true;
    }
  }
  const total = hasPnl ? Math.round(sum * 100) / 100 : null;
  return { ...out, profit: formatProfit(total), profitTone: profitTone(total) };
}
