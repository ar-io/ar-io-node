DROP INDEX IF EXISTS block_sources_name_idx;
CREATE INDEX block_sources_name_idx ON block_sources (name);
