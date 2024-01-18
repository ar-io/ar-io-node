DROP INDEX IF EXISTS stable_transactions_offset_idx;
ALTER TABLE stable_transactions DROP COLUMN offset;
