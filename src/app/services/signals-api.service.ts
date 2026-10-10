import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type Market = 'btc' | 'us30' | 'xauusd' | 'ukoil';
export type Tier = 'context' | 'light' | 'high' | 'history';

export interface RunRequest {
  market: Market;
  tier: Tier;
  bullish?: boolean;
  bearish?: boolean;
  /** «Tendencia actual»: la API detecta el bias H1 y fuerza -Bullish/-Bearish. */
  trendBias?: boolean;
  breakSetup?: boolean;
  reverse?: boolean;
  ml?: boolean;
  neural?: boolean;
  ilustrate?: boolean;
  advanced?: boolean;
  noChart?: boolean;
  noOpen?: boolean;
  entry?: string;
}

export interface ChecklistItem {
  label: string;
  ok: boolean | null;
  note?: string;
}

/** Regla graduada: ✓✓ / ✓ / ~ / ✗ / ✗✗ / · (info). */
export interface RuleReviewItem {
  label: string;
  grade: string;
  value?: string;
  impact?: string;
  winrate?: string;
  type?: string;
}

export interface PlanDetails {
  entry?: string | null;
  sl?: string | null;
  tp?: string | null;
  rr?: string | null;
  risk?: string | null;
  trigger?: string | null;
  invalidation?: string | null;
  confirmation?: string | null;
}

export interface ScoreBar {
  label: string;
  value: number | null;
  raw?: string;
  weight?: string;
  note?: string;
}

export interface VolumeInfo {
  band?: string | null;
  ratio?: number | null;
  preset?: string | null;
  thresholds?: {
    very_low?: number | null;
    low?: number | null;
    high?: number | null;
    extreme?: number | null;
  } | null;
}

export interface SignalSummary {
  market?: string;
  tier?: string;
  /** «YYYY-MM-DD HH:MM UTC» de la última vela usada por el pipeline. */
  dataAsOf?: string | null;
  dataStale?: boolean;
  staleMessage?: string | null;
  verdict?: string | null;
  plan?: string | null;
  twoM5?: string | null;
  redFlags?: string[];
  price?: string | null;
  entryOptima?: string | null;
  bias?: string | null;
  setup?: string | null;
  impulso?: string | null;
  winrate?: string | null;
  rulesPct?: number | null;
  mlPct?: number | null;
  confluencePct?: number | null;
  confluenceLabel?: string | null;
  scoreExtended?: number | null;
  scoreCombined?: number | null;
  planDetails?: PlanDetails | null;
  /** Plan de la señal antes de reajustarlo con la orden real de MT5 (Recalcular). */
  planOriginal?: { entry?: string | null; sl?: string | null; tp?: string | null } | null;
  checklist2M5?: ChecklistItem[];
  checklistE1?: ChecklistItem[];
  rulesReview?: RuleReviewItem[];
  probCalibrated?: boolean;
  scorecard?: ScoreBar[];
  chartScores?: ScoreBar[];
  volume?: VolumeInfo | null;
  zentinel?: {
    killzone?: string | null;
    watchtowerKz?: string | null;
    volBand?: string | null;
    volRatio?: number | null;
    preset?: string | null;
    kzOn?: boolean | null;
    note?: string;
  };
}

export interface JobStatus {
  /** uuid del job (SSE /api/signals/events correlaciona progreso por id). */
  id?: string;
  status: 'idle' | 'running' | 'done' | 'error' | (string & Record<never, never>);
  kind?: string;
  startedAt?: string;
  finishedAt?: string;
  market?: string;
  tier?: string;
  command?: string;
  exitCode?: number | null;
  logs: string[];
  error?: string | null;
  reportPath?: string | null;
  summary?: SignalSummary | null;
  chartName?: string;
  /** id en hive box de señales (pipeline high/light/…) */
  historyId?: number | null;
  /** id en historial MACD-quant */
  macdQuantId?: number | null;
  days?: number;
  /** Bias H1 detectado con «Tendencia actual» (flag null = no se forzó). */
  trendBias?: { bias: string; label: string; flag: 'bullish' | 'bearish' | null; method: string | null; source: string | null } | null;
}

export interface LatestResponse {
  reportPath: string;
  reportName: string;
  chartPath?: string | null;
  chartUrl?: string | null;
  chartMtime?: string | null;
  /** PNG de una corrida anterior al reporte: la API no lo expone en chartUrl. */
  chartStale?: boolean;
  mtime: string;
  summary: SignalSummary | null;
  preview: string;
}

export interface Mt5PushRequest {
  historyId?: number;
  market?: Market;
  dryRun?: boolean;
  volume?: number;
  riskPct?: number;
  allowMultiple?: boolean;
  /** Solo con historyId: ejecuta el plan aunque el veredicto no sea ENTRAR. */
  anyVerdict?: boolean;
}

