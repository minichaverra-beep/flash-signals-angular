import { CommonModule } from '@angular/common';
import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  ArtifactItem,
  ArtifactDetail,
  WikiCategory,
  SignalsApiService,
} from '../../services/signals-api.service';

export interface WikiGroup {
  id: number | null;
  name: string;
  color: string | null;
  items: ArtifactItem[];
}

@Component({
  selector: 'app-wiki',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive],
  templateUrl: './wiki.component.html',
  styleUrl: './wiki.component.scss',
})
export class WikiComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
  private readonly sanitizer = inject(DomSanitizer);

  items: ArtifactItem[] = [];
  categories: WikiCategory[] = [];
  selected: ArtifactItem | null = null;
  detail: ArtifactDetail | null = null;
  loading = false;
  detailLoading = false;
  error = '';
  filter = '';
  renderedHtml: SafeHtml | null = null;
  iframeUrl: SafeResourceUrl | null = null;
  imageUrl: string | null = null;
  pdfUrl: SafeResourceUrl | null = null;
  pdfHref: string | null = null;
  textContent: string | null = null;
  /** Overlay de lectura a viewport completa (con o sin Fullscreen API). */
  expanded = false;

  /** Inline edit del título display. */
  editingTitle = false;
  editTitleValue = '';
  renameOnDisk = false;
  savingMeta = false;

  /** Panel de gestión de categorías. */
  showCatManager = false;
  newCatName = '';
  newCatColor = '';
  renameCatId: number | null = null;
  renameCatValue = '';
  catBusy = false;

  /** Picker Asignar / Cambiar categoría (panel o menú sidebar). */
  catPickerOpen = false;
  catPickerPath: string | null = null;
  /** Menú contextual del ítem en el sidebar. */
  sidebarMenuPath: string | null = null;
  /** Formulario rápido «Nueva categoría» (sidebar / panel). */
  quickCreateOpen = false;
  quickCreateName = '';
  /** Tras crear, asignar al artefacto del picker (si hay). */
  assignAfterCreate = false;

  ngOnInit(): void {
    this.scan();
  }

  ngOnDestroy(): void {
    this.exitExpand();
  }

  get filtered(): ArtifactItem[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((i) => {
      const title = this.displayTitle(i).toLowerCase();
      return (
        title.includes(q) ||
        i.name.toLowerCase().includes(q) ||
        i.path.toLowerCase().includes(q) ||
        i.kind.toLowerCase().includes(q)
      );
    });
  }

  /** Sidebar agrupado por categoría (+ Sin categoría). */
  get grouped(): WikiGroup[] {
    const filtered = this.filtered;
    const byId = new Map<number | null, ArtifactItem[]>();
    for (const item of filtered) {
      const key = item.categoryId ?? null;
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key)!.push(item);
    }

    const groups: WikiGroup[] = [];
    const sortedCats = [...this.categories].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id - b.id
    );
    for (const cat of sortedCats) {
      const items = byId.get(cat.id) || [];
      if (items.length) {
        groups.push({
          id: cat.id,
          name: cat.name,
          color: cat.color ?? null,
          items,
        });
      }
      byId.delete(cat.id);
    }
    const uncategorized = byId.get(null) || [];
    for (const [id, items] of byId) {
      if (id == null) continue;
      groups.push({
        id,
        name: `Categoría #${id}`,
        color: null,
        items,
      });
    }
    groups.push({
      id: null,
      name: 'Sin categoría',
      color: null,
      items: uncategorized,
    });
    return groups.filter((g) => g.items.length > 0);
  }

  get canExpand(): boolean {
    return (
      !this.detailLoading &&
      !!(
        this.renderedHtml ||
        this.iframeUrl ||
        this.imageUrl ||
        this.pdfUrl ||
        this.textContent != null
      )
    );
  }

  /** Extensiones de artefacto que no se muestran en títulos / rename. */
  private static readonly DISPLAY_STRIP_EXTS = new Set([
    '.md',
    '.txt',
    '.html',
    '.htm',
    '.json',
    '.csv',
    '.log',
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
  ]);

  /** Nombre visible sin extensión (.md, .html, .pdf, …). */
  stripDisplayExtension(raw: string | null | undefined): string {
    if (raw == null) return '';
    const s = String(raw).trim();
    if (!s) return '';
    const dot = s.lastIndexOf('.');
    if (dot <= 0) return s;
    const ext = s.slice(dot).toLowerCase();
    if (WikiComponent.DISPLAY_STRIP_EXTS.has(ext)) {
      return s.slice(0, dot);
    }
    return s;
  }

  displayTitle(item: ArtifactItem | null | undefined): string {
    if (!item) return '';
    const raw = item.displayName || item.name;
    return this.stripDisplayExtension(raw);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.quickCreateOpen) {
      this.closeQuickCreate();
      return;
    }
    if (this.catPickerOpen) {
      this.closeCatPicker();
      return;
    }
    if (this.sidebarMenuPath) {
      this.sidebarMenuPath = null;
      return;
    }
    if (this.editingTitle) {
      this.cancelEditTitle();
      return;
    }
    if (this.expanded) {
      this.exitExpand();
    }
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.sidebarMenuPath) {
      this.sidebarMenuPath = null;
    }
  }

  /** Copy: Asignar vs Cambiar según tenga categoría. */
  categoryActionLabel(item: ArtifactItem | null | undefined): string {
    return item?.categoryId != null
      ? 'Cambiar categoría'
      : 'Asignar a la categoría';
  }

  categoryName(id: number | null | undefined): string {
    if (id == null) return 'Sin categoría';
    return this.categories.find((c) => c.id === id)?.name ?? `Categoría #${id}`;
  }

  categoryColor(id: number | null | undefined): string {
    if (id == null) return 'transparent';
    return this.categories.find((c) => c.id === id)?.color || 'transparent';
  }

  openCatPicker(item: ArtifactItem, event?: Event): void {
    event?.stopPropagation();
    this.sidebarMenuPath = null;
    this.catPickerPath = item.path;
    this.catPickerOpen = true;
    if (this.selected?.path !== item.path) {
      this.open(item);
    }
  }

  closeCatPicker(): void {
    this.catPickerOpen = false;
    this.catPickerPath = null;
    this.assignAfterCreate = false;
    if (this.quickCreateOpen && !this.showCatManager) {
      this.closeQuickCreate();
    }
  }

  toggleSidebarMenu(item: ArtifactItem, event: Event): void {
    event.stopPropagation();
    this.sidebarMenuPath =
      this.sidebarMenuPath === item.path ? null : item.path;
  }

  openQuickCreate(opts: { assignAfter?: boolean; openPicker?: boolean } = {}, event?: Event): void {
    event?.stopPropagation();
    this.quickCreateOpen = true;
    this.quickCreateName = '';
    this.assignAfterCreate = !!opts.assignAfter;
    if (opts.openPicker && this.selected && !this.catPickerOpen) {
      this.catPickerPath = this.selected.path;
      this.catPickerOpen = true;
    }
    if (opts.assignAfter && this.catPickerPath) {
      this.assignAfterCreate = true;
    }
  }

  closeQuickCreate(): void {
    this.quickCreateOpen = false;
    this.quickCreateName = '';
    this.assignAfterCreate = false;
  }

  scan(): void {
    this.loading = true;
    this.error = '';
    this.api.artifactsScan().subscribe({
      next: (res) => {
        this.items = res.items ?? [];
        this.categories = res.categories ?? [];
        this.loading = false;
        if (this.selected) {
          const selectedPath = this.selected.path;
          const still = this.items.find((i) => i.path === selectedPath);
          if (still) {
            this.open(still);
          } else {
            this.clearPreview();
          }
        } else if (this.items.length) {
          const prefer =
            this.items.find((i) => i.name === 'README.md') ?? this.items[0];
          this.open(prefer);
        }
      },
      error: (err) => {
        this.loading = false;
        this.error =
          err?.error?.error ||
          err?.message ||
          'No se pudo escanear artefactos. ¿API en :3847?';
      },
    });
  }

  trackByPath(_index: number, item: ArtifactItem): string {
    return item.path;
  }

  trackByGroup(_index: number, g: WikiGroup): string {
    return g.id == null ? 'none' : String(g.id);
  }

  open(item: ArtifactItem): void {
    if (this.catPickerPath && this.catPickerPath !== item.path) {
      this.closeCatPicker();
    }
    this.sidebarMenuPath = null;
    this.selected = item;
    this.editingTitle = false;
    this.detailLoading = true;
    this.detail = null;
    this.renderedHtml = null;
    this.iframeUrl = null;
    this.imageUrl = null;
    this.pdfUrl = null;
    this.pdfHref = null;
    this.textContent = null;

    this.api.artifactGet(item.path).subscribe({
      next: (d) => {
        this.detail = d;
        this.selected = { ...item, ...d };
        this.detailLoading = false;
        this.renderDetail(d);
      },
      error: (err) => {
        this.detailLoading = false;
        this.error =
          err?.error?.error || err?.message || 'No se pudo abrir el artefacto';
      },
    });
  }

  startEditTitle(): void {
    if (!this.selected) return;
    this.editingTitle = true;
    this.editTitleValue = this.displayTitle(this.selected);
    this.renameOnDisk = false;
  }

  /** Valor a persistir como display_name (sin extensión). */
  private titleForSave(raw: string): string {
    return this.stripDisplayExtension(raw.trim());
  }

  cancelEditTitle(): void {
    this.editingTitle = false;
    this.editTitleValue = '';
    this.renameOnDisk = false;
  }

  saveTitle(): void {
    if (!this.selected || this.savingMeta) return;
    const name = this.titleForSave(this.editTitleValue);
    if (!name) {
      this.error = 'El nombre no puede estar vacío';
      return;
    }
    this.savingMeta = true;
    this.error = '';
    const oldPath = this.selected.path;
    this.api
      .artifactPatchMeta({
        path: oldPath,
        displayName: name,
        renameFile: this.renameOnDisk,
      })
      .subscribe({
        next: (res) => {
          this.savingMeta = false;
          this.editingTitle = false;
          const newPath = res.path || oldPath;
          this.patchLocalItem(oldPath, {
            path: newPath,
            displayName: res.meta.displayName,
            categoryId: res.meta.categoryId,
            name: res.pathChanged
              ? newPath.split('/').pop() || this.selected!.name
              : this.selected!.name,
          });
          if (this.selected) {
            this.selected = {
              ...this.selected,
              path: newPath,
              displayName: res.meta.displayName,
              categoryId: res.meta.categoryId,
              name: res.pathChanged
                ? newPath.split('/').pop() || this.selected.name
                : this.selected.name,
            };
          }
          if (this.detail) {
            this.detail = {
              ...this.detail,
              path: newPath,
              displayName: res.meta.displayName,
              categoryId: res.meta.categoryId,
              rawUrl: `/api/artifacts/raw?path=${encodeURIComponent(newPath)}`,
            };
          }
        },
        error: (err) => {
          this.savingMeta = false;
          this.error =
            err?.error?.error || err?.message || 'No se pudo guardar el nombre';
        },
      });
  }

  moveToCategory(categoryId: number | null, itemPath?: string): void {
    const path = itemPath || this.catPickerPath || this.selected?.path;
    if (!path || this.savingMeta) return;
    const current = this.items.find((i) => i.path === path);
    if (current && (current.categoryId ?? null) === (categoryId ?? null)) {
      this.closeCatPicker();
      this.sidebarMenuPath = null;
      return;
    }
    this.savingMeta = true;
    this.error = '';
    this.api
      .artifactPatchMeta({
        path,
        categoryId,
      })
      .subscribe({
        next: (res) => {
          this.savingMeta = false;
          this.patchLocalItem(path, {
            categoryId: res.meta.categoryId,
            displayName: res.meta.displayName,
          });
          if (this.selected?.path === path) {
            this.selected = {
              ...this.selected,
              categoryId: res.meta.categoryId,
              displayName: res.meta.displayName,
            };
          }
          this.closeCatPicker();
          this.sidebarMenuPath = null;
        },
        error: (err) => {
          this.savingMeta = false;
          this.error =
            err?.error?.error || err?.message || 'No se pudo mover el artefacto';
        },
      });
  }

  removeFromCategory(itemPath?: string): void {
    this.moveToCategory(null, itemPath);
  }

  createCategory(fromQuick = false): void {
    const name = (fromQuick ? this.quickCreateName : this.newCatName).trim();
    if (!name || this.catBusy) return;
    this.catBusy = true;
    this.error = '';
    const color = fromQuick ? null : this.newCatColor.trim() || null;
    const shouldAssign = fromQuick && this.assignAfterCreate && !!this.catPickerPath;
    const assignPath = this.catPickerPath;
    this.api
      .wikiCategoryCreate({
        name,
        color,
      })
      .subscribe({
        next: (res) => {
          this.catBusy = false;
          this.categories = [...this.categories, res.category].sort(
            (a, b) => a.sortOrder - b.sortOrder || a.id - b.id
          );
          if (fromQuick) {
            this.quickCreateName = '';
            this.quickCreateOpen = false;
            this.assignAfterCreate = false;
          } else {
            this.newCatName = '';
            this.newCatColor = '';
          }
          if (shouldAssign && assignPath) {
            this.moveToCategory(res.category.id, assignPath);
          }
        },
        error: (err) => {
          this.catBusy = false;
          this.error =
            err?.error?.error || err?.message || 'No se pudo crear la categoría';
        },
      });
  }

  startRenameCategory(cat: WikiCategory): void {
    this.renameCatId = cat.id;
    this.renameCatValue = cat.name;
  }

  saveRenameCategory(): void {
    if (this.renameCatId == null || this.catBusy) return;
    const name = this.renameCatValue.trim();
    if (!name) return;
    this.catBusy = true;
    this.api.wikiCategoryPatch(this.renameCatId, { name }).subscribe({
      next: (res) => {
        this.catBusy = false;
        this.categories = this.categories.map((c) =>
          c.id === res.category.id ? res.category : c
        );
        this.renameCatId = null;
        this.renameCatValue = '';
      },
      error: (err) => {
        this.catBusy = false;
        this.error =
          err?.error?.error || err?.message || 'No se pudo renombrar';
      },
    });
  }

  deleteCategory(cat: WikiCategory): void {
    if (this.catBusy) return;
    const used = this.items.some((i) => i.categoryId === cat.id);
    const msg = used
      ? `«${cat.name}» tiene artefactos. ¿Vaciar a «Sin categoría» y borrar?`
      : `¿Borrar la categoría «${cat.name}»?`;
    if (!confirm(msg)) return;
    this.catBusy = true;
    this.api
      .wikiCategoryDelete(cat.id, used ? { reassignTo: null } : {})
      .subscribe({
        next: () => {
          this.catBusy = false;
          this.categories = this.categories.filter((c) => c.id !== cat.id);
          if (used) {
            this.items = this.items.map((i) =>
              i.categoryId === cat.id ? { ...i, categoryId: null } : i
            );
            if (this.selected?.categoryId === cat.id) {
              this.selected = { ...this.selected, categoryId: null };
            }
          }
        },
        error: (err) => {
          this.catBusy = false;
          this.error =
            err?.error?.error || err?.message || 'No se pudo borrar la categoría';
        },
      });
  }

  async enterExpand(): Promise<void> {
    if (!this.canExpand || this.expanded) return;
    this.expanded = true;
    document.body.style.overflow = 'hidden';
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* Overlay fixed basta si el browser deniega Fullscreen API */
    }
  }

  exitExpand(restoreBody = true): void {
    if (!this.expanded && !document.fullscreenElement) {
      if (restoreBody) document.body.style.overflow = '';
      return;
    }
    this.expanded = false;
    if (restoreBody) document.body.style.overflow = '';
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => undefined);
    }
  }

  private patchLocalItem(path: string, patch: Partial<ArtifactItem>): void {
    this.items = this.items.map((i) =>
      i.path === path ? { ...i, ...patch } : i
    );
  }

  private clearPreview(): void {
    this.exitExpand();
    this.selected = null;
    this.detail = null;
    this.editingTitle = false;
    this.renderedHtml = null;
    this.iframeUrl = null;
    this.imageUrl = null;
    this.pdfUrl = null;
    this.pdfHref = null;
    this.textContent = null;
  }

  private renderDetail(d: ArtifactDetail): void {
    const raw = d.rawUrl || `/api/artifacts/raw?path=${encodeURIComponent(d.path)}`;

    if (d.kind === 'markdown' && d.content != null) {
      const html = marked.parse(d.content, { async: false }) as string;
      const clean = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
      });
      this.renderedHtml = this.sanitizer.bypassSecurityTrustHtml(clean);
      return;
    }

    if (d.kind === 'html') {
      this.iframeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(raw);
      return;
    }

    if (d.kind === 'image') {
      this.imageUrl = raw;
      return;
    }

    if (d.kind === 'pdf') {
      this.pdfHref = raw;
      this.pdfUrl = this.sanitizer.bypassSecurityTrustResourceUrl(raw);
      return;
    }

    if ((d.kind === 'text' || d.kind === 'other') && d.content != null) {
      this.textContent = d.content;
      return;
    }

    if (d.content != null) {
      this.textContent = d.content;
    }
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  formatMtime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  kindLabel(kind: string): string {
    const map: Record<string, string> = {
      markdown: 'MD',
      html: 'HTML',
      image: 'IMG',
      pdf: 'PDF',
      text: 'TXT',
      other: 'BIN',
    };
    return map[kind] || kind.toUpperCase();
  }
}
