-- insertNestedDataId
INSERT OR REPLACE INTO contiguous_data_id_parents (
  id,
  parent_id,
  data_offset,
  data_size,
  created_at
) VALUES (
  :id,
  :parent_id,
  :data_offset,
  :data_size,
  :created_at
);
