#!/usr/bin/env python3

"""Load operator-defined TTL rules from a YAML file into ClickHouse.

Populates the four rule-source tables (ttl_tag_rules_src, ttl_tag_prefix_rules,
ttl_owner_rules_src, ttl_owner_prefix_rules). The two dictionaries layered on
top of the exact-match source tables (ttl_tag_rules, ttl_owner_rules) refresh
independently on their LIFETIME clauses; this script does not reload them
directly.

Fails open: a missing or malformed rules file logs a warning and exits 0 so
imports continue against whatever rules are already in the source tables. On
success, each run is a TRUNCATE+INSERT per bucket so removed YAML entries
disappear on the next load.
"""

from __future__ import annotations

import argparse
import base64
import os
import subprocess
import sys
from typing import Any, Iterable

import yaml


def b64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


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
            try:
                decoded = b64url_decode(raw_value.strip())
            except (ValueError, base64.binascii.Error) as exc:
                print(
                    f"warning: rule #{idx} value is not valid base64url ({exc}); skipping",
                    file=sys.stderr,
                )
                continue
            key = "owner_exact" if match == "exact" else "owner_prefix"
            buckets[key].append((decoded.hex(), ttl))

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
        f"(unhex('{hex_bytes}'), {ttl})" for (hex_bytes, ttl) in rows
    )
    run_query(f"INSERT INTO {table} (owner_address, ttl_seconds) VALUES {values}")


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

    if not os.path.isfile(args.path):
        print(
            f"warning: rules file not found at {args.path}; skipping load",
            file=sys.stderr,
        )
        return 0

    try:
        with open(args.path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        print(
            f"warning: failed to parse {args.path} as YAML ({exc}); skipping load",
            file=sys.stderr,
        )
        return 0

    rules = (doc or {}).get("rules") or []
    if not isinstance(rules, list):
        print(
            f"warning: {args.path} 'rules' key is not a list; treating as empty",
            file=sys.stderr,
        )
        rules = []

    buckets = bucket_rules(rules)

    try:
        load_tag_bucket("ttl_tag_rules_src", buckets["tag_exact"])
        load_tag_bucket("ttl_tag_prefix_rules", buckets["tag_prefix"])
        load_owner_bucket("ttl_owner_rules_src", buckets["owner_exact"])
        load_owner_bucket("ttl_owner_prefix_rules", buckets["owner_prefix"])
    except subprocess.CalledProcessError as exc:
        print(
            f"error: clickhouse client failed during TTL rules load (exit {exc.returncode})",
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
