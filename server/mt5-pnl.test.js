/**
 * Tests del PnL desde MT5 (deals simulados, sin puente ni terminal).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPnl, decideApply, groupPositions, lookupMt5Pnl, resolvePnlInput } = require('./mt5-pnl');

const SIGNAL = '2026-10-01T20:17:26.000Z';
const T0 = Date.parse(SIGNAL) / 1000;
const SETTINGS = { bridgeUrl: 'http://127.0.0.1:8765', symbols: { btc: 'BTCUSDm', xauusd: 'XAUUSDm' }, maxDeviationPct: 1 };

/** Fila SELL de BTC con entrada 84792.7. */
const row = (extra = {}) => ({
  id: 43,
  market: 'btc',
  finishedAt: SIGNAL,
  plannedEntry: 84792.7,
  plannedSl: 84971.08,
  plannedTp: 84395.85,
  resultado: 'ganada',
  pnlUsd: null,
  ...extra,
});

let ticket = 1000;
const deal = (position, entry, type, { price, volume = 0.1, profit = 0, commission = 0, swap = 0, fee = 0, at = 0, comment = '' }) => ({
  ticket: ++ticket, position, symbol: 'BTCUSDm', type, entry, volume, price, profit, commission, swap, fee, time: T0 + at, comment,
});
/** Posición SELL abierta en `price` a T0+at y cerrada con `profit`. */
const closedSell = (position, price, profit, at = 120, extra = {}) => [
  deal(position, 'in', 'SELL', { price, at, commission: extra.commission ?? 0, comment: extra.comment }),
  deal(position, 'out', 'BUY', { price: price - 100, at: at + 600, profit, swap: extra.swap ?? 0 }),
];

const lookup = (deals, opts = {}) =>
  lookupMt5Pnl({
    row: row(opts.row),
    resultado: opts.resultado,
    profiles: opts.profiles ?? [{ id: 'principal', settings: SETTINGS, sentOrder: opts.sentOrder ?? null }],
    fetchDeals: opts.fetchDeals ?? (async () => ({ ok: true, account: { login: 1 }, deals })),
    nowMs: (T0 + 86400) * 1000,
  });

describe('resolvePnlInput', () => {
  it('deduce SELL/BUY de la geometría del plan', () => {
    assert.equal(resolvePnlInput(row()).input.side, 'SELL');
    assert.equal(resolvePnlInput(row({ plannedSl: 84600, plannedTp: 85000 })).input.side, 'BUY');
  });

  it('sin niveles no busca', () => {
    assert.equal(resolvePnlInput(row({ plannedEntry: null })).code, 'no_levels');
  });
});

describe('groupPositions', () => {
  it('suma profit + commission + swap + fee de todos los deals; cierres parciales = una posición', () => {
    const deals = [
      deal(7, 'in', 'SELL', { price: 84790, volume: 0.4, commission: -1.2, at: 60 }),
      deal(7, 'out', 'BUY', { price: 84700, volume: 0.2, profit: 18, swap: -0.3, at: 300 }),
      deal(7, 'out', 'BUY', { price: 84650, volume: 0.2, profit: 28, commission: -1.2, fee: -0.1, at: 900 }),
    ];
    const [p] = groupPositions(deals, 1);
    assert.equal(p.closed, true);
    assert.equal(p.net, 43.2);
    assert.deepEqual([p.profit, p.commission, p.swap, p.fee], [46, -2.4, -0.3, -0.1]);
  });

  it('salida = media ponderada por volumen de los cierres; hora = último cierre; SL de apertura', () => {
    const deals = [
      deal(7, 'in', 'SELL', { price: 84790, volume: 0.4, at: 60 }),
      deal(7, 'out', 'BUY', { price: 84700, volume: 0.1, at: 300 }),
      deal(7, 'out', 'BUY', { price: 84600, volume: 0.3, at: 900 }),
    ];
    const [p] = groupPositions(deals, 1, { 7: { sl: 85000 } });
    assert.equal(p.exitPrice, 84625);
    assert.equal(p.closeTime, (T0 + 900) * 1000);
    assert.equal(p.entryTime, (T0 + 60) * 1000);
    assert.equal(p.sl, 85000);
    assert.equal(groupPositions([deal(8, 'in', 'SELL', { price: 1 })])[0].exitPrice, null);
  });

  it('cierre parcial sin completar → abierta', () => {
    const deals = [
      deal(8, 'in', 'SELL', { price: 84790, volume: 0.4 }),
      deal(8, 'out', 'BUY', { price: 84700, volume: 0.2, profit: 18 }),
    ];
    assert.equal(groupPositions(deals)[0].closed, false);
  });
});