/** Respuesta del puente MT5 (orden enviada o vista previa con dryRun). */
export interface Mt5OrderResult {
  mode: 'market' | 'pending' | 'stop';
  manual?: boolean;
  symbol: string;
  side: 'LONG' | 'SHORT';
  volume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  marketPrice: number;
  signalEntry: number | null;
  check?: { retcode: number; comment: string } | null;
  ok?: boolean;
  dryRun?: boolean;
  order?: number;
  account: { login: number; server: string; demo: boolean };
  /** Lote subido al mínimo del broker: incluye el riesgo real resultante. */
  volumeNote?: string | null;
  checkWarning?: string | null;
  /** Ajuste de SL/TP por VIX aplicado (o aviso si no se pudo leer); ausente con el toggle apagado. */
  volatilityNote?: string | null;
}

export interface Mt5PushOutcome {
  status: 'sent' | 'skipped' | 'error';
  message: string;
  order?: { symbol: string; side: 'LONG' | 'SHORT'; entry: number; sl: number; tp: number };
  result?: Mt5OrderResult;
  /** Perfil de configuración usado (activo al enviar). */
  profile?: { id: 'principal' | 'secundaria'; label: string };
}

/** Filtro del historial por Dirección (cualquiera / sin dirección) y Confluencias (todas / ninguna). */
export interface HistoryCatalogFilter {
  tagIds?: number[];
  tagNone?: boolean;
  confluenciaIds?: number[];
  confluenciaNone?: boolean;
}

/** Envío ya registrado de una señal del historial (anti doble ejecución). */
export interface Mt5SentEntry {
  at: string;
  symbol: string | null;
  side: 'LONG' | 'SHORT' | null;
  mode: 'market' | 'pending' | null;
  volume: number | null;
  price: number | null;
  sl: number | null;
  tp: number | null;
  order: number | null;
  deal: number | null;
  /** Último estado leído de MT5 con Recalcular. */
  state?: 'pending' | 'open' | 'closed' | 'canceled' | 'expired' | null;
  /** Niveles tal como se enviaron (antes del primer Recalcular). */
  original?: { price: number | null; sl: number | null; tp: number | null; volume: number | null };
  /** Cambios detectados en el último Recalcular ("SL 50590.6 → 50511.9"). */
  lastChanges?: string[];
  profit?: number | null;
  closeReason?: string | null;
  checkedAt?: string;
  /** Segunda operación con el mismo lote (botón Duplicar; solo una por señal salvo que expire). */
  duplicate?: Mt5SentEntry;
  /** Duplicados anteriores que expiraron y se reemplazaron con otro Duplicar. */
  duplicateHistory?: Mt5SentEntry[];
}

/** Nivel de una operación: + si al tocarlo se gana, − si se pierde. */
export interface Mt5LevelOutcome {
  price: number;
  pips: number | null;
  money: number | null;
}

export interface Mt5PositionLeg {
  label: string;
  ticket: number | null;
  side: 'LONG' | 'SHORT' | null;
  state: Mt5SentEntry['state'];
  volume: number | null;
  entry: number | null;
  sl: Mt5LevelOutcome | null;
  tp: Mt5LevelOutcome | null;
  slLocksProfit: boolean;
  rr: number | null;
  current: number | null;
  toTpPips: number | null;
  toSlPips: number | null;
  progressPct: number | null;
  floatingPips: number | null;
  floatingMoney: number | null;
  profit: number | null;
  closeReason: string | null;
  checkedAt: string | null;
}

/** Parámetros de una operación enviada (GET /api/mt5/position). */
export interface Mt5PositionParams {
  market: string;
  symbol: string;
  pipSize: number;
  currency: string;
  bid: number | null;
  ask: number | null;
  moneyAvailable: boolean;
  legs: Mt5PositionLeg[];
  total: { tpMoney: number | null; slMoney: number | null; floatingMoney: number | null; profit: number | null };
  quoteError: string | null;
  readAt: string;
}

export interface Mt5RecalcResult {
  ok: boolean;
  message: string;
  changes: string[];
  sent: Mt5SentEntry;
  annotation: { resultado?: string; pnlUsd?: number } | null;
  /** «Captura detalle» redibujada con los niveles de MT5 (solo última señal del mercado). */
  chart?: { updated: boolean; reason?: string; chartUrl?: string };
  /** Auto captura lanzada al cambiar el Resultado de una operación cerrada. */
  capture?: { ok: boolean; warning?: string | null; error?: string } | null;
}

export interface Mt5DuplicateResult {
  ok: boolean;
  message: string;
  sent: Mt5SentEntry;
}

/** Única señal ejecutable desde Run operation (la última) y su ventana de tiempo. */
export interface Mt5Runnable {
  id: number;
  at: string;
  expiresAt: string;
  open: boolean;
  windowMinutes: number;
}

