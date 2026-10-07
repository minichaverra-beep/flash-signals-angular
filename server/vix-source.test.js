/**
 * Tests de la fuente del VIX: broker primero, Yahoo de respaldo, caché de 60 s.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVixSource, pickVixSymbol } = require('./vix-source');

const NOW_SEC = 1_790_000_000;
const settings = { bridgeUrl: 'http://127.0.0.1:8765', vixSymbol: '' };

const yahooBody = (price, timeSec) => ({
  ok: true,
  status: 200,
  json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: timeSec } }] } }),
});

function setup({ bridge = {}, fetchImpl, clock = { t: NOW_SEC * 1000 } } = {}) {
  const calls = { fetch: 0, search: 0, rates: 0 };
  const source = createVixSource({
    bridge: {
      searchSymbols: async () => (calls.search++, { symbols: [] }),
      marketRates: async () => (calls.rates++, { bid: 0 }),
      ...bridge,
    },
    fetchImpl: async (...args) => (calls.fetch++, fetchImpl(...args)),
    now: () => clock.t,
  });
  return { source, calls, clock };
}

describe('pickVixSymbol', () => {
  it('elige el nombre más corto que contenga VIX', () => {
    assert.equal(pickVixSymbol([{ name: 'VIXm.cash' }, { name: 'VIX' }, { name: 'EURUSD' }]), 'VIX');
    assert.equal(pickVixSymbol([{ name: 'EURUSD' }]), null);
    assert.equal(pickVixSymbol(undefined), null);
  });
});

describe('getVix', () => {
  it('usa el símbolo VIX del broker si existe y tiene cotización reciente', async () => {
    const { source, calls } = setup({
      bridge: {
        searchSymbols: async () => ({ symbols: [{ name: 'VIXm' }] }),
        marketRates: async () => ({ bid: 17.45, tickTime: NOW_SEC - 20 }),
      },
      fetchImpl: () => assert.fail('no debe llamar a Yahoo'),
    });
    const r = await source.getVix(settings);
    assert.equal(r.source, 'broker');
    assert.equal(r.points, 17.45);
    assert.equal(r.symbol, 'VIXm');
    assert.equal(r.asOf, new Date((NOW_SEC - 20) * 1000).toISOString());
    assert.equal(calls.fetch, 0);
  });

  it('respeta vixSymbol del perfil sin buscar en el puente', async () => {
    const { source, calls } = setup({
      bridge: { marketRates: async ({ symbol }) => ({ bid: symbol === 'VIX.cash' ? 21 : 0, tickTime: NOW_SEC }) },
      fetchImpl: () => assert.fail('no debe llamar a Yahoo'),
    });
    const r = await source.getVix({ ...settings, vixSymbol: 'VIX.cash' });
    assert.equal(r.points, 21);
    assert.equal(calls.search, 0);
  });

  it('sin símbolo en el broker cae a Yahoo ^VIX y lo dice en attempts', async () => {
    const { source } = setup({ fetchImpl: async () => yahooBody(22.1, NOW_SEC - 30) });
    const r = await source.getVix(settings);
    assert.equal(r.source, 'yahoo');
    assert.equal(r.points, 22.1);
    assert.equal(r.stale, false);
    assert.match(r.attempts[0], /no hay símbolo VIX/);
  });

  it('con el puente caído también cae a Yahoo', async () => {
    const { source } = setup({
      bridge: { searchSymbols: async () => Promise.reject(new Error('Puente MT5 no disponible')) },
      fetchImpl: async () => yahooBody(18, NOW_SEC),
    });
    const r = await source.getVix(settings);
    assert.equal(r.source, 'yahoo');
    assert.match(r.attempts[0], /Puente MT5 no disponible/);
  });

  it('cotización vieja o valor absurdo del broker se descartan', async () => {
    const stale = setup({
      bridge: {
        searchSymbols: async () => ({ symbols: [{ name: 'VIXm' }] }),
        marketRates: async () => ({ bid: 17, tickTime: NOW_SEC - 3600 }),
      },
      fetchImpl: async () => yahooBody(19, NOW_SEC),
    });
    assert.equal((await stale.source.getVix(settings)).source, 'yahoo');

    const absurd = setup({
      bridge: {
        searchSymbols: async () => ({ symbols: [{ name: 'VIXm' }] }),
        marketRates: async () => ({ bid: 4500, tickTime: NOW_SEC }),
      },
      fetchImpl: async () => yahooBody(19, NOW_SEC),
    });
    const r = await absurd.source.getVix(settings);
    assert.equal(r.source, 'yahoo');
    assert.match(r.attempts[0], /no parece un VIX/);
  });

  it('Yahoo con mercado cerrado marca el dato como no reciente', async () => {
    const { source } = setup({ fetchImpl: async () => yahooBody(16.2, NOW_SEC - 7200) });
    assert.equal((await source.getVix(settings)).stale, true);
  });

  it('reintenta con el segundo host de Yahoo', async () => {
    let n = 0;
    const { source, calls } = setup({
      fetchImpl: async () => {
        if (n++ === 0) throw new Error('fetch failed');
        return yahooBody(20.5, NOW_SEC);
      },
    });
    const r = await source.getVix(settings);
    assert.equal(r.points, 20.5);
    assert.equal(calls.fetch, 2);
  });

  it('caché de 60 s: no repite peticiones y vuelve a leer al caducar', async () => {
    const { source, calls, clock } = setup({ fetchImpl: async () => yahooBody(23, NOW_SEC) });
    const first = await source.getVix(settings);
    assert.equal(first.cached, false);
    clock.t += 59_000;
    const second = await source.getVix(settings);
    assert.equal(second.cached, true);
    assert.equal(second.points, 23);
    assert.equal(calls.fetch, 1);
    clock.t += 2_000;
    assert.equal((await source.getVix(settings)).cached, false);
    assert.equal(calls.fetch, 2);
  });

  it('peticiones simultáneas comparten una sola lectura', async () => {
    const { source, calls } = setup({ fetchImpl: async () => yahooBody(25, NOW_SEC) });
    await Promise.all([source.getVix(settings), source.getVix(settings), source.getVix(settings)]);
    assert.equal(calls.fetch, 1);
  });

  it('si el broker y Yahoo fallan lanza 502 con el detalle de cada intento', async () => {
    const { source } = setup({ fetchImpl: async () => Promise.reject(new Error('fetch failed')) });
    await assert.rejects(
      () => source.getVix(settings),
      (err) => err.status === 502 && err.attempts.length === 3 && /No se pudo obtener el VIX/.test(err.message)
    );
  });

  it('un fallo no queda en caché', async () => {
    let ok = false;
    const { source } = setup({ fetchImpl: async () => (ok ? yahooBody(19, NOW_SEC) : Promise.reject(new Error('x'))) });
    await assert.rejects(() => source.getVix(settings));
    ok = true;
    assert.equal((await source.getVix(settings)).points, 19);
  });
});
