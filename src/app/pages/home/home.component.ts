import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  JobStatus,
  LatestResponse,
  Market,
  SignalSummary,
  SignalsApiService,
  Tier,
} from '../../services/signals-api.service';
import {
  ReportViewMode,
  SignalReportViewerComponent,
} from '../../shared/signal-report-viewer.component';
import { Subscription, interval, switchMap, takeWhile } from 'rxjs';

export type ViewMode = 'trader' | 'inversor' | 'guia';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive, SignalReportViewerComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
  private pollSub?: Subscription;

  market: Market = 'btc';
  tier: Tier = 'high';
  bias: 'auto' | 'bullish' | 'bearish' = 'bullish';
  setup: 'break' | 'reverse' = 'break';
  ml = true;
  neural = true;
  ilustrate = true;
  advanced = true;
  noChart = true;
  entry = '';

  apiOk: boolean | null = null;
  tradingRoot = '';
  tradingRootExists = false;
  busy = false;
  message = '';
  job: JobStatus | null = null;
  latest: LatestResponse | null = null;
  showRawMarkdown = false;
  viewMode: ViewMode = 'trader';

  readonly markets: { id: Market; label: string }[] = [
    { id: 'btc', label: 'BTC' },
    { id: 'us30', label: 'US30' },
    { id: 'xauusd', label: 'XAUUSD' },
  ];

  readonly tiers: { id: Tier; label: string; hint: string }[] = [
    { id: 'context', label: 'Context', hint: 'Estructura M5 — sin Entry' },
    { id: 'light', label: 'Light', hint: 'Chequeo rápido' },
    { id: 'high', label: 'High', hint: 'Señal de entrada (día a día)' },
    { id: 'history', label: 'History', hint: 'P&L última Entry — no es señal' },
  ];

  ngOnInit(): void {
    this.refreshHealth();
    this.loadLatest();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  get flagsDisabled(): boolean {
    return this.tier === 'context';
  }

  get highOnlyDisabled(): boolean {
    return this.tier === 'context' || this.tier === 'light';
  }

  get entryDisabled(): boolean {
    return this.tier !== 'high';
  }

  /** Un solo summary para el viewer (latest gana sobre job para no duplicar). */
  get reportSummary(): SignalSummary | null {
    return this.latest?.summary ?? this.job?.summary ?? null;
  }

  get reportMode(): ReportViewMode {
    return this.viewMode === 'inversor' ? 'inversor' : 'trader';
  }

  refreshHealth(): void {
    this.api.health().subscribe({
      next: (h) => {
        this.apiOk = true;
        this.tradingRoot = h.tradingRoot;
        this.tradingRootExists = h.tradingRootExists;
      },
      error: () => {
        this.apiOk = false;
        this.message =
          'API no disponible. Arranca: npm run api (puerto 3847).';
      },
    });
  }

  loadLatest(): void {
    this.showRawMarkdown = false;
    this.api.latest(this.market, this.tier === 'context' ? 'context' : 'high').subscribe({
      next: (r) => (this.latest = r),
      error: () => (this.latest = null),
    });
  }

  onMarketChange(): void {
    this.loadLatest();
  }

  run(): void {
    if (this.busy) return;
    this.busy = true;
    this.message = '';
    this.job = null;

    const body = {
      market: this.market,
      tier: this.tier,
      bullish: this.bias === 'bullish',
      bearish: this.bias === 'bearish',
      breakSetup: this.setup === 'break',
      reverse: this.setup === 'reverse',
      ml: this.ml,
      neural: this.neural,
      ilustrate: this.ilustrate,
      advanced: this.advanced,
      noChart: this.noChart,
      noOpen: true,
      entry: this.entry.trim() || undefined,
    };

    this.api.run(body).subscribe({
      next: () => {
        this.message = 'Señal en ejecución…';
        this.startPolling();
      },
      error: (err) => {
        this.busy = false;
        this.message =
          err?.error?.error ||
          err?.message ||
          'Error al iniciar la señal (revisa la API).';
      },
    });
  }

  private startPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(1500)
      .pipe(
        switchMap(() => this.api.status()),
        takeWhile((j) => j.status === 'running', true)
      )
      .subscribe({
        next: (j) => {
          this.job = j;
          if (j.status !== 'running') {
            this.busy = false;
            this.message =
              j.status === 'done'
                ? 'Listo — reporte generado.'
                : j.error || 'Error en el pipeline.';
            this.loadLatest();
          }
        },
        error: (err) => {
          this.busy = false;
          this.message = err?.message || 'Error al consultar estado.';
        },
      });
  }
}
