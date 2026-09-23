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
  biasTone,
  biasLabel,
  resolveRunBias,
  marketRows,
  hasDetalleAdicional,
  parseRewardMultiple,
  investorRiskCard,
  riskGaugeHint,
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

  it('verdictTone clasifica warn / ok / bullish / bearish', () => {
    assert.equal(verdictTone('NO_OPERAR'), 'warn');
    assert.equal(verdictTone('ESPERAR'), 'warn');
    assert.equal(verdictTone('OPERAR_LONG'), 'bullish');
    assert.equal(verdictTone('OPERAR_SHORT'), 'bearish');
    assert.equal(verdictTone('OPERAR'), 'ok');
    assert.equal(verdictTone(null), '');
  });

  it('biasTone y biasLabel colorean dirección', () => {
    assert.equal(biasTone('bullish'), 'bullish');
    assert.equal(biasTone('Bearish'), 'bearish');
    assert.equal(biasTone('alcista'), 'bullish');
    assert.equal(biasTone('bajista'), 'bearish');
    assert.equal(biasTone('auto'), 'neutral');
    assert.equal(biasTone('break'), '');
    assert.equal(biasLabel('bullish'), 'alcista');
    assert.equal(biasLabel('auto'), 'default');
    assert.equal(biasLabel(null), '—');
    assert.equal(biasLabel('bajista'), 'bajista');
  });

  it('resolveRunBias prioriza flags sobre summary', () => {
    assert.equal(resolveRunBias({ bullish: true, bearish: false }), 'bullish');
    assert.equal(resolveRunBias({ bullish: false, bearish: true }), 'bearish');
    assert.equal(resolveRunBias({ bullish: false, bearish: false }), 'auto');
    assert.equal(resolveRunBias({}, 'Bullish M5'), 'Bullish M5');
    assert.equal(resolveRunBias(null, null), null);
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

  it('parseRewardMultiple entiende 1:2, 1/3 y número suelto', () => {
    assert.equal(parseRewardMultiple('1:2.1'), 2.1);
    assert.equal(parseRewardMultiple('1 / 3'), 3);
    assert.equal(parseRewardMultiple('2.5'), 2.5);
    assert.equal(parseRewardMultiple(null), null);
  });

  it('investorRiskCard: Templado cae en zona media (33–66)', () => {
    const s: SignalSummary = {
      verdict: 'OPERAR_LONG',
      price: '83000',
      plan: 'break',
      planDetails: { entry: '83000', sl: '82700', tp: '83600', rr: '1:2.1', risk: '300.5' },
    };
    const card = investorRiskCard(s);
    assert.equal(card.heat, 'warm');
    assert.equal(card.heatLabel, 'Templado');
    assert.ok(card.barPct >= 33 && card.barPct <= 66, `barPct=${card.barPct}`);
    assert.match(riskGaugeHint(card), /Templado/);
    assert.match(riskGaugeHint(card), /300\.5/);
  });
});
