-- upsertBundle
INSERT INTO bundles (
  id, root_transaction_id, format_id,
  unbundle_filter_id, index_filter_id,
  previous_unbundle_filter_id, previous_index_filter_id,
  data_item_count, matched_data_item_count,
  first_queued_at, last_queued_at,
  first_skipped_at, last_skipped_at,
  first_unbundled_at, last_unbundled_at,
  first_fully_indexed_at, last_fully_indexed_at,
  import_attempt_count, duplicated_data_item_count
) VALUES (
  @id, @root_transaction_id, @format_id,
  @unbundle_filter_id, @index_filter_id,
  NULL, NULL,
  @data_item_count, @matched_data_item_count,
  @queued_at, @queued_at,
  @skipped_at, @skipped_at,
  @unbundled_at, @unbundled_at,
  @fully_indexed_at, @fully_indexed_at,
  CASE WHEN (@queued_at IS NOT NULL OR @skipped_at IS NOT NULL) THEN 1 ELSE 0 END,
  @duplicated_data_item_count
) ON CONFLICT DO UPDATE SET
  data_item_count = IFNULL(@data_item_count, data_item_count),
  matched_data_item_count = IFNULL(@matched_data_item_count, matched_data_item_count),
  duplicated_data_item_count = IFNULL(@duplicated_data_item_count, duplicated_data_item_count),
  previous_unbundle_filter_id = CASE
    WHEN @unbundle_filter_id IS NOT NULL THEN bundles.unbundle_filter_id
    ELSE bundles.previous_unbundle_filter_id
  END,
  previous_index_filter_id = CASE
    WHEN @index_filter_id IS NOT NULL THEN bundles.index_filter_id
    ELSE bundles.previous_index_filter_id
  END,
  unbundle_filter_id = IFNULL(@unbundle_filter_id, unbundle_filter_id),
  index_filter_id = IFNULL(@index_filter_id, index_filter_id),
  first_queued_at = IFNULL(first_queued_at, @queued_at),
  last_queued_at = IFNULL(@queued_at, last_queued_at),
  first_skipped_at = IFNULL(first_skipped_at, @skipped_at),
  last_skipped_at = IFNULL(@skipped_at, last_skipped_at),
  first_unbundled_at = IFNULL(first_unbundled_at, @unbundled_at),
  last_unbundled_at = IFNULL(@unbundled_at, last_unbundled_at),
  first_fully_indexed_at = IFNULL(first_fully_indexed_at, @fully_indexed_at),
  last_fully_indexed_at = CASE
    WHEN @unbundle_filter_id != unbundle_filter_id OR
         @index_filter_id != index_filter_id
    THEN NULL
    ELSE @fully_indexed_at
  END,
  import_attempt_count = CASE
    WHEN (@queued_at IS NOT NULL OR @skipped_at IS NOT NULL) THEN
    COALESCE(bundles.import_attempt_count, 0) + 1
    ELSE
    bundles.import_attempt_count
  END
RETURNING
  unbundle_filter_id,
  index_filter_id,
  previous_unbundle_filter_id,
  previous_index_filter_id,
  last_fully_indexed_at;

-- updateBundleRetry
UPDATE bundles
SET
  retry_attempt_count = COALESCE(retry_attempt_count, 0) + 1,
  first_retried_at = CASE
    WHEN first_retried_at IS NULL THEN @current_timestamp
    ELSE first_retried_at
  END,
  last_retried_at = @current_timestamp
WHERE root_transaction_id = @root_transaction_id;

-- insertOrIgnoreWallet
INSERT INTO wallets (address, public_modulus)
VALUES (@address, @public_modulus)
ON CONFLICT DO NOTHING

-- insertOrIgnoreTagName
INSERT INTO tag_names (hash, name)
VALUES (@hash, @name)
ON CONFLICT DO NOTHING

-- insertOrIgnoreTagValue
INSERT INTO tag_values (hash, value)
VALUES (@hash, @value)
ON CONFLICT DO NOTHING

-- upsertNewDataItemTag
INSERT INTO new_data_item_tags (
  tag_name_hash, tag_value_hash,
  root_transaction_id, data_item_id, data_item_tag_index,
  height, indexed_at
) VALUES (
  @tag_name_hash, @tag_value_hash,
  @root_transaction_id, @data_item_id, @data_item_tag_index,
  @height, @indexed_at
) ON CONFLICT DO UPDATE SET height = IFNULL(@height, height)

