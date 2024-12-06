CREATE TABLE IF NOT EXISTS blocked_names (
  name TEXT PRIMARY KEY,
  block_source_id INTEGER,
  notes TEXT,
  blocked_at INTEGER
);
