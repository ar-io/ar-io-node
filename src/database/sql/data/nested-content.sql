-- insertNestedDataId
INSERT OR REPLACE INTO contiguous_data_id_parents (
  id,
  parent_id,
  data_offset,
  data_size,
  indexed_at
) VALUES (
  :id,
  :parent_id,
  :data_offset,
  :data_size,
  :indexed_at
);
