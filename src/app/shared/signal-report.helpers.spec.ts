/**
 * Specs ligeras de helpers (sin Karma): node --experimental-strip-types --test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SignalSummary } from '../services/signals-api.service';
import {
  chartHref,
  verdictRows,
  verdictTone,
  marketRows,
  hasDetalleAdicional,
} from './signal-report.helpers.ts';

describe('signal-report.helpers', () => {
  it('chartHref prioriza chartUrl absoluto o relativo', () => {
    assert.equal(chartHref('btc', '/api/custom.png', null), '/api/custom.png');
    assert.equal(
      chartHref('btc', 'https://cdn.example/c.png', '/x'),
      'https://cdn.example/c.png'
    );
  });

  it('chartHref cae a endpoint chart por market', () => {
    assert.equal(
      chartHref('us30', null, '/tmp/chart.png'),
      '/api/signals/chart?market=us30'
    );
    assert.equal(chartHref('btc', null, null), null);
  });

  it('verdictTone clasifica warn / ok', () => {
    assert.equal(verdictTone('NO_OPERAR'), 'warn');
    assert.equal(verdictTone('ESPERAR'), 'warn');
    assert.equal(verdictTone('OPERAR_LONG'), 'ok');
    assert.equal(verdictTone(null), '');
  });

  it('verdictRows y marketRows parsean summary vacío vs con datos', () => {
    assert.deepEqual(verdictRows(null), []);
    assert.deepEqual(marketRows(null), []);

    const s: SignalSummary = {
      verdict: 'OPERAR_SHORT',
      price: '100',
      entryOptima: '99',
      plan: 'break',
    };
    assert.deepEqual(verdictRows(s), [{ campo: 'Veredicto', valor: 'OPERAR_SHORT' }]);
    assert.equal(marketRows(s).length, 3);
  });

  it('hasDetalleAdicional (empty-state útil para historial/reporte)', () => {
    assert.equal(hasDetalleAdicional(null), false);
    assert.equal(hasDetalleAdicional(null, 'preview'), true);
    assert.equal(hasDetalleAdicional({ redFlags: ['x'] }), true);
    assert.equal(hasDetalleAdicional({}), false);
  });
});