/** Operaciones de hoy (envíos MT5 + señales ganada/perdida de hoy) frente al límite diario del perfil. */
export interface Mt5DailyLimit {
  enabled: boolean;
  limit: number | null;
  count: number;
  remaining: number | null;
  reached: boolean;
  day: string;
  tz: string;
  message: string | null;
}

export interface Mt5SentState {
  profile: { id: 'principal' | 'secundaria'; label: string };
  sent: Record<number, Mt5SentEntry>;
  runnable: Mt5Runnable | null;
  dailyLimit?: Mt5DailyLimit;
}

export type Mt5SignalMarket = 'btc' | 'us30' | 'xauusd';

/** Balance y % de riesgo de la cuenta (SQLite, /api/account-settings): lote recomendado en Señales. */
export interface AccountSettings {
  balance: number | null;
  currency: string;
  riskPct: number | null;
  updatedAt: string | null;
}

export type AccountSettingsPatch = Partial<Pick<AccountSettings, 'balance' | 'riskPct' | 'currency'>>;

/** Configuración MT5 (pantalla Configuración). El token nunca vuelve del servidor: solo hasToken. */
export type DataSourceMode = 'auto' | 'yahoo' | 'mt5';

export interface Mt5Settings {
  bridgeUrl: string;
  hasToken: boolean;
  /** Fuente de velas de gráficos/análisis: Automática (Yahoo en Android), solo Yahoo o MT5. */
  dataSource: DataSourceMode;
  symbols: Record<Mt5SignalMarket, string>;
  riskPct: number;
  volume: number | null;
  /** Balance (USD) introducido a mano para el lote recomendado en móvil/APK; null = sin configurar. */
  accountBalance: number | null;
  maxDeviationPct: number;
  expiryMinutes: number;
  deviationPoints: number;
  allowMultiple: boolean;
  /** Señales con setup REVERSE (por defecto desactivadas). */
  reversalsEnabled: boolean;
  /** Límite de operaciones por día (activo por defecto, 1–100). */
  dailyTradeLimitEnabled: boolean;
  maxTradesPerDay: number;
  /** Drawdown diario máx. (%); 0 = sin límite. */
  maxDailyDrawdownPct: number;
  /** Margen extra sobre SL/TP de la señal, en pips. */
  extraSlPips: number;
  extraTpPips: number;
  /** Valor en precio de 1 pip por mercado. */
  pipSize: Record<Mt5SignalMarket, number>;
  /** Ajusta SL/TP según el nivel del VIX al enviar (desactivado por defecto). */
  volatilityAdjustEnabled: boolean;
  /** Símbolo del VIX en el broker; vacío = buscarlo en el puente. */
  vixSymbol: string;
  /** Umbrales superiores (puntos VIX) de Baja / Normal / Alta; por encima de vixHighMax es Extrema. */
  vixLowMax: number;
  vixNormalMax: number;
  vixHighMax: number;
  /** Multiplicador de SL/TP por nivel. */
  vixMultLow: number;
  vixMultNormal: number;
  vixMultHigh: number;
  vixMultExtreme: number;
}

export type VolatilityLevel = 'baja' | 'normal' | 'alta' | 'extrema';
export type VolatilityMood = 'tranquilo' | 'normal' | 'movido' | 'muy_movido';

/** GET /api/volatility/vix */
export interface VixReading {
  points: number;
  source: 'broker' | 'yahoo';
  sourceLabel: string;
  symbol: string;
  asOf: string;
  /** Dato no reciente (mercado cerrado: último cierre). */
  stale: boolean;
  cached: boolean;
  attempts: string[];
  level: VolatilityLevel | null;
  levelLabel: string | null;
  multiplier: number;
  enabled: boolean;
}

export interface VolatilityCalcRequest {
  market: Mt5SignalMarket;
  mood: VolatilityMood;
  riskPct: number;
  balance?: number | null;
  /** Valores del borrador sin guardar (si no se envían, los guardados del perfil). */
  multiplier?: number;
  pipSize?: number;
  profile?: Mt5ProfileId;
}

export interface VolatilityCalcResult {
  market: Mt5SignalMarket;
  symbol: string;
  mood: VolatilityMood;
  level: VolatilityLevel;
  levelLabel: string;
  multiplier: number;
  riskPct: number;
  balance: number;
  balanceSource: 'usuario' | 'mt5';
  currency: string;
  atr: number;
  atrPips: number;
  pipSize: number;
  price: number | null;
  asOf: string | null;
  plan: {
    slDistance: number;
    tpDistance: number;
    slPips: number;
    tpPips: number;
    lots: number;
    lotNote: string | null;
    riskAmount: number;
    rewardAmount: number;
    realRiskPct: number;
    rewardRatio: number;
    extraSlPips: number;
    extraTpPips: number;
  };
}

export type Mt5SettingsPatch = Partial<Omit<Mt5Settings, 'hasToken'>> & { bridgeToken?: string };

