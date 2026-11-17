/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The checks `backfill-bundles` makes before each bundle it queues. Each
 * reads a number from the gateway's metrics (or, if given, a node
 * exporter's) and compares it with a pause and a halt threshold. Over the
 * pause threshold, the run waits and checks again. Over the halt threshold
 * for `haltAfterSeconds` without a break, it stops. A metric that cannot be
 * read pauses the run: a guard that cannot see is not a pass.
 */
import { metricValue, Sample } from '../prometheus-text.js';

export type GuardState = 'ok' | 'pause' | 'halt';

export interface Threshold {
  pause: number;
  /** Absent: the guard only pauses. */
  halt?: number;
}

/** A free-space floor on one mount point, in bytes. */
export interface FreeSpaceGuard {
  mountpoint: string;
  pause: number;
  halt?: number;
}

/** A busy ceiling on one block device, as a fraction of wall time (0..1). */
export interface DiskBusyGuard {
  device: string;
  pause: number;
  halt?: number;
}

export interface GuardConfig {
  /** `queue_length{queue_name="bundleDataImporter"}` ceiling. */
  maxImporterQueue: number;
  /** `queue_length{queue_name="ans104DataIndexer"}` ceiling. */
  maxIndexerQueue: number;
  /** `nodejs_eventloop_lag_p99_seconds`, in seconds. */
  eventLoopLag?: Threshold;
  /** `node_load1`, from the node exporter. */
  load1?: Threshold;
  freeSpace: FreeSpaceGuard[];
  diskBusy: DiskBusyGuard[];
}

export interface Reading {
  name: string;
  value: number | undefined;
  state: GuardState;
  detail: string;
}

const judge = (
  value: number | undefined,
  { pause, halt }: Threshold,
  higherIsWorse = true,
): GuardState => {
  if (value === undefined || Number.isNaN(value)) return 'pause';
  const over = (limit: number) =>
    higherIsWorse ? value > limit : value < limit;
  if (halt !== undefined && over(halt)) return 'halt';
  return over(pause) ? 'pause' : 'ok';
};

/** A node exporter's sample of one disk's busy seconds, kept between polls. */
export interface DiskSample {
  atMs: number;
  busySeconds: Record<string, number>;
}

/**
 * Reads every configured guard. `node` and `previousDisk` are absent when no
 * node exporter is given; guards that need it then read as missing.
 */
export function readGuards({
  config,
  gateway,
  node,
  nowMs,
  previousDisk,
}: {
  config: GuardConfig;
  gateway: Sample[];
  node?: Sample[];
  nowMs: number;
  previousDisk?: DiskSample;
}): { readings: Reading[]; disk?: DiskSample } {
  const readings: Reading[] = [];
  const queue = (name: string, limit: number) => {
    const value = metricValue(gateway, 'queue_length', { queue_name: name });
    readings.push({
      name: `queue ${name}`,
      value,
      // Queues pause only: they drain on their own.
      state: judge(value, { pause: limit - 1 }),
      detail: `${value ?? 'unreadable'} (limit ${limit})`,
    });
  };
  queue('bundleDataImporter', config.maxImporterQueue);
  queue('ans104DataIndexer', config.maxIndexerQueue);

  if (config.eventLoopLag !== undefined) {
    const value = metricValue(gateway, 'nodejs_eventloop_lag_p99_seconds');
    readings.push({
      name: 'event loop lag p99',
      value,
      state: judge(value, config.eventLoopLag),
      detail: `${value === undefined ? 'unreadable' : `${Math.round(value * 1000)} ms`}`,
    });
  }

  if (config.load1 !== undefined) {
    const value = node && metricValue(node, 'node_load1');
    readings.push({
      name: 'load1',
      value,
      state: judge(value, config.load1),
      detail: `${value ?? 'unreadable'}`,
    });
  }

  for (const guard of config.freeSpace) {
    const value =
      node &&
      metricValue(node, 'node_filesystem_avail_bytes', {
        mountpoint: guard.mountpoint,
      });
    readings.push({
      name: `free ${guard.mountpoint}`,
      value,
      state: judge(value, guard, false),
      detail: `${value === undefined ? 'unreadable' : `${(value / 1e9).toFixed(0)} GB`}`,
    });
  }

  let disk: DiskSample | undefined;
  if (config.diskBusy.length > 0 && node !== undefined) {
    disk = { atMs: nowMs, busySeconds: {} };
    for (const s of node) {
      if (s.name === 'node_disk_io_time_seconds_total') {
        disk.busySeconds[s.labels.device] = s.value;
      }
    }
  }
  for (const guard of config.diskBusy) {
    let value: number | undefined;
    const before = previousDisk?.busySeconds[guard.device];
    const after = disk?.busySeconds[guard.device];
    if (
      previousDisk !== undefined &&
      disk !== undefined &&
      before !== undefined &&
      after !== undefined &&
      after >= before &&
      disk.atMs > previousDisk.atMs
    ) {
      // A counter that went down (an exporter or host restart) gives no rate:
      // the reading stays undefined (a pause) and this sample is the new
      // baseline.
      value = (after - before) / ((disk.atMs - previousDisk.atMs) / 1000);
    }
    readings.push({
      name: `busy ${guard.device}`,
      value,
      state: judge(value, guard),
      detail: `${value === undefined ? 'no rate yet' : `${Math.round(value * 100)}%`}`,
    });
  }
  return { readings, disk };
}

