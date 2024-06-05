-- selectMaxStableBlockHeight
SELECT MAX(height) AS height
FROM stable_blocks

-- selectNewTransactionTags
SELECT name, value
FROM new_transaction_tags
JOIN tag_names ON tag_name_hash = tag_names.hash
JOIN tag_values ON tag_value_hash = tag_values.hash
WHERE transaction_id = @transaction_id
ORDER BY transaction_tag_index ASC

-- selectStableTransactionTags
SELECT name, value
FROM stable_transaction_tags
JOIN tag_names ON tag_name_hash = tag_names.hash
JOIN tag_values ON tag_value_hash = tag_values.hash
WHERE transaction_id = @transaction_id
ORDER BY transaction_tag_index ASC