export type Mt5ProfileId = 'principal' | 'secundaria';

/** Dos perfiles (Conf principal / secundaria); `active` es el que se usa al enviar a MT5. */
export interface Mt5SettingsState {
  active: Mt5ProfileId;
  profiles: Record<Mt5ProfileId, Mt5Settings>;
  labels: Record<Mt5ProfileId, string>;
  defaults: Mt5Settings;
  /** Fuente realmente en uso con el perfil activo (el entorno FS_DATA_SOURCE manda sobre el ajuste). */
  dataSourceEffective?: { mode: 'yahoo' | 'mt5'; requested: DataSourceMode; reason: string };
}

export interface Mt5SettingsSaveRequest {
  profile?: Mt5ProfileId;
  settings?: Mt5SettingsPatch;
  active?: Mt5ProfileId;
}

export interface Mt5Health {
  ok: boolean;
  profile?: Mt5ProfileId;
  bridgeUrl: string;
  error?: string;
  connected?: boolean;
  tradeAllowed?: boolean;
  allowReal?: boolean;
  magic?: number;
  account?: {
    login: number;
    server: string;
    demo: boolean;
    currency: string;
    balance: number;
    equity: number;
  } | null;
}

@Injectable({ providedIn: 'root' })
export class SignalsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  health(): Observable<{ ok: boolean; tradingRoot: string; tradingRootExists: boolean }> {
    return this.http.get<{ ok: boolean; tradingRoot: string; tradingRootExists: boolean }>(
      `${this.base}/health`
    );
  }

  run(body: RunRequest): Observable<{ message: string; job: JobStatus }> {
    return this.http.post<{ message: string; job: JobStatus }>(
      `${this.base}/signals/run`,
      body
    );
  }

  /** Escaneo H4 de la semana + regenera PNG MACD-quant (soft-filter). */
  macdQuantAnalyze(
    market: Market,
    days = 7
  ): Observable<{ message: string; job: JobStatus }> {
    return this.http.post<{ message: string; job: JobStatus }>(
      `${this.base}/signals/macd-quant/analyze`,
      { market, days }
    );
  }

  macdQuantHistory(opts: {
    page?: number;
    pageSize?: number;
    market?: Market | '';
  } = {}): Observable<MacdQuantHistoryListResponse> {
    const params: Record<string, string> = {
      page: String(opts.page ?? 1),
      pageSize: String(opts.pageSize ?? 20),
    };
    if (opts.market) params['market'] = opts.market;
    return this.http.get<MacdQuantHistoryListResponse>(
      `${this.base}/signals/macd-quant/history`,
      { params }
    );
  }

  macdQuantHistoryGet(id: number): Observable<MacdQuantHistoryDetail> {
    return this.http.get<MacdQuantHistoryDetail>(
      `${this.base}/signals/macd-quant/history/${id}`
    );
  }

  macdQuantHistoryChartUrl(id: number, bust?: number | string): string {
    const q = bust != null ? `?t=${encodeURIComponent(String(bust))}` : '';
    return `${this.base}/signals/macd-quant/history/${id}/chart${q}`;
  }

  status(): Observable<JobStatus> {
    return this.http.get<JobStatus>(`${this.base}/signals/status`);
  }

  /** dryRun=true: vista previa validada por MT5 sin enviar la orden. */
  mt5Push(body: Mt5PushRequest): Observable<Mt5PushOutcome> {
    return this.http.post<Mt5PushOutcome>(`${this.base}/mt5/push`, body);
  }

  mt5Sent(): Observable<Mt5SentState> {
    return this.http.get<Mt5SentState>(`${this.base}/mt5/sent`);
  }

  mt5DailyLimit(profile?: Mt5ProfileId): Observable<Mt5DailyLimit & { profile: Mt5ProfileId }> {
    const params: Record<string, string> = profile ? { profile } : {};
    return this.http.get<Mt5DailyLimit & { profile: Mt5ProfileId }>(`${this.base}/mt5/daily-limit`, { params });
  }

  mt5Recalc(historyId: number): Observable<Mt5RecalcResult> {
    return this.http.post<Mt5RecalcResult>(`${this.base}/mt5/recalc`, { historyId });
  }

  mt5Position(historyId: number): Observable<Mt5PositionParams> {
    return this.http.get<Mt5PositionParams>(`${this.base}/mt5/position`, { params: { historyId } });
  }

  mt5Duplicate(historyId: number): Observable<Mt5DuplicateResult> {
    return this.http.post<Mt5DuplicateResult>(`${this.base}/mt5/duplicate`, { historyId });
  }

  mt5Settings(): Observable<Mt5SettingsState> {
    return this.http.get<Mt5SettingsState>(`${this.base}/mt5/settings`);
  }

  mt5SettingsSave(body: Mt5SettingsSaveRequest): Observable<Mt5SettingsState> {
    return this.http.patch<Mt5SettingsState>(`${this.base}/mt5/settings`, body);
  }

  accountSettings(): Observable<AccountSettings> {
    return this.http.get<AccountSettings>(`${this.base}/account-settings`);
  }

  accountSettingsSave(body: AccountSettingsPatch): Observable<AccountSettings> {
    return this.http.put<AccountSettings>(`${this.base}/account-settings`, body);
  }

  mt5Health(profile?: Mt5ProfileId): Observable<Mt5Health> {
    const params: Record<string, string> = profile ? { profile } : {};
    return this.http.get<Mt5Health>(`${this.base}/mt5/health`, { params });
  }

  /** VIX actual (broker MT5 o Yahoo), nivel y multiplicador con los umbrales guardados del perfil. */
  vixCurrent(profile?: Mt5ProfileId): Observable<VixReading> {
    const params: Record<string, string> = profile ? { profile } : {};
    return this.http.get<VixReading>(`${this.base}/volatility/vix`, { params });
  }

  /** Calculadora de volatilidad (solo lectura del broker): distancias SL/TP, lotes y dinero. */
  volatilityCalc(body: VolatilityCalcRequest): Observable<VolatilityCalcResult> {
    return this.http.post<VolatilityCalcResult>(`${this.base}/volatility/calc`, body);
  }

  latest(market: Market, tier: Tier = 'high'): Observable<LatestResponse> {
    return this.http.get<LatestResponse>(
      `${this.base}/signals/latest`,
      { params: { market, tier } }
    );
  }

  zentinel(market: Market): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(`${this.base}/zentinel`, {
      params: { market },
    });
  }

  historyList(opts: {
    page?: number;
    pageSize?: number;
    market?: Market | '';
    sortBy?: HistorySortKey;
    sortDir?: SortDir;
  } & HistoryCatalogFilter = {}): Observable<HistoryListResponse> {
    const params: Record<string, string> = {
      page: String(opts.page ?? 1),
      pageSize: String(opts.pageSize ?? 20),
    };
    if (opts.market) params['market'] = opts.market;
    if (opts.sortBy) params['sortBy'] = opts.sortBy;
    if (opts.sortDir) params['sortDir'] = opts.sortDir;
    if (opts.tagIds?.length) params['tagIds'] = opts.tagIds.join(',');
    if (opts.tagNone) params['tagNone'] = '1';
    if (opts.confluenciaIds?.length) params['confluenciaIds'] = opts.confluenciaIds.join(',');
    if (opts.confluenciaNone) params['confluenciaNone'] = '1';
    return this.http.get<HistoryListResponse>(`${this.base}/history`, { params });
  }

  historyGet(id: number): Observable<HistoryDetail> {
    return this.http.get<HistoryDetail>(`${this.base}/history/${id}`);
  }

  historyDelete(
    id: number,
    unlockPassword: string
  ): Observable<{ ok: boolean; deleted: number }> {
    return this.http.delete<{ ok: boolean; deleted: number }>(
      `${this.base}/history/${id}`,
      { headers: { 'X-History-Unlock': unlockPassword } }
    );
  }

  historyClear(unlockPassword: string): Observable<{ ok: boolean; deleted: number }> {
    return this.http.delete<{ ok: boolean; deleted: number }>(`${this.base}/history`, {
      headers: { 'X-History-Unlock': unlockPassword },
    });
  }

  historyPatch(
    id: number,
    body: {
      comment?: string | null;
      motivoEntradaSalida?: string | null;
      resultado?: HistoryResultado | null;
      pnlUsd?: number | null;
      tagIds?: number[];
      confluenceIds?: number[];
    }
  ): Observable<{ ok: boolean; item: HistoryDetail }> {
    return this.http.patch<{ ok: boolean; item: HistoryDetail }>(
      `${this.base}/history/${id}`,
      body
    );
  }

  /** Candado de la fila: bloqueada = solo lectura (el API rechaza cambios con 423). */
  historySetLocked(id: number, locked: boolean): Observable<{ ok: boolean; item: HistoryDetail }> {
    return this.http.patch<{ ok: boolean; item: HistoryDetail }>(`${this.base}/history/${id}`, {
      locked,
    });
  }

  historyTagsList(): Observable<{ tags: HistoryTag[] }> {
    return this.http.get<{ tags: HistoryTag[] }>(`${this.base}/history/tags`);
  }

  historyTagCreate(body: {
    name: string;
    color?: string | null;
  }): Observable<{ ok: boolean; tag: HistoryTag; created: boolean }> {
    return this.http.post<{ ok: boolean; tag: HistoryTag; created: boolean }>(
      `${this.base}/history/tags`,
      body
    );
  }

  historyConfluenciasList(): Observable<{ confluencias: HistoryTag[] }> {
    return this.http.get<{ confluencias: HistoryTag[] }>(
      `${this.base}/history/confluencias`
    );
  }

  historyCalcMarkersList(market?: Market | ''): Observable<{ markers: CalcChangeMarker[] }> {
    const params: Record<string, string> = {};
    if (market) params['market'] = market;
    return this.http.get<{ markers: CalcChangeMarker[] }>(
      `${this.base}/history/calc-markers`,
      { params }
    );
  }

  historyCalcMarkerCreate(body: {
    title: string;
    comment?: string | null;
    market?: Market | '' | null;
  }): Observable<{ ok: boolean; marker: CalcChangeMarker }> {
    return this.http.post<{ ok: boolean; marker: CalcChangeMarker }>(
      `${this.base}/history/calc-markers`,
      body
    );
  }

  historyCalcMarkerPatch(
    id: number,
    body: { title?: string; comment?: string | null; market?: string | null }
  ): Observable<{ ok: boolean; marker: CalcChangeMarker }> {
    return this.http.patch<{ ok: boolean; marker: CalcChangeMarker }>(
      `${this.base}/history/calc-markers/${id}`,
      body
    );
  }

  historyCalcMarkerDelete(id: number): Observable<{ ok: boolean; deleted: number }> {
    return this.http.delete<{ ok: boolean; deleted: number }>(
      `${this.base}/history/calc-markers/${id}`
    );
  }

  /** Recalcula Probabilidad de éxito de todo el historial (v2 acuerdo + ubicación). */
  historyRecalcProbabilidad(opts: {
    force?: boolean;
    market?: Market | '' | null;
  } = {}): Observable<{
    ok: boolean;
    version: string;
    total: number;
    updated: number;
    unchanged: number;
    skipped: number;
    /** Filas con candado (manual o de un día anterior): nunca se recalculan. */
    skippedLocked?: number;
    samples?: Array<{
      id: number;
      before: number;
      after: number;
      winrate?: string | null;
    }>;
  }> {
    return this.http.post<{
      ok: boolean;
      version: string;
      total: number;
      updated: number;
      unchanged: number;
      skipped: number;
      skippedLocked?: number;
      samples?: Array<{
        id: number;
        before: number;
        after: number;
        winrate?: string | null;
      }>;
    }>(`${this.base}/history/recalc-probabilidad`, {
      force: Boolean(opts.force),
      market: opts.market || null,
    });
  }

  /** URL de la captura del resultado (cache-bust con updatedAt opcional). */
  historyResultImageUrl(id: number, bust?: number | string): string {
    const q = bust != null ? `?v=${encodeURIComponent(String(bust))}` : '';
    return `${this.base}/history/${id}/result-image${q}`;
  }

  historyUploadResultImage(
    id: number,
    imageBase64: string,
    mime?: string
  ): Observable<{ ok: boolean; item: HistoryDetail }> {
    return this.http.post<{ ok: boolean; item: HistoryDetail }>(
      `${this.base}/history/${id}/result-image`,
      { imageBase64, mime }
    );
  }

  /** Auto captura: PNG con velas reales tras la señal (Entrada/SL/TP) como captura del resultado. */
  historyAutoCapture(id: number, resultado: HistoryResultado | null): Observable<HistoryAutoCaptureResult> {
    return this.http.post<HistoryAutoCaptureResult>(`${this.base}/history/${id}/auto-capture`, {
      resultado,
    });
  }

  /** $/PnL real desde MT5 (Auto captura); overwrite=true reemplaza un PnL manual distinto. */
  historyMt5Pnl(id: number, resultado: HistoryResultado | null, overwrite = false): Observable<HistoryMt5PnlResult> {
    return this.http.post<HistoryMt5PnlResult>(`${this.base}/history/${id}/mt5-pnl`, { resultado, overwrite });
  }

  historyDeleteResultImage(
    id: number
  ): Observable<{ ok: boolean; item: HistoryDetail }> {
    return this.http.delete<{ ok: boolean; item: HistoryDetail }>(
      `${this.base}/history/${id}/result-image`
    );
  }

  artifactsList(): Observable<ArtifactsListResponse> {
    return this.http.get<ArtifactsListResponse>(`${this.base}/artifacts`);
  }

  artifactsScan(): Observable<ArtifactsListResponse> {
    return this.http.post<ArtifactsListResponse>(`${this.base}/artifacts/scan`, {});
  }

  artifactGet(relPath: string): Observable<ArtifactDetail> {
    return this.http.get<ArtifactDetail>(`${this.base}/artifacts/item`, {
      params: { path: relPath },
    });
  }

  artifactPatchMeta(body: ArtifactMetaPatch): Observable<ArtifactMetaPatchResponse> {
    return this.http.patch<ArtifactMetaPatchResponse>(
      `${this.base}/artifacts/meta`,
      body
    );
  }

  wikiCategoriesList(): Observable<{ items: WikiCategory[] }> {
    return this.http.get<{ items: WikiCategory[] }>(`${this.base}/wiki/categories`);
  }

  wikiCategoryCreate(body: {
    name: string;
    sortOrder?: number;
    color?: string | null;
  }): Observable<{ ok: boolean; category: WikiCategory }> {
    return this.http.post<{ ok: boolean; category: WikiCategory }>(
      `${this.base}/wiki/categories`,
      body
    );
  }

  wikiCategoryPatch(
    id: number,
    body: { name?: string; sortOrder?: number; color?: string | null }
  ): Observable<{ ok: boolean; category: WikiCategory }> {
    return this.http.patch<{ ok: boolean; category: WikiCategory }>(
      `${this.base}/wiki/categories/${id}`,
      body
    );
  }

  wikiCategoryDelete(
    id: number,
    opts: { reassignTo?: number | null; force?: boolean } = {}
  ): Observable<{ ok: boolean; deleted: number }> {
    const params: Record<string, string> = {};
    if (opts.reassignTo === null) params['reassignTo'] = 'null';
    else if (opts.reassignTo != null) params['reassignTo'] = String(opts.reassignTo);
    if (opts.force) params['force'] = 'true';
    return this.http.delete<{ ok: boolean; deleted: number }>(
      `${this.base}/wiki/categories/${id}`,
      { params }
    );
  }
}

