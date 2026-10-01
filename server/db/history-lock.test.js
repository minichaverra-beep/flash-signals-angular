/**
 * Bloqueo por fecha (reglas puras): "hoy" es el día local en la zona dada, nunca medianoche UTC.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { historyTz, localDayKey, isPastDay, lockState, SYSTEM_TZ } = require('./history-lock');

const TZ = 'America/Bogota'; // UTC-5 sin horario de verano

describe('history-lock', () => {
  afterEach(() => {
    delete process.env.HISTORY_TZ;
  });

  it('localDayKey usa el día local de la zona, no el día UTC', () => {
    assert.equal(localDayKey('2026-10-02T03:30:00.000Z', TZ), '2026-10-01');
    assert.equal(localDayKey('2026-10-02T03:30:00.000Z', 'UTC'), '2026-10-02');
    assert.equal(localDayKey('no-es-fecha', TZ), null);
  });

  it('frontera de medianoche local: 23:59 de ayer bloquea, 00:01 de hoy no', () => {
    const now = new Date('2026-10-01T15:00:00.000Z'); // 10:00 local
    assert.equal(isPastDay('2026-10-01T04:59:00.000Z', now, TZ), true); // 30-sep 23:59 local
    assert.equal(isPastDay('2026-10-01T05:01:00.000Z', now, TZ), false); // 01-oct 00:01 local
  });

  it('fila del día UTC siguiente que localmente sigue siendo hoy no se bloquea', () => {
    const now = new Date('2026-10-02T04:30:00.000Z'); // 01-oct 23:30 local
    assert.equal(isPastDay('2026-10-02T03:30:00.000Z', now, TZ), false);
    assert.equal(isPastDay('2026-10-01T06:00:00.000Z', now, TZ), false);
  });

  it('al pasar la medianoche local la fila de ayer queda bloqueada', () => {
    const created = '2026-10-01T20:00:00.000Z'; // 01-oct 15:00 local
    assert.equal(isPastDay(created, new Date('2026-10-02T04:59:00.000Z'), TZ), false);
    assert.equal(isPastDay(created, new Date('2026-10-02T05:00:00.000Z'), TZ), true);
  });

  it('lockState: manual OR (día anterior AND sin override)', () => {
    const now = new Date('2026-10-01T15:00:00.000Z');
    const past = '2026-09-29T15:00:00.000Z';
    const today = '2026-10-01T14:00:00.000Z';
    assert.deepEqual(lockState({ created_at: today, locked: 0, unlock_override: 0 }, now, TZ), {
      locked: false,
      unlockOverride: false,
      autoLocked: false,
      effectiveLocked: false,
    });
    assert.equal(lockState({ created_at: today, locked: 1 }, now, TZ).effectiveLocked, true);
    const auto = lockState({ created_at: past, locked: 0, unlock_override: 0 }, now, TZ);
    assert.equal(auto.autoLocked, true);
    assert.equal(auto.effectiveLocked, true);
    const overridden = lockState({ created_at: past, locked: 0, unlock_override: 1 }, now, TZ);
    assert.equal(overridden.autoLocked, false);
    assert.equal(overridden.effectiveLocked, false);
    assert.equal(lockState({ created_at: 'x', locked: 0 }, now, TZ).effectiveLocked, false);
  });

  it('historyTz: HISTORY_TZ válida o la zona del sistema', () => {
    assert.equal(historyTz(), SYSTEM_TZ);
    process.env.HISTORY_TZ = TZ;
    assert.equal(historyTz(), TZ);
    process.env.HISTORY_TZ = 'Zona/Inventada';
    assert.equal(historyTz(), SYSTEM_TZ);
  });
});
