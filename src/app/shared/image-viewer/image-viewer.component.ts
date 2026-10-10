import { Component, ElementRef, NgZone, OnDestroy, ViewChild, inject } from '@angular/core';
import { DownloadService } from '../../services/download.service';
import { ImageViewerService } from './image-viewer.service';
import {
  MIN_SCALE,
  type ZoomState,
  clampScale,
  clampTranslate,
  toggleZoom,
  wheelZoomFactor,
  zoomAt,
} from './zoom-math';

interface Point {
  x: number;
  y: number;
}

type Gesture =
  | { kind: 'pan'; start: Point; origin: ZoomState }
  | { kind: 'pinch'; dist: number; mid: Point; origin: ZoomState };

const TAP_SLOP_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;
const BUTTON_ZOOM_STEP = 1.5;

/** Visor a pantalla completa: pinch / doble tap / pan en táctil, rueda + arrastre en escritorio. */
@Component({
  selector: 'app-image-viewer',
  standalone: true,
  templateUrl: './image-viewer.component.html',
  styleUrl: './image-viewer.component.scss',
})
export class ImageViewerComponent implements OnDestroy {
  readonly viewer = inject(ImageViewerService);
  private readonly zone = inject(NgZone);

  /** En el WebView del APK un enlace a la imagen sustituiría la app entera: ahí no se ofrece. */
  readonly showOpenOriginal = typeof navigator === 'undefined' || !/\bwv\b/.test(navigator.userAgent);
  loadFailed = false;
  downloading = false;
  private readonly downloads = inject(DownloadService);

