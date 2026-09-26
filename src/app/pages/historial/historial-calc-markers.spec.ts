/**
 * Unit tests: mergeCalcMarkersIntoRows — barras de cambio de cálculo en el grid.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeCalcMarkersIntoRows } from './historial-calc-markers.ts';

describe('mergeCalcMarkersIntoRows', () => {
  it('pone señales nuevas encima de la barra y viejas debajo', () => {
    const items = [
      { id: 3, createdAt: '2026-09-25T20:00:00.000Z' },
      { id: 2, createdAt: '2026-09-25T18:00:00.000Z' },
      { id: 1, createdAt: '2026-09-25T10:00:00.000Z' },
    ];
    const markers = [
      {
        id: 9,
        createdAt: '2026-09-25T19:00:00.000Z',
        title: 'Cálculo v2',
        comment: 'Entry/SL + acuerdo',
      },
    ];
    const rows = mergeCalcMarkersIntoRows(items, markers, { isLastPage: true });
    assert.equal(rows.length, 4);
    assert.equal(rows[0].kind, 'signal');
    assert.equal(rows[0].kind === 'signal' && rows[0].item.id, 3);
    assert.equal(rows[1].kind, 'calc_marker');
    assert.equal(rows[1].kind === 'calc_marker' && rows[1].marker.title, 'Cálculo v2');
    assert.equal(rows[2].kind === 'signal' && rows[2].item.id, 2);
    assert.equal(rows[3].kind === 'signal' && rows[3].item.id, 1);
  });

  it('muestra barra arriba si aún no hay señales posteriores', () => {
    const items = [{ id: 1, createdAt: '2026-09-20T10:00:00.000Z' }];
    const markers = [
      { id: 1, createdAt: '2026-09-25T19:45:00.000Z', title: 'Ahora' },
    ];
    const rows = mergeCalcMarkersIntoRows(items, markers, { isLastPage: true });
    assert.equal(rows[0].kind, 'calc_marker');
    assert.equal(rows[1].kind, 'signal');
  });
});
