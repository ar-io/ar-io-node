-- selectDataAttributes
SELECT *
FROM (
  SELECT data_root, data_size, content_type, content_encoding, null AS root_transaction_id, true AS stable
  FROM stable_transactions
  WHERE id = @id
  UNION
  SELECT data_root, data_size, content_type, content_encoding, null AS root_transaction_id, false AS stable
  FROM new_transactions
  WHERE id = @id
  UNION
  SELECT null AS data_root, data_size, content_type, content_encoding, root_transaction_id, true AS stable
  FROM bundles.stable_data_items
  WHERE id = @id
  UNION
  SELECT null AS data_root, data_size, content_type, content_encoding, root_transaction_id, false AS stable
  FROM bundles.new_data_items
  WHERE id = @id
)
LIMIT 1
