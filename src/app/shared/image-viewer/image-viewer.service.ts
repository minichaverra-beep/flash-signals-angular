import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';

export interface ViewerImage {
  src: string;
  alt: string;
}

const HISTORY_FLAG = 'fsImageViewer';
const SCROLL_LOCK_CLASS = 'image-viewer-open';

/**
 * Estado global del visor a pantalla completa (`<app-image-viewer>` en AppComponent).
 * Al abrir apila una entrada en el historial: el botón Atrás de Android (WebView → goBack)
 * o el gesto atrás del navegador cierran el visor en vez de salir de la página.
 */
@Injectable({ providedIn: 'root' })
export class ImageViewerService {
  private readonly doc = inject(DOCUMENT);
  readonly current = signal<ViewerImage | null>(null);

  private historyPushed = false;
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.doc.defaultView?.addEventListener('popstate', () => {
      if (!this.historyPushed) return;
      this.historyPushed = false;
      this.dismiss();
    });
  }

  open(src: string | null | undefined, alt = ''): void {
    if (!src) return;
    const wasOpen = this.current() !== null;
    this.current.set({ src, alt });
    if (wasOpen) return;

    const active = this.doc.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.doc.documentElement.classList.add(SCROLL_LOCK_CLASS);

    const history = this.doc.defaultView?.history;
    if (!history) return;
    try {
      const state = history.state && typeof history.state === 'object' ? history.state : {};
      history.pushState({ ...state, [HISTORY_FLAG]: true }, '');
      this.historyPushed = true;
    } catch {
      this.historyPushed = false;
    }
  }

  close(): void {
    if (!this.current()) return;
    const history = this.doc.defaultView?.history;
    const ownsEntry = this.historyPushed && !!history?.state?.[HISTORY_FLAG];
    this.historyPushed = false;
    this.dismiss();
    if (ownsEntry) history!.back();
  }

  private dismiss(): void {
    if (!this.current()) return;
    this.current.set(null);
    this.doc.documentElement.classList.remove(SCROLL_LOCK_CLASS);
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
}
