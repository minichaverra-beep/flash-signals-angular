import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  HistoryDetail,
  HistoryListItem,
  HistoryResultado,
  Market,
  SignalsApiService,
} from '../../services/signals-api.service';
import {
  ReportViewMode,
  SignalReportViewerComponent,
} from '../../shared/signal-report-viewer.component';
import { verdictTone, biasTone, biasLabel, resolveRunBias } from '../../shared/signal-report.helpers';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

@Component({
  selector: 'app-historial',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, SignalReportViewerComponent],
  templateUrl: './historial.component.html',
  styleUrl: './historial.component.scss',
})
export class HistorialComponent implements OnInit {
  private readonly api = inject(SignalsApiService);

  items: HistoryListItem[] = [];
  page = 1;
  pageSize = 20;
  total = 0;
  totalPages = 1;
  marketFilter: Market | '' = '';
  loading = false;
  error = '';
  clearing = false;
  /** id → guardando anotación */
  savingIds = new Set<number>();
  /** id → subiendo/borrando imagen */
  imageBusyIds = new Set<number>();
  /** cache-bust por id de imagen */
  imageBust = new Map<number, number>();
  saveHint = '';
  dropActive = false;

  detail: HistoryDetail | null = null;
  detailLoading = false;
  detailMode: ReportViewMode = 'rapida';
  drawerOpen = false;
  /** Panel detalle a pantalla amplia (vs drawer estrecho). */
  detailExpanded = true;
  lightboxUrl: string | null = null;

  /** Diálogo de desbloqueo para borrar (modo lock). */
  unlockOpen = false;
  unlockKind: 'delete' | 'clear' | null = null;
  unlockItem: HistoryListItem | null = null;
  unlockPassword = '';
  unlockError = '';
  unlockBusy = false;

  readonly markets: { id: Market | ''; label: string }[] = [
    { id: '', label: 'Todos' },
    { id: 'btc', label: 'BTC' },
    { id: 'us30', label: 'US30' },
    { id: 'xauusd', label: 'XAUUSD' },
  ];

  readonly resultadoOptions: { value: HistoryResultado | ''; label: string }[] = [
    { value: '', label: '—' },
    { value: 'ganada', label: 'Ganada (win)' },
    { value: 'perdida', label: 'Perdida (loss)' },
  ];

  ngOnInit(): void {
    this.load();
  }

  @HostListener('document:paste', ['$event'])
  onDocumentPaste(ev: ClipboardEvent): void {
    if (!this.drawerOpen || !this.detail) return;
    const file = this.fileFromClipboard(ev);
    if (!file) return;
    ev.preventDefault();
    this.uploadResultFile(this.detail, file);
  }

  load(page = this.page): void {
    this.loading = true;
    this.error = '';
    this.page = page;
    this.api
      .historyList({
        page: this.page,
        pageSize: this.pageSize,
        market: this.marketFilter || undefined,
      })
      .subscribe({
        next: (res) => {
          this.items = res.items;
          this.total = res.total;
          this.totalPages = res.totalPages;
          this.page = res.page;
          this.loading = false;
        },
        error: (err: unknown) => {
          this.loading = false;
          this.error = this.errMsg(err, 'No se pudo cargar el historial. ¿API en :3847?');
        },
      });
  }

  private errMsg(err: unknown, fallback: string): string {
    if (!err || typeof err !== 'object') return fallback;
    const e = err as { error?: { error?: string }; message?: string };
    return e.error?.error || e.message || fallback;
  }

  setMarket(m: Market | ''): void {
    this.marketFilter = m;
    this.load(1);
  }

  relativeTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return 'hace unos segundos';
    const min = Math.round(sec / 60);
    if (min < 60) return `hace ${min} min`;
    const hrs = Math.round(min / 60);
    if (hrs < 48) return `hace ${hrs} h`;
    const days = Math.round(hrs / 24);
    return `hace ${days} d`;
  }

  absoluteTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  tone(verdict: string | null | undefined): string {
    return verdictTone(verdict);
  }

  itemBias(item: HistoryListItem): string {
    return item.bias ?? resolveRunBias(item.flags, null) ?? 'auto';
  }

  biasClass(value: string | null | undefined): string {
    const t = biasTone(value) || 'neutral';
    return `bias-${t}`;
  }

  biasText(value: string | null | undefined): string {
    return biasLabel(value);
  }

  resultadoClass(value: string | null | undefined): string {
    if (value === 'ganada') return 'res-win';
    if (value === 'perdida') return 'res-lose';
    return 'res-empty';
  }

  isSaving(id: number): boolean {
    return this.savingIds.has(id);
  }

  isImageBusy(id: number): boolean {
    return this.imageBusyIds.has(id);
  }

  resultImageUrl(item: HistoryListItem | HistoryDetail): string | null {
    if (!item.hasResultImage) return null;
    const bust = this.imageBust.get(item.id) ?? item.id;
    return this.api.historyResultImageUrl(item.id, bust);
  }

  onCommentBlur(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
    const next = (el.value || '').trim();
    const prev = (item.comment || '').trim();
    if (next === prev) return;
    this.patchItem(item, { comment: next || null });
  }

  onResultadoChange(item: HistoryListItem, ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    const raw = el.value;
    const next: HistoryResultado | null =
      raw === 'ganada' || raw === 'perdida' ? raw : null;
    if ((item.resultado || null) === next) return;
    this.patchItem(item, { resultado: next });
  }

  private patchItem(
    item: HistoryListItem,
    body: { comment?: string | null; resultado?: HistoryResultado | null }
  ): void {
    this.savingIds.add(item.id);
    this.saveHint = '';
    this.api.historyPatch(item.id, body).subscribe({
      next: (res) => {
        this.savingIds.delete(item.id);
        this.applyItemPatch(item.id, res.item);
        this.saveHint = 'Guardado';
        setTimeout(() => {
          if (this.saveHint === 'Guardado') this.saveHint = '';
        }, 1500);
      },
      error: (err: unknown) => {
        this.savingIds.delete(item.id);
        this.error = this.errMsg(err, 'No se pudo guardar comentario/resultado');
      },
    });
  }

  private applyItemPatch(id: number, updated: HistoryListItem): void {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx >= 0) {
      this.items[idx] = {
        ...this.items[idx],
        comment: updated.comment ?? null,
        resultado: updated.resultado ?? null,
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
      };
    }
    if (this.detail?.id === id) {
      this.detail = {
        ...this.detail,
        comment: updated.comment ?? null,
        resultado: updated.resultado ?? null,
        hasResultImage: updated.hasResultImage ?? false,
        resultImageMime: updated.resultImageMime ?? null,
      };
    }
  }

  onDropZoneDragOver(ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dropActive = true;
  }

  onDropZoneDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.dropActive = false;
  }

  onDropZoneDrop(item: HistoryListItem, ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dropActive = false;
    const file = ev.dataTransfer?.files?.[0];
    if (file) this.uploadResultFile(item, file);
  }

  onFilePicked(item: HistoryListItem, ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.uploadResultFile(item, file);
  }

  private fileFromClipboard(ev: ClipboardEvent): File | null {
    const items = ev.clipboardData?.items;
    if (!items) return null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && IMAGE_TYPES.has(it.type)) {
        return it.getAsFile();
      }
    }
    return null;
  }

  private uploadResultFile(item: HistoryListItem, file: File): void {
    if (!IMAGE_TYPES.has(file.type)) {
      this.error = 'Formato no soportado. Usa PNG, JPG, WebP o GIF.';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.error = 'Imagen demasiado grande (máx. 5 MB).';
      return;
    }
    this.error = '';
    this.imageBusyIds.add(item.id);
    this.saveHint = 'Subiendo captura…';
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      this.api.historyUploadResultImage(item.id, dataUrl, file.type).subscribe({
        next: (res) => {
          this.imageBusyIds.delete(item.id);
          this.imageBust.set(item.id, Date.now());
          this.applyItemPatch(item.id, res.item);
          this.saveHint = 'Captura guardada';
          setTimeout(() => {
            if (this.saveHint === 'Captura guardada') this.saveHint = '';
          }, 1800);
        },
        error: (err: unknown) => {
          this.imageBusyIds.delete(item.id);
          this.saveHint = '';
          this.error = this.errMsg(err, 'No se pudo subir la captura');
        },
      });
    };
    reader.onerror = () => {
      this.imageBusyIds.delete(item.id);
      this.saveHint = '';
      this.error = 'No se pudo leer el archivo';
    };
    reader.readAsDataURL(file);
  }

  removeResultImage(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    if (!item.hasResultImage) return;
    if (!confirm('¿Quitar la captura del resultado?')) return;
    this.imageBusyIds.add(item.id);
    this.api.historyDeleteResultImage(item.id).subscribe({
      next: (res) => {
        this.imageBusyIds.delete(item.id);
        this.imageBust.delete(item.id);
        this.applyItemPatch(item.id, res.item);
        this.saveHint = 'Captura eliminada';
        setTimeout(() => {
          if (this.saveHint === 'Captura eliminada') this.saveHint = '';
        }, 1500);
      },
      error: (err: unknown) => {
        this.imageBusyIds.delete(item.id);
        this.error = this.errMsg(err, 'No se pudo borrar la captura');
      },
    });
  }

  openLightbox(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    const url = this.resultImageUrl(item);
    if (url) this.lightboxUrl = url;
  }

  closeLightbox(): void {
    this.lightboxUrl = null;
  }

  openDetail(item: HistoryListItem): void {
    this.drawerOpen = true;
    this.detailExpanded = true;
    this.detail = null;
    this.detailLoading = true;
    this.detailMode = 'trader';
    this.dropActive = false;
    this.api.historyGet(item.id).subscribe({
      next: (d) => {
        this.detail = d;
        this.detailLoading = false;
      },
      error: (err: unknown) => {
        this.detailLoading = false;
        this.error = this.errMsg(err, 'No se pudo abrir el detalle');
        this.drawerOpen = false;
      },
    });
  }

  toggleDetailExpand(): void {
    this.detailExpanded = !this.detailExpanded;
  }

  closeDetail(): void {
    this.drawerOpen = false;
    this.detail = null;
    this.detailExpanded = true;
    this.dropActive = false;
  }

  deleteOne(item: HistoryListItem, ev?: Event): void {
    ev?.stopPropagation();
    this.unlockKind = 'delete';
    this.unlockItem = item;
    this.unlockPassword = '';
    this.unlockError = '';
    this.unlockOpen = true;
  }

  clearAll(): void {
    this.unlockKind = 'clear';
    this.unlockItem = null;
    this.unlockPassword = '';
    this.unlockError = '';
    this.unlockOpen = true;
  }

  cancelUnlock(): void {
    if (this.unlockBusy) return;
    this.unlockOpen = false;
    this.unlockKind = null;
    this.unlockItem = null;
    this.unlockPassword = '';
    this.unlockError = '';
  }

  confirmUnlock(): void {
    const pwd = (this.unlockPassword || '').trim();
    if (!pwd) {
      this.unlockError = 'Escribe la contraseña';
      return;
    }
    if (this.unlockKind === 'delete' && this.unlockItem) {
      this.unlockBusy = true;
      this.unlockError = '';
      const item = this.unlockItem;
      this.api.historyDelete(item.id, pwd).subscribe({
        next: () => {
          this.unlockBusy = false;
          this.cancelUnlock();
          if (this.detail?.id === item.id) this.closeDetail();
          this.load(this.page);
        },
        error: (err: unknown) => {
          this.unlockBusy = false;
          this.unlockError = this.errMsg(err, 'Contraseña incorrecta o error al borrar');
        },
      });
      return;
    }
    if (this.unlockKind === 'clear') {
      this.unlockBusy = true;
      this.unlockError = '';
      this.clearing = true;
      this.api.historyClear(pwd).subscribe({
        next: () => {
          this.unlockBusy = false;
          this.clearing = false;
          this.cancelUnlock();
          this.closeDetail();
          this.load(1);
        },
        error: (err: unknown) => {
          this.unlockBusy = false;
          this.clearing = false;
          this.unlockError = this.errMsg(err, 'Contraseña incorrecta o error al limpiar');
        },
      });
    }
  }

  unlockTitle(): string {
    if (this.unlockKind === 'clear') return 'Limpiar historial (protegido)';
    if (this.unlockKind === 'delete' && this.unlockItem) {
      return `Borrar #${this.unlockItem.id} (protegido)`;
    }
    return 'Desbloquear borrado';
  }

  unlockHint(): string {
    if (this.unlockKind === 'clear') {
      return 'Se borrará TODO el historial local. Introduce la contraseña de bloqueo.';
    }
    if (this.unlockItem) {
      return `Vas a borrar ${this.unlockItem.market.toUpperCase()} · ${this.unlockItem.tier}. Introduce la contraseña.`;
    }
    return 'Introduce la contraseña de bloqueo.';
  }

  onUnlockPasswordInput(ev: Event): void {
    const el = ev.target as HTMLInputElement;
    this.unlockPassword = el.value;
    this.unlockError = '';
  }

  chartUrlFor(d: HistoryDetail): string | null {
    if (!d.chartPath) return null;
    return `/api/signals/chart?market=${encodeURIComponent(d.market)}`;
  }

  trackById(_index: number, item: HistoryListItem): number {
    return item.id;
  }
}
