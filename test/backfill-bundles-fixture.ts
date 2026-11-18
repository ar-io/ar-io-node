/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A core.db and bundles.db holding a few L1 bundles in every state
 * `backfill-bundles` distinguishes, for its tests.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import Sqlite, { Database } from 'better-sqlite3';

const sha1 = (value: Buffer) =>
  crypto.createHash('sha1').update(value).digest();

/** A deterministic 32-byte id, as base64url, from a label. */
export const fixtureId = (label: string) =>
  crypto.createHash('sha256').update(label).digest().toString('base64url');

/** The D1 filter: everything except Turbo's dedicated bundles. */
export const D1_FILTER = {
  not: {
    or: ['Redstone', 'AO', 'FirstBatch', 'KYVE'].map((value) => ({
      tags: [{ name: 'Bundler-App-Name', value }],
    })),
  },
};

export interface FixtureBundle {
  label: string;
  height: number;
  dataSize: number;
  tags: [string, string][];
  /** The transaction's quantity (winston), default '0'. */
  quantity?: string;
  /** The owner address (base64url), default {@link FIXTURE_OWNER}. */
  owner?: string;
  /** The `bundles` row; absent for none. */
  state?: {
    last_queued_at?: number;
    last_skipped_at?: number;
    last_fully_indexed_at?: number;
    retry_attempt_count?: number;
  };
}

/** Now, in the fixture's clock (seconds). */
export const FIXTURE_NOW = 1_800_000_000;
/** The default fixture owner address (32 bytes of 0x01). */
export const FIXTURE_OWNER = Buffer.alloc(32, 1).toString('base64url');

const turbo: [string, string][] = [
  ['Bundle-Format', 'binary'],
  ['Bundle-Version', '2.0.0'],
  ['App-Name', 'ArDrive Turbo'],
];
const skipped = { last_skipped_at: 1_700_000_000 };

export const FIXTURE_BUNDLES: FixtureBundle[] = [
  // Selected: skipped, never indexed, the filter matches.
  {
    label: 'untagged-a',
    height: 1_300_001,
    dataSize: 1000,
    tags: turbo,
    state: skipped,
  },
  {
    label: 'ardrive',
    height: 1_300_002,
    dataSize: 2000,
    tags: [...turbo, ['Bundler-App-Name', 'ArDrive']],
    state: skipped,
  },
  {
    label: 'untagged-b',
    height: 1_310_000,
    dataSize: 4000,
    tags: turbo,
    state: skipped,
  },
  // Queued again by an earlier run, long enough ago: selected again.
  {
    label: 'requeued-long-ago',
    height: 1_310_001,
    dataSize: 8000,
    tags: turbo,
    state: { ...skipped, last_queued_at: FIXTURE_NOW - 7 * 86400 },
  },
  // Dedicated: the filter says no.
  {
    label: 'redstone',
    height: 1_300_003,
    dataSize: 16000,
    tags: [...turbo, ['Bundler-App-Name', 'Redstone']],
    state: skipped,
  },
  {
    label: 'ao',
    height: 1_310_002,
    dataSize: 32000,
    tags: [...turbo, ['Bundler-App-Name', 'AO']],
    state: skipped,
  },
  // Not candidates for other reasons.
  {
    label: 'indexed',
    height: 1_300_004,
    dataSize: 1,
    tags: turbo,
    state: { ...skipped, last_fully_indexed_at: 1_750_000_000 },
  },
  { label: 'unrecorded', height: 1_300_005, dataSize: 1, tags: turbo },
  {
    label: 'live',
    height: 1_300_006,
    dataSize: 1,
    tags: turbo,
    state: { last_queued_at: 1_700_000_000 },
  },
  {
    label: 'failed-twice',
    height: 1_300_007,
    dataSize: 1,
    tags: turbo,
    state: { ...skipped, retry_attempt_count: 2 },
  },
  {
    label: 'in-flight',
    height: 1_300_008,
    dataSize: 1,
    tags: turbo,
    state: { ...skipped, last_queued_at: FIXTURE_NOW - 600 },
  },
  // Outside 1,300,000..1,319,999.
  {
    label: 'below',
    height: 1_299_999,
    dataSize: 1,
    tags: turbo,
    state: skipped,
  },
  {
    label: 'above',
    height: 1_320_000,
    dataSize: 1,
    tags: turbo,
    state: skipped,
  },
  // Not a bundle: no Bundle-Format tag.
  {
    label: 'plain-file',
    height: 1_300_009,
    dataSize: 1,
    tags: [['Content-Type', 'image/png']],
    state: skipped,
  },
];

/** Builds the fixture: in memory, or as files when `dir` is given. */
export function createFixture(
  bundlesList: FixtureBundle[] = FIXTURE_BUNDLES,
  dir?: string,
): { core: Database; bundles: Database; coreDb?: string; bundlesDb?: string } {
  const coreDb = dir !== undefined ? `${dir}/core.db` : undefined;
  const bundlesDb = dir !== undefined ? `${dir}/bundles.db` : undefined;
  const core = new Sqlite(coreDb ?? ':memory:');
  const bundles = new Sqlite(bundlesDb ?? ':memory:');
  core.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  bundles.exec(fs.readFileSync('test/bundles-schema.sql', 'utf8'));

  const insertTx = core.prepare(
    `INSERT INTO stable_transactions (id, height, block_transaction_index,
       signature, format, last_tx, owner_address, target, quantity, reward,
       data_size, data_root, content_type, tag_count)
     VALUES (@id, @height, 0, x'00', 2, x'00', @owner, NULL, @quantity, '0',
       @data_size, NULL, NULL, @tag_count)`,
  );
  const insertName = core.prepare(
    'INSERT OR IGNORE INTO tag_names (hash, name) VALUES (?, ?)',
  );
  const insertValue = core.prepare(
    'INSERT OR IGNORE INTO tag_values (hash, value) VALUES (?, ?)',
  );
  const insertTag = core.prepare(
    `INSERT INTO stable_transaction_tags (tag_name_hash, tag_value_hash,
       height, block_transaction_index, transaction_tag_index, transaction_id)
     VALUES (?, ?, ?, 0, ?, ?)`,
  );
  const insertBundle = bundles.prepare(
    `INSERT INTO bundles (id, root_transaction_id, format_id,
       last_queued_at, last_skipped_at, last_fully_indexed_at,
       retry_attempt_count)
     VALUES (@id, @id, 0, @last_queued_at, @last_skipped_at,
       @last_fully_indexed_at, @retry_attempt_count)`,
  );
  for (const b of bundlesList) {
    const id = Buffer.from(fixtureId(b.label), 'base64url');
    insertTx.run({
      id,
      height: b.height,
      owner: Buffer.from(b.owner ?? FIXTURE_OWNER, 'base64url'),
      data_size: b.dataSize,
      tag_count: b.tags.length,
      quantity: b.quantity ?? '0',
    });
    b.tags.forEach(([name, value], index) => {
      const n = Buffer.from(name);
      const v = Buffer.from(value);
      insertName.run(sha1(n), n);
      insertValue.run(sha1(v), v);
      insertTag.run(sha1(n), sha1(v), b.height, index, id);
    });
    if (b.state !== undefined) {
      insertBundle.run({
        id,
        last_queued_at: b.state.last_queued_at ?? null,
        last_skipped_at: b.state.last_skipped_at ?? null,
        last_fully_indexed_at: b.state.last_fully_indexed_at ?? null,
        retry_attempt_count: b.state.retry_attempt_count ?? null,
      });
    }
  }
  return { core, bundles, coreDb, bundlesDb };
}
