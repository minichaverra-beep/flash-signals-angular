import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  HistoryDetail,
  HistoryListItem,
  HistoryResultado,
  Market,
  SignalsApiService,
} from '../../services/signals-api.service';
import {
  ReportViewMode,
  SignalReportViewerComponent,
} from '../../shared/signal-report-viewer.component';
import { verdictTone, biasTone, biasLabel, resolveRunBias } from '../../shared/signal-report.helpers';

@Component({
  selector: 'app-historial',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, SignalReportViewerComponent],
  templateUrl: './historial.component.html',
  styleUrl: './historial.component.scss',
})
export class HistorialComponent implements OnInit {
  private readonly api = inject(SignalsApiService);

  items: HistoryListItem[] = [];
  page = 1;
  pageSize = 20;
  total = 0;
  totalPages = 1;
  marketFilter: Market | '' = '';
  loading = false;
  error = '';
  clearing = false;
  /** id → guardando anotación */
  savingIds = new Set<number>();
  saveHint = '';

  detail: HistoryDetail | null = null;
  detailLoading = false;
  detailMode: ReportViewMode = 'rapida';
  drawerOpen = false;
  /** Panel detalle a pantalla amplia (vs drawer estrecho). */
  detailExpanded = true;

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
  ];

  ngOnInit(): void {
    this.load();
  }

  load(page = this.page): void {
    this.loading = true;
    this.error = '';
    this.page = page;
    this.api
      .historyList({
        page: this.page,
        pageSize: this.pageSize,
        market: this.marketFilter || undefined,
      })
      .subscribe({
        next: (res) => {
          this.items = res.items;
          this.total = res.total;
          this.totalPages = res.totalPages;
          this.page = res.page;
          this.loading = false;
        },
        error: (err: unknown) => {
          this.loading = false;
          this.error = this.errMsg(err, 'No se pudo cargar el historial. ¿API en :3847?');
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

  tone(verdict: string | null | undefined): string {
    return verdictTone(verdict);
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

  resultadoClass(value: string | null | undefined): string {
    if (value === 'ganada') return 'res-win';
    if (value === 'perdida') return 'res-lose';
    return 'res-empty';
  }

  isSaving(id: number): boolean {
    return this.savingIds.has(id);
  }

  onCommentBlur(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
    const next = (el.value || '').trim();
    const prev = (item.comment || '').trim();
    if (next === prev) return;
    this.patchItem(item, { comment: next || null });
  }

  onResultadoChange(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    const raw = el.value;
    const next: HistoryResultado | null =
      raw === 'ganada' || raw === 'perdida' ? raw : null;
    if ((item.resultado || null) === next) return;
    this.patchItem(item, { resultado: next });
  }

  private patchItem(
    item: HistoryListItem,
    body: { comment?: string | null; resultado?: HistoryResultado | null }
  ): void {
    this.savingIds.add(item.id);
    this.saveHint = '';
    this.api.historyPatch(item.id, body).subscribe({
      next: (res) => {
        this.savingIds.delete(item.id);
        const updated = res.item;
        const idx = this.items.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          this.items[idx] = {
            ...this.items[idx],
            comment: updated.comment ?? null,
            resultado: updated.resultado ?? null,
          };
        }
        if (this.detail?.id === item.id) {
          this.detail = {
            ...this.detail,
            comment: updated.comment ?? null,
            resultado: updated.resultado ?? null,
          };
        }
        this.saveHint = 'Guardado';
        setTimeout(() => {
          if (this.saveHint === 'Guardado') this.saveHint = '';
        }, 1500);
      },
      error: (err: unknown) => {
        this.savingIds.delete(item.id);
        this.error = this.errMsg(err, 'No se pudo guardar comentario/resultado');
      },
    });
  }

  openDetail(item: HistoryListItem): void {
    this.drawerOpen = true;
    this.detailExpanded = true;
    this.detail = null;
    this.detailLoading = true;
    this.detailMode = 'trader';
    this.api.historyGet(item.id).subscribe({
      next: (d) => {
        this.detail = d;
        this.detailLoading = false;
      },
      error: (err: unknown) => {
        this.detailLoading = false;
        this.error = this.errMsg(err, 'No se pudo abrir el detalle');
        this.drawerOpen = false;
      },
    });
  }

  toggleDetailExpand(): void {
    this.detailExpanded = !this.detailExpanded;
  }

  closeDetail(): void {
    this.drawerOpen = false;
    this.detail = null;
    this.detailExpanded = true;
  }

  deleteOne(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (!confirm(`¿Borrar la entrada #${item.id} (${item.market.toUpperCase()} · ${item.tier})?`)) {
      return;
    }
    this.api.historyDelete(item.id).subscribe({
      next: () => {
        if (this.detail?.id === item.id) this.closeDetail();
        this.load(this.page);
      },
      error: (err: unknown) => {
        this.error = this.errMsg(err, 'No se pudo borrar');
      },
    });
  }

  clearAll(): void {
    if (
      !confirm(
        '¿Limpiar TODO el historial local? Esta acción no se puede deshacer.'
      )
    ) {
      return;
    }
    this.clearing = true;
    this.api.historyClear().subscribe({
      next: () => {
        this.clearing = false;
        this.closeDetail();
        this.load(1);
      },
      error: (err: unknown) => {
        this.clearing = false;
        this.error = this.errMsg(err, 'No se pudo limpiar el historial');
      },
    });
  }

  chartUrlFor(d: HistoryDetail): string | null {
    if (!d.chartPath) return null;
    return `/api/signals/chart?market=${encodeURIComponent(d.market)}`;
  }

  trackById(_index: number, item: HistoryListItem): number {
    return item.id;
  }
}
