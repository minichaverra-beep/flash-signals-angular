import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoLocked, isEffectivelyLocked, isPastDay, localDayKey } from './historial-lock.ts';

const TZ = 'America/Bogota'; // UTC-5 sin horario de verano
const ms = (iso: string) => Date.parse(iso);

describe('historial-lock (bloqueo por fecha local)', () => {
  it('localDayKey usa el día local de la zona, no el UTC', () => {
    assert.equal(localDayKey('2026-10-02T03:30:00.000Z', TZ), '2026-10-01');
    assert.equal(localDayKey('nada', TZ), null);
  });

  it('frontera: 23:59 de ayer bloquea, 00:01 de hoy no', () => {
    const now = ms('2026-10-01T15:00:00.000Z');
    assert.equal(isPastDay('2026-10-01T04:59:00.000Z', now, TZ), true);
    assert.equal(isPastDay('2026-10-01T05:01:00.000Z', now, TZ), false);
  });

  it('día UTC siguiente que localmente sigue siendo hoy no bloquea', () => {
    assert.equal(isPastDay('2026-10-02T03:30:00.000Z', ms('2026-10-02T04:30:00.000Z'), TZ), false);
  });

  it('al cruzar la medianoche local la fila de ayer queda bloqueada sin recargar', () => {
    const row = { createdAt: '2026-10-01T20:00:00.000Z' };
    assert.equal(isEffectivelyLocked(row, ms('2026-10-02T04:59:00.000Z'), TZ), false);
    assert.equal(isEffectivelyLocked(row, ms('2026-10-02T05:00:00.000Z'), TZ), true);
  });

  it('manual OR (día anterior AND sin override)', () => {
    const now = ms('2026-10-01T15:00:00.000Z');
    const past = '2026-09-28T15:00:00.000Z';
    assert.equal(isAutoLocked({ createdAt: past }, now, TZ), true);
    assert.equal(isEffectivelyLocked({ createdAt: past, unlockOverride: true }, now, TZ), false);
    assert.equal(isEffectivelyLocked({ createdAt: past, unlockOverride: true, locked: true }, now, TZ), true);
    assert.equal(isEffectivelyLocked({ createdAt: '2026-10-01T14:00:00.000Z' }, now, TZ), false);
    assert.equal(isEffectivelyLocked({ createdAt: null }, now, TZ), false);
  });
});
