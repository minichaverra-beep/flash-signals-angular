import { Injectable, computed, signal } from '@angular/core';

/** Mismo corte que `.hide-on-phone` en styles.scss. */
export const SMALL_SCREEN_QUERY = '(max-width: 768px)';

/** Puerto con el que Termux sirve la app en el teléfono (android/start.sh). */
const APK_PORT = '3847';

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

@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly isApk = signal(
    typeof navigator !== 'undefined' && typeof location !== 'undefined'
      ? detectApk(navigator.userAgent, location.hostname, location.port)
      : false
  );
  readonly isSmallScreen = signal(false);
  readonly isMobileOrApk = computed(() => this.isApk() || this.isSmallScreen());
  /** Acciones y ajustes de MT5 no disponibles (solo existen en el PC Windows). */
  readonly mt5Hidden = this.isMobileOrApk;

  constructor() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(SMALL_SCREEN_QUERY);
    this.isSmallScreen.set(mql.matches);
    mql.addEventListener('change', (e) => this.isSmallScreen.set(e.matches));
  }
}
