/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * DuckDB's threads for the index tools' own databases (index-export's band
 * builds, and the CLI's band checks and imports), unless asked otherwise:
 * one.
 *
 * The `duckdb` Node binding stops at DuckDB 1.4, whose hash aggregate can
 * crash the process (SIGSEGV) when it has spilled ("gone external") while
 * other threads keep growing it: the partitions it merges into were sized
 * for fewer radix bits than it then has (duckdb/duckdb#23757, fixed in 1.5
 * only). On turbo-gateway.com a band's compare crashed this way in 4 of 33
 * runs at two threads and in none of 35 at one, and a full
 * `index-l2-verify` of ardrive-l2 crashed at two threads and passed at one.
 * One thread changes how long a step takes, never what it produces.
 */
export const DEFAULT_DUCKDB_THREADS = 1;

/** The most threads any of these databases may be given. */
export const MAX_DUCKDB_THREADS = 64;

/**
 * A thread count given as text (a CLI option): a whole number from 1 to
 * {@link MAX_DUCKDB_THREADS}, or {@link DEFAULT_DUCKDB_THREADS} when absent.
 *
 * @throws Error naming `what` when it is anything else.
 */
export function parseDuckdbThreads(
  value: string | undefined,
  what = '--duckdb-threads',
): number {
  if (value === undefined) return DEFAULT_DUCKDB_THREADS;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1 || n > MAX_DUCKDB_THREADS) {
    throw new Error(
      `${what} must be a whole number from 1 to ${MAX_DUCKDB_THREADS}, not ${value}`,
    );
  }
  return n;
}
