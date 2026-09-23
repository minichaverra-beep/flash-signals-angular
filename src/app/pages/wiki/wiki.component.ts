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
  SignalsApiService,
} from '../../services/signals-api.service';

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

  ngOnInit(): void {
    this.scan();
  }

  ngOnDestroy(): void {
    this.exitExpand();
  }

  get filtered(): ArtifactItem[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.path.toLowerCase().includes(q) ||
        i.kind.toLowerCase().includes(q)
    );
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

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.expanded) {
      this.exitExpand();
    }
  }

  scan(): void {
    this.loading = true;
    this.error = '';
    this.api.artifactsList().subscribe({
      next: (res) => {
        this.items = res.items ?? [];
        this.loading = false;
        if (this.selected) {
          const still = this.items.find((i) => i.path === this.selected!.path);
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

  open(item: ArtifactItem): void {
    this.selected = item;
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

  private clearPreview(): void {
    this.exitExpand();
    this.selected = null;
    this.detail = null;
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
