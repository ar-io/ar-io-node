/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestLogger } from '../../../test/test-logger.js';
import {
  createFixture,
  D1_FILTER,
  FIXTURE_NOW,
  fixtureId,
} from '../../../test/backfill-bundles-fixture.js';
import { backfillBundlesCLICommand } from './backfillBundlesCommands.js';

const log = createTestLogger({ suite: 'backfill-bundles' });

/** A gateway that answers info, metrics and queue-bundle, and records it. */
function fakeGateway({
  filter = D1_FILTER as unknown,
  queueAnswers = [] as number[],
  lagSeconds = 0.01 as number | (() => number),
} = {}) {
  const queued: { id: string; body: any; auth: string | null }[] = [];
  const answers = [...queueAnswers];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/ar-io/info')) {
      return Response.json({ ans104UnbundleFilter: filter });
    }
    if (url.endsWith('/ar-io/__gateway_metrics')) {
      return new Response(
        [
          'queue_length{queue_name="bundleDataImporter"} 0',
          'queue_length{queue_name="ans104DataIndexer"} 0',
          `nodejs_eventloop_lag_p99_seconds ${typeof lagSeconds === 'function' ? lagSeconds() : lagSeconds}`,
        ].join('\n'),
      );
    }
    if (url.endsWith('/ar-io/admin/queue-bundle')) {
      const body = JSON.parse(String(init?.body));
      const status = answers.shift() ?? 200;
      if (status === 200) {
        queued.push({
          id: body.id,
          body,
          auth: new Headers(init?.headers).get('authorization'),
        });
        return Response.json({ message: 'Bundle queued' });
      }
      return new Response('Bundle importer queue is full', { status });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, queued };
}

