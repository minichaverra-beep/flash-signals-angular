import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  CalcChangeMarker,
  HistoryCatalogFilter,
  HistoryDetail,
  HistoryListItem,
  HistoryResultado,
  HistorySortKey,
  HistoryTag,
  Market,
  Mt5OrderResult,
  Mt5PushOutcome,
  Mt5Runnable,
  Mt5DailyLimit,
  Mt5PositionLeg,
  Mt5PositionParams,
  Mt5SentEntry,
  SignalsApiService,
  SortDir,
} from '../../services/signals-api.service';
import {
  ReportViewMode,
  SignalReportViewerComponent,
} from '../../shared/signal-report-viewer.component';
import { biasTone, biasLabel, resolveRunBias, hitRateTone, parseHitRateAnalysis, probabilityHint, hitRateTooltip, probabilityTooltip, explainHitFactor, HIT_RATE_COLUMN_TOOLTIP } from '../../shared/signal-report.helpers';
import type { HitRateAnalysis, HitRateFactor } from '../../shared/signal-report.helpers';
import {
  computeHistoryMetrics,
  formatMetric,
  formatPnlMoneyInput,
  type HistoryMetrics,
} from './historial-metrics';
import {
  mergeCalcMarkersIntoRows,
  type HistDisplayRow,
} from './historial-calc-markers';
import {
  summaryRow,
  summaryTotals,
  summaryTradeType,
  type SummaryRow,
  type SummaryTotals,
} from './historial-summary';
import {
  buildExportBundle,
  exportFileName,
  type ExportBundle,
  type ExportRowHelpers,
} from './historial-export';
import { isAutoLocked, isEffectivelyLocked, isPastDay } from './historial-lock';
import { ShotCaption, shotCaption } from './historial-shot-caption';
import { ImageViewerService } from '../../shared/image-viewer/image-viewer.service';
import { canShowParams } from './historial-params-visibility';
import { LotSuggestion, recommendedLot } from './historial-lot-size';
import { SignalJobService, jobKind } from '../../services/signal-job.service';
import { SignalRunFormComponent } from '../../shared/signal-run-form.component';
import { AdminLoginComponent } from '../../shared/admin-login/admin-login.component';
import { AuthService } from '../../services/auth.service';
import { DeviceService } from '../../services/device.service';
import { Subscription } from 'rxjs';

export type ExportFormat = 'excel' | 'pdf';
/** Página visible (según «por página») o todas las páginas del filtro. */
export type ExportScope = 'pagina' | 'todo';

const EXPORT_SCOPE_KEY = 'historial.exportScope';

function readExportScope(): ExportScope {
  try {
    return localStorage.getItem(EXPORT_SCOPE_KEY) === 'todo' ? 'todo' : 'pagina';
  } catch {
    return 'pagina';
  }
}

const COMPACT_MODE_KEY = 'historial.compactMode';

