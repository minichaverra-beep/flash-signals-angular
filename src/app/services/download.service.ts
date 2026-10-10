import { Injectable, signal } from '@angular/core';
import { saveBlob, saveFromUrl, type DownloadResult } from '../shared/file-download';

export interface DownloadNotice {
  ok: boolean;
  message: string;
}

const NOTICE_MS = 4000;

/**
 * Descargas de imágenes/archivos que funcionan en navegador y en el APK (puente nativo
 * `AndroidDownloader`), con aviso global en español (`<app-download-notice>`).
 */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly notice = signal<DownloadNotice | null>(null);

  /** Descarga una URL same-origin de la API (PNG del gráfico, captura del resultado…). */
  async saveUrl(url: string, filename?: string | null): Promise<DownloadResult> {
    const result = await saveFromUrl(url, filename);
    this.report(result);
    return result;
  }

  /** Guarda un blob generado en el cliente (canvas, Excel, PDF…). */
  async saveBlob(blob: Blob, filename: string): Promise<DownloadResult> {
    const result = await saveBlob(blob, filename);
    this.report(result);
    return result;
  }

  report(result: Pick<DownloadResult, 'ok' | 'message'>): void {
    this.show(result.message, result.ok);
  }

  show(message: string, ok = true): void {
    if (this.timer) clearTimeout(this.timer);
    this.notice.set({ ok, message });
    this.timer = setTimeout(() => this.dismiss(), NOTICE_MS);
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.notice.set(null);
  }
}