export type HistoryResultado = 'ganada' | 'perdida' | 'no_tomada';

/** Resultado detectado con precio real por la auto captura (app.views.trade_outcome_chart). */
export interface HistoryAutoCaptureOutcome {
  outcome: 'tp' | 'sl' | 'ambiguous' | 'not_filled' | 'open';
  label: string;
  message: string;
  reason?: string | null;
  detected: 'ganada' | 'perdida' | null;
  direction: 'LONG' | 'SHORT';
  entryType: string;
  signalTime: string;
  fillTime: string | null;
  exitTime: string | null;
  lastCandle: string;
  source: string;
  shift: number;
}

export interface HistoryAutoCaptureResult {
  ok: boolean;
  item: HistoryDetail;
  outcome: HistoryAutoCaptureOutcome;
  detected: 'ganada' | 'perdida' | null;
  /** El precio contradice el Resultado elegido (no se cambia: solo aviso). */
  mismatch: boolean;
  warning: string | null;
}

export interface HistoryMt5Pnl {
  /** Neto: profit + commission + swap + fee de todos los deals de la posición. */
  value: number;
  source: 'mt5';
  /** Posición MT5. */
  ticket: number;
  deals: number[];
  login: number | null;
  breakdown: { profit: number; commission: number; swap: number; fee: number };
  /** Ejecución real (salida = media ponderada por volumen de los cierres; horas ISO UTC). */
  execution: { entry: number; exit: number | null; sl: number | null; openedAt: string | null; closedAt: string | null };
  /** El signo contradice el Resultado elegido (no se cambia: solo aviso). */
  mismatch: boolean;
  warning: string | null;
}

