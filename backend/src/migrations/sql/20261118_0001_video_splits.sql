CREATE TABLE IF NOT EXISTS video_splits (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    title TEXT NOT NULL,
    part_minutes INTEGER NOT NULL CHECK (part_minutes BETWEEN 1 AND 90),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'error')),
    progress INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS video_splits_owner_idx ON video_splits(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS video_split_parts (
    id VARCHAR(36) PRIMARY KEY,
    split_id VARCHAR(36) NOT NULL REFERENCES video_splits(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL,
    start_seconds DOUBLE PRECISION NOT NULL,
    duration_seconds DOUBLE PRECISION NOT NULL,
    video_path TEXT NOT NULL,
    UNIQUE(split_id, part_number)
);
