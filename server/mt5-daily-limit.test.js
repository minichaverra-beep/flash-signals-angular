/**
 * Tests del límite de operaciones por día (conteo en HISTORY_TZ y estado).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  effectiveTradeLimit,
  countTradesToday,
  dailyLimitStatus,
  limitReachedMessage,
} = require('./mt5-daily-limit');

const TZ = 'America/Bogota'; // UTC-5 sin horario de verano
const now = new Date('2026-10-09T15:00:00.000Z'); // 9-oct 10:00 local

describe('effectiveTradeLimit', () => {
  it('activo por defecto; desactivado o sin valor → 0 (sin límite)', () => {
    assert.equal(effectiveTradeLimit({ maxTradesPerDay: 6 }), 6);
    assert.equal(effectiveTradeLimit({ dailyTradeLimitEnabled: true, maxTradesPerDay: 3 }), 3);
    assert.equal(effectiveTradeLimit({ dailyTradeLimitEnabled: false, maxTradesPerDay: 3 }), 0);
    assert.equal(effectiveTradeLimit({ dailyTradeLimitEnabled: true, maxTradesPerDay: 0 }), 0);
  });
});

describe('countTradesToday', () => {
  it('cuenta envíos MT5 de hoy en la zona local, no por medianoche UTC', () => {
    const sent = {
      h1: { at: '2026-10-09T05:01:00.000Z' }, // 9-oct 00:01 local → hoy
      h2: { at: '2026-10-09T04:59:00.000Z' }, // 8-oct 23:59 local → ayer
      rbtc1700000000: { at: '2026-10-09T14:00:00.000Z' },
      h3: { at: null },
    };
    assert.equal(countTradesToday({ sent, now, tz: TZ }), 2);
  });

  it('suma señales de hoy tomadas a mano (ganada/perdida) sin contar dos veces la misma', () => {
    const sent = { h10: { at: '2026-10-09T13:00:00.000Z' } };
    const taken = [
      { id: 10, createdAt: '2026-10-09T12:55:00.000Z', resultado: 'ganada' }, // ya enviada
      { id: 11, createdAt: '2026-10-09T14:00:00.000Z', resultado: 'perdida' },
      { id: 12, createdAt: '2026-10-09T14:10:00.000Z', resultado: 'no_tomada' },
      { id: 13, createdAt: '2026-10-08T20:00:00.000Z', resultado: 'ganada' }, // ayer
    ];
    assert.equal(countTradesToday({ sent, taken, now, tz: TZ }), 2);
  });
});

describe('dailyLimitStatus', () => {
  it('alcanzado con count >= límite y mensaje en español', () => {
    const s = dailyLimitStatus({ maxTradesPerDay: 3 }, 3, { now, tz: TZ });
    assert.equal(s.reached, true);
    assert.equal(s.remaining, 0);
    assert.equal(s.day, '2026-10-09');
    assert.equal(s.message, 'Límite diario de operaciones alcanzado (3/3)');
    assert.equal(limitReachedMessage(4, 3), 'Límite diario de operaciones alcanzado (4/3)');
  });

  it('por debajo del límite o desactivado no bloquea', () => {
    assert.equal(dailyLimitStatus({ maxTradesPerDay: 3 }, 2, { now, tz: TZ }).reached, false);
    const off = dailyLimitStatus({ dailyTradeLimitEnabled: false, maxTradesPerDay: 3 }, 9, { now, tz: TZ });
    assert.deepEqual([off.enabled, off.limit, off.reached, off.count], [false, null, false, 9]);
  });
});
