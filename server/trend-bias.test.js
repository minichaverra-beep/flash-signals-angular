'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrendBiasOutput, trendBiasDecision } = require('./trend-bias');

const bajista = {
  ok: true,
  bias: 'BEARISH',
  flag: 'bearish',
  label: 'BAJISTA',
  method: 'h1_bias',
  close: 50977.5,
  ema20: 51351.799,
  ema50: 51379.75,
  source: 'MT5 US30m (broker, M5/H1)',
};

test('parseTrendBiasOutput: toma la línea marcada e ignora ruido', () => {
  const out = `MT5 aviso\nTREND_BIAS_JSON ${JSON.stringify(bajista)}\n`;
  assert.deepEqual(parseTrendBiasOutput(out), bajista);
  assert.equal(parseTrendBiasOutput('sin marcador'), null);
  assert.equal(parseTrendBiasOutput('TREND_BIAS_JSON {roto'), null);
});

test('bajista → -Bearish', () => {
  const d = trendBiasDecision(bajista);
  assert.equal(d.flag, 'bearish');
  assert.equal(d.label, 'BAJISTA');
  assert.match(d.log, /^\[bias\] Tendencia actual H1: BAJISTA → -Bearish \(/);
  assert.match(d.log, /EMA20 51351\.8 · EMA50 51379\.75/);
  assert.match(d.log, /MT5 US30m/);
});

test('alcista por desempate EMA20 vs EMA50 → -Bullish', () => {
  const d = trendBiasDecision({ ...bajista, bias: 'BULLISH', flag: 'bullish', label: 'ALCISTA', method: 'ema20_vs_ema50' });
  assert.equal(d.flag, 'bullish');
  assert.match(d.log, /ALCISTA → -Bullish \(desempate EMA20 vs EMA50/);
});

test('neutral → sin forzar', () => {
  const d = trendBiasDecision({ ok: true, bias: 'NEUTRAL', flag: null, label: 'NEUTRAL', method: 'sin_datos' });
  assert.equal(d.flag, null);
  assert.match(d.log, /Tendencia actual H1: NEUTRAL → sin forzar bias/);
});

test('fallo del detector → sin forzar y motivo en el log', () => {
  const d1 = trendBiasDecision(null, 'timeout 60s');
  assert.equal(d1.flag, null);
  assert.match(d1.log, /No se pudo detectar la tendencia H1 \(timeout 60s\) → sin forzar bias/);
  const d2 = trendBiasDecision({ ok: false, error: 'puente caído' });
  assert.equal(d2.flag, null);
  assert.match(d2.log, /puente caído/);
});

test('flag desconocido no fuerza nada', () => {
  assert.equal(trendBiasDecision({ ...bajista, flag: 'sideways' }).flag, null);
});
