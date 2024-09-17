CREATE TABLE IF NOT EXISTS tags (
  height UBIGINT NOT NULL,
  id BLOB NOT NULL,
  tag_index USMALLINT NOT NULL,
  created_at UBIGINT NOT NULL,
  tag_name BLOB NOT NULL,
  tag_value BLOB NOT NULL,
  is_data_item BOOLEAN NOT NULL
);