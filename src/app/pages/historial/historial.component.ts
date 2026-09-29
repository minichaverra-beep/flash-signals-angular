import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  CalcChangeMarker,
  HistoryDetail,
  HistoryListItem,
  HistoryResultado,
  HistoryTag,
  Market,
  SignalsApiService,
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

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Color por defecto de chips Dirección / Confluencias (coincide con seed SQLite). */
const DEFAULT_TAG_COLOR = '#4b5563';

@Component({
  selector: 'app-historial',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, SignalReportViewerComponent],
  templateUrl: './historial.component.html',
  styleUrl: './historial.component.scss',
})
export class HistorialComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
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
  pageTotals: SummaryTotals = summaryTotals([]);
  marketFilter: Market | '' = '';
  loading = false;
  error = '';
  clearing = false;
  /** id → guardando anotación */
  savingIds = new Set<number>();
  /** id → subiendo/borrando imagen */
  imageBusyIds = new Set<number>();
  /** cache-bust por id de imagen */
  imageBust = new Map<number, number>();
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
  lightboxUrl: string | null = null;

  /** Dataset completo del filtro actual (todas las páginas) para métricas. */
  metricsItems: HistoryListItem[] = [];
  metrics: HistoryMetrics | null = null;
  metricsLoading = false;

  /** Formato que se está generando (deshabilita ambos botones de exportar). */
  exportBusy: ExportFormat | null = null;
  exportScope: ExportScope = readExportScope();
  /** Formato pendiente de confirmar en el diálogo de exportación. */
  exportConfirm: ExportFormat | null = null;

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
  /** Fila cuyo picker de Dirección está abierto. */
  tagPickerOpenId: number | null = null;
  /** Fila cuyo picker de Confluencias está abierto. */
  confluencePickerOpenId: number | null = null;
  newTagDraft = '';
  newConfluenceDraft = '';
  /** Expuesto al template (evita literales duplicados / $any). */
  readonly defaultTagColor = DEFAULT_TAG_COLOR;

  ngOnInit(): void {
    this.loadTags();
    this.loadConfluencias();
    this.load();
    // Capture: celdas vecinas / card-annotate hacen stopPropagation y el bubble
    // no llega a document; sin capture Confluencias (multi-select) queda abierta.
    const onDocClick = (ev: MouseEvent) => {
      const t = ev.target;
      if (t instanceof Element && t.closest('.tag-picker')) return;
      this.tagPickerOpenId = null;
      this.confluencePickerOpenId = null;
    };
    document.addEventListener('click', onDocClick, true);
    this.removeDocClickClose = () =>
      document.removeEventListener('click', onDocClick, true);
  }

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.exportConfirm) {
      this.cancelExport();
      return;
    }
    if (this.unlockOpen) {
      this.cancelUnlock();
      return;
    }
    if (this.lightboxUrl) {
      this.closeLightbox();
      return;
    }
    if (this.drawerOpen) {
      this.closeDetail();
      return;
    }
    this.tagPickerOpenId = null;
    this.confluencePickerOpenId = null;
  }

  ngOnDestroy(): void {
    this.removeDocClickClose?.();
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
      })
      .subscribe({
        next: (res) => {
          this.items = res.items;
          this.calcMarkers = res.calcMarkers ?? [];
          this.total = res.total;
          this.totalPages = res.totalPages;
          this.page = res.page;
          this.rebuildDisplayRows();
          this.loading = false;
          this.loadMetricsDataset();
        },
        error: (err: unknown) => {
          this.loading = false;
          this.metricsLoading = false;
          this.error = this.errMsg(err, 'No se pudo cargar el historial. ¿API en :3847?');
        },
      });
  }

  /** Carga todas las páginas del filtro para métricas (máx. pageSize 100). */
  private loadMetricsDataset(): void {
    this.metricsLoading = true;
    const market = this.marketFilter || undefined;
    const acc: HistoryListItem[] = [];
    const fetchPage = (page: number) => {
      this.api.historyList({ page, pageSize: 100, market }).subscribe({
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
    this.newConfluenceDraft = '';
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
    const current = (item.confluencias ?? []).map((c) => c.id);
    const nextIds = current.includes(tag.id)
      ? current.filter((id) => id !== tag.id)
      : [...current, tag.id];
    // Optimistic: evita que clics rápidos pisen el set con estado stale.
    item.confluencias = this.catalogConfluencias.filter((c) =>
      nextIds.includes(c.id)
    );
    this.patchItem(item, { confluenceIds: nextIds });
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

  createAndAssignConfluence(item: HistoryListItem, ev: Event): void {
    ev.stopPropagation();
    const name = this.newConfluenceDraft.trim();
    if (!name) return;
    this.api.historyConfluenciaCreate({ name, color: DEFAULT_TAG_COLOR }).subscribe({
      next: (res) => {
        const tag = res.confluencia;
        if (!this.catalogConfluencias.some((t) => t.id === tag.id)) {
          this.catalogConfluencias = [...this.catalogConfluencias, tag].sort(
            (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id
          );
        }
        this.newConfluenceDraft = '';
        const current = (item.confluencias ?? []).map((c) => c.id);
        if (!current.includes(tag.id)) {
          this.patchItem(item, { confluenceIds: [...current, tag.id] });
        }
      },
      error: (err: unknown) => {
        this.error = this.errMsg(err, 'No se pudo crear la confluencia');
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

  isSaving(id: number): boolean {
    return this.savingIds.has(id);
  }

  isImageBusy(id: number): boolean {
    return this.imageBusyIds.has(id);
  }

  resultImageUrl(item: HistoryListItem | HistoryDetail): string | null {
    if (!item.hasResultImage) return null;
    const bust = this.imageBust.get(item.id) ?? item.id;
    return this.api.historyResultImageUrl(item.id, bust);
  }

  /** Thumbnail del chart anotado del detalle (no la captura de resultado). */
  detailImageUrl(item: HistoryListItem | HistoryDetail): string | null {
    if (!item.chartPath) return null;
    return `/api/signals/chart?market=${encodeURIComponent(item.market)}`;
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

  onNewConfluenceDraftInput(ev: Event): void {
    const t = ev.target;
    this.newConfluenceDraft = t instanceof HTMLInputElement ? t.value : '';
  }

  onResultadoChange(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    const raw = el.value;
    const next: HistoryResultado | null =
      raw === 'ganada' || raw === 'perdida' || raw === 'no_tomada' ? raw : null;
    if ((item.resultado || null) === next) return;
    this.patchItem(item, { resultado: next });
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
    }
  ): void {
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
      },
      error: (err: unknown) => {
        this.savingIds.delete(item.id);
        this.error = this.errMsg(
          err,
          'No se pudo guardar comentario/motivo/resultado/PnL/dirección/confluencias'
        );
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
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
        tags: updated.tags ?? [],
        confluencias: updated.confluencias ?? [],
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
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
        plannedRr: updated.plannedRr ?? this.metricsItems[mIdx].plannedRr,
        tags: updated.tags ?? this.metricsItems[mIdx].tags ?? [],
        confluencias:
          updated.confluencias ?? this.metricsItems[mIdx].confluencias ?? [],
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
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
        tags: updated.tags ?? [],
        confluencias: updated.confluencias ?? [],
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
    if (!item.hasResultImage) return;
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
    const url = this.resultImageUrl(item);
    if (url) this.lightboxUrl = url;
  }

  openDetailImageLightbox(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    const url = this.detailImageUrl(item);
    if (url) this.lightboxUrl = url;
  }

  closeLightbox(): void {
    this.lightboxUrl = null;
  }

  openDetail(item: HistoryListItem): void {
    this.drawerOpen = true;
    this.detailExpanded = true;
    this.detail = null;
    this.detailLoading = true;
    this.detailMode = 'trader';
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
        this.drawerOpen = false;
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
  }

  deleteOne(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
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
    this.displayRows = mergeCalcMarkersIntoRows(this.items, this.calcMarkers, {
      isLastPage: this.page >= this.totalPages,
    });
    this.pageTotals = summaryTotals(this.items);
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
        'Es idempotente (no duplica el ajuste).'
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
            (res.skipped ? ` · ${res.skipped} sin score` : '');
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
