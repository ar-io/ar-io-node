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

EXACT_DICTIONARIES = (
    "ttl_tag_rules",
    "ttl_owner_rules",
)

BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


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
        if not isinstance(ttl, int) or ttl <= 0:
            print(
                f"warning: rule #{idx} has non-positive ttl_seconds {ttl!r}; skipping",
                file=sys.stderr,
            )
            continue

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
            buckets[key].append((normalized_name, normalized_value, ttl))
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
            buckets[key].append((normalized_value, ttl))

    return buckets


def load_tag_bucket(table: str, rows: list[tuple]) -> None:
    run_query(f"TRUNCATE TABLE {table}")
    if not rows:
        return
    values = ",".join(
        f"({escape_str(name)}, {escape_str(value)}, {ttl})"
        for (name, value, ttl) in rows
    )
    run_query(f"INSERT INTO {table} (tag_name, tag_value, ttl_seconds) VALUES {values}")


def load_owner_bucket(table: str, rows: list[tuple]) -> None:
    run_query(f"TRUNCATE TABLE {table}")
    if not rows:
        return
    values = ",".join(
        f"({escape_str(owner)}, {ttl})" for (owner, ttl) in rows
    )
    run_query(f"INSERT INTO {table} (owner_address, ttl_seconds) VALUES {values}")


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


def load_rules_file(path: str) -> list[Any] | None:
    """Read and parse the rules YAML.

    Returns a list of rule mappings, an empty list if the file is missing /
    empty / structurally doesn't contain rules, or None if the caller should
    skip the load entirely (unreadable / malformed). All failure modes here
    log a warning but never raise.
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
        return []

    if not isinstance(doc, dict):
        print(
            f"warning: {path} root is {type(doc).__name__}, expected mapping; treating as no rules",
            file=sys.stderr,
        )
        return []

    rules = doc.get("rules")
    if rules is None:
        return []

    if not isinstance(rules, list):
        print(
            f"warning: {path} 'rules' key is {type(rules).__name__}, expected list; treating as empty",
            file=sys.stderr,
        )
        return []

    return rules


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

    rules = load_rules_file(args.path)
    if rules is None:
        # File missing / unreadable / malformed. Leave previously loaded rules
        # in place; the auto-import loop continues with whatever is already
        # in ClickHouse.
        return 0

    buckets = bucket_rules(rules)

    try:
        load_tag_bucket("ttl_tag_rules_src", buckets["tag_exact"])
        load_tag_bucket("ttl_tag_prefix_rules", buckets["tag_prefix"])
        load_owner_bucket("ttl_owner_rules_src", buckets["owner_exact"])
        load_owner_bucket("ttl_owner_prefix_rules", buckets["owner_prefix"])
        if not reload_dictionaries_with_retry():
            raise subprocess.CalledProcessError(1, "SYSTEM RELOAD DICTIONARY")
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
        "tag_exact={te} tag_prefix={tp} owner_exact={oe} owner_prefix={op}".format(
            path=args.path,
            te=len(buckets["tag_exact"]),
            tp=len(buckets["tag_prefix"]),
            oe=len(buckets["owner_exact"]),
            op=len(buckets["owner_prefix"]),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
