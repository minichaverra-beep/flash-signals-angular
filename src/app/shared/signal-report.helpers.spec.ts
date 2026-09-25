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
  displayScoreLabel,
  isCombinedScoreLabel,
  biasTone,
  biasLabel,
  resolveRunBias,
  marketRows,
  hasDetalleAdicional,
  parseRewardMultiple,
  investorRiskCard,
  riskGaugeHint,
  hitRateTone,
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

  it('verdictRows muestra Probabilidad de éxito (score combinado), no wait/stop', () => {
    assert.deepEqual(verdictRows(null), []);
    assert.deepEqual(marketRows(null), []);

    const s: SignalSummary = {
      verdict: 'NO_OPERAR',
      scoreCombined: 68,
      price: '100',
      entryOptima: '99',
      plan: 'break',
    };
    assert.deepEqual(verdictRows(s), [
      { campo: 'Probabilidad de éxito', valor: '68%' },
    ]);
    // Sin score: no rellenar con NO_OPERAR / ESPERAR
    assert.deepEqual(verdictRows({ verdict: 'ESPERAR' }), []);
    assert.deepEqual(
      verdictRows({
        verdict: 'ESPERAR',
        chartScores: [{ label: 'Combinado', value: 55 }],
      }),
      [{ campo: 'Probabilidad de éxito', valor: '55%' }]
    );
    assert.equal(marketRows(s).length, 3);
  });

  it('verdictTone entiende porcentajes y displayScoreLabel renombra Combinado', () => {
    assert.equal(verdictTone('75%'), 'ok');
    assert.equal(verdictTone('68%'), '');
    assert.equal(verdictTone('40%'), 'warn');
    assert.equal(verdictTone('NO_OPERAR'), 'warn');
    assert.equal(displayScoreLabel('Combinado'), 'Probabilidad de éxito');
    assert.equal(displayScoreLabel('Score combinado'), 'Probabilidad de éxito');
    assert.equal(displayScoreLabel('Rules E1'), 'Rules E1');
    assert.equal(isCombinedScoreLabel('Probabilidad de éxito'), true);
  });

  it('hitRateTone extrae % de texto de patrón ganador', () => {
    assert.equal(
      hitRateTone('~82% — patrón ganador similar · histórico El BTC'),
      'ok'
    );
    assert.equal(hitRateTone('55% similar'), '');
    assert.equal(hitRateTone('~30% — bajo'), 'warn');
    assert.equal(hitRateTone(null), '');
    assert.equal(hitRateTone('sin dato'), '');
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
