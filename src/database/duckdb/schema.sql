CREATE TABLE IF NOT EXISTS tags (
  height UINTEGER NOT NULL,
  id TEXT NOT NULL,
  tag_index USMALLINT NOT NULL,
  created_at INTEGER NOT NULL,
  tag_name TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  is_data_item BOOLEAN NOT NULL
);