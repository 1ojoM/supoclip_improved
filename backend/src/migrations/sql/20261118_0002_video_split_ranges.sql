ALTER TABLE video_splits ADD COLUMN IF NOT EXISTS selected_ranges JSONB;
ALTER TABLE video_splits ADD COLUMN IF NOT EXISTS source_duration DOUBLE PRECISION;
ALTER TABLE video_splits DROP CONSTRAINT IF EXISTS video_splits_status_check;
ALTER TABLE video_splits ADD CONSTRAINT video_splits_status_check CHECK (status IN ('queued', 'processing', 'cancelling', 'cancelled', 'completed', 'error'));