  private stage: HTMLElement | null = null;
  private image: HTMLImageElement | null = null;
  private state: ZoomState = { scale: MIN_SCALE, tx: 0, ty: 0 };
  private readonly pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private tap: { start: Point; onImage: boolean; moved: boolean } | null = null;
  private lastTap: { at: Point; time: number } | null = null;
  private clickClosesAllowed = false;
  private detachStage: (() => void) | null = null;

  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (!this.viewer.current()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.zoomIn();
    } else if (e.key === '-') {
      e.preventDefault();
      this.zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      this.resetZoom();
    }
  };

  constructor() {
    // Captura en window: el Escape del visor no debe llegar a los @HostListener de las páginas.
    window.addEventListener('keydown', this.onKeydown, true);
  }

  @ViewChild('stage')
  set stageRef(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement ?? null;
    if (el === this.stage) return;
    this.detachStage?.();
    this.detachStage = null;
    this.stage = el;
    if (el) this.attachStage(el);
  }

  @ViewChild('image')
  set imageRef(ref: ElementRef<HTMLImageElement> | undefined) {
    const el = ref?.nativeElement ?? null;
    if (el === this.image) return;
    this.image = el;
    this.loadFailed = false;
    this.reset();
  }

  @ViewChild('closeBtn')
  set closeBtnRef(ref: ElementRef<HTMLButtonElement> | undefined) {
    ref?.nativeElement.focus({ preventScroll: true });
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKeydown, true);
    this.detachStage?.();
  }

  close(): void {
    this.viewer.close();
  }

  /** Guarda la imagen abierta: Descargas en el APK (puente nativo), descarga normal en el navegador. */
  download(): void {
    const img = this.viewer.current();
    if (!img || this.downloading) return;
    this.downloading = true;
    void this.downloads.saveUrl(img.src).finally(() => {
      this.downloading = false;
    });
  }

  zoomIn(): void {
    this.setState(zoomAt(this.state, this.state.scale * BUTTON_ZOOM_STEP, 0, 0), true);
  }

  zoomOut(): void {
    this.setState(zoomAt(this.state, this.state.scale / BUTTON_ZOOM_STEP, 0, 0), true);
  }

  resetZoom(): void {
    this.setState({ scale: MIN_SCALE, tx: 0, ty: 0 }, true);
  }

  onImageLoad(): void {
    this.loadFailed = false;
    this.reset();
  }

  onImageError(): void {
    this.loadFailed = true;
  }

  private attachStage(stage: HTMLElement): void {
    this.zone.runOutsideAngular(() => {
      const active: AddEventListenerOptions = { passive: false };
      const down = (e: PointerEvent) => this.onPointerDown(e);
      const move = (e: PointerEvent) => this.onPointerMove(e);
      const up = (e: PointerEvent) => this.onPointerUp(e);
      const wheel = (e: WheelEvent) => this.onWheel(e);
      const dbl = (e: MouseEvent) => this.onDoubleClick(e);
      const click = (e: MouseEvent) => this.onStageClick(e);
      const block = (e: Event) => e.preventDefault();
      const resize = () => this.setState(this.state);

      stage.addEventListener('pointerdown', down, active);
      stage.addEventListener('pointermove', move, active);
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
      stage.addEventListener('wheel', wheel, active);
      stage.addEventListener('dblclick', dbl);
      stage.addEventListener('click', click);
      stage.addEventListener('gesturestart', block, active);
      window.addEventListener('resize', resize);

      this.detachStage = () => {
        stage.removeEventListener('pointerdown', down);
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        stage.removeEventListener('pointercancel', up);
        stage.removeEventListener('wheel', wheel);
        stage.removeEventListener('dblclick', dbl);
        stage.removeEventListener('click', click);
        stage.removeEventListener('gesturestart', block);
        window.removeEventListener('resize', resize);
      };
    });
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      this.stage?.setPointerCapture(e.pointerId);
    } catch {
      /* puntero ya liberado */
    }
    const p = this.toLocal(e);
    this.pointers.set(e.pointerId, p);
    this.setAnimated(false);
    if (this.pointers.size === 1) {
      this.tap = { start: p, onImage: e.target === this.image, moved: false };
      this.beginPan(p);
    } else {
      this.tap = null;
      this.beginPinch();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.toLocal(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;

    if (g.kind === 'pinch') {
      const pair = this.firstTwoPointers();
      if (!pair) return;
      const [a, b] = pair;
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = clampScale((g.origin.scale * dist) / g.dist);
      const k = scale / g.origin.scale;
      this.setState({
        scale,
        tx: mid.x - (g.mid.x - g.origin.tx) * k,
        ty: mid.y - (g.mid.y - g.origin.ty) * k,
      });
      return;
    }

    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (this.tap && Math.hypot(dx, dy) > TAP_SLOP_PX) this.tap.moved = true;
    if (g.origin.scale <= MIN_SCALE + 0.001) return;
    this.setState({ scale: g.origin.scale, tx: g.origin.tx + dx, ty: g.origin.ty + dy });
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size >= 2) {
      this.beginPinch();
      return;
    }
    if (this.pointers.size === 1) {
      const [rest] = this.pointers.values();
      this.beginPan(rest);
      return;
    }

    this.gesture = null;
    const tap = this.tap;
    this.tap = null;
    this.clickClosesAllowed = false;
    if (e.type !== 'pointerup' || !tap || tap.moved) return;

    if (e.pointerType !== 'mouse') {
      const now = performance.now();
      const prev = this.lastTap;
      if (
        prev &&
        now - prev.time < DOUBLE_TAP_MS &&
        Math.hypot(tap.start.x - prev.at.x, tap.start.y - prev.at.y) < DOUBLE_TAP_SLOP_PX
      ) {
        this.lastTap = null;
        this.setState(toggleZoom(this.state, tap.start.x, tap.start.y), true);
        return;
      }
      this.lastTap = { at: tap.start, time: now };
    }
    this.clickClosesAllowed = !tap.onImage;
  }

  /** Cierra en `click` (no en pointerup) para que el tap no atraviese al contenido de debajo. */
  private onStageClick(e: MouseEvent): void {
    const allowed = this.clickClosesAllowed;
    this.clickClosesAllowed = false;
    if (allowed && e.target !== this.image) this.zone.run(() => this.close());
  }

  private onDoubleClick(e: MouseEvent): void {
    if (e.target !== this.image) return;
    const p = this.toLocal(e);
    this.setState(toggleZoom(this.state, p.x, p.y), true);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.toLocal(e);
    const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
    this.setState(zoomAt(this.state, this.state.scale * factor, p.x, p.y));
  }

  private beginPan(start: Point): void {
    this.gesture = { kind: 'pan', start, origin: { ...this.state } };
  }

  private beginPinch(): void {
    const pair = this.firstTwoPointers();
    if (!pair) return;
    const [a, b] = pair;
    this.gesture = {
      kind: 'pinch',
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      origin: { ...this.state },
    };
  }

  private firstTwoPointers(): [Point, Point] | null {
    const it = this.pointers.values();
    const a = it.next();
    const b = it.next();
    return a.done || b.done ? null : [a.value, b.value];
  }

  /** Coordenadas relativas al centro del escenario (= centro de la imagen sin transformar). */
  private toLocal(e: { clientX: number; clientY: number }): Point {
    const r = this.stage?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
  }

  private setState(next: ZoomState, animate = false): void {
    this.setAnimated(animate);
    const img = this.image;
    const stage = this.stage;
    this.state =
      img && stage
        ? clampTranslate(
            next,
            { width: img.offsetWidth, height: img.offsetHeight },
            { width: stage.clientWidth, height: stage.clientHeight }
          )
        : next;
    this.apply();
  }

  private setAnimated(on: boolean): void {
    this.image?.classList.toggle('is-animating', on);
  }

  private apply(): void {
    const { scale, tx, ty } = this.state;
    if (this.image) this.image.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    this.stage?.classList.toggle('is-zoomed', scale > MIN_SCALE + 0.01);
  }

  private reset(): void {
    this.pointers.clear();
    this.gesture = null;
    this.tap = null;
    this.lastTap = null;
    this.clickClosesAllowed = false;
    this.state = { scale: MIN_SCALE, tx: 0, ty: 0 };
    this.setAnimated(false);
    this.apply();
  }
}
