/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseMetrics } from '../prometheus-text.js';
import {
  decide,
  GuardConfig,
  HourlyByteBudget,
  parseBytes,
  parseQuietWindow,
  quietWindowRemainingMs,
  readGuards,
} from './guards.js';

const gatewayText = (importer: number, indexer: number, lagSeconds = 0.01) =>
  [
    '# TYPE queue_length gauge',
    `queue_length{queue_name="bundleDataImporter",release="88"} ${importer}`,
    `queue_length{queue_name="ans104DataIndexer",release="88"} ${indexer}`,
    `nodejs_eventloop_lag_p99_seconds{release="88"} ${lagSeconds}`,
  ].join('\n');

const config: GuardConfig = {
  maxImporterQueue: 50,
  maxIndexerQueue: 200_000,
  eventLoopLag: { pause: 0.2, halt: 1 },
  load1: { pause: 20, halt: 28 },
  freeSpace: [{ mountpoint: '/data', pause: 600e9, halt: 400e9 }],
  diskBusy: [{ device: 'sda', pause: 0.7, halt: 0.9 }],
};

const nodeText = (load: number, freeBytes: number, sdaBusy: number) =>
  [
    `node_load1 ${load}`,
    `node_filesystem_avail_bytes{device="/dev/x",mountpoint="/data"} ${freeBytes}`,
    `node_disk_io_time_seconds_total{device="sda"} ${sdaBusy}`,
  ].join('\n');

const states = (r: ReturnType<typeof readGuards>) =>
  Object.fromEntries(r.readings.map((x) => [x.name, x.state]));

describe('readGuards', () => {
  it('passes when everything is under its limits', () => {
    const first = readGuards({
      config,
      gateway: parseMetrics(gatewayText(10, 1000)),
      node: parseMetrics(nodeText(5, 900e9, 100)),
      nowMs: 0,
    });
    const second = readGuards({
      config,
      gateway: parseMetrics(gatewayText(10, 1000)),
      node: parseMetrics(nodeText(5, 900e9, 130)),
      nowMs: 60_000,
      previousDisk: first.disk,
    });
    assert.deepEqual(states(second), {
      'queue bundleDataImporter': 'ok',
      'queue ans104DataIndexer': 'ok',
      'event loop lag p99': 'ok',
      load1: 'ok',
      'free /data': 'ok',
      'busy sda': 'ok', // 30 s busy in 60 s = 50%
    });
  });

  it('pauses at the queue limits, which never halt', () => {
    const r = readGuards({
      config: { ...config, load1: undefined, freeSpace: [], diskBusy: [] },
      gateway: parseMetrics(gatewayText(50, 10_000_000, 0.01)),
      nowMs: 0,
    });
    assert.equal(states(r)['queue bundleDataImporter'], 'pause');
    assert.equal(states(r)['queue ans104DataIndexer'], 'pause');
    assert.equal(
      states(
        readGuards({
          config,
          gateway: parseMetrics(gatewayText(49, 0)),
          nowMs: 0,
        }),
      )['queue bundleDataImporter'],
      'ok',
    );
  });

  it('reads pause and halt bands, free space falling', () => {
    const r = readGuards({
      config,
      gateway: parseMetrics(gatewayText(0, 0, 0.5)),
      node: parseMetrics(nodeText(30, 300e9, 0)),
      nowMs: 0,
    });
    assert.equal(states(r)['event loop lag p99'], 'pause');
    assert.equal(states(r).load1, 'halt');
    assert.equal(states(r)['free /data'], 'halt');
    assert.equal(states(r)['busy sda'], 'pause'); // no rate yet
  });

  it('pauses on a metric it cannot read', () => {
    const r = readGuards({ config, gateway: [], nowMs: 0 });
    for (const reading of r.readings) assert.equal(reading.state, 'pause');
  });
});

describe('decide', () => {
  const halting = readGuards({
    config: { ...config, freeSpace: [], diskBusy: [], load1: undefined },
    gateway: parseMetrics(gatewayText(0, 0, 2)),
    nowMs: 0,
  }).readings;

  it('pauses on a halt reading until it has held for haltAfterSeconds', () => {
    const haltSince: Record<string, number> = {};
    assert.equal(
      decide(halting, { nowMs: 0, haltSince, haltAfterSeconds: 900 }).state,
      'pause',
    );
    assert.equal(
      decide(halting, { nowMs: 899_000, haltSince, haltAfterSeconds: 900 })
        .state,
      'pause',
    );
    const halted = decide(halting, {
      nowMs: 900_000,
      haltSince,
      haltAfterSeconds: 900,
    });
    assert.equal(halted.state, 'halt');
    assert.match(halted.reasons[0], /event loop lag p99 2000 ms/);
  });

  it('restarts the clock when the reading recovers', () => {
    const haltSince: Record<string, number> = {};
    decide(halting, { nowMs: 0, haltSince, haltAfterSeconds: 900 });
    const ok = readGuards({
      config: { ...config, freeSpace: [], diskBusy: [], load1: undefined },
      gateway: parseMetrics(gatewayText(0, 0, 0.01)),
      nowMs: 0,
    }).readings;
    assert.equal(
      decide(ok, { nowMs: 500_000, haltSince, haltAfterSeconds: 900 }).state,
      'ok',
    );
    assert.equal(
      decide(halting, { nowMs: 1_000_000, haltSince, haltAfterSeconds: 900 })
        .state,
      'pause',
    );
  });
});

