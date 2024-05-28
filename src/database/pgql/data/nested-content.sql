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

-- insertNestedDataHash
INSERT OR REPLACE INTO contiguous_data_parents (
  hash,
  parent_hash,
  data_offset,
  indexed_at
)
SELECT :hash, contiguous_data_hash, :data_offset, :indexed_at
FROM contiguous_data_ids
WHERE id = :parent_id;
