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
  checklist2M5?: ChecklistItem[];
  checklistE1?: ChecklistItem[];
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
  status: 'idle' | 'running' | 'done' | 'error' | string;
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
}

export interface LatestResponse {
  reportPath: string;
  reportName: string;
  chartPath?: string | null;
  chartUrl?: string | null;
  mtime: string;
  summary: SignalSummary | null;
  preview: string;
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

  run(body: RunRequest): Observable<{ message: string; job: Partial<JobStatus> }> {
    return this.http.post<{ message: string; job: Partial<JobStatus> }>(
      `${this.base}/signals/run`,
      body
    );
  }

  /** Escaneo H4 de la semana + regenera PNG MACD-quant (soft-filter). */
  macdQuantAnalyze(
    market: Market,
    days = 7
  ): Observable<{ message: string; job: Partial<JobStatus> }> {
    return this.http.post<{ message: string; job: Partial<JobStatus> }>(
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
  } = {}): Observable<HistoryListResponse> {
    const params: Record<string, string> = {
      page: String(opts.page ?? 1),
      pageSize: String(opts.pageSize ?? 20),
    };
    if (opts.market) params['market'] = opts.market;
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

  historyConfluenciaCreate(body: {
    name: string;
    color?: string | null;
  }): Observable<{ ok: boolean; confluencia: HistoryTag; created: boolean }> {
    return this.http.post<{
      ok: boolean;
      confluencia: HistoryTag;
      created: boolean;
    }>(`${this.base}/history/confluencias`, body);
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
    samples?: Array<{
      id: number;
      before: number;
      after: number;
      winrate?: string | null;
    }>;
  }> {
    return this.http.post(`${this.base}/history/recalc-probabilidad`, {
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
  /** Hay captura de resultado adjunta. */
  hasResultImage?: boolean;
  resultImageMime?: string | null;
  /** Chart anotado del detalle de la señal (si la corrida lo generó). */
  chartPath?: string | null;
  /** Etiquetas de Dirección (single-select; catálogo history_tags). */
  tags?: HistoryTag[];
  /** Confluencias (multi-select; catálogo history_confluencias). */
  confluencias?: HistoryTag[];
}

export interface HistoryTag {
  id: number;
  name: string;
  color?: string | null;
  sortOrder?: number;
  createdAt?: string | null;
}

export interface HistoryListResponse {
  items: HistoryListItem[];
  /** Barras de cambio de cálculo (corte viejo vs nuevo en el grid). */
  calcMarkers?: CalcChangeMarker[];
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
  kind: ArtifactKind | string;
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