describe('backfill-bundles CLI', () => {
  let dir: string;
  let coreDb: string;
  let bundlesDb: string;
  // FIXTURE_NOW is 08:00 UTC; noon is outside the default quiet window
  // (03:30–07:30 UTC) and keeps the fixture's queue times where it put them.
  const noon = FIXTURE_NOW * 1000 + 4 * 3_600_000;
  const clock = () => {
    let now = noon;
    const sleeps: number[] = [];
    return {
      nowMs: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      sleeps,
    };
  };
  const base = () => ({
    from: '1300000',
    to: '1319999',
    coreDb,
    bundlesDb,
    gatewayUrl: 'http://gw:4000/',
  });

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-bundles-'));
    const fixture = createFixture(undefined, dir);
    fixture.core.close();
    fixture.bundles.close();
    coreDb = fixture.coreDb!;
    bundlesDb = fixture.bundlesDb!;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const expectedSelected = [
    fixtureId('untagged-a'),
    fixtureId('ardrive'),
    fixtureId('untagged-b'),
    fixtureId('requeued-long-ago'),
  ];

  it('dry run counts per bucket and queues nothing', async () => {
    const gw = fakeGateway();
    const t = clock();
    const result: any = await backfillBundlesCLICommand(
      { ...base(), dryRun: true },
      { log, env: {}, fetch: gw.fetchImpl, nowMs: t.nowMs, sleep: t.sleep },
    );
    assert.equal(gw.queued.length, 0);
    assert.equal(result.totals.selected, 4);
    assert.equal(result.totals.selectedBytes, 1000 + 2000 + 4000 + 8000);
    assert.deepEqual(
      result.buckets.map((b: any) => [b.from, b.to, b.verdicts.selected]),
      [
        [1_300_000, 1_309_999, 2],
        [1_310_000, 1_319_999, 2],
      ],
    );
    assert.deepEqual(
      { ...result.selectedByBundlerAppName },
      {
        '(none)': 3,
        ArDrive: 1,
      },
    );
    assert.equal(result.totals.verdicts['filtered-out'], 2);
  });

  it('queues exactly what the dry run selected, in height order, non-prioritized', async () => {
    const dry = fakeGateway();
    const t1 = clock();
    const dryResult: any = await backfillBundlesCLICommand(
      { ...base(), dryRun: true },
      { log, env: {}, fetch: dry.fetchImpl, ...t1 },
    );
    const gw = fakeGateway();
    const t2 = clock();
    const result: any = await backfillBundlesCLICommand(base(), {
      log,
      env: { ADMIN_API_KEY: 'k' },
      fetch: gw.fetchImpl,
      ...t2,
    });
    assert.deepEqual(
      gw.queued.map((q) => q.id),
      expectedSelected,
    );
    assert.equal(result.totals.queued, dryResult.totals.selected);
    for (const q of gw.queued) {
      assert.deepEqual(q.body, {
        id: q.id,
        bypassFilter: true,
        prioritized: false,
      });
      assert.equal(q.auth, 'Bearer k');
    }
  });

  it("selects with the gateway's filter", async () => {
    const gw = fakeGateway({ filter: { always: true } });
    const result: any = await backfillBundlesCLICommand(
      { ...base(), dryRun: true },
      { log, env: {}, fetch: gw.fetchImpl, ...clock() },
    );
    assert.equal(result.totals.selected, 6); // Redstone and AO too
  });

  it('takes --filter for a dry run, and refuses it for a real one', async () => {
    const gw = fakeGateway({ filter: { never: true } });
    const result: any = await backfillBundlesCLICommand(
      { ...base(), dryRun: true, filter: JSON.stringify(D1_FILTER) },
      { log, env: {}, fetch: gw.fetchImpl, ...clock() },
    );
    assert.equal(result.totals.selected, 4);
    await assert.rejects(
      backfillBundlesCLICommand(
        { ...base(), filter: JSON.stringify(D1_FILTER) },
        { log, env: { ADMIN_API_KEY: 'k' }, fetch: gw.fetchImpl, ...clock() },
      ),
      /dry-run only/,
    );
    assert.equal(gw.queued.length, 0);
  });

  it('refuses a filter on the owner public key', async () => {
    const gw = fakeGateway({
      filter: { and: [{ attributes: { owner: 'abc' } }] },
    });
    await assert.rejects(
      backfillBundlesCLICommand(
        { ...base(), dryRun: true },
        { log, env: {}, fetch: gw.fetchImpl, ...clock() },
      ),
      /owner_address/,
    );
  });

  it('retries a bundle the gateway had no room for', async () => {
    const gw = fakeGateway({ queueAnswers: [429, 429, 200] });
    const t = clock();
    const result: any = await backfillBundlesCLICommand(
      { ...base(), poll: '7' },
      { log, env: { ADMIN_API_KEY: 'k' }, fetch: gw.fetchImpl, ...t },
    );
    assert.deepEqual(
      gw.queued.map((q) => q.id),
      expectedSelected,
    );
    assert.deepEqual(t.sleeps, [7000, 7000]);
    assert.equal(result.pausedSeconds['queue bundleDataImporter'], 14);
  });

  it('waits out the quiet window before queueing', async () => {
    const gw = fakeGateway();
    let now = FIXTURE_NOW * 1000 - 4 * 3_600_000; // 04:00 UTC
    const sleeps: number[] = [];
    await backfillBundlesCLICommand(base(), {
      log,
      env: { ADMIN_API_KEY: 'k' },
      fetch: gw.fetchImpl,
      nowMs: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    assert.equal(sleeps[0], 3.5 * 3_600_000);
    assert.equal(gw.queued.length, 4);
  });

  it('keeps to the hourly byte budget', async () => {
    const gw = fakeGateway();
    const t = clock();
    await backfillBundlesCLICommand(
      { ...base(), bytesPerHour: '5000' },
      { log, env: { ADMIN_API_KEY: 'k' }, fetch: gw.fetchImpl, ...t },
    );
    // 1000 + 2000 fit; 4000 waits for both to age out; 8000 goes alone.
    assert.equal(gw.queued.length, 4);
    assert.deepEqual(t.sleeps, [3_600_000, 3_600_000]);
  });

  it('stops at --limit', async () => {
    const gw = fakeGateway();
    const result: any = await backfillBundlesCLICommand(
      { ...base(), limit: '1' },
      { log, env: { ADMIN_API_KEY: 'k' }, fetch: gw.fetchImpl, ...clock() },
    );
    assert.equal(gw.queued.length, 1);
    assert.equal(result.limitReached, true);
  });

  it('halts with its result when a guard holds past its halt limit', async () => {
    const gw = fakeGateway({ lagSeconds: 5 });
    await assert.rejects(
      backfillBundlesCLICommand(
        { ...base(), haltAfter: '60', poll: '30' },
        { log, env: { ADMIN_API_KEY: 'k' }, fetch: gw.fetchImpl, ...clock() },
      ),
      (error: any) => {
        assert.match(error.halted, /event loop lag p99/);
        assert.equal(error.totals.queued, 0);
        return true;
      },
    );
    assert.equal(gw.queued.length, 0);
  });

  it('needs the admin key to queue, but not for a dry run', async () => {
    const gw = fakeGateway();
    await assert.rejects(
      backfillBundlesCLICommand(base(), {
        log,
        env: {},
        fetch: gw.fetchImpl,
        ...clock(),
      }),
      /ADMIN_API_KEY/,
    );
  });

  it('counts a 503 as refused and moves on, instead of retrying it forever', async () => {
    const gw = fakeGateway({ queueAnswers: [503] });
    const t = clock();
    const result: any = await backfillBundlesCLICommand(base(), {
      log,
      env: { ADMIN_API_KEY: 'k' },
      fetch: gw.fetchImpl,
      ...t,
    });
    assert.equal(result.totals.refused, 1);
    assert.deepEqual(
      gw.queued.map((q) => q.id),
      expectedSelected.slice(1),
    );
    assert.deepEqual(t.sleeps, []);
  });

  it('does not count the quiet window as time a guard held its halt', async () => {
    // 03:25 UTC: the lag is in its halt band for 5 minutes before the
    // window and 5 minutes after it. Neither stretch reaches --halt-after
    // (10 minutes), so the run must not halt on the unobserved 4 hours.
    let now = FIXTURE_NOW * 1000 - (4 * 60 + 35) * 60_000;
    const windowEnd = FIXTURE_NOW * 1000 - 30 * 60_000; // 07:30 UTC
    const gw = fakeGateway({
      lagSeconds: () => (now < windowEnd + 5 * 60_000 ? 5 : 0.01),
    });
    const result: any = await backfillBundlesCLICommand(
      { ...base(), haltAfter: '600', poll: '60' },
      {
        log,
        env: { ADMIN_API_KEY: 'k' },
        fetch: gw.fetchImpl,
        nowMs: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
    );
    assert.equal(result.totals.queued, 4);
    assert.ok(result.pausedSeconds['quiet window'] > 0);
  });

  it('counts Bundler-App-Name values like __proto__ as app names', async () => {
    const appDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'backfill-bundles-apps-'),
    );
    try {
      const tags = (app: string): [string, string][] => [
        ['Bundle-Format', 'binary'],
        ['Bundle-Version', '2.0.0'],
        ['Bundler-App-Name', app],
      ];
      const f = createFixture(
        [
          {
            label: 'proto',
            height: 1_300_001,
            dataSize: 1,
            tags: tags('__proto__'),
            state: { last_skipped_at: 1_700_000_000 },
          },
          {
            label: 'ctor',
            height: 1_300_002,
            dataSize: 1,
            tags: tags('constructor'),
            state: { last_skipped_at: 1_700_000_000 },
          },
        ],
        appDir,
      );
      f.core.close();
      f.bundles.close();
      const gw = fakeGateway();
      const result: any = await backfillBundlesCLICommand(
        { ...base(), coreDb: f.coreDb!, bundlesDb: f.bundlesDb!, dryRun: true },
        { log, env: {}, fetch: gw.fetchImpl, ...clock() },
      );
      const apps = result.selectedByBundlerAppName;
      assert.equal(
        Object.prototype.hasOwnProperty.call(apps, '__proto__'),
        true,
      );
      assert.equal(apps['__proto__'], 1);
      assert.equal(apps['constructor'], 1);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it('needs --node-metrics-url for host guards', async () => {
    await assert.rejects(
      backfillBundlesCLICommand(
        { ...base(), dryRun: true, maxLoad1: '20:28' },
        { log, env: {}, fetch: fakeGateway().fetchImpl, ...clock() },
      ),
      /node-metrics-url/,
    );
  });
});
