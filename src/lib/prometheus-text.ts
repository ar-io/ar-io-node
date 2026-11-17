/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** One sample from a Prometheus text exposition. */
export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse Prometheus text exposition, enough for plain gauges and counters. */
export function parseMetrics(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (match === null) continue;
    const labels: Record<string, string> = {};
    for (const [, key, value] of (match[3] ?? '').matchAll(
      /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
    )) {
      labels[key] = value.replace(/\\(.)/g, '$1');
    }
    out.push({ name: match[1], labels, value: Number(match[4]) });
  }
  return out;
}

/**
 * The value of the first sample named `name` whose labels include `where`,
 * or undefined when there is none.
 */
export function metricValue(
  samples: Sample[],
  name: string,
  where: Record<string, string> = {},
): number | undefined {
  return samples.find(
    (s) =>
      s.name === name &&
      Object.entries(where).every(([key, value]) => s.labels[key] === value),
  )?.value;
}
