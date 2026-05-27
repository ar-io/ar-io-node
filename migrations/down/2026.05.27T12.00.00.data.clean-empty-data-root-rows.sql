-- down migration

-- Intentionally do nothing. The deleted rows were poison (empty/NULL
-- data_root pointing at unrelated content) and must not be restored.
