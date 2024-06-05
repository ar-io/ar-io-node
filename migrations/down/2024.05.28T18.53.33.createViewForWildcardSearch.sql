-- down migration
DROP INDEX IF EXISTS tag_names_index;
DROP INDEX IF EXISTS  tag_values_index;
DROP INDEX IF EXISTS  new_transaction_tags_index;
DROP INDEX IF EXISTS  stable_transaction_tags_index;
DROP INDEX IF EXISTS  new_blocks_index;
DROP INDEX IF EXISTS  stable_blocks_index;
