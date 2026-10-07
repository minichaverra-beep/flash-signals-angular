const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { positionParams, legParams } = require('./position-params');

// XAUUSDm: tick 0.001 = 0.1 USD por lote → 100 USD por 1.0 de precio y lote.
const details = { tickSize: 0.001, tickValue: 0.1, bid: 4115.0, ask: 4115.2, currency: 'USD' };
const long = {
  order: 1, side: 'LONG', state: 'open', volume: 0.01, price: 4110.0, sl: 4104.0, tp: 4122.0, profit: 0.5,
};

describe('legParams', () => {
  it('LONG abierta: SL y TP en pips y dinero, R:R, distancias y flotante', () => {
    const p = legParams(long, { pipSize: 0.1, details, label: 'Original' });
    assert.deepEqual(p.sl, { price: 4104, pips: -60, money: -6 });
    assert.deepEqual(p.tp, { price: 4122, pips: 120, money: 12 });
    assert.equal(p.rr, 2);
    assert.equal(p.current, 4115);
    assert.equal(p.toTpPips, 70);
    assert.equal(p.toSlPips, 110);
    assert.equal(p.floatingPips, 50);
    assert.equal(p.floatingMoney, 5);
    assert.equal(p.progressPct, 42);
    assert.equal(p.slLocksProfit, false);
  });

  it('SHORT usa el ask para salir', () => {
    const short = { ...long, side: 'SHORT', price: 4120, sl: 4126, tp: 4108 };
    const p = legParams(short, { pipSize: 0.1, details, label: 'Original' });
    assert.equal(p.current, 4115.2);
    assert.equal(p.sl.money, -6);
    assert.equal(p.tp.money, 12);
    assert.equal(p.floatingPips, 48);
  });

  it('SL movido por encima de la entrada asegura ganancia y no tiene R:R', () => {
    const p = legParams({ ...long, sl: 4112 }, { pipSize: 0.1, details, label: 'Original' });
    assert.equal(p.slLocksProfit, true);
    assert.equal(p.sl.money, 2);
    assert.equal(p.rr, null);
  });

  it('pendiente: sin flotante; cerrada: sin precio actual', () => {
    const pend = legParams({ ...long, state: 'pending' }, { pipSize: 0.1, details, label: 'Original' });
    assert.equal(pend.floatingMoney, null);
    assert.equal(pend.toTpPips, 70);
    const closed = legParams({ ...long, state: 'closed' }, { pipSize: 0.1, details, label: 'Original' });
    assert.equal(closed.current, null);
    assert.equal(closed.toTpPips, null);
  });

  it('sin valor del tick: pips sí, dinero null', () => {
    const p = legParams(long, { pipSize: 0.1, details: { bid: 4115 }, label: 'Original' });
    assert.equal(p.sl.pips, -60);
    assert.equal(p.sl.money, null);
  });
});

describe('positionParams', () => {
  it('suma original + duplicada', () => {
    const sent = { ...long, duplicate: { ...long, order: 2, profit: 0.7 } };
    const r = positionParams(sent, { pipSize: 0.1, details, symbol: 'XAUUSDm', market: 'xauusd' });
    assert.equal(r.legs.length, 2);
    assert.equal(r.legs[1].label, 'Duplicada');
    assert.deepEqual(r.total, { tpMoney: 24, slMoney: -12, floatingMoney: 10, profit: 1.2 });
    assert.equal(r.moneyAvailable, true);
  });
});
