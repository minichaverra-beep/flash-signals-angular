/**
 * SL al soporte (compra) o a la resistencia (venta) cuando el riesgo está en zona alta.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.MT5_SETTINGS_PATH = path.join(os.tmpdir(), `high-risk-sl-${process.pid}.json`);
const { expandSlIfHighRisk } = require('./high-risk-sl');
const { buildOrderFromSummary } = require('./mt5');

const h1 = (low, high) => ({ crt: { h1_detail: `Rango H1 ${low}-${high}` } });

describe('expandSlIfHighRisk', () => {
  it('con R:R 1:2 no mueve el SL', () => {
    assert.equal(
      expandSlIfHighRisk({
        entry: 81530,
        sl: 81470,
        plan: { entry: '81530', sl: '81470', rr: '1:2', risk: '60' },
        engine: h1(81400, 81600),
      }),
      null,
    );
  });

  it('compra baja al soporte más cercano bajo el SL; venta sube a la resistencia', () => {
    assert.equal(
      expandSlIfHighRisk({
        market: 'btc',
        entry: 81530,
        sl: 81470,
        plan: { entry: '81530', sl: '81470', rr: '1:1', risk: '60' },
        engine: {
          crt: { h1_detail: 'Rango H1 81434-81674' },
          ict: { scan: { zone_level: 81400, zone_type: 'soporte_debil' } },
        },
      }),
      81414,
    );
    assert.equal(
      expandSlIfHighRisk({
        market: 'xauusd',
        entry: 4169.9,
        sl: 4175.9,
        plan: { entry: '4169.9', sl: '4175.9', rr: '1:1', risk: '6' },
        engine: {
          crt: { h1_detail: 'Rango H1 4164-4182' },
          ict: { scan: { zone_level: 4166.4, zone_type: 'soporte_debil' } },
        },
      }),
      4184,
    );
  });

  it('un nivel entre la entrada y el SL no acerca el stop', () => {
    assert.equal(
      expandSlIfHighRisk({
        entry: 4169.9,
        sl: 4175.9,
        plan: { entry: '4169.9', sl: '4175.9', rr: '1:1', risk: '6' },
        engine: h1(4164, 4170),
      }),
      null,
    );
  });

  it('la orden MT5 sale con el SL en esa resistencia', () => {
    const { order } = buildOrderFromSummary('xauusd', {
      verdict: 'ENTRAR',
      price: '4169.90',
      planDetails: { entry: '4169.90', sl: '4175.90', tp: '4163.90', rr: '1:1', risk: '6' },
      engine: { crt: { h1_detail: 'Rango H1 4164-4182' } },
    });
    assert.equal(order.side, 'SHORT');
    assert.equal(order.sl, 4184);
    assert.equal(order.tp, 4163.9);
    assert.equal(order.entry, 4169.9);
  });
});