describe('quiet window', () => {
  const at = (hh: number, mm: number) => Date.UTC(2026, 10, 16, hh, mm);

  it('parses HH:MM-HH:MM and none', () => {
    assert.deepEqual(parseQuietWindow('03:30-07:30'), {
      startMinute: 210,
      endMinute: 450,
    });
    assert.equal(parseQuietWindow('none'), undefined);
    assert.throws(() => parseQuietWindow('3:30-7:30'));
    assert.throws(() => parseQuietWindow('25:00-07:30'));
  });

  it('waits until the window ends', () => {
    const window = parseQuietWindow('03:30-07:30');
    assert.equal(quietWindowRemainingMs(window, at(3, 29)), 0);
    assert.equal(quietWindowRemainingMs(window, at(3, 30)), 4 * 3_600_000);
    assert.equal(quietWindowRemainingMs(window, at(7, 0)), 30 * 60_000);
    assert.equal(quietWindowRemainingMs(window, at(7, 30)), 0);
  });

  it('wraps past midnight', () => {
    const window = parseQuietWindow('22:00-02:00');
    assert.equal(quietWindowRemainingMs(window, at(23, 0)), 3 * 3_600_000);
    assert.equal(quietWindowRemainingMs(window, at(1, 0)), 3_600_000);
    assert.equal(quietWindowRemainingMs(window, at(12, 0)), 0);
  });
});

describe('HourlyByteBudget', () => {
  it('waits for old bundles to age out of the hour', () => {
    const budget = new HourlyByteBudget(100);
    assert.equal(budget.waitMs(60, 0), 0);
    budget.record(60, 0);
    assert.equal(budget.waitMs(30, 1000), 0);
    budget.record(30, 1000);
    // 90 used: 20 more needs the first (60) gone, at 3,600,000.
    assert.equal(budget.waitMs(20, 2000), 3_600_000 - 2000);
    assert.equal(budget.waitMs(20, 3_600_001), 0);
  });

  it('lets a bundle larger than the budget go alone', () => {
    const budget = new HourlyByteBudget(100);
    assert.equal(budget.waitMs(500, 0), 0);
    budget.record(500, 0);
    assert.equal(budget.waitMs(1, 1000), 3_600_000 - 1000);
  });

  it('never waits without a budget', () => {
    assert.equal(new HourlyByteBudget(undefined).waitMs(1e15, 0), 0);
  });
});

describe('parseBytes', () => {
  it('reads decimal suffixes', () => {
    assert.equal(parseBytes('42G'), 42e9);
    assert.equal(parseBytes('1.5T'), 1.5e12);
    assert.equal(parseBytes('600GB'), 600e9);
    assert.equal(parseBytes('1024'), 1024);
    assert.throws(() => parseBytes('lots'));
  });
});

describe('review cases', () => {
  it('pauses, not passes, when the disk counter goes down', () => {
    const first = readGuards({
      config,
      gateway: parseMetrics(gatewayText(10, 1000)),
      node: parseMetrics(nodeText(5, 900e9, 1000)),
      nowMs: 0,
    });
    const reset = readGuards({
      config,
      gateway: parseMetrics(gatewayText(10, 1000)),
      node: parseMetrics(nodeText(5, 900e9, 5)),
      nowMs: 30_000,
      previousDisk: first.disk,
    });
    const busy = reset.readings.find((r) => r.name === 'busy sda')!;
    assert.equal(busy.value, undefined);
    assert.notEqual(busy.state, 'ok');
    // The reset sample is the next baseline: 15 s busy in 30 s = 50%.
    const next = readGuards({
      config,
      gateway: parseMetrics(gatewayText(10, 1000)),
      node: parseMetrics(nodeText(5, 900e9, 20)),
      nowMs: 60_000,
      previousDisk: reset.disk,
    });
    assert.equal(next.readings.find((r) => r.name === 'busy sda')!.value, 0.5);
  });

  it('keeps no history without a byte budget', () => {
    const budget = new HourlyByteBudget(undefined);
    for (let i = 0; i < 1000; i++) budget.record(1e9, i);
    assert.equal((budget as unknown as { queued: unknown[] }).queued.length, 0);
  });
});
