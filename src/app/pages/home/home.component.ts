import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  effect,
  inject,
  untracked,
} from '@angular/core';
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
import {
  chartHref,
  hasScoresCard,
  investorRiskCard,
  investorScoreRows,
  scoreKpiRows,
  verdictRows,
} from '../../shared/signal-report.helpers';
import { SignalJobService, isRecentJob, jobKind } from '../../services/signal-job.service';
import { Subscription } from 'rxjs';

export type ViewMode = 'rapida' | 'trader' | 'inversor';

export interface HomeSectionLink {
  id: string;
  label: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive, SignalReportViewerComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy, AfterViewChecked {
  private readonly api = inject(SignalsApiService);
  readonly jobs = inject(SignalJobService);
  private finishedSub?: Subscription;
  /** Job cuya config (mercado/tier) ya se adoptó al reconectar. */
  private adoptedJobId: string | null = null;
  private scrollSpyPausedUntil = 0;
  private lastSectionKey = '';

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
  /** POST /signals/run en vuelo (antes de que el job exista en el servidor). */
  starting = false;
  message = '';
  latest: LatestResponse | null = null;
  showRawMarkdown = false;
  viewMode: ViewMode = 'rapida';
  activeSection = 'sec-config';

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

  constructor() {
    effect(() => {
      const j = this.jobs.job();
      untracked(() => this.adoptRunningJob(j));
    });
  }

  ngOnInit(): void {
    this.refreshHealth();
    this.loadLatest();
    this.finishedSub = this.jobs.finished$.subscribe((j) => {
      if (jobKind(j) !== 'signal') return;
      this.message = '';
      this.loadLatest();
    });
  }

  ngAfterViewChecked(): void {
    this.syncSectionObserver();
  }

  ngOnDestroy(): void {
    this.finishedSub?.unsubscribe();
  }

  /** Job de señal visible: en curso o terminado hace poco (sobrevive a F5 / cambio de ruta). */
  get job(): JobStatus | null {
    const j = this.jobs.job();
    return jobKind(j) === 'signal' && isRecentJob(j) ? j : null;
  }

  get busy(): boolean {
    return this.starting || this.jobs.running();
  }

  get runLabel(): string {
    if (this.starting) return 'Iniciando…';
    const j = this.jobs.job();
    if (j?.status !== 'running') return 'Ejecutar señal';
    const what = jobKind(j) === 'macd-quant' ? 'MACD en curso' : 'Ejecutando';
    return `${what}… ${this.jobs.elapsed()}`;
  }

  get statusMessage(): string {
    if (this.message) return this.message;
    const running = this.jobs.job();
    if (running?.status === 'running') {
      return jobKind(running) === 'macd-quant'
        ? 'Hay un análisis MACD-quant en ejecución; espera a que termine.'
        : `Señal ${String(running.market ?? '').toUpperCase()} · ${running.tier ?? ''} en ejecución…`;
    }
    const j = this.job;
    if (j?.status === 'done') return 'Listo — reporte generado.';
    if (j?.status === 'error') return j.error || 'Error en el pipeline.';
    return '';
  }

  /** Tras F5 / volver a la ruta: alinea mercado y tier con la corrida en curso. */
  private adoptRunningJob(j: JobStatus | null): void {
    if (j?.status !== 'running' || jobKind(j) !== 'signal' || !j.id) return;
    if (j.id === this.adoptedJobId) return;
    this.adoptedJobId = j.id;
    const market = this.markets.find((m) => m.id === j.market)?.id ?? this.market;
    const tier = this.tiers.find((t) => t.id === j.tier)?.id ?? this.tier;
    if (market === this.market && tier === this.tier) return;
    this.market = market;
    this.tier = tier;
    this.loadLatest();
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
    if (this.viewMode === 'inversor') return 'inversor';
    if (this.viewMode === 'rapida') return 'rapida';
    return 'trader';
  }

  get visibleSections(): HomeSectionLink[] {
    const links: HomeSectionLink[] = [
      { id: 'sec-config', label: 'Configurar corrida' },
      { id: 'sec-modos', label: 'Modo de vista' },
    ];
    if (this.job) {
      links.push({ id: 'sec-estado', label: 'Estado' });
    }
    const s = this.reportSummary;
    if (!s) return links;

    links.push({ id: 'sec-reporte', label: 'Resultado' });

    if (verdictRows(s).length || this.viewMode === 'inversor') {
      links.push({ id: 'sec-veredicto', label: 'Veredicto' });
    }

    if (this.viewMode === 'rapida' || this.viewMode === 'inversor') {
      const risk = investorRiskCard(s);
      if (risk.active) {
        links.push({ id: 'sec-riesgo', label: 'Riesgo' });
      }
    }

    const showScores =
      this.viewMode === 'trader'
        ? hasScoresCard(s)
        : this.viewMode === 'rapida'
          ? !!(s.chartScores?.length || scoreKpiRows(s).length)
          : investorScoreRows(s).length > 0;
    if (showScores) {
      links.push({ id: 'sec-scores', label: 'Probabilidades' });
    }

    if (this.viewMode !== 'inversor') {
      const hasChart = !!(
        this.latest?.chartUrl ||
        this.latest?.chartPath ||
        chartHref(this.market, this.latest?.chartUrl, this.latest?.chartPath)
      );
      if (hasChart) {
        links.push({ id: 'sec-grafico', label: 'Gráfico' });
      }
    }

    return links;
  }

  scrollToSection(id: string): void {
    const el = this.findSectionEl(id);
    if (!el) {
      // Fallback: no dejar el click muerto si el modo no montó ese bloque.
      const fallback = this.findSectionEl('sec-reporte');
      if (fallback) {
        this.activeSection = 'sec-reporte';
        this.scrollSpyPausedUntil = Date.now() + 900;
        this.smoothScrollTo(fallback);
      }
      return;
    }
    this.activeSection = id;
    this.scrollSpyPausedUntil = Date.now() + 900;
    this.smoothScrollTo(el);
  }

  @HostListener('window:scroll')
  onWindowScroll(): void {
    this.updateActiveFromScroll();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.updateActiveFromScroll();
  }

  private findSectionEl(id: string): HTMLElement | null {
    const byId = document.getElementById(id);
    if (byId) return byId;
    const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '');
    const el = document.querySelector(`[data-section="${safe}"]`);
    return el instanceof HTMLElement ? el : null;
  }

