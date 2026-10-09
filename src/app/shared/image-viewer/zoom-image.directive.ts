import { Directive, ElementRef, Input, inject } from '@angular/core';
import { ImageViewerService } from './image-viewer.service';

/** Ctrl/Cmd/Shift/clic central conservan el comportamiento nativo (abrir el enlace contenedor en otra pestaña). */
function wantsNativeClick(e: MouseEvent): boolean {
  return e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
}

function imageSource(img: HTMLImageElement): string {
  return img.currentSrc || img.src;
}

/**
 * `<img appZoomImage>`: al tocarla abre el visor a pantalla completa.
 * `appZoomImage="url"` permite mostrar otra URL (p. ej. la versión a resolución completa).
 */
@Directive({
  selector: 'img[appZoomImage]',
  standalone: true,
  host: {
    class: 'zoomable-img',
    role: 'button',
    tabindex: '0',
    '(click)': 'onClick($event)',
    '(keydown.enter)': 'onKey($event)',
    '(keydown.space)': 'onKey($event)',
  },
})
export class ZoomImageDirective {
  private readonly el = inject<ElementRef<HTMLImageElement>>(ElementRef);
  private readonly viewer = inject(ImageViewerService);

  @Input() appZoomImage: string | null | undefined = '';

  onClick(e: MouseEvent): void {
    if (wantsNativeClick(e)) return;
    e.preventDefault();
    e.stopPropagation();
    this.open();
  }

  onKey(e: Event): void {
    e.preventDefault();
    this.open();
  }

  private open(): void {
    const img = this.el.nativeElement;
    this.viewer.open(this.appZoomImage || imageSource(img), img.alt);
  }
}

/** Delegación para HTML inyectado (`[innerHTML]` del wiki): cualquier `<img>` descendiente abre el visor. */
@Directive({
  selector: '[appZoomImagesIn]',
  standalone: true,
  host: {
    class: 'zoom-images-in',
    '(click)': 'onClick($event)',
  },
})
export class ZoomImagesInDirective {
  private readonly viewer = inject(ImageViewerService);

  onClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLImageElement) || wantsNativeClick(e)) return;
    e.preventDefault();
    this.viewer.open(imageSource(target), target.alt);
  }
}
