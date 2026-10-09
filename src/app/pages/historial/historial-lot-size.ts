/**
 * Lote recomendado sin MT5 (APK / móvil): misma fórmula que `calculatePlan` (server/volatility.js)
 * y `calc_volume` (mt5-bridge/bridge.py), con la ficha del símbolo fija en vez de `symbol_info`.
 */

export interface SymbolSpec {
  /** USD que se ganan/pierden por 1.0 de precio con 1 lote (tickValue / tickSize). */
  usdPerPricePerLot: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

/**
 * Fichas típicas del broker (Exness, cuenta en USD):
 *  - BTCUSD: contrato 1 BTC, tick 0,01 = 0,01 USD → 1 USD por punto (server/volatility.test.js).
 *  - XAUUSD: contrato 100 oz, tick 0,001 = 0,1 USD → 100 USD por 1,0 de precio (volatility.test.js, test_metaapi_mt5.py).
 *  - US30: contrato 1 índice → 1 USD por punto (supuesto: CFD de índice estándar Exness).
 *  - UKOIL: contrato 100 barriles → 100 USD por 1,0 de precio (supuesto: CFD de petróleo estándar).
 * Lotes: mínimo 0,01, paso 0,01, máximo 200.
 */
export const SYMBOL_SPECS: Record<string, SymbolSpec> = {
  btc: { usdPerPricePerLot: 1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 },
  us30: { usdPerPricePerLot: 1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 },
  xauusd: { usdPerPricePerLot: 100, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 },
  ukoil: { usdPerPricePerLot: 100, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01 },
};

export interface LotSuggestion {
  lots: number;
  /** Riesgo objetivo: balance × riesgo %. */
  riskUsd: number;
  /** Riesgo con el lote final (mayor que el objetivo si se fuerza el lote mínimo). */
  realRiskUsd: number;
  /** El cálculo daba menos que el lote mínimo del broker y se usa el mínimo. */
  belowMin: boolean;
}

/**
 * lote = (balance × riesgo %) / (|entrada − SL| × USD por 1,0 de precio y lote),
 * redondeado hacia abajo al paso de lote y acotado a [mínimo, máximo].
 * null si falta algún dato o el mercado no tiene ficha.
 */
export function recommendedLot(input: {
  market: string | null | undefined;
  entry: number | null | undefined;
  sl: number | null | undefined;
  balance: number | null | undefined;
  riskPct: number | null | undefined;
}): LotSuggestion | null {
  const spec = SYMBOL_SPECS[String(input.market ?? '').toLowerCase()];
  const { entry, sl, balance, riskPct } = input;
  if (!spec || entry == null || sl == null || !Number.isFinite(entry) || !Number.isFinite(sl)) return null;
  if (!(balance! > 0) || !(riskPct! > 0)) return null;
  const distance = Math.abs(entry - sl);
  if (!(distance > 0)) return null;

  const riskUsd = (balance! * riskPct!) / 100;
  const lossPerLot = distance * spec.usdPerPricePerLot;
  const stepDecimals = (String(spec.volumeStep).split('.')[1] || '').length;
  const factor = 10 ** stepDecimals;
  let lots = Math.round(Math.floor(riskUsd / lossPerLot / spec.volumeStep + 1e-9) * spec.volumeStep * factor) / factor;
  const belowMin = lots < spec.volumeMin;
  if (belowMin) lots = spec.volumeMin;
  else if (lots > spec.volumeMax) lots = spec.volumeMax;
  return {
    lots,
    riskUsd: Math.round(riskUsd * 100) / 100,
    realRiskUsd: Math.round(lots * lossPerLot * 100) / 100,
    belowMin,
  };
}
