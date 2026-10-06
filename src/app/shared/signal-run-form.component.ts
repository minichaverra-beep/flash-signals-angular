import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { JobStatus, Market, SignalsApiService, Tier } from '../services/signals-api.service';
import { SignalJobService, isRecentJob, jobKind } from '../services/signal-job.service';

/** «Configurar corrida» + estado del job de señal (cabecera de /senales). */
@Component({
  selector: 'app-signal-run-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './signal-run-form.component.html',
  styleUrl: './signal-run-form.component.scss',
})
export class SignalRunFormComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
  readonly jobs = inject(SignalJobService);
  private finishedSub?: Subscription;
  /** Job cuya config (mercado/tier) ya se adoptó al reconectar. */
  private adoptedJobId: string | null = null;

  market: Market = 'btc';
  readonly tier: Tier = 'high';
  bias: 'auto' | 'bullish' | 'bearish' = 'bullish';
  setup: 'break' | 'reverse' = 'break';
  /**
   * `reversalsEnabled` del perfil MT5 activo. `null` = desconocido (cargando o API caída):
   * Reverse queda habilitado y el servidor filtra al enviar a MT5.
   */
  reversalsEnabled: boolean | null = null;
  ml = true;
  neural = true;
  ilustrate = true;
  advanced = true;
  noChart = true;
  entry = '';

  apiOk: boolean | null = null;
  /** POST /signals/run en vuelo (antes de que el job exista en el servidor). */
  starting = false;
  message = '';

  readonly markets: { id: Market; label: string }[] = [
    { id: 'btc', label: 'BTC' },
    { id: 'us30', label: 'US30' },
    { id: 'xauusd', label: 'XAUUSD' },
  ];

  constructor() {
    effect(() => {
      const j = this.jobs.job();
      untracked(() => this.adoptRunningJob(j));
    });
  }

  ngOnInit(): void {
    this.refreshHealth();
    this.loadReversalsSetting();
    // El historial de la misma página recarga la lista al terminar (nueva fila con Run operation).
    this.finishedSub = this.jobs.finished$.subscribe((j) => {
      if (jobKind(j) === 'signal') this.message = '';
    });
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
    if (j?.status === 'done') return 'Listo — la señal ya está en el historial de abajo.';
    if (j?.status === 'error') return j.error || 'Error en el pipeline.';
    return '';
  }

  /** Tras F5 / volver a la ruta: alinea el mercado con la corrida en curso (el tier siempre es High). */
  private adoptRunningJob(j: JobStatus | null): void {
    if (j?.status !== 'running' || jobKind(j) !== 'signal' || !j.id) return;
    if (j.id === this.adoptedJobId) return;
    this.adoptedJobId = j.id;
    this.market = this.markets.find((m) => m.id === j.market)?.id ?? this.market;
  }

  /** Solo se deshabilita Reverse cuando la configuración confirma que está desactivado. */
  get reversalsDisabled(): boolean {
    return this.reversalsEnabled === false;
  }

  private loadReversalsSetting(): void {
    this.api.mt5Settings().subscribe({
      next: (s) => {
        this.reversalsEnabled = !!s.profiles?.[s.active]?.reversalsEnabled;
        if (!this.reversalsEnabled && this.setup === 'reverse') this.setup = 'break';
      },
      error: () => {
        this.reversalsEnabled = null;
      },
    });
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

  refreshHealth(): void {
    this.api.health().subscribe({
      next: () => {
        this.apiOk = true;
      },
      error: () => {
        this.apiOk = false;
        this.message = 'API no disponible. Arranca: npm run api (puerto 3847).';
      },
    });
  }

  run(): void {
    if (this.busy) return;
    this.starting = true;
    this.message = '';
    if (this.reversalsDisabled && this.setup === 'reverse') this.setup = 'break';

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
