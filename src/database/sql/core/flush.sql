-- selectMaxStableBlockTimestamp
SELECT IFNULL(MAX(block_timestamp), 0) AS block_timestamp
FROM stable_blocks

-- insertOrIgnoreStableBlocks
INSERT INTO stable_blocks (
  height, indep_hash, previous_block, nonce, hash,
  block_timestamp, diff, cumulative_diff, last_retarget,
  reward_addr, reward_pool, block_size, weave_size,
  usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
  scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
  hash_list_merkle, wallet_list, tx_root,
  tx_count, missing_tx_count
) SELECT
  nb.height, nb.indep_hash, nb.previous_block, nb.nonce, nb.hash,
  nb.block_timestamp, nb.diff, nb.cumulative_diff, nb.last_retarget,
  nb.reward_addr, nb.reward_pool, nb.block_size, nb.weave_size,
  nb.usd_to_ar_rate_dividend, nb.usd_to_ar_rate_divisor,
  nb.scheduled_usd_to_ar_rate_dividend, nb.scheduled_usd_to_ar_rate_divisor,
  nb.hash_list_merkle, nb.wallet_list, nb.tx_root,
  nb.tx_count, nb.missing_tx_count
FROM new_blocks nb
WHERE nb.height < @end_height
ON CONFLICT DO NOTHING

-- insertOrIgnoreStableBlockTransactions
INSERT INTO stable_block_transactions (
  block_indep_hash, transaction_id, block_transaction_index
) SELECT
  nbt.block_indep_hash, nbt.transaction_id, nbt.block_transaction_index
FROM new_block_transactions nbt
WHERE nbt.height < @end_height
ON CONFLICT DO NOTHING

-- insertOrIgnoreStableTransactions
INSERT INTO stable_transactions (
  id, height, block_transaction_index, signature,
  format, last_tx, owner_address, target, quantity,
  reward, data_size, data_root, content_type, tag_count,
  content_encoding, indexed_at
) SELECT
  nt.id, nbt.height, nbt.block_transaction_index, nt.signature,
  nt.format, nt.last_tx, nt.owner_address, nt.target, nt.quantity,
  nt.reward, nt.data_size, nt.data_root, nt.content_type, nt.tag_count,
  nt.content_encoding, nt.indexed_at
FROM new_transactions nt
JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
WHERE nbt.height < @end_height
ON CONFLICT DO NOTHING

-- insertOrIgnoreStableTransactionTags
INSERT INTO stable_transaction_tags (
  tag_name_hash, tag_value_hash, height,
  block_transaction_index, transaction_tag_index,
  transaction_id
) SELECT
  ntt.tag_name_hash, ntt.tag_value_hash, nbt.height,
  nbt.block_transaction_index, ntt.transaction_tag_index,
  ntt.transaction_id
FROM new_transaction_tags ntt
JOIN new_block_transactions nbt ON nbt.transaction_id = ntt.transaction_id
WHERE nbt.height < @end_height
ON CONFLICT DO NOTHING
