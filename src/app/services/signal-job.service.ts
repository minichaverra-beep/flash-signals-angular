import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Observable, Subject, tap } from 'rxjs';
import { JobStatus, Market, RunRequest, SignalsApiService } from './signals-api.service';

const EVENTS_URL = '/api/signals/events';
const MAX_LOGS = 500;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
/** Sin mensajes (el servidor hace ping cada 15 s) → conexión muerta aunque el proxy no la cierre. */
const STALE_MS = 35000;
const WATCHDOG_MS = 5000;
/** Tras terminar, el resultado se sigue mostrando al volver a la página (F5 / cambio de ruta). */
const RESULT_TTL_MS = 15 * 60 * 1000;
const LOST_JOB_ERROR =
  'Se perdió el seguimiento del job: la API se reinició mientras estaba en ejecución.';

export type JobKind = 'signal' | 'macd-quant';

/** Tipo de job (el servidor comparte un único lock entre señal E1 y MACD-quant). */
export function jobKind(job: JobStatus | null | undefined): JobKind | null {
  if (!job || job.status === 'idle') return null;
  return job.kind === 'macd-quant' ? 'macd-quant' : 'signal';
}

/** En ejecución o terminado hace menos de RESULT_TTL_MS. */
export function isRecentJob(job: JobStatus | null | undefined, now = Date.now()): boolean {
  if (!job) return false;
  if (job.status === 'running') return true;
  const finished = Date.parse(job.finishedAt ?? '');
  return Number.isFinite(finished) && now - finished < RESULT_TTL_MS;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function parseEventData<T>(ev: Event): T | null {
  try {
    return JSON.parse((ev as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/**
 * Estado del job en curso, compartido por toda la app (singleton).
 * Se alimenta del SSE /api/signals/events: al recargar o cambiar de ruta
 * el snapshot inicial restaura la corrida y luego llegan progreso y resultado.
 */
@Injectable({ providedIn: 'root' })
export class SignalJobService implements OnDestroy {
  private readonly api = inject(SignalsApiService);
  private readonly finishedSubject = new Subject<JobStatus>();
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private readonly now = signal(Date.now());

  readonly job = signal<JobStatus | null>(null);
  /** Canal SSE abierto. */
  readonly connected = signal(false);
  readonly running = computed(() => this.job()?.status === 'running');
  readonly elapsed = computed(() => {
    const j = this.job();
    const started = Date.parse(j?.startedAt ?? '');
    if (!j || !Number.isFinite(started)) return '';
    const finished = Date.parse(j.finishedAt ?? '');
    const end = j.status !== 'running' && Number.isFinite(finished) ? finished : this.now();
    return formatElapsed(end - started);
  });
  /** Emite cuando un job visto en ejecución termina (done / error). */
  readonly finished$: Observable<JobStatus> = this.finishedSubject.asObservable();

  constructor() {
    this.refresh();
    this.connect();
  }

  ngOnDestroy(): void {
    this.clearReconnect();
    this.source?.close();
    this.stopClock();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
  }

  /** Fallback HTTP: GET /api/signals/status. */
  refresh(): void {
    this.api.status().subscribe({
      next: (j) => this.apply(j),
      error: () => undefined,
    });
  }

  run(body: RunRequest): Observable<{ message: string; job: JobStatus }> {
    return this.api.run(body).pipe(
      tap({ next: (r) => this.apply(r.job), error: (err: unknown) => this.applyConflict(err) })
    );
  }

  macdQuantAnalyze(market: Market, days = 7): Observable<{ message: string; job: JobStatus }> {
    return this.api.macdQuantAnalyze(market, days).pipe(
      tap({ next: (r) => this.apply(r.job), error: (err: unknown) => this.applyConflict(err) })
    );
  }

  private connect(): void {
    if (typeof EventSource === 'undefined') return;
    this.clearReconnect();
    const es = new EventSource(EVENTS_URL);
    this.source = es;
    this.lastMessageAt = Date.now();
    this.startWatchdog();
    es.onopen = () => {
      this.lastMessageAt = Date.now();
      this.connected.set(true);
      this.reconnectDelay = RECONNECT_MIN_MS;
    };
    const seen = () => {
      this.lastMessageAt = Date.now();
    };
    const onJob = (ev: Event) => {
      seen();
      this.apply(parseEventData<JobStatus>(ev));
    };
    es.addEventListener('ping', seen);
    es.addEventListener('snapshot', onJob);
    es.addEventListener('job:started', onJob);
    es.addEventListener('job:finished', onJob);
    es.addEventListener('job:failed', onJob);
    es.addEventListener('job:progress', (ev) => {
      seen();
      this.appendLogs(parseEventData<{ id?: string; lines?: string[] }>(ev));
    });
    es.onerror = () => {
      this.connected.set(false);
      this.refresh();
      // CONNECTING = el navegador reintenta solo; CLOSED (502 del proxy, API caída) = backoff propio.
      if (es.readyState === EventSource.CLOSED) this.dropConnection();
    };
  }

  /** El proxy de desarrollo puede dejar el stream abierto con la API caída: vigilar pings. */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.source && Date.now() - this.lastMessageAt > STALE_MS) {
        this.connected.set(false);
        this.refresh();
        this.dropConnection();
      }
    }, WATCHDOG_MS);
  }

  private dropConnection(): void {
    this.source?.close();
    this.source = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private applyConflict(err: unknown): void {
    const e = err as { status?: number; error?: { job?: JobStatus } } | null;
    if (e?.status === 409 && e.error?.job) this.apply(e.error.job);
  }

  private apply(next: JobStatus | null | undefined): void {
    if (!next || typeof next !== 'object') return;
    const prev = this.job();
    const sameJob = !!prev?.id && prev.id === next.id;
    // Snapshot HTTP/SSE atrasado: no revivir un job que ya terminó.
    if (sameJob && prev.status !== 'running' && next.status === 'running') return;

    const wasRunning = prev?.status === 'running';
    if (wasRunning && next.status === 'idle') {
      const lost: JobStatus = {
        ...prev,
        status: 'error',
        error: LOST_JOB_ERROR,
        finishedAt: new Date().toISOString(),
      };
      this.setJob(lost);
      this.finishedSubject.next(lost);
      return;
    }
    // idle solo llega tras reiniciar la API: no borra el último resultado conocido.
    if (next.status === 'idle' && prev && prev.status !== 'idle') return;

    const logs = Array.isArray(next.logs) ? next.logs : [];
    const job: JobStatus = {
      ...next,
      logs: sameJob && prev.logs.length > logs.length ? prev.logs : logs,
    };
    this.setJob(job);
    if (wasRunning && job.status !== 'running') this.finishedSubject.next(job);
  }

  private appendLogs(payload: { id?: string; lines?: string[] } | null): void {
    if (!payload?.id || !payload.lines?.length) return;
    const { id, lines } = payload;
    this.job.update((j) =>
      j?.id === id ? { ...j, logs: [...j.logs, ...lines].slice(-MAX_LOGS) } : j
    );
  }

  private setJob(job: JobStatus): void {
    this.job.set(job);
    if (job.status === 'running') this.startClock();
    else this.stopClock();
  }

  private startClock(): void {
    if (this.clockTimer) return;
    this.now.set(Date.now());
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  private stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.now.set(Date.now());
  }
}
