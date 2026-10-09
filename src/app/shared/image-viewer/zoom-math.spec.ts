import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampTranslate,
  toggleZoom,
  wheelZoomFactor,
  zoomAt,
} from './zoom-math.ts';

describe('zoom-math', () => {
  it('clampScale limita a 1x–5x', () => {
    assert.equal(clampScale(0.3), MIN_SCALE);
    assert.equal(clampScale(9), MAX_SCALE);
    assert.equal(clampScale(2.2), 2.2);
    assert.equal(clampScale(Number.NaN), MIN_SCALE);
  });

  it('zoomAt mantiene fijo el punto bajo el dedo', () => {
    const start = { scale: 1, tx: 0, ty: 0 };
    const next = zoomAt(start, 2, 100, -50);
    // píxel de imagen bajo (100,-50) antes y después
    const before = { x: (100 - start.tx) / start.scale, y: (-50 - start.ty) / start.scale };
    const after = { x: (100 - next.tx) / next.scale, y: (-50 - next.ty) / next.scale };
    assert.deepEqual(after, before);
    assert.equal(next.scale, 2);
  });

  it('clampTranslate centra a 1x y limita el pan ampliado', () => {
    const image = { width: 400, height: 300 };
    const stage = { width: 400, height: 600 };
    assert.deepEqual(clampTranslate({ scale: 1, tx: 80, ty: -40 }, image, stage), { scale: 1, tx: 0, ty: 0 });
    const zoomed = clampTranslate({ scale: 3, tx: 9999, ty: -9999 }, image, stage);
    assert.equal(zoomed.tx, 400);
    assert.equal(zoomed.ty, -150);
  });

  it('toggleZoom alterna 1x ↔ 2.5x', () => {
    const z = toggleZoom({ scale: 1, tx: 0, ty: 0 }, 0, 0);
    assert.equal(z.scale, 2.5);
    assert.deepEqual(toggleZoom(z, 30, 30), { scale: 1, tx: 0, ty: 0 });
  });

  it('wheelZoomFactor amplía hacia arriba y reduce hacia abajo', () => {
    assert.ok(wheelZoomFactor(-100, 0) > 1);
    assert.ok(wheelZoomFactor(100, 0) < 1);
    assert.ok(wheelZoomFactor(3, 1) < wheelZoomFactor(3, 0));
  });
});