describe('lookupMt5Pnl', () => {
  it('un solo deal de cierre → su PnL neto', async () => {
    const out = await lookup(closedSell(680126942, 84792.7, 74.84));
    assert.equal(out.ok, true);
    assert.equal(out.pnl.value, 74.84);
    assert.equal(out.pnl.ticket, 680126942);
    assert.equal(out.pnl.source, 'mt5');
    assert.equal(out.pnl.mismatch, false);
    assert.deepEqual(out.pnl.execution, {
      entry: 84792.7,
      exit: 84692.7,
      sl: null,
      openedAt: new Date((T0 + 120) * 1000).toISOString(),
      closedAt: new Date((T0 + 720) * 1000).toISOString(),
    });
  });

  it('SL de apertura del puente llega a la ejecución', async () => {
    const out = await lookup([], {
      fetchDeals: async () => ({ account: { login: 1 }, deals: closedSell(70, 84792.7, 5), positions: { 70: { sl: 85001.08 } } }),
    });
    assert.equal(out.pnl.execution.sl, 85001.08);
  });

  it('cierres parciales se suman (incluye comisión y swap)', async () => {
    const deals = [
      deal(9, 'in', 'SELL', { price: 84795, volume: 0.4, commission: -2, at: 200 }),
      deal(9, 'out', 'BUY', { price: 84700, volume: 0.1, profit: 10, at: 400 }),
      deal(9, 'out', 'BUY', { price: 84600, volume: 0.3, profit: 60, swap: -1.5, at: 900 }),
    ];
    const out = await lookup(deals);
    assert.equal(out.pnl.value, 66.5);
    assert.equal(out.pnl.deals.length, 3);
  });

  it('elige la entrada más cercana al plan', async () => {
    const out = await lookup([...closedSell(1, 84688.37, 31.55, 1200), ...closedSell(2, 84792.7, 74.84)]);
    assert.equal(out.pnl.ticket, 2);
  });

  it('sin coincidencia: otra dirección, antes de la señal o lejos de la entrada → aviso, sin número', async () => {
    const deals = [
      deal(3, 'in', 'BUY', { price: 84792, at: 60 }),
      deal(3, 'out', 'SELL', { price: 84900, profit: 10, at: 600 }),
      ...closedSell(4, 84790, 5, -3600),
      ...closedSell(5, 80000, 5, 300),
    ];
    const out = await lookup(deals);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'no_match');
    assert.match(out.warning, /^MT5: no se encontró una operación cerrada de BTCUSDm SELL desde \d{2}:\d{2}$/);
  });

  it('varias igual de plausibles → ambigua', async () => {
    const out = await lookup([...closedSell(11, 84792.7, 20), ...closedSell(12, 84793.5, 22, 300)]);
    assert.equal(out.code, 'ambiguous');
    assert.match(out.warning, /Varias operaciones coinciden \(#11, #12\); ingresa el PnL a mano/);
  });

  it('la etiquetada «FS h<id>» gana aunque otra esté más cerca; ignora las de otras filas', async () => {
    const deals = [
      ...closedSell(21, 84792.7, 50, 120, { comment: 'FS h40' }),
      ...closedSell(22, 84700, -12, 240, { comment: 'FS h43' }),
      ...closedSell(23, 84792.7, 30),
    ];
    const out = await lookup(deals);
    assert.equal(out.pnl.ticket, 22);
  });

  it('orden registrada en mt5-sent identifica la posición', async () => {
    const out = await lookup([...closedSell(31, 84792.7, 10), ...closedSell(32, 84700, 15)], { sentOrder: 32 });
    assert.equal(out.pnl.ticket, 32);
  });

  it('operación abierta → aviso', async () => {
    const out = await lookup([deal(41, 'in', 'SELL', { price: 84792.7, at: 60 })]);
    assert.equal(out.code, 'open');
    assert.match(out.warning, /#41 de BTCUSDm SELL sigue abierta/);
  });

  it('signo contradice el Resultado → guarda el valor de MT5 con aviso', async () => {
    const out = await lookup(closedSell(51, 84792.7, -33.2), { resultado: 'ganada' });
    assert.equal(out.pnl.value, -33.2);
    assert.equal(out.pnl.mismatch, true);
    assert.match(out.pnl.warning, /MT5 da -33\.20 USD \(#51\) pero marcaste Ganada/);
  });

  it('puente caído → «MT5 no conectado»', async () => {
    const err = Object.assign(new Error('Puente MT5 no disponible'), { status: 503 });
    const out = await lookup([], { fetchDeals: async () => { throw err; } });
    assert.deepEqual(out, { ok: false, code: 'mt5_offline', warning: 'MT5 no conectado' });
  });

  it('un perfil caído no impide usar el otro; misma cuenta en dos puentes no duplica', async () => {
    const deals = closedSell(61, 84792.7, 12);
    const profiles = [
      { id: 'principal', settings: SETTINGS },
      { id: 'secundaria', settings: { ...SETTINGS, bridgeUrl: 'http://127.0.0.1:8766' } },
      { id: 'otra', settings: { ...SETTINGS, bridgeUrl: 'http://127.0.0.1:8767' } },
    ];
    const fetchDeals = async (_q, s) => {
      if (s.bridgeUrl.endsWith('8767')) throw Object.assign(new Error('caído'), { status: 503 });
      return { account: { login: 1 }, deals };
    };
    const out = await lookup([], { profiles, fetchDeals });
    assert.equal(out.pnl.value, 12);
  });

  it('consulta el símbolo del perfil desde la hora de la señal', async () => {
    let query;
    await lookup([], { fetchDeals: async (q) => { query = q; return { deals: [] }; } });
    assert.equal(query.symbol, 'BTCUSDm');
    assert.equal(query.from, T0 - 120);
  });
});

describe('buildPnl / decideApply', () => {
  it('sin Resultado elegido no hay mismatch', () => {
    assert.equal(buildPnl({ net: -5, position: 1, deals: [], profit: -5 }, null).mismatch, false);
  });

  it('PnL vacío o 0 se rellena; igual no cambia; manual distinto pide confirmación', () => {
    assert.equal(decideApply(null, 10), 'fill');
    assert.equal(decideApply(0, 10), 'fill');
    assert.equal(decideApply(10.001, 10), 'same');
    assert.equal(decideApply(37.6, 117.8), 'confirm');
    assert.equal(decideApply(37.6, 117.8, true), 'fill');
  });
});
