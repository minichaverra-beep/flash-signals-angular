import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shotCaption } from './historial-shot-caption.ts';
import type { Mt5SentEntry } from '../../services/signals-api.service';

const base: Mt5SentEntry = {
  at: '2026-10-07T16:30:00Z', symbol: 'XAUUSDm', side: 'LONG', mode: 'pending',
  volume: 0.01, price: 4110.89, sl: 4103.09, tp: 4121.87, order: 1, deal: null,
};

describe('shotCaption', () => {
  it('ganada con original y duplicada en TP → total en $ y TP', () => {
    const sent: Mt5SentEntry = {
      ...base, state: 'closed', closeReason: 'tp', profit: 10.98,
      duplicate: { ...base, order: 2, state: 'closed', closeReason: 'tp', profit: 10.99 },
    };
    assert.deepEqual(shotCaption('ganada', 21.97, sent), { text: '+21.97 $ · TP', tone: 'pos' });
  });

  it('perdida por SL', () => {
    const sent: Mt5SentEntry = { ...base, state: 'closed', closeReason: 'sl', profit: -7.8 };
    assert.deepEqual(shotCaption('perdida', -7.8, sent), { text: '-7.80 $ · SL', tone: 'neg' });
  });

  it('original TP y duplicada SL', () => {
    const sent: Mt5SentEntry = {
      ...base, state: 'closed', closeReason: 'tp', profit: 11,
      duplicate: { ...base, order: 2, state: 'closed', closeReason: 'sl', profit: -7 },
    };
    assert.equal(shotCaption('ganada', 4, sent)?.text, '+4.00 $ · TP + SL');
  });

  it('estados sin resultado: esperando, en curso, expirada, cancelada', () => {
    assert.deepEqual(shotCaption(null, null, { ...base, state: 'pending' }), { text: '⏳ Esperando entrada', tone: 'wait' });
    assert.equal(shotCaption(null, null, { ...base, state: 'open', profit: 3.5 })?.text, '▶ En curso · +3.50 $');
    assert.equal(shotCaption(null, null, { ...base, state: 'expired' })?.text, '⌛ Expiró · no entró · 0 $');
    assert.equal(shotCaption(null, null, { ...base, state: 'canceled' })?.text, '✗ Cancelada · no entró · 0 $');
  });

  it('no tomada y sin envío', () => {
    assert.deepEqual(shotCaption('no_tomada', null, null), { text: 'No tomada · 0 $', tone: 'muted' });
    assert.equal(shotCaption(null, null, null), null);
  });

  it('ganada sin PnL ni MT5 → solo la palabra', () => {
    assert.deepEqual(shotCaption('ganada', null, null), { text: '✓ Ganada', tone: 'pos' });
  });
});
