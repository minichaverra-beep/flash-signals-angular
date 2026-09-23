import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  HistoryDetail,
  HistoryListItem,
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

  detail: HistoryDetail | null = null;
  detailLoading = false;
  detailMode: ReportViewMode = 'rapida';
  drawerOpen = false;

  readonly markets: { id: Market | ''; label: string }[] = [
    { id: '', label: 'Todos' },
    { id: 'btc', label: 'BTC' },
    { id: 'us30', label: 'US30' },
    { id: 'xauusd', label: 'XAUUSD' },
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

  openDetail(item: HistoryListItem): void {
    this.drawerOpen = true;
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

  closeDetail(): void {
    this.drawerOpen = false;
    this.detail = null;
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