  private smoothScrollTo(el: HTMLElement): void {
    const offset = 12;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /** Última sección cruzada según posición en el documento (no el orden del nav). */
  private updateActiveFromScroll(): void {
    if (Date.now() < this.scrollSpyPausedUntil) return;
    const ids = this.visibleSections.map((s) => s.id);
    if (!ids.length) return;

    const activationY = 96;
    const entries = ids
      .map((id) => {
        const el = this.findSectionEl(id);
        return el ? { id, el, docTop: el.getBoundingClientRect().top + window.scrollY } : null;
      })
      .filter((x): x is { id: string; el: HTMLElement; docTop: number } => !!x)
      .sort((a, b) => a.docTop - b.docTop);

    if (!entries.length) return;

    let current = entries[0].id;
    for (const entry of entries) {
      if (entry.el.getBoundingClientRect().top <= activationY) {
        current = entry.id;
      }
    }
    if (current !== this.activeSection) {
      this.activeSection = current;
    }
  }

  private syncSectionObserver(): void {
    // Cuando cambian los bloques del viewer (modo / reporte), recalcular activo.
    const ids = this.visibleSections.map((s) => s.id).join('|');
    if (ids === this.lastSectionKey) return;
    this.lastSectionKey = ids;
    setTimeout(() => this.updateActiveFromScroll(), 0);
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
    this.starting = true;
    this.message = '';

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

    this.jobs.run(body).subscribe({
      next: (r) => {
        this.starting = false;
        this.adoptedJobId = r.job.id ?? null;
      },
      error: (err: unknown) => {
        this.starting = false;
        // 409: el job en curso ya se refleja vía SignalJobService.
        this.message = this.jobs.running()
          ? ''
          : this.errMsg(err, 'Error al iniciar la señal (revisa la API).');
      },
    });
  }

  private errMsg(err: unknown, fallback: string): string {
    if (!err || typeof err !== 'object') return fallback;
    const e = err as { error?: { error?: string }; message?: string };
    return e.error?.error || e.message || fallback;
  }
}
