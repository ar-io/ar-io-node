-- upsertBundle
INSERT INTO bundles (id, root_transaction_id, format_id,
                     unbundle_filter_id, index_filter_id,
                     data_item_count, matched_data_item_count,
                     first_queued_at, last_queued_at,
                     first_skipped_at, last_skipped_at,
                     first_unbundled_at, last_unbundled_at,
                     first_fully_indexed_at, last_fully_indexed_at,
                     import_attempt_count)
VALUES (cast(@id as bytea),
        cast(@root_transaction_id as bytea),
        cast(@format_id as bigint),
        cast(@unbundle_filter_id as bigint),
        cast(@index_filter_id as bigint),
        cast(@data_item_count as bigint),
        cast(@matched_data_item_count as bigint),
        cast(@queued_at as bigint),
        cast(@queued_at as bigint),
        cast(@skipped_at as bigint),
        cast(@skipped_at as bigint),
        cast(@unbundled_at as bigint),
        cast(@unbundled_at as bigint),
        cast(@fully_indexed_at as bigint),
        cast(@fully_indexed_at as bigint),
        CASE WHEN @queued_at IS NOT NULL THEN 1 ELSE 0 END)
ON CONFLICT (id) DO UPDATE SET data_item_count         = COALESCE(EXCLUDED.data_item_count, bundles.data_item_count),
                               matched_data_item_count = COALESCE(EXCLUDED.matched_data_item_count,
                                                                  bundles.matched_data_item_count),
                               unbundle_filter_id      = COALESCE(EXCLUDED.unbundle_filter_id, bundles.unbundle_filter_id),
                               index_filter_id         = COALESCE(EXCLUDED.index_filter_id, bundles.index_filter_id),
                               first_queued_at         = COALESCE(bundles.first_queued_at, EXCLUDED.first_queued_at),
                               last_queued_at          = COALESCE(EXCLUDED.last_queued_at, bundles.last_queued_at),
                               first_skipped_at        = COALESCE(bundles.first_skipped_at, EXCLUDED.first_skipped_at),
                               last_skipped_at         = COALESCE(EXCLUDED.last_skipped_at, bundles.last_skipped_at),
                               first_unbundled_at      = COALESCE(bundles.first_unbundled_at, EXCLUDED.first_unbundled_at),
                               last_unbundled_at       = COALESCE(EXCLUDED.last_unbundled_at, bundles.last_unbundled_at),
                               first_fully_indexed_at  = COALESCE(bundles.first_fully_indexed_at,
                                                                  EXCLUDED.first_fully_indexed_at),
                               last_fully_indexed_at   = EXCLUDED.last_fully_indexed_at,
                               import_attempt_count    = CASE
                                                             WHEN EXCLUDED.first_queued_at IS NOT NULL THEN
                                                                 COALESCE(bundles.import_attempt_count, 0) + 1
                                                             ELSE
                                                                 bundles.import_attempt_count
                                   END

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
INSERT INTO new_data_item_tags (tag_name_hash, tag_value_hash,
                                root_transaction_id, data_item_id, data_item_tag_index,
                                height, indexed_at)
VALUES (@tag_name_hash, @tag_value_hash,
        @root_transaction_id, @data_item_id, @data_item_tag_index,
        @height, @indexed_at)
ON CONFLICT (tag_name_hash, tag_value_hash, data_item_id) DO UPDATE SET height = COALESCE(EXCLUDED.height, new_data_item_tags.height);

-- upsertBundleDataItem
INSERT INTO bundle_data_items (id,
                               parent_id,
                               parent_index,
                               filter_id,
                               root_transaction_id,
                               first_indexed_at,
                               last_indexed_at)
VALUES (@id,
        @parent_id,
        @parent_index,
        @filter_id,
        @root_transaction_id,
        @indexed_at,
        @indexed_at)
ON CONFLICT (id) DO UPDATE SET filter_id       = COALESCE(EXCLUDED.filter_id, bundle_data_items.filter_id),
                               last_indexed_at = EXCLUDED.last_indexed_at;

-- upsertNewDataItem
INSERT INTO new_data_items (id, parent_id, root_transaction_id, height, signature, anchor,
                            owner_address, target, data_offset, data_size, content_type,
                            tag_count, indexed_at)
VALUES (@id, @parent_id, @root_transaction_id, @height, @signature, @anchor,
        @owner_address, @target, @data_offset, @data_size, @content_type,
        @tag_count, @indexed_at)
ON CONFLICT (id) DO UPDATE SET height              = COALESCE(EXCLUDED.height, new_data_items.height),
                               root_transaction_id = EXCLUDED.root_transaction_id