-- upsertBundleDataItem
INSERT INTO bundle_data_items (
  id,
  parent_id,
  parent_index,
  filter_id,
  root_transaction_id,
  first_indexed_at,
  last_indexed_at
) VALUES (
  @id,
  @parent_id,
  @parent_index,
  @filter_id,
  @root_transaction_id,
  @indexed_at,
  @indexed_at
) ON CONFLICT DO
UPDATE SET
  filter_id = IFNULL(@filter_id, filter_id),
  last_indexed_at = @indexed_at

/*
 * Root atom (consistency tuple): the fields describing a data item's
 * placement within an L1 bundling. They must move together. Two writer
 * contracts express this:
 *
 *   - insertOptimisticDataItem — used by the admin queue-data-item
 *     route, which has no tuple knowledge. INSERT carries NULL for
 *     every root-atom field; on conflict, the statement does nothing.
 *     Never touches the tuple, never alters always-known fields like
 *     signature/owner/tags (those are immutable per data-item id).
 *     Safe to call repeatedly for the same id.
 *
 *   - upsertNewDataItem — used by the unbundle path and the on-demand
 *     metadata resolver, both of which know the full root atom. INSERT
 *     carries the full tuple; on conflict, every root-atom field is
 *     updated atomically (COALESCE protects against the rare partial
 *     write — see note below). Height is IFNULL'd because it lives on
 *     a different timeline than the bundling (set by chain ingestion
 *     via updateNewDataItemHeights).
 *
 * The COALESCE on the root-atom UPDATE columns is a safety net for
 * callers that don't actually have full tuple knowledge yet (e.g., a
 * partially-resolved metadata fetch). It is NOT a license to write
 * partial tuples — callers in the unbundle path are expected to
 * provide all eleven fields together.
 */

-- insertOptimisticDataItem
--
-- The eleven root-atom columns are hardcoded to NULL here, even though
-- the prepared-statement bindings could supply them. This enforces the
-- "no tuple knowledge" contract at the SQL layer: a future caller that
-- accidentally binds non-NULL values for parent_id / root_transaction_id
-- / the offset/size fields cannot recreate the shadow-row class this
-- statement exists to prevent. The TS dispatch via the isOptimistic
-- flag is the first line of defense; this is the second.
-- height stays bound — it's not part of the root atom and is written
-- on a separate timeline by chain ingestion.
INSERT INTO new_data_items (
  id, parent_id, root_transaction_id, height, signature, anchor,
  owner_address, target, data_offset, data_size, content_type,
  tag_count, indexed_at, signature_type, offset, size, owner_offset,
  owner_size, signature_offset, signature_size, content_encoding,
  root_parent_offset
) VALUES (
  @id, NULL, NULL, @height, @signature, @anchor,
  @owner_address, @target, NULL, @data_size, @content_type,
  @tag_count, @indexed_at, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, @content_encoding,
  NULL
) ON CONFLICT DO NOTHING

-- upsertNewDataItem
INSERT INTO new_data_items (
  id, parent_id, root_transaction_id, height, signature, anchor,
  owner_address, target, data_offset, data_size, content_type,
  tag_count, indexed_at, signature_type, offset, size, owner_offset,
  owner_size, signature_offset, signature_size, content_encoding,
  root_parent_offset
) VALUES (
  @id, @parent_id, @root_transaction_id, @height, @signature, @anchor,
  @owner_address, @target, @data_offset, @data_size, @content_type,
  @tag_count, @indexed_at, @signature_type, @offset, @size, @owner_offset,
  @owner_size, @signature_offset, @signature_size, @content_encoding,
  @root_parent_offset
) ON CONFLICT DO
UPDATE SET
  height              = IFNULL(@height,                height),
  parent_id           = COALESCE(@parent_id,           parent_id),
  root_transaction_id = COALESCE(@root_transaction_id, root_transaction_id),
  data_offset         = COALESCE(@data_offset,         data_offset),
  root_parent_offset  = COALESCE(@root_parent_offset,  root_parent_offset),
  offset              = COALESCE(@offset,              offset),
  size                = COALESCE(@size,                size),
  signature_offset    = COALESCE(@signature_offset,    signature_offset),
  signature_size      = COALESCE(@signature_size,      signature_size),
  owner_offset        = COALESCE(@owner_offset,        owner_offset),
  owner_size          = COALESCE(@owner_size,          owner_size),
  signature_type      = COALESCE(@signature_type,      signature_type)
