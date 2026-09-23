import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  inject,
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
import { Subscription, interval, switchMap, takeWhile } from 'rxjs';

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
  private pollSub?: Subscription;
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
  busy = false;
  message = '';
  job: JobStatus | null = null;
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

  ngOnInit(): void {
    this.refreshHealth();
    this.loadLatest();
  }

  ngAfterViewChecked(): void {
    this.syncSectionObserver();
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
    return (
      document.getElementById(id) ||
      (document.querySelector(`[data-section="${id}"]`) as HTMLElement | null)
    );
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
