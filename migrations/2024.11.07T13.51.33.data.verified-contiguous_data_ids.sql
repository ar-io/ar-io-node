CREATE INDEX IF NOT EXISTS contiguous_data_ids_verified ON contiguous_data_ids (id) WHERE verified = FALSE;
