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
  Mt5ManualOrderMode,
  Mt5ManualRequest,
  Mt5OrderResult,
  Mt5PushOutcome,
  Mt5PushRequest,
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

/** Veredicto ENTRAR con Entry/SL/TP: candidata a enviarse a MT5. */
export function isEntrySignal(s: SignalSummary | null | undefined): boolean {
  const p = s?.planDetails;
  return /entrar/i.test(s?.verdict ?? '') && !!(p?.entry && p?.sl && p?.tp);
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

  /** Confirmación de envío a MT5: vista previa (dryRun) → Confirmar / No enviar. */
  mt5Open = false;
  mt5Loading = false;
  mt5Sending = false;
  mt5Preview: Mt5OrderResult | null = null;
  /** Perfil activo en Configuración (Conf principal / secundaria) usado para el envío. */
  mt5ProfileLabel = '';
  mt5Volume: number | null = null;
  mt5Error = '';
  mt5Message = '';
  mt5MessageErr = false;
  private mt5Target: Mt5PushRequest = {};

  /** Operación manual: cualquier dirección/tipo/precio; solo MT5 valida. */
  manualOpen = false;
  manualLoading = false;
  manualSending = false;
  manualPreview: Mt5OrderResult | null = null;
  manualProfileLabel = '';
  manualError = '';
  manualForm = {
    market: 'btc' as Market,
    symbol: '',
    side: 'LONG' as 'LONG' | 'SHORT',
    orderMode: 'market' as Mt5ManualOrderMode,
    entry: null as number | null,
    sl: null as number | null,
    tp: null as number | null,
    volume: null as number | null,
  };
  readonly manualModes: { id: Mt5ManualOrderMode; label: string }[] = [
    { id: 'market', label: 'Mercado' },
    { id: 'limit', label: 'Limit' },
    { id: 'stop', label: 'Stop' },
  ];

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
      this.mt5Message = '';
      this.loadLatest();
      if (j.status === 'done' && isEntrySignal(j.summary)) {
        this.openMt5Confirm(j.historyId ? { historyId: j.historyId } : { market: j.market as Market });
      }
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

  get canSendMt5(): boolean {
    return isEntrySignal(this.reportSummary);
  }

  /** Corrida recién terminada del mercado visible → por historyId; si no, último reporte del mercado. */
  private currentMt5Target(): Mt5PushRequest {
    const j = this.job;
    if (j?.status === 'done' && j.historyId && j.market === this.market) {
      return { historyId: j.historyId };
    }
    return { market: this.market };
  }

  openMt5Confirm(target: Mt5PushRequest = this.currentMt5Target()): void {
    this.mt5Target = target;
    this.mt5Open = true;
    this.mt5Loading = true;
    this.mt5Preview = null;
    this.mt5Volume = null;
    this.mt5Error = '';
    this.mt5Message = '';
    this.mt5ProfileLabel = '';
    this.api.mt5Push({ ...target, dryRun: true }).subscribe({
      next: (r) => {
        this.mt5Loading = false;
        this.mt5ProfileLabel = r.profile?.label ?? '';
        if (r.status === 'sent' && r.result) {
          this.mt5Preview = r.result;
          this.mt5Volume = r.result.volume;
        } else {
          this.mt5Error = r.message;
        }
      },
      error: (err: unknown) => {
        this.mt5Loading = false;
        const body = (err as { error?: Mt5PushOutcome } | null)?.error;
        this.mt5ProfileLabel = body?.profile?.label ?? '';
        this.mt5Error = this.mt5ErrMsg(err, 'No se pudo preparar la orden MT5.');
      },
    });
  }

  confirmMt5(): void {
    if (!this.mt5Preview || this.mt5Sending) return;
    const volume = Number(this.mt5Volume);
    if (!Number.isFinite(volume) || volume <= 0) {
      this.mt5Error = 'Lotes debe ser un número mayor que 0.';
      return;
    }
    this.mt5Sending = true;
    this.mt5Error = '';
    const body: Mt5PushRequest = { ...this.mt5Target };
    if (volume !== this.mt5Preview.volume) body.volume = volume;
    this.api.mt5Push(body).subscribe({
      next: (r) => {
        this.mt5Sending = false;
        if (r.status !== 'sent') {
          this.mt5Error = r.message;
          return;
        }
        this.mt5Open = false;
        this.mt5Message = `Enviada a MT5: ${r.message}`;
        this.mt5MessageErr = false;
      },
      error: (err: unknown) => {
        this.mt5Sending = false;
        this.mt5Error = this.mt5ErrMsg(err, 'MT5 no aceptó la orden.');
      },
    });
  }

  cancelMt5(): void {
    if (this.mt5Sending) return;
    const hadPreview = !!this.mt5Preview;
    this.mt5Open = false;
    this.mt5Message = hadPreview ? 'Operación no enviada a MT5.' : '';
    this.mt5MessageErr = false;
  }

  /** Abre el formulario manual precargado con el plan visible (si lo hay) del mercado actual. */
  openManual(): void {
    const plan = this.reportSummary?.planDetails;
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const entry = num(plan?.entry);
    const sl = num(plan?.sl);
    const tp = num(plan?.tp);
    this.manualForm = {
      market: this.market,
      symbol: '',
      side: sl != null && entry != null && sl > entry ? 'SHORT' : 'LONG',
      orderMode: 'market',
      entry,
      sl,
      tp,
      volume: this.manualForm.volume,
    };
    this.manualPreview = null;
    this.manualError = '';
    this.manualProfileLabel = '';
    this.manualOpen = true;
  }

  /** Cualquier cambio del formulario invalida la vista previa. */
  manualChanged(): void {
    this.manualPreview = null;
    this.manualError = '';
  }

  private manualBody(dryRun: boolean): Mt5ManualRequest {
    const f = this.manualForm;
    const opt = (v: number | null) => (v != null && Number(v) > 0 ? Number(v) : undefined);
    const symbol = f.symbol.trim();
    return {
      ...(symbol ? { symbol } : { market: f.market }),
      side: f.side,
      orderMode: f.orderMode,
      entry: f.orderMode === 'market' ? undefined : opt(f.entry),
      sl: opt(f.sl),
      tp: opt(f.tp),
      volume: opt(f.volume),
      dryRun,
    };
  }

  previewManual(): void {
    if (this.manualLoading || this.manualSending) return;
    this.manualLoading = true;
    this.manualPreview = null;
    this.manualError = '';
    this.api.mt5Manual(this.manualBody(true)).subscribe({
      next: (r) => {
        this.manualLoading = false;
        this.manualProfileLabel = r.profile?.label ?? '';
        this.manualPreview = r.result ?? null;
        if (r.result?.ok === false) {
          this.manualError = `Aviso de MT5 (order_check): ${r.result.check?.comment ?? 'rechazo'}. Puedes enviar igualmente.`;
        }
      },
      error: (err: unknown) => {
        this.manualLoading = false;
        const body = (err as { error?: Mt5PushOutcome } | null)?.error;
        this.manualProfileLabel = body?.profile?.label ?? '';
        this.manualError = this.mt5ErrMsg(err, 'No se pudo preparar la orden manual.');
      },
    });
  }

  confirmManual(): void {
    if (!this.manualPreview || this.manualSending) return;
    this.manualSending = true;
    this.manualError = '';
    const body = this.manualBody(false);
    if (!body.volume) body.volume = this.manualPreview.volume;
    this.api.mt5Manual(body).subscribe({
      next: (r) => {
        this.manualSending = false;
        this.manualOpen = false;
        this.mt5Message = `Operación manual enviada a MT5: ${r.message}`;
        this.mt5MessageErr = false;
      },
      error: (err: unknown) => {
        this.manualSending = false;
        this.manualError = this.mt5ErrMsg(err, 'MT5 no aceptó la orden manual.');
      },
    });
  }

  cancelManual(): void {
    if (this.manualSending) return;
    this.manualOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.manualOpen) this.cancelManual();
    else if (this.mt5Open) this.cancelMt5();
  }

  private mt5ErrMsg(err: unknown, fallback: string): string {
    const body = (err as { error?: Partial<Mt5PushOutcome> & { error?: string } } | null)?.error;
    return body?.message || body?.error || fallback;
  }

  private errMsg(err: unknown, fallback: string): string {
    if (!err || typeof err !== 'object') return fallback;
    const e = err as { error?: { error?: string }; message?: string };
    return e.error?.error || e.message || fallback;
  }
}
