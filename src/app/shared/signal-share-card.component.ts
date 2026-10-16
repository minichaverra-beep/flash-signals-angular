import { AfterViewChecked, Component, ElementRef, HostListener, Input, OnDestroy, ViewChild, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SignalsApiService, type JobStatus, type Market, type Tier } from '../services/signals-api.service';
import { DownloadService } from '../services/download.service';
import { ImageViewerService } from './image-viewer/image-viewer.service';
import {
  DISCORD_APP,
  INSTAGRAM_WEB,
  MESSENGER_WEB,
  buildShareCard,
  facebookShareUrl,
  jobChartSrc,
  posterShareData,
  posterShareFileName,
  sharePngFilename,
  telegramShareUrl,
  twitterShareUrl,
  whatsAppShareUrl,
  type ShareCardModel,
} from './signal-share-card.model';
import { renderSharePoster } from './signal-share-poster';

/** Póster de la corrida terminada, descarga PNG y modal para compartir. */
@Component({
  selector: 'app-signal-share-card',
  standalone: true,
  templateUrl: './signal-share-card.component.html',
  styleUrl: './signal-share-card.component.scss',
})
export class SignalShareCardComponent implements AfterViewChecked, OnDestroy {
  private readonly downloads = inject(DownloadService);
  private readonly api = inject(SignalsApiService);
  private readonly viewer = inject(ImageViewerService);

  @Input({ required: true }) job!: JobStatus;
  @ViewChild('poster') private poster?: ElementRef<HTMLCanvasElement>;
  @ViewChild('shareBtn') private shareBtn?: ElementRef<HTMLButtonElement>;
  @ViewChild('shareDialog') private shareDialog?: ElementRef<HTMLElement>;

  busy = false;
  note = '';
  shareOpen = false;
  savedPosterUrl: string | null = null;

  private paintedKey = '';
  private paintToken = 0;
  private paintTask: Promise<void> | null = null;
  private uploadedKey = '';
  private missingPosterId = 0;
  /** Captura real de /signals/latest cuando el job no trae chartUrl. */
  private extraChart: string | null = null;
  private extraChartKey = '';

  get card(): ShareCardModel | null {
    return buildShareCard(this.job);
  }

  ngAfterViewChecked(): void {
    this.rememberPoster();
    const key = this.posterKey();
    if (!key || key === this.paintedKey || !this.poster) return;
    this.paintedKey = key;
    this.paintTask = this.paint();
  }

  private posterObjectUrl: string | null = null;

  ngOnDestroy(): void {
    if (this.shareOpen) document.body.style.overflow = '';
    if (this.posterObjectUrl) URL.revokeObjectURL(this.posterObjectUrl);
  }

  async download(): Promise<void> {
    this.note = '';
    await this.savePng();
  }

  openShare(): void {
    this.shareOpen = true;
    this.note = '';
    document.body.style.overflow = 'hidden';
    setTimeout(() => this.shareDialog?.nativeElement.focus());
  }

  closeShare(): void {
    if (!this.shareOpen) return;
    this.shareOpen = false;
    document.body.style.overflow = '';
    setTimeout(() => this.shareBtn?.nativeElement.focus());
  }

  onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeShare();
      return;
    }
    if (event.key !== 'Tab') return;
    const root = this.shareDialog?.nativeElement;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute('disabled'),
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeShare();
  }

  onSavedPosterError(): void {
    this.missingPosterId = this.historyId();
    this.savedPosterUrl = null;
  }

  shareWhatsApp(): void {
    void this.shareTo('whatsapp');
  }

  shareTelegram(): void {
    void this.shareTo('telegram');
  }

  shareFacebook(): void {
    void this.shareTo('facebook');
  }

  shareInstagram(): void {
    void this.shareTo('instagram');
  }

  shareMessenger(): void {
    void this.shareTo('messenger');
  }

  shareDiscord(): void {
    void this.shareTo('discord');
  }

  shareTwitter(): void {
    void this.shareTo('twitter');
  }

  /** Doble clic (ratón) o un toque en pantalla táctil. Un clic de ratón no navega. */
  onPosterClick(event: MouseEvent): void {
    if (event.detail > 1) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    void this.expandPoster(event);
  }

  expandPoster(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    void this.openPosterViewer();
  }

  private posterKey(): string {
    const card = this.card;
    if (!card) return '';
    const odds = card.odds ? `${card.odds.compra}/${card.odds.venta}` : '';
    return `${this.historyId()}|${card.caption}|${card.risk ?? ''}|${odds}|${jobChartSrc(this.job) ?? this.extraChart ?? ''}`;
  }

  private historyId(): number {
    const id = Number(this.job?.historyId);
    return Number.isInteger(id) && id > 0 ? id : 0;
  }

  /** Si la fila ya tiene póster guardado, el marco muestra esa imagen. */
  private rememberPoster(): void {
    const id = this.historyId();
    if (!id || this.missingPosterId === id || this.savedPosterUrl) return;
    this.savedPosterUrl = this.api.historyPosterImageUrl(id);
  }

  private async paint(): Promise<void> {
    const token = ++this.paintToken;
    const card = this.card;
    const canvas = this.poster?.nativeElement;
    if (!card || !canvas) return;
    try {
      const src = await this.chartSource();
      if (token !== this.paintToken || !this.poster) return;
      renderSharePoster(this.poster.nativeElement, card, null);
      const fonts = document.fonts?.ready ?? Promise.resolve();
      const chartPromise = src ? loadChart(src) : Promise.resolve(null);
      const [chart] = await Promise.all([chartPromise, fonts]);
      if (token !== this.paintToken || !this.poster) return;
      renderSharePoster(this.poster.nativeElement, this.card ?? card, chart);
      await this.persistPoster(this.poster.nativeElement);
    } catch {
      /* el canvas queda con el último póster válido */
    }
  }

  /** PNG de la corrida: el del job, o el de latest si no está marcado como viejo. */
  private async chartSource(): Promise<string | null> {
    const direct = jobChartSrc(this.job);
    if (direct) return direct;
    const market = asMarket(this.job.market || this.job.summary?.market);
    if (!market || this.job.status !== 'done') return null;
    const key = `${this.job.id ?? ''}|${market}|${this.job.tier ?? ''}|${this.job.finishedAt ?? ''}|${this.job.reportPath ?? ''}`;
    if (this.extraChartKey === key) return this.extraChart;
    this.extraChartKey = key;
    try {
      const latest = await firstValueFrom(this.api.latest(market, asTier(this.job.tier)));
      this.extraChart = latest.chartStale || !latest.chartUrl ? null : latest.chartUrl;
    } catch {
      this.extraChart = null;
    }
    return this.extraChart;
  }

  private async savePng(): Promise<boolean> {
    const card = this.card;
    if (!card || this.busy) return false;
    this.busy = true;
    try {
      const canvas = await this.ensurePoster();
      if (!canvas) {
        this.note = 'No se pudo generar la imagen.';
        return false;
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
      if (!blob) {
        this.note = 'No se pudo generar la imagen.';
        return false;
      }
      const result = await this.downloads.saveBlob(blob, sharePngFilename(card));
      if (!result.ok) this.note = result.message;
      return result.ok;
    } catch {
      this.note = 'No se pudo generar la imagen.';
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async persistPoster(canvas: HTMLCanvasElement): Promise<void> {
    const id = this.historyId();
    if (!id || !canvas.width) return;
    const key = `${id}|${this.posterKey()}`;
    if (this.uploadedKey === key) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    if (!blob || blob.size < 24) return;
    try {
      const imageBase64 = await blobToBase64(blob);
      await firstValueFrom(this.api.historyUploadPosterImage(id, imageBase64, 'image/png'));
      this.uploadedKey = key;
      this.missingPosterId = 0;
      this.savedPosterUrl = this.api.historyPosterImageUrl(id, Date.now());
    } catch {
      /* La ruta nueva no responde hasta reiniciar el API; el canvas sigue en el marco. */
    }
  }

  private async ensurePoster(): Promise<HTMLCanvasElement | null> {
    const key = this.posterKey();
    if (!this.poster || !key) return null;
    if (key !== this.paintedKey || !this.paintTask) {
      this.paintedKey = key;
      this.paintTask = this.paint();
    }
    await this.paintTask;
    const canvas = this.poster?.nativeElement;
    return canvas && canvas.width ? canvas : null;
  }

  private async shareTo(kind: ShareNet): Promise<void> {
    const card = this.card;
    if (!card || this.busy) return;
    this.note = '';
    this.busy = true;
    try {
      const file = await this.posterFile(card);
      const data = file ? posterShareData(file, card.caption) : null;
      if (!file || !data || data.files[0].size <= 0) {
        this.note = 'No hay imagen del póster para compartir.';
        return;
      }
      const outcome = await systemSharePoster(data);
      if (outcome === 'shared') {
        this.closeShare();
        this.note = 'Se abrió la hoja del sistema con la imagen del póster.';
        return;
      }
      if (outcome === 'cancelled') return;
      const copied = await copyPosterPng(file, card.caption);
      if (kind === 'instagram') {
        const saved = await this.downloads.saveBlob(file, file.name);
        if (!copied && !saved.ok) {
          this.note = 'No se pudo adjuntar ni copiar la imagen. No se compartió el póster.';
          return;
        }
        this.closeShare();
        this.open(INSTAGRAM_WEB);
        this.note = copied
          ? 'La imagen se descargó y se copió. Instagram no acepta el archivo desde el navegador: pégala en la app.'
          : 'La imagen se descargó. Instagram no acepta el archivo desde el navegador: súbela desde la galería.';
        return;
      }
      if (!copied) {
        this.note = 'Este navegador no puede adjuntar ni copiar la imagen. No se abrió el enlace para no enviar solo texto.';
        return;
      }
      this.closeShare();
      this.open(networkHref(kind, card));
      this.note = 'La imagen se copió. Este sitio no acepta el archivo desde el navegador: pégala en el chat.';
    } finally {
      this.busy = false;
    }
  }

  private async posterFile(card: ShareCardModel): Promise<File | null> {
    const blob = await this.shownPosterBlob();
    if (!blob || blob.size <= 0) return null;
    const png = blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' });
    if (png.size <= 0) return null;
    return new File([png], posterShareFileName(card.symbol), { type: 'image/png' });
  }

  /** El canvas recién pintado; si aún no existe, la imagen ya guardada. */
  private async shownPosterBlob(): Promise<Blob | null> {
    const canvas = await this.ensurePoster();
    if (canvas && canvas.width > 0) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
      if (blob && blob.size > 0) return blob;
    }
    if (!this.savedPosterUrl) return null;
    try {
      const res = await fetch(this.savedPosterUrl);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size <= 0) return null;
      return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' });
    } catch {
      return null;
    }
  }

  private async openPosterViewer(): Promise<void> {
    const card = this.card;
    if (!card) return;
    const file = await this.posterFile(card);
    if (!file) return;
    if (this.posterObjectUrl) URL.revokeObjectURL(this.posterObjectUrl);
    this.posterObjectUrl = URL.createObjectURL(file);
    this.viewer.open(this.posterObjectUrl, 'Póster de la señal');
  }

  private open(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

type ShareNet = 'whatsapp' | 'telegram' | 'facebook' | 'instagram' | 'messenger' | 'discord' | 'twitter';

function networkHref(kind: ShareNet, card: ShareCardModel): string {
  if (kind === 'whatsapp') return whatsAppShareUrl(card.caption);
  if (kind === 'telegram') return telegramShareUrl(card.caption);
  if (kind === 'facebook') return facebookShareUrl(window.location.href, card.caption);
  if (kind === 'messenger') return MESSENGER_WEB;
  if (kind === 'discord') return DISCORD_APP;
  if (kind === 'twitter') return twitterShareUrl(card.caption);
  return INSTAGRAM_WEB;
}

async function systemSharePoster(data: { files: [File]; text: string; title: string }): Promise<'shared' | 'cancelled' | 'unavailable'> {
  const nav = navigator;
  if (typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return 'unavailable';
  if (data.files[0].size <= 0) return 'unavailable';
  try {
    if (!nav.canShare(data)) return 'unavailable';
  } catch {
    return 'unavailable';
  }
  try {
    await nav.share(data);
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    return 'unavailable';
  }
}

async function copyPosterPng(file: File, caption: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (!clip?.write || typeof ClipboardItem === 'undefined' || file.size <= 0) return false;
  const png = file.type === 'image/png' ? file : new Blob([await file.arrayBuffer()], { type: 'image/png' });
  const text = new Blob([caption], { type: 'text/plain' });
  try {
    await clip.write([new ClipboardItem({ 'image/png': png, 'text/plain': text })]);
    return true;
  } catch {
    try {
      await clip.write([new ClipboardItem({ 'image/png': png })]);
      return true;
    } catch {
      return false;
    }
  }
}

function asMarket(value: string | null | undefined): Market | null {
  const market = (value || '').toLowerCase();
  if (market === 'btc' || market === 'us30' || market === 'xauusd' || market === 'ukoil') return market;
  return null;
}

function asTier(value: string | null | undefined): Tier {
  if (value === 'context' || value === 'light' || value === 'high' || value === 'history') return value;
  return 'high';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || '');
      const cut = raw.indexOf(',');
      resolve(cut >= 0 ? raw.slice(cut + 1) : raw);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadChart(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img.naturalWidth ? img : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
