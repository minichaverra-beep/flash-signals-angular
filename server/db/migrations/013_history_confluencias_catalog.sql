-- Migración 013: catálogo cerrado de confluencias.
-- Solo quedan: Continuación, Reversion, Macro tendencia, Micro tendencia, Resistencia débil,
-- Soporte débil (en ese orden). El resto se borra junto con sus asignaciones a señales.
-- La API ya no crea opciones nuevas (POST /api/history/confluencias → 400 si no existe).
-- Aplicada en boot por history-store.js (applyConfluenciasCatalogMigration, una sola vez).

DELETE FROM signal_history_confluencias WHERE confluencia_id IN (
  SELECT id FROM history_confluencias WHERE name NOT IN (
    'Continuación', 'Reversion', 'Macro tendencia', 'Micro tendencia', 'Resistencia débil', 'Soporte débil'
  )
);

DELETE FROM history_confluencias WHERE name NOT IN (
  'Continuación', 'Reversion', 'Macro tendencia', 'Micro tendencia', 'Resistencia débil', 'Soporte débil'
);

UPDATE history_confluencias SET sort_order = 10 WHERE name = 'Continuación';
UPDATE history_confluencias SET sort_order = 20 WHERE name = 'Reversion';
UPDATE history_confluencias SET sort_order = 30 WHERE name = 'Macro tendencia';
UPDATE history_confluencias SET sort_order = 40 WHERE name = 'Micro tendencia';
UPDATE history_confluencias SET sort_order = 50 WHERE name = 'Resistencia débil';
UPDATE history_confluencias SET sort_order = 60 WHERE name = 'Soporte débil';
