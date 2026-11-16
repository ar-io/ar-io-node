/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from 'better-sqlite3';

import { createFilter } from '../../filters.js';
import { createTestLogger } from '../../../test/test-logger.js';
import {
  createFixture,
  D1_FILTER,
  FIXTURE_NOW,
  fixtureId,
} from '../../../test/backfill-bundles-fixture.js';
import {
  BUNDLE_FORMAT_BINARY_HASH,
  BUNDLE_FORMAT_NAME_HASH,
  buckets,
  judgeBundleState,
  selectBucket,
} from './select.js';

const log = createTestLogger({ suite: 'backfill-bundles select' });

describe('backfill-bundles selection', () => {
  let core: Database;
  let bundles: Database;

  before(() => ({ core, bundles } = createFixture()));
  after(() => {
    core.close();
    bundles.close();
  });

  const select = (filter: unknown, from = 1_300_000, to = 1_319_999) =>
    Object.fromEntries(
      selectBucket({
        core,
        bundles,
        filter: createFilter(filter, log),
        from,
        to,
        maxRetries: 2,
        cooldownSeconds: 6 * 3600,
        nowSeconds: FIXTURE_NOW,
      }).map((c) => [c.id, c.verdict]),
    );

  it('uses the Bundle-Format hashes the repair worker uses', () => {
    // repair.sql selectFailedBundleIds hard-codes these.
    assert.equal(
      BUNDLE_FORMAT_NAME_HASH.toString('hex').toUpperCase(),
      'BF796ECA81CCE3FF36CEA53FA1EBB0F274A0FF29',
    );
    assert.equal(
      BUNDLE_FORMAT_BINARY_HASH.toString('hex').toUpperCase(),
      '7E57CFE843145135AEE1F4D0D63CEB7842093712',
    );
  });

  it('judges every bundle in the range', () => {
    assert.deepEqual(select(D1_FILTER), {
      [fixtureId('untagged-a')]: 'selected',
      [fixtureId('ardrive')]: 'selected',
      [fixtureId('untagged-b')]: 'selected',
      [fixtureId('requeued-long-ago')]: 'selected',
      [fixtureId('redstone')]: 'filtered-out',
      [fixtureId('ao')]: 'filtered-out',
      [fixtureId('indexed')]: 'indexed',
      [fixtureId('unrecorded')]: 'unrecorded',
      [fixtureId('live')]: 'not-skipped',
      [fixtureId('failed-twice')]: 'retries-exhausted',
      [fixtureId('in-flight')]: 'recently-queued',
    });
  });

  it('leaves out heights outside the range and non-bundles', () => {
    const ids = Object.keys(select({ always: true }));
    for (const label of ['below', 'above', 'plain-file']) {
      assert.ok(!ids.includes(fixtureId(label)), label);
    }
  });

  it('follows the filter it is given (mutations of the D1 filter)', () => {
    // always: the dedicated bundles become candidates too.
    const always = select({ always: true });
    assert.equal(always[fixtureId('redstone')], 'selected');
    assert.equal(always[fixtureId('ao')], 'selected');
    // never: nothing is selected.
    assert.ok(!Object.values(select({ never: true })).includes('selected'));
    // Dropping AO from the exclusions lets AO through, Redstone still out.
    const withoutAo = select({
      not: {
        or: D1_FILTER.not.or.filter((clause) => clause.tags[0].value !== 'AO'),
      },
    });
    assert.equal(withoutAo[fixtureId('ao')], 'selected');
    assert.equal(withoutAo[fixtureId('redstone')], 'filtered-out');
    // Values match exactly and case-sensitively, as forward indexing does.
    const lower = select({
      not: { tags: [{ name: 'Bundler-App-Name', value: 'redstone' }] },
    });
    assert.equal(lower[fixtureId('redstone')], 'selected');
  });

  it('matches owner_address attribute filters', () => {
    const owner = Buffer.alloc(32, 1).toString('base64url');
    const byOwner = select({ attributes: { owner_address: owner } });
    assert.equal(byOwner[fixtureId('untagged-a')], 'selected');
    const other = select({ attributes: { owner_address: 'x'.repeat(43) } });
    assert.equal(other[fixtureId('untagged-a')], 'filtered-out');
  });

  it('reports Bundler-App-Name and size', () => {
    const [ardrive] = selectBucket({
      core,
      bundles,
      filter: createFilter(D1_FILTER, log),
      from: 1_300_002,
      to: 1_300_002,
      maxRetries: 2,
      cooldownSeconds: 0,
      nowSeconds: FIXTURE_NOW,
    });
    assert.equal(ardrive.bundlerAppName, 'ArDrive');
    assert.equal(ardrive.dataSize, 2000);
  });
});

describe('judgeBundleState', () => {
  const opts = { maxRetries: 2, cooldownSeconds: 100, nowSeconds: 1000 };

  it('selects a skipped bundle queued again only after the cooldown', () => {
    const state = {
      last_skipped_at: 10,
      last_fully_indexed_at: null,
      retry_attempt_count: null,
    };
    assert.equal(
      judgeBundleState({ ...state, last_queued_at: 950 }, opts),
      'recently-queued',
    );
    assert.equal(
      judgeBundleState({ ...state, last_queued_at: 850 }, opts),
      undefined,
    );
    // Queued before it was skipped: the skip is the latest word.
    assert.equal(
      judgeBundleState({ ...state, last_queued_at: 5 }, opts),
      undefined,
    );
  });
});

describe('buckets', () => {
  it('aligns to 10,000 heights and clamps to the range', () => {
    assert.deepEqual(buckets(1_305_000, 1_321_000), [
      [1_305_000, 1_309_999],
      [1_310_000, 1_319_999],
      [1_320_000, 1_321_000],
    ]);
    assert.deepEqual(buckets(5, 5), [[5, 5]]);
  });
});
