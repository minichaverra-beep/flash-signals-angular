/**
 * Specs ligeras de helpers (sin Karma): node --experimental-strip-types --test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SignalSummary } from '../services/signals-api.service';
import {
  chartHref,
  executionLevels,
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
  parseHitRateAnalysis,
  probabilityHint,
  hitRateTooltip,
  probabilityTooltip,
  hitRateBandLabel,
  formatExpectancyR,
  HIT_RATE_COLUMN_TOOLTIP,
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

  it('parseHitRateAnalysis separa % y factores bias/PD/acuerdo', () => {
    const a = parseHitRateAnalysis(
      '~48% — histórico E2 reversión BTC · 83% reglas; patron WIN similar +3; SHORT en DISCOUNT -7; acuerdo BAJA -8'
    );
    assert.equal(a.pctLabel, '~48%');
    assert.equal(a.pct, 48);
    assert.match(String(a.source), /E2/);
    assert.ok(a.factors.some((f) => f.kind === 'pd' && /DISCOUNT/.test(f.label)));
    assert.ok(a.factors.some((f) => f.kind === 'acuerdo' && /BAJA/.test(f.label)));
    assert.ok(a.factors.some((f) => f.kind === 'patron'));
  });

  it('probabilityHint resume PD desde winrate o tags', () => {
    assert.match(
      String(
        probabilityHint({
          winrate:
            '~55% — histórico E1 BTC · SHORT en PREMIUM +2 (zona a favor); H1 BEARISH a favor +4',
        })
      ),
      /PREMIUM/
    );
  });

  it('hitRateTooltip explica bias y Premium/Discount', () => {
    const tip = hitRateTooltip(
      '~48% — histórico E2 reversión BTC · SHORT en DISCOUNT -7; acuerdo BAJA -8'
    );
    assert.match(tip, /Tasa de acierto/);
    assert.match(tip, /Premium \/ Discount|DISCOUNT/);
    assert.match(tip, /Acuerdo|acuerdo/i);
  });

  it('hitRateTooltip explica significado, banda, esperanza y diferencia con Probabilidad', () => {
    const tip = hitRateTooltip('~60% — histórico E1 BTC · LONG en DISCOUNT +4');
    assert.match(tip, /6 de cada 10/);
    assert.match(tip, /setup aceptable/);
    assert.match(tip, /\+0\.80R/);
    assert.match(tip, /No es la Probabilidad/);
  });

  it('hitRateBandLabel y formatExpectancyR', () => {
    assert.equal(hitRateBandLabel(50), 'setup débil');
    assert.equal(hitRateBandLabel(55), 'setup aceptable');
    assert.equal(hitRateBandLabel(70), 'setup sólido');
    assert.equal(formatExpectancyR(48), '+0.44R');
    assert.equal(formatExpectancyR(30), '-0.10R');
  });

  it('HIT_RATE_COLUMN_TOOLTIP describe cálculo y rango', () => {
    assert.match(HIT_RATE_COLUMN_TOOLTIP, /48–74%/);
    assert.match(HIT_RATE_COLUMN_TOOLTIP, /Premium\/Discount/);
  });

  it('probabilityTooltip resume score y contexto', () => {
    const tip = probabilityTooltip({
      scoreCombined: 58,
      winrate: '~48% — histórico E2 · SHORT en DISCOUNT -7; H1 BEARISH a favor +4',
    });
    assert.match(tip, /58%/);
    assert.match(tip, /Premium\/Discount|DISCOUNT|blend/i);
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

describe('executionLevels (ejecución real MT5)', () => {
  const pd = { entry: '84792.7', sl: '84971.08', tp: '84395.85', rr: '1:2.2', risk: '178.38' };
  const real = {
    ticket: 680126942,
    entry: 84792.7,
    exit: 84610.17,
    sl: null,
    openedAt: '2026-10-01T20:21:00.000Z',
    closedAt: '2026-10-01T20:54:12.000Z',
  };

  it('SHORT: salida real, R realizado con signo y riesgo del plan si el SL no cambia', () => {
    const ex = executionLevels(pd, real);
    assert.equal(ex?.entry, '84792.70');
    assert.equal(ex?.exit, '84610.17');
    assert.equal(ex?.realizedR, '+1.02R');
    assert.equal(ex?.risk, '178.38');
    assert.equal(ex?.slChanged, false);
  });

  it('SL real distinto → riesgo y R con el SL real', () => {
    const ex = executionLevels(pd, { ...real, sl: 85001.08 });
    assert.equal(ex?.slChanged, true);
    assert.equal(ex?.sl, '85001.08');
    assert.equal(ex?.risk, '208.38');
    assert.equal(ex?.realizedR, '+0.88R');
  });

  it('pérdida → R negativo; sin ejecución completa → null', () => {
    assert.equal(executionLevels(pd, { ...real, exit: 84880 })?.realizedR, '−0.49R');
    assert.equal(executionLevels(pd, { ...real, exit: null }), null);
    assert.equal(executionLevels(pd, null), null);
  });
});
