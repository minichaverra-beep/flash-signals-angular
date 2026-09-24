import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription, interval, switchMap, takeWhile } from 'rxjs';
import {
  JobStatus,
  MacdQuantHistoryDetail,
  MacdQuantHistoryListItem,
  Market,
  SignalsApiService,
} from '../../services/signals-api.service';

@Component({
  selector: 'app-macd-quant',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, DatePipe],
  templateUrl: './macd-quant.component.html',
  styleUrl: './macd-quant.component.scss',
})
export class MacdQuantComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
  private pollSub?: Subscription;

  market: Market = 'btc';
  chartBroken = false;
  analyzing = false;
  analyzeMessage = '';
  job: JobStatus | null = null;
  private cacheBust = Date.now();

  /** Historial preservado (SQLite). */
  historyItems: MacdQuantHistoryListItem[] = [];
  historyLoading = false;
  historyError = '';
  selectedId: number | null = null;
  selectedDetail: MacdQuantHistoryDetail | null = null;
  viewingHistory = false;
  private historyChartBust = Date.now();

  readonly markets: { id: Market; label: string }[] = [
    { id: 'btc', label: 'BTC' },
    { id: 'us30', label: 'US30' },
    { id: 'xauusd', label: 'XAUUSD' },
  ];

  readonly artifactPath = '2026-09-24-quant-macd-e1-backtest.html';
  readonly artifactRawUrl = `/api/artifacts/raw?path=${encodeURIComponent(this.artifactPath)}`;
  readonly wikiHint = '/wiki';

  readonly mdPath =
    'D:\\Danilo\\Trading\\Cursor Trading\\docs\\strategy\\TRADING_QUANT_MACD_E1_BACKTEST.md';

  readonly plotCmd = `cd "D:\\Danilo\\Trading\\Cursor Trading"
python -m scripts.plot_macd_quant --days 7 --force-refresh
python -m scripts.plot_macd_quant --symbol us30 --days 7 --force-refresh`;

  ngOnInit(): void {
    this.loadHistory();
  }

  chartUrl(): string {
    if (this.viewingHistory && this.selectedId != null) {
      return this.api.macdQuantHistoryChartUrl(
        this.selectedId,
        this.historyChartBust
      );
    }
    return `/api/signals/macd-chart?market=${encodeURIComponent(this.market)}&t=${this.cacheBust}`;
  }

  onMarketChange(id: Market): void {
    this.market = id;
    this.chartBroken = false;
    this.cacheBust = Date.now();
    this.backToLive();
    this.loadHistory();
  }

  onChartError(): void {
    this.chartBroken = true;
  }

  onChartLoad(): void {
    this.chartBroken = false;
  }

  reloadChart(): void {
    this.chartBroken = false;
    if (this.viewingHistory) {
      this.historyChartBust = Date.now();
    } else {
      this.cacheBust = Date.now();
    }
  }

  /** Escaneo H4 de la semana + regenera PNG quant (auto-guarda en DB). */
  nuevoAnalisis(): void {
    if (this.analyzing) return;
    this.analyzing = true;
    this.analyzeMessage = 'Escaneando semana H4…';
    this.job = null;
    this.backToLive();

    this.api.macdQuantAnalyze(this.market, 7).subscribe({
      next: () => {
        this.analyzeMessage = 'Generando mini-chart MACD H4…';
        this.startPolling();
      },
      error: (err: unknown) => {
        this.analyzing = false;
        this.analyzeMessage = this.errMsg(
          err,
          'No se pudo iniciar el análisis (¿API en Windows?).'
        );
      },
    });
  }

  private startPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(1200)
      .pipe(
        switchMap(() => this.api.status()),
        takeWhile((j) => j.status === 'running', true)
      )
      .subscribe({
        next: (j) => {
          this.job = j;
          if (j.status !== 'running') {
            this.analyzing = false;
            if (j.status === 'done') {
              const saved =
                j.macdQuantId != null
                  ? ` · guardado #${j.macdQuantId}`
                  : '';
              this.analyzeMessage =
                `Listo — PNG H4 regenerado y preservado${saved} (soft-filter, nunca trigger solo).`;
              this.reloadChart();
              this.loadHistory();
            } else {
              this.analyzeMessage = j.error || 'Error al generar el chart H4.';
              this.loadHistory();
            }
          }
        },
        error: (err: unknown) => {
          this.analyzing = false;
          this.analyzeMessage = this.errMsg(err, 'Error al consultar estado.');
        },
      });
  }

  loadHistory(): void {
    this.historyLoading = true;
    this.historyError = '';
    this.api
      .macdQuantHistory({ market: this.market, page: 1, pageSize: 30 })
      .subscribe({
        next: (res) => {
          this.historyItems = res.items || [];
          this.historyLoading = false;
        },
        error: (err: unknown) => {
          this.historyLoading = false;
          this.historyError = this.errMsg(
            err,
            'No se pudo cargar el historial (¿API reiniciada?).'
          );
        },
      });
  }

  openHistoryItem(item: MacdQuantHistoryListItem): void {
    this.selectedId = item.id;
    this.viewingHistory = true;
    this.chartBroken = false;
    this.historyChartBust = Date.now();
    this.selectedDetail = null;
    this.api.macdQuantHistoryGet(item.id).subscribe({
      next: (d) => {
        this.selectedDetail = d;
      },
      error: (err: unknown) => {
        this.analyzeMessage = this.errMsg(err, 'No se pudo abrir el análisis.');
      },
    });
  }

  backToLive(): void {
    this.viewingHistory = false;
    this.selectedId = null;
    this.selectedDetail = null;
    this.chartBroken = false;
    this.cacheBust = Date.now();
  }

  formatParams(item: MacdQuantHistoryListItem | MacdQuantHistoryDetail): string {
    const p = item.params;
    if (!p) return '12/26/9';
    return `${p.fast ?? 12}/${p.slow ?? 26}/${p.signal ?? 9}`;
  }

  marketLabel(): string {
    return this.markets.find((m) => m.id === this.market)?.label || this.market;
  }

  trackById(_index: number, item: MacdQuantHistoryListItem): number {
    return item.id;
  }

  private errMsg(err: unknown, fallback: string): string {
    if (!err || typeof err !== 'object') return fallback;
    const e = err as { error?: { error?: string }; message?: string };
    return e.error?.error || e.message || fallback;
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }
}