/**
 * Turns readings into a decision, keeping `haltSince` across polls: a halt
 * reading only stops the run once it has held for `haltAfterSeconds`.
 */
export function decide(
  readings: Reading[],
  {
    nowMs,
    haltSince,
    haltAfterSeconds,
  }: {
    nowMs: number;
    haltSince: Record<string, number>;
    haltAfterSeconds: number;
  },
): { state: GuardState; reasons: string[]; guards: string[] } {
  const reasons: string[] = [];
  const guards: string[] = [];
  let state: GuardState = 'ok';
  for (const r of readings) {
    if (r.state !== 'halt') delete haltSince[r.name];
    if (r.state === 'ok') continue;
    guards.push(r.name);
    if (r.state === 'halt') {
      haltSince[r.name] ??= nowMs;
      if (nowMs - haltSince[r.name] >= haltAfterSeconds * 1000) {
        state = 'halt';
        reasons.push(`${r.name} ${r.detail} past its halt limit`);
        continue;
      }
    }
    if (state === 'ok') state = 'pause';
    reasons.push(`${r.name} ${r.detail}`);
  }
  return { state, reasons, guards };
}

/** A daily window of UTC minutes, `[start, end)`, wrapping past midnight. */
export interface QuietWindow {
  startMinute: number;
  endMinute: number;
}

/** Parses `HH:MM-HH:MM` (UTC) or `none`. */
export function parseQuietWindow(value: string): QuietWindow | undefined {
  if (value === 'none') return undefined;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(
      `--quiet-window must be HH:MM-HH:MM (UTC) or none: ${value}`,
    );
  }
  const [h1, m1, h2, m2] = match.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) {
    throw new Error(`--quiet-window is not a time range: ${value}`);
  }
  return { startMinute: h1 * 60 + m1, endMinute: h2 * 60 + m2 };
}

/** Milliseconds until `window` ends if `nowMs` is inside it, else 0. */
export function quietWindowRemainingMs(
  window: QuietWindow | undefined,
  nowMs: number,
): number {
  if (window === undefined) return 0;
  const day = 24 * 60;
  const msOfDay = nowMs % (day * 60_000);
  const minute = msOfDay / 60_000;
  const { startMinute: start, endMinute: end } = window;
  const inside =
    start <= end
      ? minute >= start && minute < end
      : minute >= start || minute < end;
  if (!inside) return 0;
  const untilEnd = (end - minute + day) % day;
  return Math.ceil(untilEnd * 60_000);
}

/** Bytes queued in the last hour, against a budget. */
export class HourlyByteBudget {
  private queued: { atMs: number; bytes: number }[] = [];

  constructor(private readonly bytesPerHour: number | undefined) {}

  /**
   * Milliseconds to wait before `bytes` fits, or 0. A bundle larger than the
   * whole budget goes alone, once the last hour is empty.
   */
  waitMs(bytes: number, nowMs: number): number {
    if (this.bytesPerHour === undefined) return 0;
    this.queued = this.queued.filter((q) => q.atMs > nowMs - 3_600_000);
    const used = this.queued.reduce((sum, q) => sum + q.bytes, 0);
    if (used + bytes <= this.bytesPerHour || this.queued.length === 0) {
      return 0;
    }
    // Wait for enough of the oldest to age out.
    let freed = 0;
    for (const q of this.queued) {
      freed += q.bytes;
      if (used - freed + bytes <= this.bytesPerHour) {
        return q.atMs + 3_600_000 - nowMs;
      }
    }
    return this.queued[this.queued.length - 1].atMs + 3_600_000 - nowMs;
  }

  record(bytes: number, nowMs: number): void {
    // Without a budget nothing reads the history: keep none.
    if (this.bytesPerHour === undefined) return;
    this.queued.push({ atMs: nowMs, bytes });
  }
}

/** Parses a byte size: a number with an optional K/M/G/T suffix (powers of 1000). */
export function parseBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i.exec(value.trim());
  if (match === null) throw new Error(`not a byte size: ${value}`);
  const scale = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[
    match[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T'
  ];
  return Math.round(Number(match[1]) * scale);
}
