import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canShowParams, isSentLegFinished } from './historial-params-visibility.ts';

type State = 'pending' | 'open' | 'closed' | 'canceled' | 'expired' | null | undefined;
const sent = (state: State, duplicate?: { state: State }) => ({ state, duplicate }) as never;

describe('historial-params-visibility (botón «Parámetros»)', () => {
  it('isSentLegFinished: cerrada/cancelada/expirada terminan; pendiente/abierta/sin leer siguen vivas', () => {
    for (const s of ['closed', 'canceled', 'expired'] as const) assert.equal(isSentLegFinished({ state: s }), true, s);
    for (const s of ['pending', 'open', null, undefined] as const) assert.equal(isSentLegFinished({ state: s }), false, String(s));
    assert.equal(isSentLegFinished(null), false);
  });

  it('se muestra mientras la original siga viva y la fila no tenga resultado', () => {
    assert.equal(canShowParams(null, sent('open'), false), true);
    assert.equal(canShowParams(undefined, sent('pending'), false), true);
    assert.equal(canShowParams(null, sent(null), false), true); // enviada, aún sin Recalcular
    assert.equal(canShowParams('no_tomada', sent('open'), false), true);
  });

  it('se oculta si la operación terminó en MT5', () => {
    assert.equal(canShowParams(null, sent('closed'), false), false);
    assert.equal(canShowParams(null, sent('canceled'), false), false);
    assert.equal(canShowParams(null, sent('expired'), false), false);
    assert.equal(canShowParams(null, sent('closed', { state: 'closed' }), false), false);
    assert.equal(canShowParams(null, sent('closed', { state: 'expired' }), false), false);
  });

  it('original cerrada pero duplicada viva: se sigue mostrando', () => {
    assert.equal(canShowParams(null, sent('closed', { state: 'open' }), false), true);
    assert.equal(canShowParams(null, sent('expired', { state: 'pending' }), false), true);
    assert.equal(canShowParams(null, sent('closed', { state: null }), false), true);
  });

  it('se oculta con resultado ganada/perdida aunque MT5 no haya cerrado', () => {
    assert.equal(canShowParams('ganada', sent('open'), false), false);
    assert.equal(canShowParams('perdida', sent('open', { state: 'pending' }), false), false);
  });

  it('se oculta en filas bloqueadas o sin envío', () => {
    assert.equal(canShowParams(null, sent('open'), true), false);
    assert.equal(canShowParams(null, null, false), false);
    assert.equal(canShowParams(null, undefined, false), false);
  });
});
