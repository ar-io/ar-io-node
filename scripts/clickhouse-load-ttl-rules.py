#!/usr/bin/env python3

"""Load operator-defined TTL rules from a YAML file into ClickHouse.

Populates the four rule-source tables (ttl_tag_rules_src, ttl_tag_prefix_rules,
ttl_owner_rules_src, ttl_owner_prefix_rules) and force-reloads the two
dictionaries (ttl_tag_rules, ttl_owner_rules) so the new rules are visible to
the next migrate_staging_to_final invocation without waiting for the
dictionaries' LIFETIME to expire.

Owner values stay in their base64url form (never decoded) on both sides: the
migrate query compares base64URLEncode(owner_address) against the stored
string. That lets operators write textual prefixes like "test-uploader-"
rather than raw-byte prefixes which wouldn't correspond to any clean base64url
cut.

Exit codes:
  * 0 — load succeeded, or the rules file was missing/unreadable/malformed
    and existing rules were left untouched. Callers can proceed normally.
  * 1 — ClickHouse rejected a write or a dictionary reload while loading a
    parsed rules document. The loader makes a best-effort pass to leave the
    rule state as empty as possible (TRUNCATE all four source tables, retry
    the dictionary reload). When reload succeeds, the import cycle sees no
    TTL rules; when it doesn't, prefix rules are cleared but exact-match
    dictionaries may briefly serve stale entries until the next successful
    load.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Iterable

import yaml

ALL_RULE_TABLES = (
    "ttl_tag_rules_src",
    "ttl_tag_prefix_rules",
    "ttl_owner_rules_src",
    "ttl_owner_prefix_rules",
)

SETTINGS_TABLE = "ttl_settings"

EXACT_DICTIONARIES = (
    "ttl_tag_rules",
    "ttl_owner_rules",
)

BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")

UINT32_MAX = 2**32 - 1
TTL_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent / "src" / "database" / "clickhouse" / "ttl-schema.sql"
)


def clickhouse_args() -> list[str]:
    args = ["clickhouse", "client"]
    host = os.environ.get("CLICKHOUSE_HOST")
    port = os.environ.get("CLICKHOUSE_PORT")
    user = os.environ.get("CLICKHOUSE_USER")
    password = os.environ.get("CLICKHOUSE_PASSWORD")
    if host:
        args.append(f"--host={host}")
    if port:
        args.append(f"--port={port}")
    if user:
        args.append(f"--user={user}")
    if password:
        args.append(f"--password={password}")
    return args


def sql_string_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def render_ttl_schema_sql(schema_sql: str) -> str:
    return (
        schema_sql.replace(
            "{{CLICKHOUSE_DICT_USER}}",
            sql_string_literal(os.environ.get("CLICKHOUSE_USER", "default")),
        ).replace(
            "{{CLICKHOUSE_DICT_PASSWORD}}",
            sql_string_literal(os.environ.get("CLICKHOUSE_PASSWORD", "")),
        )
    )


def run_query(query: str) -> None:
    subprocess.run(
        clickhouse_args() + ["--query", query],
        check=True,
    )


def try_truncate(table: str) -> None:
    try:
        run_query(f"TRUNCATE TABLE {table}")
    except subprocess.CalledProcessError as exc:
        print(
            f"warning: best-effort truncate of {table} failed (exit {exc.returncode})",
            file=sys.stderr,
        )


def ensure_ttl_schema() -> None:
    try:
        schema_sql = TTL_SCHEMA_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(
            f"TTL schema file not found or unreadable at {TTL_SCHEMA_PATH}: {exc}"
        ) from exc
    subprocess.run(
        clickhouse_args() + ["--multiquery"],
        input=render_ttl_schema_sql(schema_sql),
        text=True,
        check=True,
    )


def escape_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def bucket_rules(rules: Iterable[dict[str, Any]]) -> dict[str, list[tuple]]:
    buckets: dict[str, list[tuple]] = {
        "tag_exact": [],
        "tag_prefix": [],
        "owner_exact": [],
        "owner_prefix": [],
    }

    for idx, raw in enumerate(rules):
        if not isinstance(raw, dict):
            print(f"warning: rule #{idx} is not a mapping; skipping", file=sys.stderr)
            continue

        field = raw.get("field", "tag")
        match = raw.get("match", "exact")
        ttl = raw.get("ttl_seconds")
        never_expire = raw.get("never_expire", False)

        if field not in ("tag", "owner_address"):
            print(
                f"warning: rule #{idx} has invalid field {field!r}; skipping",
                file=sys.stderr,
            )
            continue
        if match not in ("exact", "prefix"):
            print(
                f"warning: rule #{idx} has invalid match {match!r}; skipping",
                file=sys.stderr,
            )
            continue
        if not isinstance(never_expire, bool):
            print(
                f"warning: rule #{idx} has non-boolean never_expire {never_expire!r}; skipping",
                file=sys.stderr,
            )
            continue
        if never_expire:
            if ttl is not None:
                print(
                    f"warning: rule #{idx} sets both never_expire and ttl_seconds;"
                    " skipping (use one or the other)",
                    file=sys.stderr,
                )
                continue
            ttl_value = 0
        else:
            if (
                not isinstance(ttl, int)
                or isinstance(ttl, bool)
                or ttl <= 0
                or ttl > UINT32_MAX
            ):
                print(
                    f"warning: rule #{idx} has invalid ttl_seconds {ttl!r}"
                    f" (must be a positive integer <= {UINT32_MAX}); skipping",
                    file=sys.stderr,
                )
                continue
            ttl_value = ttl

        never_flag = 1 if never_expire else 0

        if field == "tag":
            tag_name = raw.get("tag_name")
            tag_value = raw.get("tag_value")
            if not isinstance(tag_name, str) or not tag_name.strip():
                print(
                    f"warning: rule #{idx} missing non-empty tag_name; skipping",
                    file=sys.stderr,
                )
                continue
            if not isinstance(tag_value, str) or not tag_value.strip():
                print(
                    f"warning: rule #{idx} missing non-empty tag_value; skipping",
                    file=sys.stderr,
                )
                continue
            normalized_name = tag_name.strip().lower()
            normalized_value = tag_value.strip()
            key = "tag_exact" if match == "exact" else "tag_prefix"
            buckets[key].append((normalized_name, normalized_value, ttl_value, never_flag))
        else:
            raw_value = raw.get("value")
            if not isinstance(raw_value, str) or not raw_value.strip():
                print(
                    f"warning: rule #{idx} missing non-empty value; skipping",
                    file=sys.stderr,
                )
                continue
            normalized_value = raw_value.strip()
            if not BASE64URL_RE.match(normalized_value):
                print(
                    f"warning: rule #{idx} value {normalized_value!r} is not base64url"
                    " ([A-Za-z0-9_-]+); skipping",
                    file=sys.stderr,
                )
                continue
            key = "owner_exact" if match == "exact" else "owner_prefix"
            buckets[key].append((normalized_value, ttl_value, never_flag))

    return buckets


def load_tag_bucket(table: str, rows: list[tuple]) -> None:
    run_query(f"TRUNCATE TABLE {table}")
    if not rows:
        return
    values = ",".join(
        f"({escape_str(name)}, {escape_str(value)}, {ttl}, {never})"
        for (name, value, ttl, never) in rows
    )
    run_query(
        f"INSERT INTO {table} (tag_name, tag_value, ttl_seconds, never_expire)"
        f" VALUES {values}"
    )


def load_owner_bucket(table: str, rows: list[tuple]) -> None:
    run_query(f"TRUNCATE TABLE {table}")
    if not rows:
        return
    values = ",".join(
        f"({escape_str(owner)}, {ttl}, {never})" for (owner, ttl, never) in rows
    )
    run_query(
        f"INSERT INTO {table} (owner_address, ttl_seconds, never_expire)"
        f" VALUES {values}"
    )


def load_settings(default_ttl_seconds: int | None) -> None:
    run_query(f"TRUNCATE TABLE {SETTINGS_TABLE}")
    value = "NULL" if default_ttl_seconds is None else str(default_ttl_seconds)
    run_query(
        f"INSERT INTO {SETTINGS_TABLE} (singleton, default_ttl_seconds)"
        f" VALUES (1, {value})"
    )


def reload_dictionaries() -> None:
    for dict_name in EXACT_DICTIONARIES:
        run_query(f"SYSTEM RELOAD DICTIONARY {dict_name}")


def reload_dictionaries_with_retry(attempts: int = 3, delay_seconds: float = 0.5) -> bool:
    """Reload exact-match dictionaries, retrying on transient failures.

    Returns True on success, False if all attempts failed. Each retry waits
    `delay_seconds * 2**attempt` before trying again (short backoff bounded
    by attempts).
    """
    last_exit = 0
    for attempt in range(attempts):
        try:
            reload_dictionaries()
            return True
        except subprocess.CalledProcessError as exc:
            last_exit = exc.returncode
            if attempt < attempts - 1:
                time.sleep(delay_seconds * (2 ** attempt))
    print(
        f"warning: SYSTEM RELOAD DICTIONARY failed after {attempts} attempts"
        f" (last exit {last_exit})",
        file=sys.stderr,
    )
    return False


def truncate_all_rule_tables() -> None:
    for table in ALL_RULE_TABLES:
        try_truncate(table)
    try_truncate(SETTINGS_TABLE)


def load_rules_file(path: str) -> tuple[list[Any], int | None] | None:
    """Read and parse the rules YAML.

    Returns a (rules, default_ttl_seconds) tuple on success — rules is an
    empty list if the file is missing rules or is empty-but-well-formed;
    default_ttl_seconds is the top-level `default_ttl_seconds` value or None
    if unset/invalid. Returns None if the caller should skip the load
    entirely (file missing/unreadable/malformed, or structurally invalid —
    root not a mapping, `rules` not a list). All failure modes here log a
    warning but never raise.
    """
    if not os.path.isfile(path):
        print(
            f"warning: rules file not found at {path}; skipping load",
            file=sys.stderr,
        )
        return None

    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except OSError as exc:
        print(
            f"warning: could not read {path} ({exc}); skipping load",
            file=sys.stderr,
        )
        return None
    except yaml.YAMLError as exc:
        print(
            f"warning: failed to parse {path} as YAML ({exc}); skipping load",
            file=sys.stderr,
        )
        return None

    if doc is None:
        return ([], None)

    if not isinstance(doc, dict):
        print(
            f"warning: {path} root is {type(doc).__name__}, expected mapping;"
            " skipping load (previously loaded rules, if any, are retained)",
            file=sys.stderr,
        )
        return None

    default_ttl = doc.get("default_ttl_seconds")
    if default_ttl is not None and (
        not isinstance(default_ttl, int)
        or isinstance(default_ttl, bool)
        or default_ttl <= 0
        or default_ttl > UINT32_MAX
    ):
        print(
            f"warning: {path} default_ttl_seconds {default_ttl!r} is not a positive"
            f" integer <= {UINT32_MAX}; ignoring",
            file=sys.stderr,
        )
        default_ttl = None

    rules = doc.get("rules")
    if rules is None:
        return ([], default_ttl)

    if not isinstance(rules, list):
        print(
            f"warning: {path} 'rules' key is {type(rules).__name__}, expected list;"
            " skipping load (previously loaded rules, if any, are retained)",
            file=sys.stderr,
        )
        return None

    return (rules, default_ttl)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path",
        nargs="?",
        default=os.environ.get("CLICKHOUSE_TTL_RULES_PATH"),
        help="Path to rules YAML (falls back to CLICKHOUSE_TTL_RULES_PATH env)",
    )
    args = parser.parse_args()

    if not args.path:
        print(
            "warning: no rules path supplied (set CLICKHOUSE_TTL_RULES_PATH or pass as argument); skipping load",
            file=sys.stderr,
        )
        return 0

    parsed = load_rules_file(args.path)
    if parsed is None:
        # File missing / unreadable / malformed. Leave previously loaded rules
        # and settings in place; the auto-import loop continues with whatever
        # is already in ClickHouse.
        return 0

    rules, default_ttl = parsed
    buckets = bucket_rules(rules)

    try:
        ensure_ttl_schema()
        load_tag_bucket("ttl_tag_rules_src", buckets["tag_exact"])
        load_tag_bucket("ttl_tag_prefix_rules", buckets["tag_prefix"])
        load_owner_bucket("ttl_owner_rules_src", buckets["owner_exact"])
        load_owner_bucket("ttl_owner_prefix_rules", buckets["owner_prefix"])
        load_settings(default_ttl)
        if not reload_dictionaries_with_retry():
            raise subprocess.CalledProcessError(1, "SYSTEM RELOAD DICTIONARY")
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(
            f"error: clickhouse client failed during TTL rules load (exit {exc.returncode});"
            " truncating all rule tables to avoid a partial rule set",
            file=sys.stderr,
        )
        truncate_all_rule_tables()
        if reload_dictionaries_with_retry():
            print(
                "info: after-failure cleanup cleared rule tables and reloaded"
                " dictionaries; exact-match lookups will return NULL this cycle",
                file=sys.stderr,
            )
        else:
            print(
                "warning: after-failure dictionary reload did not succeed; prefix"
                " rules are cleared but exact-match dictionaries may serve stale"
                " entries until the next successful load",
                file=sys.stderr,
            )
        return 1

    print(
        "TTL rules loaded from {path}: "
        "tag_exact={te} tag_prefix={tp} owner_exact={oe} owner_prefix={op}"
        " default_ttl_seconds={dt}".format(
            path=args.path,
            te=len(buckets["tag_exact"]),
            tp=len(buckets["tag_prefix"]),
            oe=len(buckets["owner_exact"]),
            op=len(buckets["owner_prefix"]),
            dt="none" if default_ttl is None else default_ttl,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
