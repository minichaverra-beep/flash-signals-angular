/** Geometría del visor: coordenadas relativas al centro del escenario, transform `translate(t) scale(s)` con origen en el centro. */

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2.5;

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

export interface Size {
  width: number;
  height: number;
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Escala a `nextScale` manteniendo fijo bajo el punto (px, py) el mismo píxel de la imagen. */
export function zoomAt(state: ZoomState, nextScale: number, px: number, py: number): ZoomState {
  const scale = clampScale(nextScale);
  const k = scale / state.scale;
  return {
    scale,
    tx: px - (px - state.tx) * k,
    ty: py - (py - state.ty) * k,
  };
}

/** Impide que la imagen ampliada se separe de los bordes; a 1x queda centrada. */
export function clampTranslate(state: ZoomState, image: Size, stage: Size): ZoomState {
  const maxX = Math.max(0, (image.width * state.scale - stage.width) / 2);
  const maxY = Math.max(0, (image.height * state.scale - stage.height) / 2);
  return {
    scale: state.scale,
    tx: Math.min(maxX, Math.max(-maxX, state.tx)) || 0,
    ty: Math.min(maxY, Math.max(-maxY, state.ty)) || 0,
  };
}

/** Doble tap: desde ~1x amplía a 2.5x en el punto tocado; si ya está ampliada vuelve a 1x. */
export function toggleZoom(state: ZoomState, px: number, py: number): ZoomState {
  if (state.scale > MIN_SCALE + 0.01) return { scale: MIN_SCALE, tx: 0, ty: 0 };
  return zoomAt(state, DOUBLE_TAP_SCALE, px, py);
}

/** Factor de zoom para un evento de rueda (deltaMode 0 = píxeles, 1 = líneas, 2 = páginas). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * 0.0015);
}
