-- Tag-based TTL rules. Operators populate the `_src` / prefix tables via
-- scripts/clickhouse-load-ttl-rules.py (run by clickhouse-auto-import once per
-- import cycle). The loader force-reloads the exact-match dictionaries after
-- every load so new rules are visible to the next migrate query without
-- waiting for LIFETIME to expire.
--
-- Schema contract:
--   - tag_name is stored lower-cased (normalization happens in the loader);
--     the migrate query lower-casts the row's tag_name BLOB to String before
--     dictionary / prefix lookup.
--   - tag_value is stored trimmed but case-preserving.
--   - owner_address is stored as the operator-supplied base64url string
--     verbatim (no decode). The migrate query compares
--     base64URLEncode(transactions.owner_address) against it so a prefix
--     like "test-uploader-" matches textually — raw-byte prefixes wouldn't
--     correspond to any clean base64url cut.
--   - Prefix rules are scanned by startsWith() over small arrays materialised
--     from these tables; exact rules go through dictGetOrNull() for O(1)
--     lookup.
--   - never_expire = 1 marks an exempt rule; the migrate query treats any
--     matching exempt rule as an overriding signal to leave expires_at NULL,
--     beating both TTL matches and the default TTL. ttl_seconds is ignored
--     (stored as 0) when never_expire = 1.
CREATE TABLE IF NOT EXISTS ttl_tag_rules_src (
  tag_name String,
  tag_value String,
  ttl_seconds UInt32,
  never_expire UInt8 DEFAULT 0
) Engine = ReplacingMergeTree()
ORDER BY (tag_name, tag_value);

CREATE TABLE IF NOT EXISTS ttl_tag_prefix_rules (
  tag_name String,
  tag_value String,
  ttl_seconds UInt32,
  never_expire UInt8 DEFAULT 0
) Engine = ReplacingMergeTree()
ORDER BY (tag_name, tag_value);

CREATE TABLE IF NOT EXISTS ttl_owner_rules_src (
  owner_address String,
  ttl_seconds UInt32,
  never_expire UInt8 DEFAULT 0
) Engine = ReplacingMergeTree()
ORDER BY owner_address;

CREATE TABLE IF NOT EXISTS ttl_owner_prefix_rules (
  owner_address String,
  ttl_seconds UInt32,
  never_expire UInt8 DEFAULT 0
) Engine = ReplacingMergeTree()
ORDER BY owner_address;

CREATE DICTIONARY IF NOT EXISTS ttl_tag_rules (
  tag_name String,
  tag_value String,
  ttl_seconds UInt32,
  never_expire UInt8 DEFAULT 0
)
PRIMARY KEY tag_name, tag_value
SOURCE(CLICKHOUSE(TABLE 'ttl_tag_rules_src'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 60 MAX 300);

CREATE DICTIONARY IF NOT EXISTS ttl_owner_rules (
  owner_address String,
  ttl_seconds UInt32,
  never_expire UInt8 DEFAULT 0
)
PRIMARY KEY owner_address
SOURCE(CLICKHOUSE(TABLE 'ttl_owner_rules_src'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 60 MAX 300);

-- Single-row settings table for cross-rule knobs. Populated by the loader
-- from the YAML (TRUNCATE + INSERT) so there is always at most one row;
-- `updated_at` + ReplacingMergeTree(updated_at) ensures FINAL yields the
-- latest write. default_ttl_seconds applies when no rule matches a row and
-- no exempt rule fires.
CREATE TABLE IF NOT EXISTS ttl_settings (
  singleton UInt8 DEFAULT 1,
  default_ttl_seconds Nullable(UInt32),
  updated_at DateTime DEFAULT now()
) Engine = ReplacingMergeTree(updated_at)
ORDER BY singleton;
