/**
 * Specs ligeras de helpers (sin Karma): node --experimental-strip-types --test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SignalSummary } from '../services/signals-api.service';
import {
  chartHref,
  executionLevels,
  rapidaScoreGroups,
  hasRapidaScores,
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
  ruleGradeClass,
  scoreRowStatus,
  naturalScoreName,
  hasChecklistsCard,
  isCalibratedWinrate,
  calibratedBandLabel,
} from './signal-report.helpers.ts';
import { INSTAGRAM_SIZES, imageLines, scoreImageFilename, statusMark } from './score-image-export.ts';

describe('export imagen Instagram', () => {
  it('tamaños Instagram y filas sin Detalle', () => {
    assert.deepEqual(
      [INSTAGRAM_SIZES.post.width, INSTAGRAM_SIZES.post.height],
      [1080, 1350]
    );
    assert.deepEqual(
      [INSTAGRAM_SIZES.story.width, INSTAGRAM_SIZES.story.height],
      [1080, 1920]
    );
    const lines = imageLines([
      { titulo: 'Resumen', rows: [{ concepto: 'Reglas', valor: '66%', detalle: 'Peso 28%', ok: true }] },
      { titulo: 'Resultado', rows: [{ concepto: 'Probabilidad', valor: '51%', detalle: 'x', ok: false, final: true }] },
    ]);
    assert.deepEqual(lines.map((l) => [l.kind, l.text, l.valor ?? null]), [
      ['group', 'RESUMEN', null],
      ['row', 'Reglas', '66%'],
      ['group', 'RESULTADO', null],
      ['row', 'Probabilidad', '51%'],
    ]);
    assert.ok(!JSON.stringify(lines).includes('Peso 28%'));
    assert.equal(statusMark(true), '✓');
    assert.equal(statusMark(false), '✗');
    assert.equal(statusMark(null), '·');
    assert.match(scoreImageFilename('BTC', 'story', new Date('2026-10-07T15:30:00Z')), /^scores-btc-story-202610071530\.png$/);
  });
});

describe('reglas graduadas y probabilidad calibrada', () => {
  it('ruleGradeClass distingue los 6 estados', () => {
    assert.equal(ruleGradeClass('✓✓'), 'grade-strong');
    assert.equal(ruleGradeClass('✓'), 'grade-ok');
    assert.equal(ruleGradeClass('~'), 'grade-neutral');
    assert.equal(ruleGradeClass('✗'), 'grade-bad');
    assert.equal(ruleGradeClass('✗✗'), 'grade-critical');
    assert.equal(ruleGradeClass('·'), 'grade-info');
    assert.equal(ruleGradeClass(null), 'grade-info');
  });

  it('hasChecklistsCard acepta solo rulesReview', () => {
    assert.equal(hasChecklistsCard({ rulesReview: [{ label: 'RSI', grade: '✗' }] } as SignalSummary), true);
  });

  it('detecta winrate calibrado y lo lee frente a la media', () => {
    assert.equal(
      isCalibratedWinrate('~46% — calibrado walk-forward BTC E1 · 80%: 44–48%'),
      true
    );
    assert.equal(isCalibratedWinrate('~64% — histórico E1 BTC · 83% reglas'), false);
    assert.equal(calibratedBandLabel(55), 'por encima de la media del motor');
    assert.equal(calibratedBandLabel(46), 'en la media del motor');
    assert.equal(calibratedBandLabel(35), 'por debajo de la media del motor');
  });
});

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

  it('rapidaScoreGroups une scores + scorecard sin duplicar ni repetir Probabilidad de éxito', () => {
    assert.deepEqual(rapidaScoreGroups(null), []);
    assert.equal(hasRapidaScores({}), false);

    const s: SignalSummary = {
      scoreCombined: 58,
      rulesPct: 83,
      mlPct: 61,
      confluencePct: 57,
      confluenceLabel: 'MEDIA',
      scorecard: [
        { label: 'Rules E1', value: 65.7, raw: '65.7%', weight: '30%', note: '6/9 reglas' },
        { label: 'Neural galería', value: 65, raw: '65%', weight: '20%', note: 'WIN similar' },
        { label: 'Acuerdo entre capas', value: 57, raw: '57%', weight: '10%', note: 'capas dispersas' },
        { label: 'Probabilidad de éxito', value: 58, raw: '58%', weight: '100%', note: 'blend' },
      ],
      chartScores: [
        { label: 'Rules E1', value: 65.7 },
        { label: 'Acuerdo entre capas', value: 57 },
        { label: 'Probabilidad de éxito', value: 58 },
      ],
    };
    const groups = rapidaScoreGroups(s);
    assert.deepEqual(groups.map((g) => g.titulo), ['Resumen', 'Detalle por análisis', 'Resultado']);

    const [scores, layers, result] = groups;
    assert.deepEqual(
      scores.rows.map((r) => [r.concepto, r.ok]),
      [
        ['Reglas del plan cumplidas', true],
        ['Predicción del modelo de datos', true],
        ['Coincidencia entre los análisis', true],
      ]
    );
    assert.equal(scores.rows[0].tecnico, 'Cumplimiento de reglas');
    // Rules E1 y Acuerdo del scorecard se fusionan en la fila del score (peso/nota)
    assert.equal(scores.rows[0].detalle, 'Peso 30% · 6/9 reglas');
    assert.equal(scores.rows[2].valor, 'MEDIA · 57%');
    assert.equal(scores.rows[2].detalle, 'Peso 10% · capas dispersas');

    assert.deepEqual(
      layers.rows.map((r) => [r.concepto, r.valor, r.ok]),
      [['Parecido con operaciones pasadas', '65%', true]]
    );

    assert.equal(result.rows.length, 1);
    const final = result.rows[0];
    assert.equal(final.concepto, 'Probabilidad de ganar la operación');
    assert.equal(final.valor, '58%');
    assert.equal(final.final, true);
    assert.equal(final.ok, true);
    assert.match(final.detalle, /equilibrio 33% con R:R 1:2/);

    const all = groups.flatMap((g) => g.rows.map((r) => r.concepto.toLowerCase()));
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(verdictRows(s), [{ campo: 'Probabilidad de éxito', valor: '58%' }]);
  });

  it('scoreRowStatus interpreta %, fracciones, pass/fail, multiplicadores y EV', () => {
    assert.equal(scoreRowStatus('Cumplimiento de reglas', '66%'), true);
    assert.equal(scoreRowStatus('Rules E1', '2/6'), false);
    assert.equal(scoreRowStatus('Rules extendidas (10)', '65%'), false);
    assert.equal(scoreRowStatus('ML tabular (gated)', '69.5%'), true);
    assert.equal(scoreRowStatus('Acuerdo entre capas', 'BAJA · 38%'), false);
    assert.equal(scoreRowStatus('CRT coherence', 'pass'), true);
    assert.equal(scoreRowStatus('CRT coherence', 'fail'), false);
    assert.equal(scoreRowStatus('Penalización ubicación', '×0.72'), false);
    assert.equal(scoreRowStatus('Bonificación ubicación', '×1.03'), true);
    assert.equal(scoreRowStatus('EV por operación', '+0.18R'), true);
    assert.equal(scoreRowStatus('EV por operación', '-0.07R'), false);
    assert.equal(scoreRowStatus('Fusión heurística (anterior)', '60%'), null);
    assert.equal(scoreRowStatus('Neural galería', 'n/d'), null);
  });

  it('naturalScoreName traduce la jerga y fusiona duplicados de la foto', () => {
    assert.equal(naturalScoreName('CRT coherence'), 'Precio respeta el rango de ayer');
    assert.equal(naturalScoreName('Penalización ubicación'), 'Precio en zona favorable');
    const groups = rapidaScoreGroups({
      rulesPct: 66,
      mlPct: 69.5,
      scoreExtended: 70,
      scoreCombined: 51,
      planDetails: { rr: '1:2' },
      scorecard: [
        { label: 'Rules E1', value: 66, raw: '4/6', weight: '28%', note: '66% OK' },
        { label: 'Rules extendidas (10)', value: 70, raw: '70%', weight: '12%', note: 'meta >70%' },
        { label: 'ML tabular (gated)', value: 69.5, raw: '69.5%', weight: '18%', note: 'grade B' },
        { label: 'Penalización ubicación', value: null, raw: '×0.72', weight: '—', note: 'chase' },
      ],
    });
    const names = groups.flatMap((g) => g.rows.map((r) => r.concepto));
    assert.equal(names.filter((n) => n === 'Predicción del modelo de datos').length, 1);
    assert.equal(names.filter((n) => n === 'Chequeo ampliado (10 puntos)').length, 1);
    assert.equal(names.filter((n) => n === 'Reglas del plan cumplidas').length, 1);
    const last = groups.at(-1)!.rows[0];
    assert.equal(last.valor, '51%');
    assert.equal(last.ok, true);
  });

  it('rapidaScoreGroups sin scorecard usa chartScores solo para lo que falta', () => {
    const groups = rapidaScoreGroups({
      rulesPct: 80,
      mlPct: 55,
      chartScores: [
        { label: 'Rules', value: 80 },
        { label: 'ML', value: 55 },
        { label: 'Neural galería', value: 62.5 },
        { label: 'Probabilidad de éxito', value: 58 },
      ],
    });
    assert.deepEqual(groups.map((g) => g.titulo), ['Resumen', 'Detalle por análisis', 'Resultado']);
    assert.deepEqual(groups[1].rows, [{
      concepto: 'Parecido con operaciones pasadas',
      valor: '62.5%',
      detalle: '—',
      ok: true,
      tecnico: 'Neural galería',
    }]);

    const onlyBars = rapidaScoreGroups({ chartScores: [{ label: 'Rules E1', value: 70 }] });
    assert.deepEqual(onlyBars.map((g) => g.titulo), ['Detalle por análisis']);
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
