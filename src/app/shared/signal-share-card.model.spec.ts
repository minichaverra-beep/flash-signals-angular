/**
 * Specs de la tarjeta para compartir (node --experimental-strip-types --test).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JobStatus, SignalSummary } from '../services/signals-api.service';
import {
  DISCORD_APP,
  MESSENGER_WEB,
  buildShareCard,
  shareOdds,
  facebookShareUrl,
  formatRiskNumber,
  jobChartSrc,
  parseRiskPoints,
  posterShareData,
  resolveShareAction,
  runningSessionLabel,
  posterShareFileName,
  realPublicUrl,
  riskFillPercent,
  scenarioTitle,
  sharePngFilename,
  telegramShareUrl,
  twitterShareUrl,
  whatsAppShareUrl,
} from './signal-share-card.model.ts';

function job(partial: Partial<JobStatus> & { summary?: SignalSummary | null }): JobStatus {
  return {
    status: 'done',
    logs: [],
    market: 'xauusd',
    tier: 'high',
    reportPath: String.raw`D:\live\xauusd_m5_high_signal.md`,
    ...partial,
  };
}

describe('buildShareCard', () => {
  it('oculta la tarjeta si la corrida no terminó o no hay summary', () => {
    assert.equal(buildShareCard(job({ status: 'running', summary: { price: '1' } })), null);
    assert.equal(buildShareCard(job({ status: 'idle', summary: { price: '1' } })), null);
    assert.equal(buildShareCard(job({ status: 'error', summary: { price: '1' } })), null);
    assert.equal(buildShareCard(job({ summary: null })), null);
    assert.equal(buildShareCard(job({ summary: {} })), null);
    assert.equal(buildShareCard(null), null);
  });

  it('con solo entrada, stop, objetivo y dirección no inventa zonas ni minutos', () => {
    const card = buildShareCard(
      job({
        reportPath: null,
        summary: {
          bias: 'bearish',
          planDetails: { entry: '4164.18', sl: '4170.18', tp: '4152.18' },
        },
      })
    );
    assert.ok(card);
    assert.equal(card.direction, 'Bajista');
    assert.equal(card.timeframe, null);
    assert.equal(card.price, null);
    assert.equal(card.asOf, null);
    assert.equal(card.primary, null);
    assert.equal(card.pullback, null);
    assert.equal(card.footer, null);
    assert.equal(card.odds, null);
    assert.deepEqual(
      card.levels.map((l) => l.label),
      ['Entrada', 'SL', 'TP']
    );
    assert.equal(card.pills.length, 1);
    assert.equal(card.pills[0].title, 'Bajista');
    assert.equal(card.action, null);
    assert.equal(JSON.stringify(card).includes('Retesteo posible'), false);
    assert.equal(card.risk, null);
    assert.equal(
      card.caption,
      [
        '╭━━━ ✦ 𝙁𝙇𝘼𝙎𝙃 𝙎𝙄𝙂𝙉𝘼𝙇𝙎 ✦ ━━━╮',
        '◈ XAUUSD  │  ↘️ BAJISTA',
        '',
        '🟣 ◉ ENTRADA SELL: 4164.18',
        '🔴 ▼ STOP LOSS: 4170.18',
        '💜 ✧ OBJETIVO TP: 4152.18',
        '',
        '╰━━ ⌁ ANÁLISIS · ESTRUCTURA · PRECISIÓN ⌁ ━━╯',
        '                 BY: SKAYDER',
      ].join('\n'),
    );
    assert.equal(card.caption.includes('81607'), false);
    const blob = JSON.stringify(card);
    assert.equal(blob.includes('4143'), false);
    assert.equal(blob.includes('minutos'), false);
    assert.equal(blob.includes('Resistencia'), false);
  });

  it('mapea precio, temporalidad del reporte, veredicto, plan y rango que sí existen', () => {
    const card = buildShareCard(
      job({
        summary: {
          market: 'xauusd',
          price: '4162.34',
          dataAsOf: '2026-10-16 22:05 UTC',
          bias: 'BEARISH',
          setup: 'BREAK (breakout)',
          verdict: 'ESPERAR',
          scoreCombined: 55.1,
          twoM5: 'Sin 2M5',
          winrate: '~55%',
          planDetails: {
            entry: '4164.18',
            sl: '4170.18',
            tp: '4152.18',
            rr: '1:2',
            risk: '6',
            trigger: 'ICT retest FVG BEARISH edge',
            invalidation: 'Cierre M5 > 4168.34',
          },
          redFlags: ['Precio dentro PDH/PDL'],
          engine: {
            schemaVersion: 1,
            asset: 'XAUUSD',
            direction: 'SHORT',
            price: 4162.34,
            crt: { h1_detail: 'Rango H1 4156-4168; 0.5=4162', midpoint: 4138.525 },
          },
        },
      })
    );
    assert.ok(card);
    assert.equal(card.symbol, 'XAUUSD');
    assert.equal(card.timeframe, 'M5');
    assert.equal(card.tier, 'HIGH');
    assert.equal(card.price, '4162.34');
    assert.equal(card.asOf, '2026-10-16 22:05 UTC');
    assert.equal(card.direction, 'Bajista');
    assert.deepEqual(card.odds, { compra: 45, venta: 55 });
    assert.equal(card.pills[0].title, 'Bajista');
    assert.equal(card.action?.state, 'ESPERAR');
    assert.equal(card.action?.reason, null);
    assert.equal(JSON.stringify(card).includes('Retesteo posible'), false);
    assert.equal(JSON.stringify(card.pills).includes('ESCENARIO PRINCIPAL'), false);
    assert.equal(JSON.stringify(card.pills).includes('BREAK'), false);
    assert.equal(card.pills.some((p) => p.kicker === 'Probabilidad de éxito' && p.title === '55%'), true);
    assert.equal(card.pills.some((p) => /tiempo de an/i.test(p.kicker)), false);
    assert.deepEqual(
      card.levels.map((l) => `${l.label}=${l.value}`),
      [
        'Entrada=4164.18',
        'SL=4170.18',
        'TP=4152.18',
        'Punto medio=4138.525',
      ]
    );
    assert.equal(card.risk, 6);
    assert.equal(card.levels.some((l) => l.label === 'Riesgo'), false);
    assert.equal(card.levels.some((l) => l.label === 'R:R' || l.label === 'Rango H1'), false);
    assert.equal(card.primary?.bullets.some((b) => b.startsWith('Estructura:')), false);
    assert.equal(card.primary?.bullets.some((b) => b.startsWith('Acierto:')), false);
    assert.equal(JSON.stringify(card).includes('Rango H1'), false);
    assert.equal(card.primary?.title, 'Escenario bajista');
    assert.equal(card.primary?.tone, 'loss');
    assert.equal(card.primary?.bullets.includes('Veredicto: Esperar'), true);
    assert.equal(card.primary?.bullets.some((b) => b.includes('Activación: ICT retest FVG BAJISTA edge')), true);
    assert.equal(card.pullback?.title, 'Escenario de retroceso');
    assert.equal(card.pullback?.bullets[0], 'Invalidación: Cierre M5 > 4168.34');
    assert.equal(card.pullback?.bullets[1], 'Precio dentro PDH/PDL');
  });

  it('traduce continuación solo cuando el setup la menciona', () => {
    assert.equal(scenarioTitle('BREAK (continuación E1)', 'Alcista'), 'Continuación alcista');
    assert.equal(scenarioTitle('BREAK (breakout)', 'Bajista'), 'BREAK (breakout)');
    const card = buildShareCard(
      job({
        summary: { bias: 'bullish', setup: 'BREAK (continuación E1)', verdict: 'OPERAR' },
      })
    );
    assert.equal(card?.action?.state, 'TOMAR');
    assert.equal(card?.action?.reason, null);
    assert.equal(card?.pills.some((p) => p.title === 'Retesteo posible'), false);
    assert.equal(card?.primary?.title, 'Escenario alcista');
    assert.equal(card?.primary?.tone, 'gain');
  });

  it('elige TOMAR o ESPERAR solo con campos reales', () => {
    assert.equal(resolveShareAction({ bias: 'bullish' }), null);
    assert.deepEqual(resolveShareAction({ verdict: 'ESPERAR' }), { state: 'ESPERAR', reason: null });
    assert.equal(
      resolveShareAction({ plan: 'Niveles planificados (no es entrada activa)' })?.state,
      'ESPERAR',
    );
    assert.match(
      resolveShareAction({ plan: 'Niveles planificados (no es entrada activa)' })?.reason ?? '',
      /no es entrada activa/i,
    );
    assert.equal(
      resolveShareAction({ zentinel: { kzOn: false, killzone: 'FUERA_NY' } })?.reason,
      runningSessionLabel(),
    );
    assert.equal(runningSessionLabel(new Date('2026-10-17T01:07:00Z')), 'Tokio · Sídney');
    assert.equal(runningSessionLabel(new Date('2026-10-16T14:00:00Z')), 'Nueva York · Londres');
    assert.deepEqual(resolveShareAction({ zentinel: { kzOn: false, killzone: 'NY AM 08-10' } }), {
      state: 'ESPERAR',
      reason: 'NY AM 08-10',
    });
    assert.equal(resolveShareAction({ verdict: 'OPERAR', zentinel: { kzOn: false } })?.state, 'ESPERAR');
    const waiting = buildShareCard(job({ summary: { verdict: 'ESPERAR', bias: 'bullish' } }));
    assert.deepEqual(
      waiting?.pills.find((p) => p.kicker === 'Si es Esperar'),
      { kicker: 'Si es Esperar', title: '2 velas M5 a favor', detail: 'Hay que esperar a que salgan' },
    );
    const taking = buildShareCard(job({ summary: { verdict: 'OPERAR_LONG', bias: 'bullish' } }));
    assert.equal(taking?.pills.some((p) => p.kicker === 'Si es Esperar'), false);
    assert.equal(resolveShareAction({ setup: 'BREAK (breakout)' }), null);
    assert.equal(resolveShareAction({ planDetails: { confirmation: 'Entrada activa en zona' } })?.state, 'TOMAR');
    assert.equal(resolveShareAction({ verdict: 'OPERAR_LONG' })?.state, 'TOMAR');
    assert.equal(resolveShareAction({ verdict: 'NO_OPERAR' }), null);
    assert.equal(JSON.stringify(resolveShareAction({ verdict: 'OPERAR' })).includes('Retesteo'), false);
  });

  it('la barra de riesgo lee los puntos de la librería y no los usa como porcentaje', () => {
    assert.equal(parseRiskPoints('60.0'), 60);
    assert.equal(parseRiskPoints('232.1'), 232.1);
    assert.equal(parseRiskPoints(''), null);
    assert.equal(parseRiskPoints('no'), null);
    assert.equal(riskFillPercent(60), 60);
    assert.equal(riskFillPercent(140), 100);
    assert.equal(formatRiskNumber(60), '60');
    const summary = {
      market: 'btc',
      bias: 'bullish',
      price: '81530.17',
      planDetails: { entry: '81530.17', rr: '1:2', risk: '60.0' },
    };
    const card = buildShareCard(job({ market: 'btc', summary }));
    assert.equal(card?.risk, 60);
    assert.equal(card?.riskFill, 41);
    assert.equal(card?.riskNote, 'Si el riesgo es alto, el SL pasa el soporte o la resistencia para cubrir el slippage');
    assert.notEqual(card?.riskFill, card?.risk);
    const hot = buildShareCard(
      job({
        market: 'xauusd',
        summary: {
          market: 'xauusd',
          bias: 'bearish',
          price: '4169.90',
          planDetails: { entry: '4169.90', sl: '4175.90', tp: '4163.90', rr: '1:1', risk: '6' },
          engine: { schemaVersion: 1, asset: 'XAUUSD', crt: { h1_detail: 'Rango H1 4164-4182' } },
        },
      }),
    );
    assert.equal(hot?.riskNote, 'Riesgo alto: el SL pasa la resistencia para cubrir el slippage');
    assert.equal(hot?.levels.find((level) => level.label === 'SL')?.value, '4184.00');
    const hotBtc = buildShareCard(
      job({
        market: 'btc',
        summary: {
          market: 'btc',
          bias: 'bullish',
          price: '81530',
          planDetails: { entry: '81530.00', sl: '81470.00', tp: '81590.00', rr: '1:1', risk: '60' },
          engine: {
            schemaVersion: 1,
            asset: 'BTC',
            crt: { h1_detail: 'Rango H1 81434-81674' },
            ict: { scan: { zone_level: 81400, zone_type: 'soporte_debil' } },
          },
        },
      }),
    );
    assert.equal(hotBtc?.riskNote, 'Riesgo alto: el SL pasa el soporte para cubrir el slippage');
    assert.equal(hotBtc?.levels.find((level) => level.label === 'SL')?.value, '81414.00');
    const wide = buildShareCard(
      job({ summary: { market: 'btc', bias: 'bullish', planDetails: { risk: '232.1' } } }),
    );
    assert.equal(wide?.risk, 232.1);
    assert.equal(wide?.riskFill, null);
    assert.equal(card?.levels.some((l) => l.label === 'Riesgo'), false);
    assert.equal(card?.caption.includes('₿ BTC'), true);
    assert.equal(card?.caption.includes('↗️ ALCISTA'), true);
    assert.equal(card?.caption.includes('ENTRADA BUY: 81530.17'), true);
    assert.equal(card?.caption.includes('STOP LOSS'), false);
    assert.equal(card?.caption.includes('81607'), false);
  });

  it('el payload de compartir lleva el archivo PNG y no solo el texto', () => {
    const file = new File([Uint8Array.from([137, 80, 78, 71])], posterShareFileName('XAUUSD'), { type: 'image/png' });
    const data = posterShareData(file, 'texto');
    assert.ok(data);
    assert.equal(data.files[0], file);
    assert.equal(data.files[0].size > 0, true);
    assert.equal(data.files[0].name, 'senal-xauusd.png');
    assert.equal(data.title, 'Flash Signals');
    assert.equal(data.text, 'texto');
    assert.equal(Object.hasOwn(data, 'url'), false);
    assert.equal(posterShareData(new File([], 'vacio.png', { type: 'image/png' }), 'texto'), null);
  });

  it('arma las URLs de WhatsApp y Facebook sin simular un archivo', () => {
    const text = 'XAUUSD · Bajista · Entrada 1';
    assert.equal(whatsAppShareUrl(text), `https://wa.me/?text=${encodeURIComponent(text)}`);
    const fb = new URL(facebookShareUrl('http://localhost:4400/senales', text));
    assert.equal(fb.origin + fb.pathname, 'https://www.facebook.com/sharer/sharer.php');
    assert.equal(fb.searchParams.get('u'), 'http://localhost:4400/senales');
    assert.equal(fb.searchParams.get('quote'), text);
    assert.equal(sharePngFilename({ symbol: 'XAUUSD', timeframe: 'M5' }), 'senal-xauusd-m5.png');
  });

  it('arma Telegram y Twitter solo con texto y no inventa una URL pública', () => {
    const text = 'XAUUSD · Bajista · Entrada 1';
    const tg = new URL(telegramShareUrl(text));
    assert.equal(tg.origin + tg.pathname, 'https://t.me/share/url');
    assert.equal(tg.searchParams.get('text'), text);
    assert.equal(tg.searchParams.get('url'), null);
    assert.equal(telegramShareUrl(text, 'http://localhost:4400/senales').includes('url='), false);
    assert.equal(realPublicUrl('http://127.0.0.1/senales'), null);
    const pub = new URL(telegramShareUrl(text, 'https://flash.example/senales'));
    assert.equal(pub.searchParams.get('url'), 'https://flash.example/senales');
    assert.equal(pub.searchParams.get('text'), text);
    const tw = new URL(twitterShareUrl(text));
    assert.equal(tw.origin + tw.pathname, 'https://twitter.com/intent/tweet');
    assert.equal(tw.searchParams.get('text'), text);
    assert.equal(tw.searchParams.get('url'), null);
    assert.equal(DISCORD_APP, 'https://discord.com/app');
    assert.equal(MESSENGER_WEB, 'https://www.messenger.com/');
  });

  it('reparte COMPRA/VENTA solo con un porcentaje real y la dirección', () => {
    assert.equal(shareOdds({ scoreCombined: 62 }, null), null);
    assert.equal(shareOdds({}, 'Alcista'), null);
    assert.deepEqual(shareOdds({ scoreCombined: 62.4, bias: 'bullish' }, 'Alcista'), { compra: 62, venta: 38 });
    assert.deepEqual(shareOdds({ winrate: '80%: 40-60%' }, 'Bajista'), null);
    assert.deepEqual(shareOdds({ winrate: '~55%', bias: 'bearish' }, 'Bajista'), { compra: 45, venta: 55 });
    assert.deepEqual(
      shareOdds({ scoreCombined: 10, engine: { schemaVersion: 1, asset: 'XAUUSD', probability: { pct: 71 } } }, 'Alcista'),
      { compra: 71, venta: 29 },
    );
  });

  it('no incrusta gráfico si el job no trae imagen', () => {
    const done = job({ summary: { price: '1' } });
    assert.equal(jobChartSrc(done), null);
    assert.equal(jobChartSrc({ ...done, chartUrl: '/charts/xau.png' }), '/charts/xau.png');
    assert.equal(jobChartSrc({ ...done, chartPath: String.raw`D:\live\xau.png` }), '/api/signals/chart?market=xauusd');
  });
});
