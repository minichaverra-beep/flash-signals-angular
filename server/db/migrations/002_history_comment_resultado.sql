-- Migration 002: comment + resultado on signal_history
-- Applied on boot by history-store.js (ALTER if missing).
-- resultado: NULL | 'ganada' | 'perdida'

ALTER TABLE signal_history ADD COLUMN comment TEXT;
ALTER TABLE signal_history ADD COLUMN resultado TEXT;
