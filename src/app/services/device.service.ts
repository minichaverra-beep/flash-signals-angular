import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

/** Mismo corte que `.hide-on-phone` en styles.scss. */
export const SMALL_SCREEN_QUERY = '(max-width: 768px)';

/** Puerto con el que Termux sirve la app en el teléfono (android/start.sh). */
const APK_PORT = '3847';

/** Preferencia local del admin. No se envía al servidor ni a mt5-settings.json. */
const MOBILE_SIM_KEY = 'flash-signals.simulate-mobile';

/**
 * APK = WebView del lanzador android/app-launcher (UA Android con «; wv)») o la app servida por
 * Termux en 127.0.0.1:3847 abierta desde Android. En el teléfono no existe MetaTrader 5.
 */
export function detectApk(ua: string, host: string, port: string): boolean {
  if (!/Android/i.test(ua)) return false;
  const isWebView = /;\s*wv\)/i.test(ua);
  const isTermuxHost = (host === '127.0.0.1' || host === 'localhost') && port === APK_PORT;
  return isWebView || isTermuxHost;
}

function readMobileSim(): boolean {
  try {
    return localStorage.getItem(MOBILE_SIM_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMobileSim(on: boolean): void {
  try {
    if (on) localStorage.setItem(MOBILE_SIM_KEY, '1');
    else localStorage.removeItem(MOBILE_SIM_KEY);
  } catch {
    /* modo privado: la preferencia vive solo en memoria */
  }
}

@Injectable({ providedIn: 'root' })
export class DeviceService {
  private readonly auth = inject(AuthService);
  /** Ventana realmente estrecha (matchMedia). */
  private readonly viewportNarrow = signal(false);
  /** Interruptor del admin. Por defecto apagado. */
  private readonly simulateMobilePref = signal(readMobileSim());

  readonly isApk = signal(
    typeof navigator !== 'undefined' && typeof location !== 'undefined'
      ? detectApk(navigator.userAgent, location.hostname, location.port)
      : false
  );
  /** Lo que muestra el interruptor. La simulación solo aplica con sesión admin. */
  readonly simulateMobile = this.simulateMobilePref.asReadonly();

  private readonly simActive = computed(() => this.simulateMobilePref() && this.auth.isAdmin());

  /** Pantalla estrecha o simulación de APK del admin (ventana ancha incluida). */
  readonly isSmallScreen = computed(() => this.viewportNarrow() || this.simActive());
  readonly isMobileOrApk = computed(() => this.isApk() || this.isSmallScreen());
  /** Acciones y ajustes de MT5 no disponibles (solo existen en el PC Windows). */
  readonly mt5Hidden = this.isMobileOrApk;

  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia(SMALL_SCREEN_QUERY);
      this.viewportNarrow.set(mql.matches);
      mql.addEventListener('change', (e) => this.viewportNarrow.set(e.matches));
    }
    this.syncSimClass();
  }

  /** Clase global para las reglas de teléfono (styles.scss) aunque el viewport sea ancho. */
  private readonly simClassEffect = effect(() => {
    this.simActive();
    this.syncSimClass();
  });

  setSimulateMobile(on: boolean): void {
    const next = !!on;
    this.simulateMobilePref.set(next);
    writeMobileSim(next);
    this.syncSimClass();
  }

  private syncSimClass(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('fs-mobile-sim', this.simActive());
  }
}
