/**
 * Tests de estilos de operación (Scalping / Day trading): niveles SL/TP, validación y body de /api/mt5/push.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mt5Style = require('./mt5-style');
const { buildOrderFromSummary } = require('./mt5');
const { parsePushOverrides } = require('./mt5-push-body');
const settings = require('./mt5-settings');

const baseSettings = {
  symbols: { btc: 'BTCUSD', us30: 'US30', xauusd: 'XAUUSD' },
  pipSize: { btc: 1, us30: 1, xauusd: 0.1 },
  extraSlPips: 30,
  extraTpPips: 30,
  riskPct: 0.5,
};

const summary = (entry, sl, tp) => ({ verdict: 'ENTRAR', setup: 'PULLBACK', planDetails: { entry, sl, tp } });

describe('mt5-style: niveles SL/TP', () => {
  it('LONG scalping: SL +15 pips y TP 1:1 desde el SL final', () => {
    const style = mt5Style.resolveStyle(baseSettings, 'scalping');
    const { order } = buildOrderFromSummary('btc', summary(100000, 99800, 100500), baseSettings, { style });
    assert.equal(order.side, 'LONG');
    assert.equal(order.sl, 99785);
    assert.equal(order.tp, 100215);
  });

  it('SHORT day trading: SL +30 pips y TP 1:2', () => {
    const style = mt5Style.resolveStyle(baseSettings, 'daytrading');
    const { order } = buildOrderFromSummary('xauusd', summary(2000, 2005, 1990), baseSettings, { style });
    assert.equal(order.side, 'SHORT');
    assert.equal(order.sl, 2008);
    assert.equal(order.tp, 1984);
  });

  it('sin tpRr: TP de la señal + TP extra del estilo', () => {
    const s = { ...baseSettings, styles: { scalping: { extraSlPips: 10, extraTpPips: 5, tpRr: null } } };
    const style = mt5Style.resolveStyle(s, 'scalping');
    const { order } = buildOrderFromSummary('us30', summary(40000, 39900, 40150), s, { style });
    assert.equal(order.sl, 39890);
    assert.equal(order.tp, 40155);
  });

  it('sin estilo se mantiene el margen extra del perfil', () => {
    const { order } = buildOrderFromSummary('btc', summary(100000, 99800, 100500), baseSettings);
    assert.equal(order.sl, 99770);
    assert.equal(order.tp, 100530);
  });

  it('el plan incoherente se sigue descartando con estilo', () => {
    const style = mt5Style.resolveStyle(baseSettings, 'scalping');
    const built = buildOrderFromSummary('btc', summary(100000, 100200, 100500), baseSettings, { style });
    assert.match(built.skip, /incoherente/);
  });

  it('defaults derivados del perfil', () => {
    const d = mt5Style.defaultStyles({ extraSlPips: 31, extraTpPips: 20, riskPct: 1 });
    assert.deepEqual(d.scalping, { extraSlPips: 16, extraTpPips: 0, riskPct: 1, tpRr: 1 });
    assert.deepEqual(d.daytrading, { extraSlPips: 31, extraTpPips: 20, riskPct: 1, tpRr: 2 });
  });

  it('resumen legible del estilo', () => {
    const style = mt5Style.resolveStyle(baseSettings, 'scalping');
    assert.equal(mt5Style.styleSummary(style), 'Scalping · riesgo 0.5 % · SL +15 pips · TP R:R 1:1');
    assert.equal(mt5Style.styleSummary(style, { fixedVolume: 0.1 }), 'Scalping · lotes fijos 0.1 · SL +15 pips · TP R:R 1:1');
  });
});

describe('mt5-style: body de /api/mt5/push', () => {
  it('style válido, ausente o inválido', () => {
    assert.equal(parsePushOverrides({ style: 'scalping' }).style, 'scalping');
    assert.equal(parsePushOverrides({ style: 'daytrading', dryRun: true }).overrides.dry_run, true);
    assert.equal(parsePushOverrides({}).style, null);
    assert.match(parsePushOverrides({ style: 'swing' }).error, /style debe ser/);
    assert.match(parsePushOverrides({ style: 1 }).error, /style debe ser/);
  });

  it('riskPct y volume siguen validándose', () => {
    assert.match(parsePushOverrides({ riskPct: 6 }).error, /riskPct/);
    assert.match(parsePushOverrides({ volume: 0 }).error, /volume/);
    assert.equal(parsePushOverrides({ riskPct: 1, style: 'scalping' }).overrides.risk_pct, 1);
  });
});

describe('mt5-style: configuración por perfil', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt5-style-'));
    process.env.MT5_SETTINGS_PATH = path.join(dir, 'mt5-settings.json');
  });

  after(() => {
    delete process.env.MT5_SETTINGS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(process.env.MT5_SETTINGS_PATH, { force: true });
    settings._resetForTests();
  });

  it('sin estilos guardados se derivan del perfil guardado', () => {
    fs.writeFileSync(process.env.MT5_SETTINGS_PATH, JSON.stringify({ profiles: { principal: { extraSlPips: 40, riskPct: 1 } } }));
    settings._resetForTests();
    const s = settings.get();
    assert.equal(s.styles.scalping.extraSlPips, 20);
    assert.equal(s.styles.daytrading.extraSlPips, 40);
    assert.equal(s.styles.daytrading.riskPct, 1);
    assert.equal(s.styles.daytrading.tpRr, 2);
  });

  it('guarda un estilo parcial, conserva el otro y tpRr 0 = sin R:R', () => {
    settings.update({ styles: { scalping: { riskPct: 0.25, tpRr: 0 } } });
    settings._resetForTests();
    const s = settings.get();
    assert.equal(s.styles.scalping.riskPct, 0.25);
    assert.equal(s.styles.scalping.tpRr, null);
    assert.equal(s.styles.scalping.extraSlPips, 15);
    assert.equal(s.styles.daytrading.tpRr, 2);
  });

  it('rechaza valores fuera de rango', () => {
    const bad = [
      { styles: { scalping: { riskPct: 0 } } },
      { styles: { scalping: { riskPct: 5.5 } } },
      { styles: { daytrading: { extraSlPips: -1 } } },
      { styles: { daytrading: { tpRr: 11 } } },
      { styles: { daytrading: { tpRr: -1 } } },
      { styles: { scalping: 'x' } },
      { styles: [] },
    ];
    for (const patch of bad) {
      assert.throws(() => settings.update(patch), (err) => err.status === 400, JSON.stringify(patch));
    }
  });
});