export interface HistoryMt5PnlResult {
  ok: boolean;
  /** false si ya coincidía o si hay un PnL manual distinto (needsConfirm). */
  applied: boolean;
  needsConfirm: boolean;
  current: number | null;
  pnl: HistoryMt5Pnl;
  item: HistoryDetail;
}

/** Ejecución real en MT5 guardada en el historial (el plan sigue en summary.planDetails). */
export interface HistoryMt5Real {
  ticket: number;
  entry: number | null;
  exit: number | null;
  sl: number | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface HistoryListItem {
  id: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  market: string;
  tier: string;
  status: string;
  verdict?: string | null;
  /** Bias elegido (bullish/bearish/auto) o texto del summary. */
  bias?: string | null;
  /**
   * Tasa de acierto / patrón ganador (summary.winrate del MD).
   * No es el veredicto wait/stop (NO_OPERAR, ESPERAR).
   */
  winrate?: string | null;
  /** R:R del plan (summary.planDetails.rr), si existe en el snapshot. */
  plannedRr?: string | null;
  /** Niveles del plan (summary.planDetails) para la vista resumida. */
  plannedEntry?: number | null;
  plannedSl?: number | null;
  plannedTp?: number | null;
  scoreCombined?: number | null;
  entry?: string | null;
  error?: string | null;
  flags?: Record<string, boolean>;
  /** Comentario del trader (editable, hive box local). */
  comment?: string | null;
  /** Motivo de entrada/salida (editable, hive box local). */
  motivoEntradaSalida?: string | null;
  /** Resultado de la operación: ganada | perdida | no_tomada. */
  resultado?: HistoryResultado | null;
  /** PnL real en USD (nullable; editable en /historial). */
  pnlUsd?: number | null;
  /** 'mt5' si el $/PnL salió de MT5 (se borra al editarlo a mano). */
  pnlSource?: string | null;
  /** Ejecución real en MT5 (Auto captura). */
  real?: HistoryMt5Real | null;
  /** Hay captura de resultado adjunta. */
  hasResultImage?: boolean;
  resultImageMime?: string | null;
  /** Chart anotado del detalle de la señal (si la corrida lo generó). */
  chartPath?: string | null;
  /** Etiquetas de Dirección (single-select; catálogo history_tags). */
  tags?: HistoryTag[];
  /** Confluencias (multi-select; catálogo history_confluencias). */
  confluencias?: HistoryTag[];
  /** Candado manual opcional. */
  locked?: boolean;
  lockedAt?: string | null;
  /** Fila de un día anterior desbloqueada a mano (anula el bloqueo por fecha). */
  unlockOverride?: boolean;
  /** Bloqueada por ser de un día anterior (según el API al leerla). */
  autoLocked?: boolean;
  /** Solo lectura: manual OR día anterior sin override. */
  effectiveLocked?: boolean;
}

export interface HistoryTag {
  id: number;
  name: string;
  color?: string | null;
  sortOrder?: number;
  createdAt?: string | null;
  /** Solo confluencias: requiere reversiones activadas en el perfil MT5 activo para asignarse. */
  requiresReversals?: boolean;
}

/** Columnas ordenables en /api/history (whitelist en history-store.js). */
export type HistorySortKey =
  | 'createdAt'
  | 'id'
  | 'market'
  | 'bias'
  | 'winrate'
  | 'scoreCombined'
  | 'status'
  | 'comment'
  | 'resultado'
  | 'pnlUsd'
  | 'hasResultImage'
  | 'plannedEntry'
  | 'plannedSl'
  | 'plannedTp'
  | 'plannedRr';

export type SortDir = 'asc' | 'desc';

export interface HistoryListResponse {
  items: HistoryListItem[];
  /** Barras de cambio de cálculo (corte viejo vs nuevo en el grid). */
  calcMarkers?: CalcChangeMarker[];
  /** Zona horaria del API para «hoy» (bloqueo de operaciones de días anteriores). */
  lockTz?: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Marcador horizontal: señales encima = cálculo nuevo; debajo = anterior. */
export interface CalcChangeMarker {
  id: number;
  createdAt: string;
  title: string;
  comment?: string | null;
  market?: string | null;
}

export interface HistoryDetail extends HistoryListItem {
  summary?: SignalSummary | null;
  reportPath?: string | null;
  chartPath?: string | null;
  preview?: string | null;
  command?: string | null;
  exitCode?: number | null;
}

/** Entrada de historial MACD-quant (soft-filter H4). */
export interface MacdQuantHistoryListItem {
  id: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  market: string;
  timeframe: string;
  days?: number | null;
  status: string;
  softFilter?: {
    role?: string;
    neverTriggerAlone?: boolean;
    disclaimer?: string;
    macdQuant?: boolean;
    days?: number | string;
  };
  params?: { fast?: number; slow?: number; signal?: number };
  hasPng?: boolean;
  error?: string | null;
}

export interface MacdQuantHistoryListResponse {
  items: MacdQuantHistoryListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MacdQuantHistoryDetail extends MacdQuantHistoryListItem {
  sourcePngPath?: string | null;
  pngName?: string | null;
  command?: string | null;
  exitCode?: number | null;
  logsTail?: string | null;
}

export type ArtifactKind =
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'text'
  | 'other';

export interface ArtifactItem {
  name: string;
  path: string;
  ext: string;
  size: number;
  mtime: string;
  kind: ArtifactKind | (string & Record<never, never>);
  /** Nombre de display (meta local); por defecto = name del archivo. */
  displayName?: string;
  categoryId?: number | null;
  /**
   * Dirección de sesgo (meta local): bullish | bearish | auto.
   * No se infiere del path/filename.
   */
  bias?: string | null;
  metaUpdatedAt?: string | null;
}

export interface WikiCategory {
  id: number;
  name: string;
  sortOrder: number;
  color?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ArtifactsListResponse {
  root: string;
  exists: boolean;
  count: number;
  truncated?: boolean;
  scannedAt: string;
  items: ArtifactItem[];
  categories?: WikiCategory[];
}

export interface ArtifactDetail extends ArtifactItem {
  mime?: string;
  rawUrl: string;
  content: string | null;
  note?: string;
}

export interface ArtifactMetaPatch {
  path: string;
  displayName?: string;
  categoryId?: number | null;
  /** Dirección: bullish | bearish | auto | null. Alias: direction. */
  bias?: string | null;
  direction?: string | null;
  /** Si true, intenta renombrar el archivo en disco (mismo directorio). */
  renameFile?: boolean;
}

export interface ArtifactMetaPatchResponse {
  ok: boolean;
  path: string;
  pathChanged: boolean;
  oldPath: string | null;
  meta: {
    path: string;
    displayName: string;
    categoryId: number | null;
    bias: string | null;
    updatedAt: string;
  };
}
