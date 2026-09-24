-- Migration 003: result image attachment on signal_history
-- File lives under data/history-attachments/<name>

ALTER TABLE signal_history ADD COLUMN result_image_name TEXT;
ALTER TABLE signal_history ADD COLUMN result_image_mime TEXT;