function readCompactMode(): boolean {
  try {
    return localStorage.getItem(COMPACT_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

const AUTO_CAPTURE_KEY = 'historial.autoCapture';

function readAutoCapture(): boolean {
  try {
    // Sin preferencia guardada (APK/teléfono: otro origen, otro localStorage) → activada.
    return localStorage.getItem(AUTO_CAPTURE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Aviso de auto captura junto a la celda CAPTURA (mismatch / sin niveles / no ejecutada…). */
export interface AutoCaptureNote {
  text: string;
  tone: 'ok' | 'warn' | 'err';
}

const PAGE_SIZE_KEY = 'historial.pageSize';
const PAGE_SIZE_OPTIONS = [5, 10, 15] as const;

function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : PAGE_SIZE_OPTIONS[0];
  } catch {
    return PAGE_SIZE_OPTIONS[0];
  }
}

const SORT_KEY = 'historial.sort';
const DEFAULT_SORT: { by: HistorySortKey; dir: SortDir } = { by: 'createdAt', dir: 'desc' };

function readSort(): { by: HistorySortKey; dir: SortDir } {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (raw && typeof raw.by === 'string' && (raw.dir === 'asc' || raw.dir === 'desc')) {
      return { by: raw.by as HistorySortKey, dir: raw.dir };
    }
  } catch {
    /* storage no disponible o JSON inválido */
  }
  return { ...DEFAULT_SORT };
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Color por defecto de chips Dirección / Confluencias (coincide con seed SQLite). */
const DEFAULT_TAG_COLOR = '#4b5563';
const DETAIL_HISTORY_FLAG = '__fsHistorialDetail';

/** Campos del candado que devuelve el API tras cualquier cambio de la fila. */
function lockFields(u: HistoryListItem): Partial<HistoryListItem> {
  return {
    locked: u.locked ?? false,
    lockedAt: u.lockedAt ?? null,
    unlockOverride: u.unlockOverride ?? false,
    autoLocked: u.autoLocked ?? false,
    effectiveLocked: u.effectiveLocked ?? false,
  };
}

@Component({
  selector: 'app-historial',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, SignalReportViewerComponent, SignalRunFormComponent, AdminLoginComponent],
  templateUrl: './historial.component.html',
  styleUrl: './historial.component.scss',
})
export class HistorialComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
  private readonly jobs = inject(SignalJobService);
  private readonly imageViewer = inject(ImageViewerService);
  /** Botones de borrar solo visibles con sesión admin. */
  readonly isAdmin = inject(AuthService).isAdmin;
  /** APK o pantalla pequeña: sin acciones MT5 (Run, Parámetros, Duplicar, Recalcular). */
  readonly mt5Hidden = inject(DeviceService).mt5Hidden;
  /** «Ver detalle» (ojo) a pantalla completa, sin scroll del body y cerrable con Atrás. */
  readonly isMobileOrApk = inject(DeviceService).isMobileOrApk;
  private detailHistoryPushed = false;
  private readonly onDetailPopState = (): void => {
    if (!this.detailHistoryPushed || history.state?.[DETAIL_HISTORY_FLAG]) return;
    this.detailHistoryPushed = false;
    this.closeDetail();
  };
  private finishedSub?: Subscription;
  /** Tras terminar una corrida: bajar a la tabla cuando llegue la lista recargada. */
  private scrollToListAfterLoad = false;
  /** Limpia el listener de cierre outside-click (fase capture). */
  private removeDocClickClose?: () => void;

  items: HistoryListItem[] = [];
  calcMarkers: CalcChangeMarker[] = [];
  displayRows: HistDisplayRow<HistoryListItem>[] = [];
  page = 1;
  pageSize = readPageSize();
  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  total = 0;
  totalPages = 1;
  readonly hitRateColumnTip = HIT_RATE_COLUMN_TOOLTIP;
  /** Vista «Resumido» (estilo historial MT5) vs detallada editable. */
  compactMode = readCompactMode();
  /** «Auto captura»: al marcar Ganada/Perdida se genera la captura del resultado con precio real. */
  autoCapture = readAutoCapture();
  /** Filas generando auto captura. */
  autoCaptureBusyIds = new Set<number>();
  /** id → último aviso de auto captura. */
  autoCaptureNotes = new Map<number, AutoCaptureNote>();
  /** Filas buscando el $/PnL en MT5 (Auto captura). */
  mt5PnlBusyIds = new Set<number>();
  /** id → último aviso del $/PnL de MT5. */
  mt5PnlNotes = new Map<number, AutoCaptureNote>();
  pageTotals: SummaryTotals = summaryTotals([]);
  sortBy: HistorySortKey = readSort().by;
  sortDir: SortDir = readSort().dir;
  marketFilter: Market | '' = '';
  loading = false;
  error = '';
  clearing = false;
  /** id → guardando anotación */
  savingIds = new Set<number>();
  /** id → subiendo/borrando imagen */
  imageBusyIds = new Set<number>();
  /** id → cambiando el candado */
  lockBusyIds = new Set<number>();
  /** Zona del API para «hoy» (bloqueo por fecha); sin dato → zona del navegador. */
  lockTz: string | undefined;
  /** cache-bust por id de imagen */
  imageBust = new Map<number, number>();
  /** URL con cache-bust de la «Captura detalle» redibujada tras Recalcular (por mercado). */
  detailChartUrl = new Map<string, string>();
  saveHint = '';
  dropActive = false;

  /** Diálogo: nueva barra de cambio de cálculo */
  calcMarkerOpen = false;
  calcMarkerTitle = '';
  calcMarkerComment = '';
  calcMarkerBusy = false;
  calcMarkerError = '';
  /** Edición inline de comentario de marcador */
  editingMarkerId: number | null = null;
  editingMarkerComment = '';
  recalcBusy = false;

  detail: HistoryDetail | null = null;
  detailLoading = false;
  detailMode: ReportViewMode = 'rapida';
  drawerOpen = false;
  /** Panel detalle a pantalla amplia (vs drawer estrecho). */
  detailExpanded = true;

  /** Dataset completo del filtro actual (todas las páginas) para métricas. */
  metricsItems: HistoryListItem[] = [];
  metrics: HistoryMetrics | null = null;
  metricsLoading = false;

  /** Formato que se está generando (deshabilita ambos botones de exportar). */
  exportBusy: ExportFormat | null = null;
  exportScope: ExportScope = readExportScope();
  /** Formato pendiente de confirmar en el diálogo de exportación. */
  exportConfirm: ExportFormat | null = null;

  /** Señales del historial ya enviadas a MT5 con el perfil activo (por historyId). */
  mt5Sent: Record<number, Mt5SentEntry> = {};
  mt5ProfileLabel = '';
  /** Solo la última señal es ejecutable, y solo dentro de su ventana (30 min). */
  mt5Runnable: Mt5Runnable | null = null;
  /** Operaciones de hoy frente al límite diario del perfil activo. */
  dailyLimit: Mt5DailyLimit | null = null;
  /** Reloj para deshabilitar Run al vencer la ventana sin recargar. */
  nowMs = Date.now();
  private clockTimer?: ReturnType<typeof setInterval>;
  /** Run operation: fila en confirmación → vista previa (dryRun) → enviar. */
  runItem: HistoryListItem | null = null;
  runLoading = false;
  runSending = false;
  runPreview: Mt5OrderResult | null = null;
  runError = '';
  runToast = '';
  runToastErr = false;
  /** Filas con Recalcular en curso (lee MT5 y reajusta el historial). */
  mt5RecalcBusy = new Set<number>();
  /** Filas con Duplicar en curso (segunda operación con el mismo lote). */
  mt5DuplicateBusy = new Set<number>();

  /** Diálogo de desbloqueo para borrar (modo lock). */
  unlockOpen = false;
  unlockKind: 'delete' | 'clear' | null = null;
  unlockItem: HistoryListItem | null = null;
  unlockPassword = '';
  unlockError = '';
  unlockBusy = false;

  readonly markets: { id: Market | ''; label: string }[] = [
    { id: '', label: 'Todos' },
    { id: 'btc', label: 'BTC' },
    { id: 'us30', label: 'US30' },
    { id: 'xauusd', label: 'XAUUSD' },
  ];

  readonly resultadoOptions: { value: HistoryResultado | ''; label: string }[] = [
    { value: '', label: '—' },
    { value: 'ganada', label: 'Ganada (win)' },
    { value: 'perdida', label: 'Perdida (loss)' },
    { value: 'no_tomada', label: 'No tomada' },
  ];

  /** Catálogo Dirección (SQLite history_tags). */
  catalogTags: HistoryTag[] = [];
  /** Catálogo Confluencias (SQLite history_confluencias). */
  catalogConfluencias: HistoryTag[] = [];
  /** Filtro por columna: Dirección (cualquiera de las elegidas) y Confluencias (todas las elegidas). */
  catalogFilter: Required<HistoryCatalogFilter> = { tagIds: [], tagNone: false, confluenciaIds: [], confluenciaNone: false };
  colFilterOpen: 'tags' | 'confluencias' | null = null;
  /** Fila cuyo picker de Dirección está abierto. */
  tagPickerOpenId: number | null = null;
  /** Fila cuyo picker de Confluencias está abierto. */
  confluencePickerOpenId: number | null = null;
  newTagDraft = '';
  /**
   * `reversalsEnabled` del perfil MT5 activo. `null` = desconocido (cargando o API caída):
   * no se bloquea nada y decide el servidor.
   */
  reversalsEnabled: boolean | null = null;
  /** Balance y % de riesgo de la cuenta (BD, Configuración) para el lote recomendado en móvil. */
  accountBalance: number | null = null;
  riskPct: number | null = null;
  readonly reversalsBlockedTip = 'Activa las reversiones en Configuración';
  /** Expuesto al template (evita literales duplicados / $any). */
  readonly defaultTagColor = DEFAULT_TAG_COLOR;

  ngOnInit(): void {
    this.loadTags();
    this.loadConfluencias();
    this.loadReversalsSetting();
    this.load();
    // Señal terminada (formulario de arriba) → recarga lista + envíos MT5 y baja a la tabla.
    this.finishedSub = this.jobs.finished$.subscribe((j) => {
      if (jobKind(j) !== 'signal') return;
      this.scrollToListAfterLoad = j.status === 'done';
      this.load(1);
    });
    // Capture: celdas vecinas / card-annotate hacen stopPropagation y el bubble
    // no llega a document; sin capture Confluencias (multi-select) queda abierta.
    const onDocClick = (ev: MouseEvent) => {
      const t = ev.target;
      if (t instanceof Element && !t.closest('.col-filter')) this.colFilterOpen = null;
      if (t instanceof Element && t.closest('.tag-picker')) return;
      this.tagPickerOpenId = null;
      this.confluencePickerOpenId = null;
    };
    document.addEventListener('click', onDocClick, true);
    this.removeDocClickClose = () =>
      document.removeEventListener('click', onDocClick, true);
    this.clockTimer = setInterval(() => (this.nowMs = Date.now()), 15_000);
    window.addEventListener('popstate', this.onDetailPopState);
  }

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.runItem) {
      this.cancelRun();
      return;
    }
    if (this.paramsItem) {
      this.closeParams();
      return;
    }
    if (this.exportConfirm) {
      this.cancelExport();
      return;
    }
    if (this.unlockOpen) {
      this.cancelUnlock();
      return;
    }
    if (this.drawerOpen) {
      this.closeDetail();
      return;
    }
    this.tagPickerOpenId = null;
    this.confluencePickerOpenId = null;
    this.colFilterOpen = null;
  }

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
    this.stopParamsRefresh();
    this.removeDocClickClose?.();
    this.finishedSub?.unsubscribe();
    window.removeEventListener('popstate', this.onDetailPopState);
    document.body.style.removeProperty('overflow');
  }

  @HostListener('document:paste', ['$event'])
  onDocumentPaste(ev: ClipboardEvent): void {
    if (!this.drawerOpen || !this.detail) return;
    const file = this.fileFromClipboard(ev);
    if (!file) return;
    ev.preventDefault();
    this.uploadResultFile(this.detail, file);
  }

  load(page = this.page): void {
    this.loading = true;
    this.error = '';
    this.page = page;
    this.metricsLoading = true;
    this.metrics = null;
    this.metricsItems = [];
    this.api
      .historyList({
        page: this.page,
        pageSize: this.pageSize,
        market: this.marketFilter || undefined,
        sortBy: this.sortBy,
        sortDir: this.sortDir,
        ...this.catalogFilter,
      })
      .subscribe({
        next: (res) => {
          this.items = res.items;
          this.calcMarkers = res.calcMarkers ?? [];
          this.lockTz = res.lockTz || undefined;
          this.nowMs = Date.now();
          this.total = res.total;
          this.totalPages = res.totalPages;
          this.page = res.page;
          this.rebuildDisplayRows();
          this.loading = false;
          this.loadMetricsDataset();
          this.loadMt5Sent();
          if (this.scrollToListAfterLoad) {
            this.scrollToListAfterLoad = false;
            setTimeout(() => this.scrollToList(), 0);
          }
        },
        error: (err: unknown) => {
          this.loading = false;
          this.metricsLoading = false;
          this.error = this.errMsg(err, 'No se pudo cargar el historial. ¿API en :3847?');
        },
      });
  }

  private scrollToList(): void {
    const el = document.getElementById('sec-historial');
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  private loadMt5Sent(): void {
    this.api.mt5Sent().subscribe({
      next: (r) => {
        this.mt5Sent = r.sent ?? {};
        this.mt5ProfileLabel = r.profile?.label ?? '';
        this.mt5Runnable = r.runnable ?? null;
        this.dailyLimit = r.dailyLimit ?? null;
        this.nowMs = Date.now();
      },
      error: (err: unknown) => console.warn('[historial] envíos MT5 opcionales:', err),
    });
  }

  /** Última señal con plan Entry/SL/TP coherente (LONG: SL<E<TP · SHORT: TP<E<SL); el veredicto solo se avisa. */
  canRunOperation(item: HistoryListItem): boolean {
    if (item.id !== this.mt5Runnable?.id) return false;
    const { plannedEntry: e, plannedSl: sl, plannedTp: tp } = item;
    if (item.status !== 'done' || e == null || sl == null || tp == null) return false;
    return (sl < e && e < tp) || (tp < e && e < sl);
  }

  /** Dentro de los 30 min desde que terminó la última señal. */
  runWindowOpen(): boolean {
    const r = this.mt5Runnable;
    return !!r && this.nowMs <= Date.parse(r.expiresAt);
  }

  /** Límite diario de operaciones alcanzado: Run no envía más órdenes hoy. */
  dailyLimitReached(): boolean {
    return !!this.dailyLimit?.reached;
  }

  dailyLimitText(): string {
    const d = this.dailyLimit;
    return d?.enabled ? `Operaciones hoy: ${d.count} / ${d.limit}` : '';
  }

  runTip(): string {
    const r = this.mt5Runnable;
    if (!r) return '';
    if (this.dailyLimitReached()) return `${this.dailyLimit!.message}. Vuelve mañana o sube el límite en Configuración.`;
    if (!this.runWindowOpen()) return `Pasaron más de ${r.windowMinutes} min desde la señal: ya no se puede ejecutar.`;
    const left = Math.max(1, Math.ceil((Date.parse(r.expiresAt) - this.nowMs) / 60_000));
    return `Envía a MT5 la entrada óptima con SL y TP · quedan ${left} min`;
  }

  /** Color de Run por veredicto: NO OPERAR (LONG/SHORT) rojo · ESPERAR amarillo · resto verde. */
  runTone(item: HistoryListItem): 'bad' | 'warn' | 'ok' {
    const v = (item.verdict ?? '').toUpperCase().replace(/[_\s]+/g, ' ');
    if (/NO OPERAR/.test(v)) return 'bad';
    if (/ESPERAR/.test(v)) return 'warn';
    return 'ok';
  }

  isEntrarVerdict(item: HistoryListItem): boolean {
    return /entrar/i.test(item.verdict ?? '');
  }

  sentInfo(item: HistoryListItem): Mt5SentEntry | null {
    return this.mt5Sent[item.id] ?? null;
  }

  // --- Modal «Parámetros» de la operación enviada ---

  paramsItem: HistoryListItem | null = null;
  paramsData: Mt5PositionParams | null = null;
  paramsLoading = false;
  paramsError = '';
  private paramsTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly PARAMS_REFRESH_MS = 15_000;

  /** «⚙ Parámetros» solo mientras alguna pata siga viva, sin resultado ganada/perdida y fila no bloqueada. */
  lotSuggestion(item: HistoryListItem): LotSuggestion | null {
    return recommendedLot({
      market: item.market,
      entry: item.plannedEntry,
      sl: item.plannedSl,
      balance: this.accountBalance,
      riskPct: this.riskPct,
    });
  }

  canShowParams(item: HistoryListItem, s: Mt5SentEntry | null | undefined): boolean {
    return canShowParams(item.resultado, s, this.isLocked(item));
  }

  openParams(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    this.paramsItem = item;
    this.paramsData = null;
    this.paramsError = '';
    this.loadParams();
    this.stopParamsRefresh();
    this.paramsTimer = setInterval(() => {
      if (this.paramsLive()) this.loadParams();
    }, HistorialComponent.PARAMS_REFRESH_MS);
  }

  closeParams(): void {
    this.paramsItem = null;
    this.paramsData = null;
    this.stopParamsRefresh();
  }

  loadParams(): void {
    const item = this.paramsItem;
    if (!item || this.paramsLoading) return;
    this.paramsLoading = true;
    this.api.mt5Position(item.id).subscribe({
      next: (p) => {
        this.paramsLoading = false;
        if (this.paramsItem?.id !== item.id) return;
        this.paramsData = p;
        this.paramsError = p.quoteError ? `Sin precio del broker: ${p.quoteError}` : '';
      },
      error: (err: unknown) => {
        this.paramsLoading = false;
        this.paramsError = this.runErrMsg(err, 'No se pudieron leer los parámetros (¿API o puente MT5 sin conexión?).');
      },
    });
  }

  /** Recalcular desde el modal: reajusta con MT5 y vuelve a leer los parámetros. */
  recalcFromParams(): void {
    if (this.paramsItem) this.recalcOperation(this.paramsItem);
  }

  /** Alguna pata sigue abierta o pendiente: el precio cambia y merece refresco automático. */
  paramsLive(): boolean {
    return !!this.paramsData?.legs.some((l) => l.state === 'open' || l.state === 'pending' || !l.state);
  }

  private stopParamsRefresh(): void {
    if (this.paramsTimer) clearInterval(this.paramsTimer);
    this.paramsTimer = null;
  }

  legStateLabel(leg: Mt5PositionLeg): string {
    if (leg.state === 'closed' && leg.closeReason) return `Cerrada por ${leg.closeReason.toUpperCase()}`;
    return this.sentStateLabel({ state: leg.state } as Mt5SentEntry) || 'Sin leer (pulsa Recalcular)';
  }

  signedMoney(v: number | null | undefined, currency = 'USD'): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(2)} ${currency}`;
  }

  signedPips(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v > 0 ? '+' : ''}${v} pips`;
  }

  /** Dinero y estado (TP/SL, esperando entrada, no entró…) bajo las capturas. */
  shotCaption(item: HistoryListItem): ShotCaption | null {
    return shotCaption(item.resultado, item.pnlUsd, this.sentInfo(item));
  }

  sentTip(s: Mt5SentEntry): string {
    const how = s.mode === 'market' ? 'mercado' : 'LIMIT';
    const head = `${s.side ?? ''} ${s.symbol ?? ''} · ${how}${this.ticketState(s)}`;
    const body = s.checkedAt
      ? [
          `Enviada: ${this.sentLevels(s.original ?? s)} (${this.absoluteTime(s.at)})`,
          `Ahora en MT5: ${this.sentLevels(s)} (revisada ${this.absoluteTime(s.checkedAt)})`,
          s.lastChanges?.length ? `Último reajuste: ${s.lastChanges.join(' · ')}` : 'Último reajuste: sin cambios',
        ]
      : [`Enviada: ${this.sentLevels(s)} (${this.absoluteTime(s.at)})`, 'Pulsa Recalcular para leer el estado actual en MT5.'];
    const d = s.duplicate;
    const dup = d ? [`Duplicada${this.ticketState(d)}: ${this.sentLevels(d)} (${this.absoluteTime(d.at)})`] : [];
    return [head, ...body, ...this.pnlLine('PnL', s), ...dup, ...(d ? this.pnlLine('PnL duplicada', d) : [])].join('\n');
  }

  private sentLevels(l: { price: number | null; sl: number | null; tp: number | null; volume: number | null }): string {
    return `${l.price ?? '—'} · SL ${l.sl ?? '—'} · TP ${l.tp ?? '—'} · ${l.volume ?? '—'} lotes`;
  }

  private ticketState(s: Mt5SentEntry): string {
    const state = this.sentStateLabel(s);
    return `${s.order ? ' · ticket ' + s.order : ''}${state ? ' · ' + state : ''}`;
  }

  private pnlLine(label: string, s: Mt5SentEntry): string[] {
    if (s.profit == null) return [];
    return [`${label}: ${s.profit} USD${s.closeReason ? ' · cierre por ' + s.closeReason.toUpperCase() : ''}`];
  }

  /**
   * Duplicar una vez mientras la original siga viva (pendiente/abierta o sin leer aún) o haya expirado;
   * si el duplicado expiró, se puede volver a duplicar.
   */
  canDuplicate(s: Mt5SentEntry): boolean {
    const originalOk = !s.state || s.state === 'pending' || s.state === 'open' || s.state === 'expired';
    return !!s.order && originalOk && (!s.duplicate || s.duplicate.state === 'expired');
  }

  duplicateTip(s: Mt5SentEntry): string {
    if (s.state === 'expired' || s.duplicate?.state === 'expired') {
      return 'La orden expiró: vuelve a colocar la LIMIT con el mismo lote, SL y TP';
    }
    return 'Abre una segunda operación en MT5 con el mismo lote, SL y TP (solo una vez)';
  }

  duplicateOperation(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    const s = this.sentInfo(item);
    if (!s || !this.canDuplicate(s) || this.mt5DuplicateBusy.has(item.id) || this.rejectIfLocked(item)) return;
    const how = s.state === 'open' ? 'a mercado' : `como LIMIT en ${s.price ?? '—'}`;
    const what = s.state === 'expired' || s.duplicate?.state === 'expired' ? 'La orden expiró. ¿Volver a colocar' : '¿Abrir';
    if (!confirm(`${what} una segunda operación ${s.side ?? ''} ${s.symbol ?? ''} ${how} con ${s.volume ?? '—'} lotes y el mismo SL/TP?`)) return;
    this.mt5DuplicateBusy.add(item.id);
    this.api.mt5Duplicate(item.id).subscribe({
      next: (r) => {
        this.mt5DuplicateBusy.delete(item.id);
        this.showRunToast(`#${item.id} · ${r.message}`);
        this.loadMt5Sent();
      },
      error: (err: unknown) => {
        this.mt5DuplicateBusy.delete(item.id);
        this.showRunToast(`#${item.id} · ${this.runErrMsg(err, 'MT5 no aceptó la operación duplicada.')}`, true);
        this.loadMt5Sent();
      },
    });
  }

  openRun(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (this.sentInfo(item) || !this.canRunOperation(item) || !this.runWindowOpen() || this.dailyLimitReached()) return;
    this.runItem = item;
    this.runPreview = null;
    this.runError = '';
    this.runLoading = true;
    this.api.mt5Push({ historyId: item.id, anyVerdict: true, dryRun: true }).subscribe({
      next: (r) => {
        this.runLoading = false;
        this.mt5ProfileLabel = r.profile?.label ?? this.mt5ProfileLabel;
        if (r.status === 'sent' && r.result) this.runPreview = r.result;
        else this.runError = r.message;
      },
      error: (err: unknown) => {
        this.runLoading = false;
        this.runError = this.runErrMsg(err, 'No se pudo preparar la orden MT5.');
        this.loadMt5Sent();
      },
    });
  }

  confirmRun(): void {
    const item = this.runItem;
    if (!item || !this.runPreview || this.runSending) return;
    this.nowMs = Date.now();
    if (!this.runWindowOpen()) {
      this.runError = this.runTip();
      return;
    }
    this.runSending = true;
    this.runError = '';
    this.api.mt5Push({ historyId: item.id, anyVerdict: true }).subscribe({
      next: (r) => {
        this.runSending = false;
        this.runItem = null;
        this.showRunToast(`Enviada a MT5: ${r.message}`);
        this.loadMt5Sent();
      },
      error: (err: unknown) => {
        this.runSending = false;
        this.runError = this.runErrMsg(err, 'MT5 no aceptó la orden.');
        this.loadMt5Sent();
      },
    });
  }

  cancelRun(): void {
    if (this.runSending) return;
    this.runItem = null;
  }

  /** Lee la orden en MT5 y reajusta Entrada/SL/TP (y Resultado/$PnL si cerró) en el historial. */
  recalcOperation(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (this.mt5RecalcBusy.has(item.id) || this.rejectIfLocked(item)) return;
    this.mt5RecalcBusy.add(item.id);
    this.api.mt5Recalc(item.id).subscribe({
      next: (r) => {
        this.mt5RecalcBusy.delete(item.id);
        if (r.chart?.updated && r.chart.chartUrl) this.detailChartUrl.set(item.market, r.chart.chartUrl);
        const chartMsg = r.chart?.updated ? ' · captura detalle actualizada' : '';
        let captureMsg = '';
        if (r.capture?.ok) {
          this.imageBust.set(item.id, Date.now());
          captureMsg = ` · captura automática guardada${r.capture.warning ? ' (' + r.capture.warning + ')' : ''}`;
        } else if (r.capture) {
          captureMsg = ` · auto captura falló: ${r.capture.error ?? 'error desconocido'}`;
        }
        this.showRunToast(`#${item.id} · ${r.message}${chartMsg}${captureMsg}`, r.capture?.ok === false);
        this.load();
        if (this.paramsItem?.id === item.id) this.loadParams();
        if (this.drawerOpen && this.detail?.id === item.id) {
          this.api.historyGet(item.id).subscribe({ next: (d) => (this.detail = d) });
        }
      },
      error: (err: unknown) => {
        this.mt5RecalcBusy.delete(item.id);
        this.showRunToast(`#${item.id} · ${this.runErrMsg(err, 'No se pudo recalcular con MT5.')}`, true);
      },
    });
  }

  sentStateLabel(s: Mt5SentEntry): string {
    const labels: Record<string, string> = {
      pending: 'Pendiente',
      open: 'Abierta',
      closed: 'Cerrada',
      canceled: 'Cancelada',
      expired: 'Expirada',
    };
    return s.state ? labels[s.state] ?? s.state : '';
  }

  private showRunToast(text: string, isError = false): void {
    this.runToast = text;
    this.runToastErr = isError;
    setTimeout(() => {
      if (this.runToast === text) this.runToast = '';
    }, 8000);
  }

  private runErrMsg(err: unknown, fallback: string): string {
    const body = (err as { error?: Partial<Mt5PushOutcome> & { error?: string } } | null)?.error;
    return body?.message || body?.error || fallback;
  }

  /** Carga todas las páginas del filtro para métricas (máx. pageSize 100). */
  private loadMetricsDataset(): void {
    this.metricsLoading = true;
    const market = this.marketFilter || undefined;
    const acc: HistoryListItem[] = [];
    const fetchPage = (page: number) => {
      this.api.historyList({ page, pageSize: 100, market, ...this.catalogFilter }).subscribe({
        next: (res) => {
          acc.push(...res.items);
          if (res.page < res.totalPages) {
            fetchPage(res.page + 1);
          } else {
            this.metricsItems = acc;
            this.recomputeMetrics();
            this.metricsLoading = false;
          }
        },
        error: (err: unknown) => {
          this.metricsLoading = false;
          console.warn('[historial] métricas opcionales:', err);
        },
      });
    };
    fetchPage(1);
  }

  private recomputeMetrics(): void {
    this.metrics = computeHistoryMetrics(this.metricsItems);
  }

  fmtMetric(
    value: number | null | undefined,
    opts?: { suffix?: string; digits?: number }
  ): string {
    return formatMetric(value, opts);
  }

  /** Anillo SVG para tasa de acierto (0–100). */
  winrateRing(): { dash: string; tone: string } {
    const pct = this.metrics?.winratePct;
    if (pct == null) return { dash: '0 100', tone: 'muted' };
    const c = Math.max(0, Math.min(100, pct));
    let tone = 'bad';
    if (c >= 55) tone = 'ok';
    else if (c >= 40) tone = 'warn';
    return { dash: `${c} ${100 - c}`, tone };
  }

  /** Puntos de sparkline de equity (viewBox 0 0 100 36). */
  equitySparkPoints(): string {
    const curve = this.metrics?.equityCurve?.length
      ? this.metrics.equityCurve
      : this.metrics?.equityCurveR;
    if (!curve?.length) return '';
    const min = Math.min(0, ...curve);
    const max = Math.max(0, ...curve);
    const span = max - min || 1;
    return curve
      .map((v, i) => {
        const x = curve.length === 1 ? 50 : (i / (curve.length - 1)) * 100;
        const y = 34 - ((v - min) / span) * 32;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  /** Ancho de barra 0–100 para métricas positivas acotadas. */
  barPct(value: number | null | undefined, cap: number): number {
    if (value == null || !Number.isFinite(value) || cap <= 0) return 0;
    return Math.max(0, Math.min(100, (value / cap) * 100));
  }

  expectancyBarPct(): number {
    const v = this.metrics?.expectancy ?? this.metrics?.expectancyR;
    if (v == null) return 0;
    const cap = this.metrics?.pnlUnit === 'usd' ? 150 : 1.5;
    return this.barPct(Math.abs(v), cap);
  }

  streakDots(n: number | null | undefined): number[] {
    if (n == null || n < 1) return [];
    return Array.from({ length: Math.min(n, 12) }, (_, i) => i);
  }

  private loadTags(): void {
    this.api.historyTagsList().subscribe({
      next: (res) => {
        this.catalogTags = res.tags ?? [];
      },
      error: (err: unknown) => {
        console.warn('[historial] catálogo Dirección opcional:', err);
      },
    });
  }

  private loadConfluencias(): void {
    this.api.historyConfluenciasList().subscribe({
      next: (res) => {
        this.catalogConfluencias = res.confluencias ?? [];
      },
      error: (err: unknown) => {
        console.warn('[historial] catálogo Confluencias opcional:', err);
      },
    });
  }

  private loadReversalsSetting(): void {
    this.api.mt5Settings().subscribe({
      next: (s) => {
        const p = s.profiles?.[s.active];
        this.reversalsEnabled = !!p?.reversalsEnabled;
        this.riskPct ??= p?.riskPct ?? null;
      },
      error: () => {
        this.reversalsEnabled = null;
      },
    });
    this.loadAccountSettings();
  }

  /** Balance y % de riesgo guardados en la BD (Configuración) para el lote recomendado. */
  private loadAccountSettings(): void {
    this.api.accountSettings().subscribe({
      next: (a) => {
        this.accountBalance = a.balance;
        if (a.riskPct != null) this.riskPct = a.riskPct;
      },
      error: () => {
        this.accountBalance = null;
      },
    });
  }

  /** Con reversiones desactivadas no se añaden Reversion / Macro tendencia (quitar sí se permite). */
  isConfluenceBlocked(item: HistoryListItem, tag: HistoryTag): boolean {
    return (
      this.reversalsEnabled === false &&
      !!tag.requiresReversals &&
      !this.isConfluenceSelected(item, tag.id)
    );
  }

  itemTags(item: HistoryListItem): HistoryTag[] {
    const tags = item.tags ?? [];
    return tags.length ? [tags[0]] : [];
  }

  itemConfluencias(item: HistoryListItem): HistoryTag[] {
    return item.confluencias ?? [];
  }

  isTagSelected(item: HistoryListItem, tagId: number): boolean {
    return (item.tags ?? [])[0]?.id === tagId;
  }

  isConfluenceSelected(item: HistoryListItem, id: number): boolean {
    return (item.confluencias ?? []).some((c) => c.id === id);
  }

  toggleTagPicker(item: HistoryListItem, ev: Event): void {
    ev.stopPropagation();
    this.confluencePickerOpenId = null;
    this.tagPickerOpenId = this.tagPickerOpenId === item.id ? null : item.id;
    this.newTagDraft = '';
  }

  toggleConfluencePicker(item: HistoryListItem, ev: Event): void {
    ev.stopPropagation();
    this.tagPickerOpenId = null;
    this.confluencePickerOpenId =
      this.confluencePickerOpenId === item.id ? null : item.id;
  }

  /** Dirección: una sola etiqueta por fila; elegir otra reemplaza; re-clic limpia. */
  toggleTag(item: HistoryListItem, tag: HistoryTag, ev: Event): void {
    ev.stopPropagation();
    const currentId = (item.tags ?? [])[0]?.id;
    const next = currentId === tag.id ? [] : [tag.id];
    this.tagPickerOpenId = null;
    this.newTagDraft = '';
    this.patchItem(item, { tagIds: next });
  }

  /** Confluencias: multi-select; el menú permanece abierto. */
  toggleConfluence(item: HistoryListItem, tag: HistoryTag, ev: Event): void {
    ev.stopPropagation();
    if (this.isConfluenceBlocked(item, tag)) return;
    const prev = item.confluencias ?? [];
    const current = prev.map((c) => c.id);
    const nextIds = current.includes(tag.id)
      ? current.filter((id) => id !== tag.id)
      : [...current, tag.id];
    // Optimistic: evita que clics rápidos pisen el set con estado stale.
    item.confluencias = this.catalogConfluencias.filter((c) =>
      nextIds.includes(c.id)
    );
    this.patchItem(item, { confluenceIds: nextIds }, undefined, (status) => {
      item.confluencias = prev;
      // 409: el perfil activo cambió (reversiones desactivadas) → refresca el bloqueo.
      if (status === 409) this.loadReversalsSetting();
    });
  }

  removeTag(item: HistoryListItem, _tag: HistoryTag, ev: Event): void {
    ev.stopPropagation();
    this.patchItem(item, { tagIds: [] });
  }

  removeConfluence(item: HistoryListItem, tag: HistoryTag, ev: Event): void {
    ev.stopPropagation();
    const next = (item.confluencias ?? [])
      .map((c) => c.id)
      .filter((id) => id !== tag.id);
    this.patchItem(item, { confluenceIds: next });
  }

  createAndAssignTag(item: HistoryListItem, ev: Event): void {
    ev.stopPropagation();
    const name = this.newTagDraft.trim();
    if (!name) return;
    this.api.historyTagCreate({ name, color: DEFAULT_TAG_COLOR }).subscribe({
      next: (res) => {
        const tag = res.tag;
        if (!this.catalogTags.some((t) => t.id === tag.id)) {
          this.catalogTags = [...this.catalogTags, tag].sort(
            (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id
          );
        }
        this.newTagDraft = '';
        this.tagPickerOpenId = null;
        this.patchItem(item, { tagIds: [tag.id] });
      },
      error: (err: unknown) => {
        this.error = this.errMsg(err, 'No se pudo crear la dirección');
      },
    });
  }

  private errMsg(err: unknown, fallback: string): string {
    if (!err || typeof err !== 'object') return fallback;
    const e = err as { error?: { error?: string }; message?: string };
    return e.error?.error || e.message || fallback;
  }

  setMarket(m: Market | ''): void {
    this.marketFilter = m;
    this.load(1);
  }

  toggleColFilter(col: 'tags' | 'confluencias', ev: Event): void {
    ev.stopPropagation();
    this.tagPickerOpenId = null;
    this.confluencePickerOpenId = null;
    this.colFilterOpen = this.colFilterOpen === col ? null : col;
  }

  colFilterCount(col: 'tags' | 'confluencias'): number {
    const f = this.catalogFilter;
    const [ids, none] = col === 'tags' ? [f.tagIds, f.tagNone] : [f.confluenciaIds, f.confluenciaNone];
    return ids.length + Number(none);
  }

  isColFilterOn(col: 'tags' | 'confluencias', id: number | 'none'): boolean {
    const f = this.catalogFilter;
    if (col === 'tags') return id === 'none' ? f.tagNone : f.tagIds.includes(id);
    return id === 'none' ? f.confluenciaNone : f.confluenciaIds.includes(id);
  }

  /** «Sin confluencias» excluye a las concretas (y viceversa): juntas no darían resultados. */
  toggleColFilterValue(col: 'tags' | 'confluencias', id: number | 'none'): void {
    const f = { ...this.catalogFilter };
    const flip = (ids: number[], v: number) => (ids.includes(v) ? ids.filter((x) => x !== v) : [...ids, v]);
    if (col === 'tags') {
      if (id === 'none') f.tagNone = !f.tagNone;
      else f.tagIds = flip(f.tagIds, id);
    } else if (id === 'none') {
      f.confluenciaNone = !f.confluenciaNone;
      if (f.confluenciaNone) f.confluenciaIds = [];
    } else {
      f.confluenciaIds = flip(f.confluenciaIds, id);
      if (f.confluenciaIds.length) f.confluenciaNone = false;
    }
    this.catalogFilter = f;
    this.load(1);
  }

  clearColFilter(col: 'tags' | 'confluencias'): void {
    this.catalogFilter =
      col === 'tags'
        ? { ...this.catalogFilter, tagIds: [], tagNone: false }
        : { ...this.catalogFilter, confluenciaIds: [], confluenciaNone: false };
    this.colFilterOpen = null;
    this.load(1);
  }

  relativeTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return 'hace unos segundos';
    const min = Math.round(sec / 60);
    if (min < 60) return `hace ${min} min`;
    const hrs = Math.round(min / 60);
    if (hrs < 48) return `hace ${hrs} h`;
    const days = Math.round(hrs / 24);
    return `hace ${days} d`;
  }

  absoluteTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  /** Texto de tasa de acierto para la lista (no NO_OPERAR/ESPERAR). */
  hitRate(item: HistoryListItem): string {
    const w = (item.winrate || '').trim();
    return w || '—';
  }

  /** Desglose avanzado: % + factores bias/PD/acuerdo. */
  hitRateAnalysis(item: HistoryListItem): HitRateAnalysis {
    return parseHitRateAnalysis(item.winrate);
  }

  hitRateTone(item: HistoryListItem): string {
    return hitRateTone(item.winrate);
  }

  /** Tooltip explicativo de la tasa (bias / PD / acuerdo). */
  hitRateTip(item: HistoryListItem): string {
    return hitRateTooltip(item.winrate);
  }

  /** Hint corto bajo Probabilidad (PD · bias). */
  probHint(item: HistoryListItem): string | null {
    return probabilityHint(item);
  }

  /** Tooltip explicativo de Probabilidad de éxito. */
  probTip(item: HistoryListItem): string {
    return probabilityTooltip(item);
  }

  /** Tooltip de un chip de factor. */
  factorTip(f: HitRateFactor): string {
    return `${f.label}\n${explainHitFactor(f)}`;
  }

  factorTone(delta: number | null): string {
    if (delta == null) return '';
    if (delta > 0) return 'up';
    if (delta < 0) return 'down';
    return '';
  }

  itemBias(item: HistoryListItem): string {
    return item.bias ?? resolveRunBias(item.flags, null) ?? 'auto';
  }

  biasClass(value: string | null | undefined): string {
    const t = biasTone(value) || 'neutral';
    return `bias-${t}`;
  }

  biasText(value: string | null | undefined): string {
    return biasLabel(value);
  }

  isNoTomada(item: HistoryListItem): boolean {
    return item.resultado === 'no_tomada';
  }

  /** Números de página con elipsis: 1 … 4 5 6 … 20 */
  pageNumbers(): Array<number | null> {
    const total = this.totalPages;
    const cur = this.page;
    const set = new Set<number>([1, total, cur - 1, cur, cur + 1]);
    const pages = [...set].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const out: Array<number | null> = [];
    for (const p of pages) {
      const prev = out.at(-1) ?? null;
      if (prev != null && p - prev > 1) out.push(null);
      out.push(p);
    }
    return out;
  }

  resultadoClass(value: string | null | undefined): string {
    if (value === 'ganada') return 'res-win';
    if (value === 'perdida') return 'res-lose';
    if (value === 'no_tomada') return 'res-skip';
    return 'res-empty';
  }

  pnlMoneyClass(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return 'pnl-empty';
    if (value > 0) return 'pnl-pos';
    if (value < 0) return 'pnl-neg';
    return 'pnl-zero';
  }

  pnlMoneyDisplay(item: HistoryListItem): string {
    return formatPnlMoneyInput(item.pnlUsd);
  }

  onPnlMoneyBlur(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLInputElement;
    const raw = (el.value || '').trim();
    const prev = item.pnlUsd ?? null;
    if (!raw) {
      if (prev == null) {
        el.value = '';
        return;
      }
      this.patchItem(item, { pnlUsd: null });
      return;
    }
    const cleaned = raw.replace(/\s/g, '').replace(/^\$/, '').replace(',', '.');
    const next = Number(cleaned);
    if (!Number.isFinite(next)) {
      el.value = this.pnlMoneyDisplay(item);
      this.error = 'PnL inválido: usa un número (ej. 125.5 o -40)';
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (prev != null && Math.abs(prev - rounded) < 0.001) {
      el.value = this.pnlMoneyDisplay(item);
      return;
    }
    this.patchItem(item, { pnlUsd: rounded });
  }

  isMt5PnlBusy(id: number): boolean {
    return this.mt5PnlBusyIds.has(id);
  }

  mt5PnlNote(id: number): AutoCaptureNote | null {
    return this.mt5PnlNotes.get(id) ?? null;
  }

  /** Tooltip «MT5 #ticket» si el $/PnL vino de MT5. */
  mt5PnlTitle(item: HistoryListItem): string | null {
    return item.pnlSource === 'mt5' && item.real?.ticket ? `MT5 #${item.real.ticket}` : null;
  }

  /**
   * Busca la operación en MT5: guarda su ejecución real y rellena $/PnL (un PnL manual distinto
   * solo se reemplaza tras confirmar). `done` se llama al terminar, haya o no coincidencia.
   */
  runMt5Pnl(itemId: number, resultado: HistoryResultado, done?: () => void, overwrite = false): void {
    if (this.mt5PnlBusyIds.has(itemId)) return;
    this.mt5PnlBusyIds.add(itemId);
    this.mt5PnlNotes.delete(itemId);
    this.api.historyMt5Pnl(itemId, resultado, overwrite).subscribe({
      next: (res) => {
        this.mt5PnlBusyIds.delete(itemId);
        this.applyItemPatch(itemId, res.item);
        const { pnl } = res;
        const value = formatPnlMoneyInput(pnl.value);
        if (res.needsConfirm) {
          const current = formatPnlMoneyInput(res.current);
          if (confirm(`¿Reemplazar el PnL ${current} por ${value} de MT5 (#${pnl.ticket})?`)) {
            this.runMt5Pnl(itemId, resultado, done, true);
            return;
          }
          this.mt5PnlNotes.set(itemId, { text: `MT5 #${pnl.ticket}: ${value} (no aplicado)`, tone: 'warn' });
          done?.();
          return;
        }
        const ok = res.applied ? `MT5 #${pnl.ticket}: ${value}` : `MT5 #${pnl.ticket}: ya coincide`;
        this.mt5PnlNotes.set(itemId, pnl.warning ? { text: pnl.warning, tone: 'warn' } : { text: ok, tone: 'ok' });
        if (pnl.warning) this.showRunToast(`PnL #${itemId}: ${pnl.warning}`, true);
        done?.();
      },
      error: (err: unknown) => {
        this.mt5PnlBusyIds.delete(itemId);
        const msg = this.errMsg(err, 'No se pudo obtener el PnL de MT5');
        this.mt5PnlNotes.set(itemId, { text: msg, tone: 'warn' });
        this.showRunToast(`PnL #${itemId}: ${msg}`, true);
        done?.();
      },
    });
  }

  isSaving(id: number): boolean {
    return this.savingIds.has(id);
  }

  isImageBusy(id: number): boolean {
    return this.imageBusyIds.has(id);
  }

  /**
   * Solo lectura (ver, abrir detalle y copiar siguen permitidos): candado manual o, sin
   * desbloqueo puntual, operación de un día anterior. Se recalcula con el reloj (nowMs),
   * así al pasar la medianoche las filas de ayer se bloquean sin recargar.
   */
  isLocked(item: HistoryListItem | null | undefined): boolean {
    return !!item && isEffectivelyLocked(item, this.nowMs, this.lockTz);
  }

  /** Bloqueada solo por fecha (no por candado manual). */
  isDateLocked(item: HistoryListItem): boolean {
    return !item.locked && isAutoLocked(item, this.nowMs, this.lockTz);
  }

  isEditBlocked(item: HistoryListItem): boolean {
    return this.isSaving(item.id) || this.isLocked(item);
  }

  isImageBlocked(item: HistoryListItem): boolean {
    return this.isImageBusy(item.id) || this.isLocked(item);
  }

  isLockBusy(id: number): boolean {
    return this.lockBusyIds.has(id);
  }

  lockTip(item: HistoryListItem): string {
    if (!this.isLocked(item)) return 'Bloquear fila';
    return this.isDateLocked(item)
      ? 'Bloqueada: operación de un día anterior — clic para desbloquear'
      : 'Fila bloqueada — clic para desbloquear';
  }

  /** Defensa en la UI (el API también responde 423): true si la fila está bloqueada. */
  private rejectIfLocked(item: HistoryListItem): boolean {
    if (!this.isLocked(item)) return false;
    this.error = 'La fila está bloqueada';
    return true;
  }

  /** Bloquear no pide confirmación; desbloquear sí (evita desbloqueos accidentales). */
  toggleLock(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (this.lockBusyIds.has(item.id)) return;
    const next = !this.isLocked(item);
    const question = isPastDay(item.createdAt, this.nowMs, this.lockTz)
      ? 'Esta operación es de un día anterior. ¿Desbloquearla para editar?'
      : '¿Desbloquear esta fila?';
    if (!next && !confirm(question)) return;
    this.lockBusyIds.add(item.id);
    this.tagPickerOpenId = null;
    this.confluencePickerOpenId = null;
    this.api.historySetLocked(item.id, next).subscribe({
      next: (res) => {
        this.lockBusyIds.delete(item.id);
        this.applyItemPatch(item.id, res.item);
      },
      error: (err: unknown) => {
        this.lockBusyIds.delete(item.id);
        this.error = this.errMsg(err, 'No se pudo cambiar el candado de la fila');
      },
    });
  }

  resultImageUrl(item: HistoryListItem | HistoryDetail): string | null {
    if (!item.hasResultImage) return null;
    const bust = this.imageBust.get(item.id) ?? item.id;
    return this.api.historyResultImageUrl(item.id, bust);
  }

  /** Thumbnail del chart anotado del detalle (no la captura de resultado). */
  detailImageUrl(item: HistoryListItem | HistoryDetail): string | null {
    if (!item.chartPath) return null;
    return (
      this.detailChartUrl.get(item.market) ??
      `/api/signals/chart?market=${encodeURIComponent(item.market)}`
    );
  }

  onCommentBlur(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
    this.autoGrowTextarea(el);
    const next = (el.value || '').trim();
    const prev = (item.comment || '').trim();
    if (next === prev) return;
    this.patchItem(item, { comment: next || null });
  }

  onMotivoBlur(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLTextAreaElement;
    this.autoGrowTextarea(el);
    const next = (el.value || '').trim();
    const prev = (item.motivoEntradaSalida || '').trim();
    if (next === prev) return;
    this.patchItem(item, { motivoEntradaSalida: next || null });
  }

  /** Auto-altura de textareas (comentarios / motivo) al escribir o al cargar. */
  autoGrowTextarea(el: HTMLTextAreaElement | HTMLInputElement | null | undefined): void {
    if (el?.tagName !== 'TEXTAREA') return;
    const ta = el as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 44)}px`;
  }

  onAnnotateTextareaInput(ev: Event): void {
    this.autoGrowTextarea(ev.target as HTMLTextAreaElement);
  }

  /** Enter en inputs de anotación → blur (sin $any en plantilla). */
  blurEventTarget(ev: Event): void {
    const t = ev.target;
    if (t instanceof HTMLElement) t.blur();
  }

  onNewTagDraftInput(ev: Event): void {
    const t = ev.target;
    this.newTagDraft = t instanceof HTMLInputElement ? t.value : '';
  }

  onResultadoChange(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    const raw = el.value;
    const next: HistoryResultado | null =
      raw === 'ganada' || raw === 'perdida' || raw === 'no_tomada' ? raw : null;
    if ((item.resultado || null) === next) return;
    const closed = next === 'ganada' || next === 'perdida' ? next : null;
    const auto = this.autoCapture ? closed : null;
    let onSaved: (() => void) | undefined;
    if (auto) {
      onSaved = () => this.runMt5Pnl(item.id, auto, () => this.runAutoCapture(item, auto));
    } else if (closed && !item.hasResultImage) {
      onSaved = () => this.showRunToast(`#${item.id}: Auto captura desactivada · actívala arriba o usa Adjuntar`);
    }
    this.patchItem(item, { resultado: next }, onSaved);
  }

  isAutoCaptureBusy(id: number): boolean {
    return this.autoCaptureBusyIds.has(id);
  }

  autoCaptureNote(id: number): AutoCaptureNote | null {
    return this.autoCaptureNotes.get(id) ?? null;
  }

  /** Genera la captura del resultado con velas reales; nunca cambia el Resultado elegido. */
  runAutoCapture(item: HistoryListItem, resultado: HistoryResultado): void {
    if (this.autoCaptureBusyIds.has(item.id) || this.rejectIfLocked(item)) return;
    if (item.hasResultImage && !confirm('¿Reemplazar la captura actual por la auto captura?')) return;
    this.autoCaptureBusyIds.add(item.id);
    this.autoCaptureNotes.delete(item.id);
    this.api.historyAutoCapture(item.id, resultado).subscribe({
      next: (res) => {
        this.autoCaptureBusyIds.delete(item.id);
        this.imageBust.set(item.id, Date.now());
        this.applyItemPatch(item.id, res.item);
        const note: AutoCaptureNote = res.warning
          ? { text: res.warning, tone: 'warn' }
          : { text: res.outcome.message, tone: 'ok' };
        this.autoCaptureNotes.set(item.id, note);
        if (res.warning) this.showRunToast(`Auto captura #${item.id}: ${res.warning}`, res.mismatch);
        else if (this.runToast.startsWith(`Auto captura #${item.id}:`)) this.runToast = '';
      },
      error: (err: unknown) => {
        this.autoCaptureBusyIds.delete(item.id);
        const msg = this.errMsg(err, 'No se pudo generar la auto captura');
        const text = /Adjuntar/.test(msg) ? msg : `${msg} · usa Adjuntar`;
        this.autoCaptureNotes.set(item.id, { text, tone: 'err' });
        this.showRunToast(`Auto captura #${item.id}: ${msg}`, true);
      },
    });
  }

  private patchItem(
    item: HistoryListItem,
    body: {
      comment?: string | null;
      motivoEntradaSalida?: string | null;
      resultado?: HistoryResultado | null;
      pnlUsd?: number | null;
      tagIds?: number[];
      confluenceIds?: number[];
    },
    onSaved?: () => void,
    onError?: (status: number) => void
  ): void {
    if (this.rejectIfLocked(item)) return;
    this.savingIds.add(item.id);
    this.saveHint = '';
    this.api.historyPatch(item.id, body).subscribe({
      next: (res) => {
        this.savingIds.delete(item.id);
        this.applyItemPatch(item.id, res.item);
        this.saveHint = 'Guardado';
        setTimeout(() => {
          if (this.saveHint === 'Guardado') this.saveHint = '';
        }, 1500);
        onSaved?.();
      },
      error: (err: unknown) => {
        this.savingIds.delete(item.id);
        this.error = this.errMsg(
          err,
          'No se pudo guardar comentario/motivo/resultado/PnL/dirección/confluencias'
        );
        onError?.(err instanceof HttpErrorResponse ? err.status : 0);
      },
    });
  }

  private applyItemPatch(id: number, updated: HistoryListItem): void {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx >= 0) {
      this.items[idx] = {
        ...this.items[idx],
        comment: updated.comment ?? null,
        motivoEntradaSalida: updated.motivoEntradaSalida ?? null,
        resultado: updated.resultado ?? null,
        pnlUsd: updated.pnlUsd ?? null,
        pnlSource: updated.pnlSource ?? null,
        real: updated.real ?? null,
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
        tags: updated.tags ?? [],
        confluencias: updated.confluencias ?? [],
        ...lockFields(updated),
      };
      this.rebuildDisplayRows();
    }
    const mIdx = this.metricsItems.findIndex((i) => i.id === id);
    if (mIdx >= 0) {
      this.metricsItems[mIdx] = {
        ...this.metricsItems[mIdx],
        comment: updated.comment ?? null,
        motivoEntradaSalida: updated.motivoEntradaSalida ?? null,
        resultado: updated.resultado ?? null,
        pnlUsd: updated.pnlUsd ?? null,
        pnlSource: updated.pnlSource ?? null,
        real: updated.real ?? null,
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
        plannedRr: updated.plannedRr ?? this.metricsItems[mIdx].plannedRr,
        tags: updated.tags ?? this.metricsItems[mIdx].tags ?? [],
        confluencias:
          updated.confluencias ?? this.metricsItems[mIdx].confluencias ?? [],
        ...lockFields(updated),
      };
      this.recomputeMetrics();
    }
    if (this.detail?.id === id) {
      this.detail = {
        ...this.detail,
        comment: updated.comment ?? null,
        motivoEntradaSalida: updated.motivoEntradaSalida ?? null,
        resultado: updated.resultado ?? null,
        pnlUsd: updated.pnlUsd ?? null,
        pnlSource: updated.pnlSource ?? null,
        real: updated.real ?? null,
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
        tags: updated.tags ?? [],
        confluencias: updated.confluencias ?? [],
        ...lockFields(updated),
      };
    }
  }

  onDropZoneDragOver(ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dropActive = true;
  }

  onDropZoneDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.dropActive = false;
  }

  onDropZoneDrop(item: HistoryListItem, ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dropActive = false;
    const file = ev.dataTransfer?.files?.[0];
    if (file) this.uploadResultFile(item, file);
  }

  onFilePicked(item: HistoryListItem, ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.uploadResultFile(item, file);
  }

  private fileFromClipboard(ev: ClipboardEvent): File | null {
    const items = ev.clipboardData?.items;
    if (!items) return null;
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && IMAGE_TYPES.has(it.type)) {
        return it.getAsFile();
      }
    }
    return null;
  }

  private uploadResultFile(item: HistoryListItem, file: File): void {
    if (this.rejectIfLocked(item)) return;
    if (!IMAGE_TYPES.has(file.type)) {
      this.error = 'Formato no soportado. Usa PNG, JPG, WebP o GIF.';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.error = 'Imagen demasiado grande (máx. 5 MB).';
      return;
    }
    this.error = '';
    this.imageBusyIds.add(item.id);
    this.saveHint = 'Subiendo captura…';
    const reader = new FileReader();
    reader.onload = () => {
      const raw = reader.result;
      const dataUrl = typeof raw === 'string' ? raw : '';
      this.api.historyUploadResultImage(item.id, dataUrl, file.type).subscribe({
        next: (res) => {
          this.imageBusyIds.delete(item.id);
          this.imageBust.set(item.id, Date.now());
          this.applyItemPatch(item.id, res.item);
          this.saveHint = 'Captura guardada';
          setTimeout(() => {
            if (this.saveHint === 'Captura guardada') this.saveHint = '';
          }, 1800);
        },
        error: (err: unknown) => {
          this.imageBusyIds.delete(item.id);
          this.saveHint = '';
          this.error = this.errMsg(err, 'No se pudo subir la captura');
        },
      });
    };
    reader.onerror = () => {
      this.imageBusyIds.delete(item.id);
      this.saveHint = '';
      this.error = 'No se pudo leer el archivo';
    };
    reader.readAsDataURL(file);
  }

  removeResultImage(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (!item.hasResultImage || this.rejectIfLocked(item)) return;
    if (!confirm('¿Quitar la captura del resultado?')) return;
    this.imageBusyIds.add(item.id);
    this.api.historyDeleteResultImage(item.id).subscribe({
      next: (res) => {
        this.imageBusyIds.delete(item.id);
        this.imageBust.delete(item.id);
        this.applyItemPatch(item.id, res.item);
        this.saveHint = 'Captura eliminada';
        setTimeout(() => {
          if (this.saveHint === 'Captura eliminada') this.saveHint = '';
        }, 1500);
      },
      error: (err: unknown) => {
        this.imageBusyIds.delete(item.id);
        this.error = this.errMsg(err, 'No se pudo borrar la captura');
      },
    });
  }

  openLightbox(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    this.imageViewer.open(this.resultImageUrl(item), 'Captura del resultado');
  }

  openDetailImageLightbox(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    this.imageViewer.open(this.detailImageUrl(item), 'Captura detalle');
  }

  openDetail(item: HistoryListItem): void {
    this.drawerOpen = true;
    this.detailExpanded = true;
    if (this.isMobileOrApk()) {
      document.body.style.overflow = 'hidden';
      if (!this.detailHistoryPushed) {
        try {
          const state = history.state && typeof history.state === 'object' ? history.state : {};
          history.pushState({ ...state, [DETAIL_HISTORY_FLAG]: true }, '');
          this.detailHistoryPushed = true;
        } catch {
          this.detailHistoryPushed = false;
        }
      }
    }
    this.detail = null;
    this.detailLoading = true;
    this.detailMode = 'rapida';
    this.dropActive = false;
    this.api.historyGet(item.id).subscribe({
      next: (d) => {
        this.detail = d;
        this.detailLoading = false;
        setTimeout(() => this.growDetailTextareas(), 0);
      },
      error: (err: unknown) => {
        this.detailLoading = false;
        this.error = this.errMsg(err, 'No se pudo abrir el detalle');
        this.closeDetail();
      },
    });
  }

  private growDetailTextareas(): void {
    document
      .querySelectorAll<HTMLTextAreaElement>('.detail-annotate textarea.hist-textarea')
      .forEach((el) => this.autoGrowTextarea(el));
  }

  toggleDetailExpand(): void {
    this.detailExpanded = !this.detailExpanded;
  }

  closeDetail(): void {
    this.drawerOpen = false;
    this.detail = null;
    this.detailExpanded = true;
    this.dropActive = false;
    document.body.style.removeProperty('overflow');
    if (this.detailHistoryPushed) {
      this.detailHistoryPushed = false;
      history.back();
    }
  }

  deleteOne(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (this.rejectIfLocked(item)) return;
    this.unlockKind = 'delete';
    this.unlockItem = item;
    this.unlockPassword = '';
    this.unlockError = '';
    this.unlockOpen = true;
  }

  clearAll(): void {
    this.unlockKind = 'clear';
    this.unlockItem = null;
    this.unlockPassword = '';
    this.unlockError = '';
    this.unlockOpen = true;
  }

  cancelUnlock(): void {
    if (this.unlockBusy) return;
    this.unlockOpen = false;
    this.unlockKind = null;
    this.unlockItem = null;
    this.unlockPassword = '';
    this.unlockError = '';
  }

  confirmUnlock(): void {
    const pwd = (this.unlockPassword || '').trim();
    if (!pwd) {
      this.unlockError = 'Escribe la contraseña';
      return;
    }
    if (this.unlockKind === 'delete' && this.unlockItem) {
      this.unlockBusy = true;
      this.unlockError = '';
      const item = this.unlockItem;
      this.api.historyDelete(item.id, pwd).subscribe({
        next: () => {
          this.unlockBusy = false;
          this.cancelUnlock();
          if (this.detail?.id === item.id) this.closeDetail();
          this.load(this.page);
        },
        error: (err: unknown) => {
          this.unlockBusy = false;
          this.unlockError = this.errMsg(err, 'Contraseña incorrecta o error al borrar');
        },
      });
      return;
    }
    if (this.unlockKind === 'clear') {
      this.unlockBusy = true;
      this.unlockError = '';
      this.clearing = true;
      this.api.historyClear(pwd).subscribe({
        next: () => {
          this.unlockBusy = false;
          this.clearing = false;
          this.cancelUnlock();
          this.closeDetail();
          this.load(1);
        },
        error: (err: unknown) => {
          this.unlockBusy = false;
          this.clearing = false;
          this.unlockError = this.errMsg(err, 'Contraseña incorrecta o error al limpiar');
        },
      });
    }
  }

  unlockTitle(): string {
    if (this.unlockKind === 'clear') return 'Limpiar historial (protegido)';
    if (this.unlockKind === 'delete' && this.unlockItem) {
      return `Borrar #${this.unlockItem.id} (protegido)`;
    }
    return 'Desbloquear borrado';
  }

  unlockHint(): string {
    if (this.unlockKind === 'clear') {
      return 'Se borrará TODO el historial local. Introduce la contraseña de bloqueo.';
    }
    if (this.unlockItem) {
      return `Vas a borrar ${this.unlockItem.market.toUpperCase()} · ${this.unlockItem.tier}. Introduce la contraseña.`;
    }
    return 'Introduce la contraseña de bloqueo.';
  }

  onUnlockPasswordInput(ev: Event): void {
    const el = ev.target as HTMLInputElement;
    this.unlockPassword = el.value;
    this.unlockError = '';
  }

  chartUrlFor(d: HistoryDetail): string | null {
    return this.detailImageUrl(d);
  }

  private rebuildDisplayRows(): void {
    // Las barras de cambio de cálculo se ubican por fecha: solo tienen sentido en orden cronológico
    const markers = this.sortBy === 'createdAt' ? this.calcMarkers : [];
    this.displayRows = mergeCalcMarkersIntoRows(this.items, markers, {
      isLastPage: this.page >= this.totalPages,
    });
    this.pageTotals = summaryTotals(this.items);
  }

  /** Click en cabecera: misma columna alterna asc/desc; columna nueva empieza en desc. */
  toggleSort(key: HistorySortKey): void {
    if (this.sortBy === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortBy = key;
      this.sortDir = 'desc';
    }
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify({ by: this.sortBy, dir: this.sortDir }));
    } catch {
      /* storage no disponible: solo en memoria */
    }
    this.load(1);
  }

  sortIcon(key: HistorySortKey): string {
    if (this.sortBy !== key) return '↕';
    return this.sortDir === 'asc' ? '▲' : '▼';
  }

  ariaSort(key: HistorySortKey): 'ascending' | 'descending' | 'none' {
    if (this.sortBy !== key) return 'none';
    return this.sortDir === 'asc' ? 'ascending' : 'descending';
  }

  setCompactMode(on: boolean): void {
    this.compactMode = on;
    this.tagPickerOpenId = null;
    this.confluencePickerOpenId = null;
    try {
      localStorage.setItem(COMPACT_MODE_KEY, on ? '1' : '0');
    } catch {
      /* storage no disponible: solo en memoria */
    }
  }

  setAutoCapture(on: boolean): void {
    this.autoCapture = on;
    try {
      localStorage.setItem(AUTO_CAPTURE_KEY, on ? '1' : '0');
    } catch {
      /* storage no disponible: solo en memoria */
    }
  }

  onPageSizeChange(ev: Event): void {
    const n = Number((ev.target as HTMLSelectElement).value);
    if (!n || n === this.pageSize) return;
    this.pageSize = n;
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(n));
    } catch {
      /* storage no disponible: solo en memoria */
    }
    this.load(1);
  }

  summaryFor(item: HistoryListItem): SummaryRow {
    return summaryRow(item);
  }

  /** Exporta la página visible o todo el filtro, en el modo del interruptor Resumido. */
  canExport(): boolean {
    if (this.exportBusy || !this.compactMode) return false;
    if (this.exportScope === 'pagina') return !this.loading && this.items.length > 0;
    return !this.metricsLoading && !!this.metrics && this.metricsItems.length > 0;
  }

  setExportScope(scope: ExportScope): void {
    this.exportScope = scope;
    try {
      localStorage.setItem(EXPORT_SCOPE_KEY, this.exportScope);
    } catch {
      /* storage no disponible: solo en memoria */
    }
  }

  exportScopeLabel(): string {
    return this.exportScope === 'pagina'
      ? `Página ${this.page} de ${this.totalPages} · ${this.pageSize} por página`
      : 'Todas las páginas';
  }

  exportTooltip(): string {
    if (this.exportScope === 'todo' && this.metricsLoading) return 'Cargando todas las páginas del filtro…';
    return `${this.exportScopeLabel()} · ${this.exportCount()} señales · mercado ${this.exportMarketLabel()} + métricas y análisis`;
  }

  exportCount(): number {
    return this.exportScope === 'pagina' ? this.items.length : this.metricsItems.length;
  }

  exportMarketLabel(): string {
    return this.markets.find((m) => m.id === this.marketFilter)?.label ?? 'Todos';
  }

  exportFileNamePreview(format: ExportFormat): string {
    return exportFileName(
      'resumido',
      this.exportMarketLabel(),
      format === 'excel' ? 'xlsx' : 'pdf',
      new Date(),
      this.exportScope === 'pagina' ? `p${this.page}` : '',
    );
  }

  requestExport(format: ExportFormat): void {
    if (!this.canExport()) return;
    this.exportConfirm = format;
  }

  cancelExport(): void {
    this.exportConfirm = null;
  }

  confirmExport(): void {
    const format = this.exportConfirm;
    this.exportConfirm = null;
    if (format) void this.exportHistory(format);
  }

  async exportHistory(format: ExportFormat): Promise<void> {
    if (!this.canExport()) return;
    this.exportBusy = format;
    this.error = '';
    this.saveHint = format === 'excel' ? 'Generando Excel…' : 'Generando PDF…';
    try {
      const bundle = this.buildExportBundle();
      const writers = await import('./historial-export.writers');
      if (format === 'excel') await writers.exportHistoryExcel(bundle);
      else await writers.exportHistoryPdf(bundle);
      this.saveHint = format === 'excel' ? 'Excel descargado' : 'PDF descargado';
      setTimeout(() => {
        if (this.saveHint.endsWith('descargado')) this.saveHint = '';
      }, 2000);
    } catch (err: unknown) {
      console.error('[historial] exportación:', err);
      this.saveHint = '';
      this.error = this.errMsg(err, `No se pudo generar el ${format === 'excel' ? 'Excel' : 'PDF'}`);
    } finally {
      this.exportBusy = null;
    }
  }

  private buildExportBundle(): ExportBundle {
    const helpers: ExportRowHelpers = {
      tradeType: (item) => summaryTradeType(item),
      biasText: (item) => this.biasText(this.itemBias(item as HistoryListItem)),
      hitRate: (item) => {
        const ha = parseHitRateAnalysis(item.winrate);
        return [ha.pctLabel, ha.source].filter(Boolean).join(' · ') || '—';
      },
    };
    const pageScope = this.exportScope === 'pagina';
    const rows = pageScope ? this.items : this.metricsItems;
    return buildExportBundle(rows, {
      mode: 'resumido',
      marketLabel: this.exportMarketLabel(),
      metrics: pageScope ? computeHistoryMetrics(rows) : (this.metrics as HistoryMetrics),
      helpers,
      scopeLabel: this.exportScopeLabel(),
      fileTag: pageScope ? `p${this.page}` : '',
    });
  }

  trackByRow(_index: number, row: HistDisplayRow<HistoryListItem>): string {
    return row.key;
  }

  /** Alias para *ngIf="asItem(row) as item" en el template. */
  asItem(row: HistDisplayRow<HistoryListItem>): HistoryListItem | null {
    return row.kind === 'signal' ? row.item : null;
  }

  openCalcMarkerDialog(): void {
    this.calcMarkerOpen = true;
    this.calcMarkerTitle = '';
    this.calcMarkerComment = '';
    this.calcMarkerError = '';
  }

  closeCalcMarkerDialog(): void {
    if (this.calcMarkerBusy) return;
    this.calcMarkerOpen = false;
    this.calcMarkerError = '';
  }

  submitCalcMarker(): void {
    const title = this.calcMarkerTitle.trim();
    if (!title) {
      this.calcMarkerError = 'Escribe un título del cambio';
      return;
    }
    this.calcMarkerBusy = true;
    this.calcMarkerError = '';
    this.api
      .historyCalcMarkerCreate({
        title,
        comment: this.calcMarkerComment.trim() || null,
        market: this.marketFilter || null,
      })
      .subscribe({
        next: (res) => {
          this.calcMarkerBusy = false;
          this.calcMarkerOpen = false;
          if (res.marker) {
            this.calcMarkers = [res.marker, ...this.calcMarkers];
            this.rebuildDisplayRows();
          }
          this.saveHint = 'Barra de cálculo añadida — señales nuevas quedarán encima';
        },
        error: (err: unknown) => {
          this.calcMarkerBusy = false;
          this.calcMarkerError = this.errMsg(err, 'No se pudo crear la barra');
        },
      });
  }

  startEditMarker(marker: CalcChangeMarker, ev?: Event): void {
    ev?.stopPropagation();
    this.editingMarkerId = marker.id;
    this.editingMarkerComment = marker.comment || '';
  }

  cancelEditMarker(): void {
    this.editingMarkerId = null;
    this.editingMarkerComment = '';
  }

  saveMarkerComment(marker: CalcChangeMarker): void {
    const comment = this.editingMarkerComment.trim() || null;
    this.api.historyCalcMarkerPatch(marker.id, { comment }).subscribe({
      next: (res) => {
        const updated = res.marker;
        this.calcMarkers = this.calcMarkers.map((m) =>
          m.id === updated.id ? updated : m
        );
        this.rebuildDisplayRows();
        this.editingMarkerId = null;
        this.saveHint = 'Comentario de barra guardado';
      },
      error: (err: unknown) => {
        this.error = this.errMsg(err, 'No se pudo guardar el comentario');
      },
    });
  }

  deleteCalcMarker(marker: CalcChangeMarker, ev?: Event): void {
    ev?.stopPropagation();
    if (!confirm(`¿Borrar la barra «${marker.title}»?`)) return;
    this.api.historyCalcMarkerDelete(marker.id).subscribe({
      next: () => {
        this.calcMarkers = this.calcMarkers.filter((m) => m.id !== marker.id);
        this.rebuildDisplayRows();
        this.saveHint = 'Barra de cálculo borrada';
      },
      error: (err: unknown) => {
        this.error = this.errMsg(err, 'No se pudo borrar la barra');
      },
    });
  }

  /** Aplica v3 (bias + PD + acuerdo) a la columna Probabilidad de todo el historial. */
  recalcAllProbabilidad(): void {
    if (this.recalcBusy) return;
    const ok = confirm(
      '¿Recalcular la columna Probabilidad de TODO el historial?\n\n' +
        'Aplica v3: bias H1/CLI + Premium/Discount + blend Acuerdo (62/38).\n' +
        'También actualiza Tasa de acierto cuando hay datos.\n' +
        'Es idempotente (no duplica el ajuste).\n' +
        'Las filas bloqueadas (candado o días anteriores) no se modifican.'
    );
    if (!ok) return;
    this.recalcBusy = true;
    this.error = '';
    this.api
      .historyRecalcProbabilidad({
        force: false,
        market: this.marketFilter || null,
      })
      .subscribe({
        next: (res) => {
          this.recalcBusy = false;
          this.saveHint =
            `Probabilidad actualizada: ${res.updated} filas` +
            (res.unchanged ? ` · ${res.unchanged} ya al día` : '') +
            (res.skipped ? ` · ${res.skipped} sin score` : '') +
            (res.skippedLocked ? ` · ${res.skippedLocked} bloqueadas (sin cambios)` : '');
          this.load(this.page);
        },
        error: (err: unknown) => {
          this.recalcBusy = false;
          this.error = this.errMsg(err, 'No se pudo recalcular la probabilidad');
        },
      });
  }

  trackById(_index: number, item: HistoryListItem): number {
    return item.id;
  }
}
