/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import { Database } from 'duckdb-async';

import { createTestLogger } from '../../../test/test-logger.js';
import { bandPublisherTag } from '../../lib/index-band/build.js';
import { getSolanaAddress } from '../../lib/httpsig.js';
import {
  serializeIndexPublication,
  signIndexPublication,
} from '../../lib/index-publication.js';
import type { ClickHouseHeld } from '../../lib/parquet-l2/clickhouse-held.js';
import { L2ImportRefused } from '../../lib/parquet-l2/import-clickhouse.js';
import { L2_LEDGER_MIGRATION } from '../../lib/parquet-l2/import-ledger.js';
import {
  BAND_FILE,
  bandTablesDigest,
  l2BandId,
  lookupsOf,
  type ParquetL2Band,
  parseSelection,
  serializeBandFile,
} from '../../lib/parquet-l2/layout.js';
import {
  indexL2ImportCLICommand,
  takeL2ImportLock,
} from './indexL2ImportCommands.js';

const log = createTestLogger({ suite: 'index-l2-import' });
const SCHEMA = await fs.readFile(
  new URL('../../../test/bundles-schema.sql', import.meta.url),
  'utf8',
);
const PUBLISHER = getSolanaAddress(
  crypto.generateKeyPairSync('ed25519').publicKey,
);

const hex64 = (seed: string) =>
  crypto.createHash('sha256').update(seed).digest('hex');

const band = (from: number, to: number): ParquetL2Band => {
  const b: ParquetL2Band = {
    version: 1,
    schema: 'l2-2',
    heightRange: [from, to],
    selection: parseSelection({
      kind: 'ans104-data-items',
      tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
    }),
    keyTags: [],
    statTags: [],
    tables: {
      data_items: { rows: 1, rowDigest: hex64(`items-${from}`) },
      tags: { rows: 1, rowDigest: hex64('empty') },
      wallets: { rows: 1, rowDigest: hex64('empty') },
      parents: { rows: 0, rowDigest: hex64('empty') },
    },
    lookups: {},
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  for (const { name } of lookupsOf(b)) {
    b.lookups[name] = {
      rows: 0,
      rowDigest: hex64('empty'),
    } as ParquetL2Band['lookups'][string];
  }
  return b;
};

/** ClickHouse that holds nothing below `top`, and records whether it was asked. */
const heldWithTop = (top: number | undefined) => {
  const held: ClickHouseHeld & { asked: number } = {
    asked: 0,
    async topHeight() {
      return top;
    },
    async heldIn() {
      held.asked += 1;
      throw new Error('not expected in this test');
    },
  };
  return held;
};

describe('index-l2-import', () => {
  let root: string;
  let bandsDir: string;
  let bundlesDb: string;
  let jobsDir: string;
  let tmpDir: string;
  const env = { CLICKHOUSE_URL: 'http://clickhouse:8123' };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-import-cli-'));
    bandsDir = path.join(root, 'installed', 'ardrive-l2');
    jobsDir = path.join(root, 'jobs');
    tmpDir = path.join(root, 'tmp');
    await fs.mkdir(bandsDir, { recursive: true });
    bundlesDb = path.join(root, 'bundles.db');
    const db = new Sqlite(bundlesDb);
    db.exec(SCHEMA);
    db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO migrations VALUES (?)').run(L2_LEDGER_MIGRATION);
    db.close();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Writes a band's directory: its band.json and placeholder tables. */
  const installBand = async (from: number, to: number) => {
    const b = band(from, to);
    const id = l2BandId(b, bandPublisherTag(PUBLISHER));
    const dir = path.join(bandsDir, `${id}~1`);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, BAND_FILE), serializeBandFile(b));
    for (const t of ['data_items', 'tags', 'wallets', 'parents']) {
      await fs.writeFile(path.join(dir, `${t}.parquet`), 'not parquet');
    }
    return { id, band: b, dir };
  };

  const ledgerRows = () => {
    const db = new Sqlite(bundlesDb, { readonly: true });
    try {
      return db.prepare('SELECT * FROM parquet_l2_imports').all();
    } finally {
      db.close();
    }
  };

  const run = (
    options: Record<string, unknown>,
    held: ClickHouseHeld = heldWithTop(10_000_000),
  ) =>
    indexL2ImportCLICommand(
      {
        target: 'clickhouse',
        bandsDir,
        bundlesDb,
        jobsDir,
        tmpDir,
        ...options,
      },
      { log, env, held },
    );

  it('refuses to run beside another import on the same jobs directory', async () => {
    const lock = await takeL2ImportLock(jobsDir);
    try {
      await assert.rejects(run({}), /another index-l2-import is running/);
    } finally {
      lock.close();
    }
    // Released, the next run goes ahead.
    const result = (await run({})) as Record<string, unknown>;
    assert.equal(result.imported, 0);
  });

  it('removes what an interrupted run left, before anything else', async () => {
    await fs.mkdir(path.join(jobsDir, '.partial', 'band-a.20261028T000000Z'), {
      recursive: true,
    });
    await fs.mkdir(
      path.join(tmpDir, 'l2-h1-2-3078e8b8-000000000000.x.scratch'),
      {
        recursive: true,
      },
    );
    await fs.mkdir(path.join(tmpDir, 'not-ours'), { recursive: true });
    await run({});
    assert.deepEqual(await fs.readdir(path.join(jobsDir, '.partial')), []);
    assert.deepEqual(await fs.readdir(tmpDir), ['not-ours']);
  });

  it('refuses any target but clickhouse', async () => {
    await assert.rejects(run({ target: 'sqlite' }), /not built yet/);
    await assert.rejects(run({ target: 'postgres' }), L2ImportRefused);
  });

  it('refuses without CLICKHOUSE_URL', async () => {
    await assert.rejects(
      indexL2ImportCLICommand(
        { target: 'clickhouse', bandsDir, bundlesDb },
        { log, env: {} },
      ),
      /CLICKHOUSE_URL/,
    );
  });

  it('refuses a bundles.db without the ledger migration', async () => {
    const db = new Sqlite(bundlesDb);
    db.exec('DELETE FROM migrations');
    db.close();
    await assert.rejects(run({}), /has not run/);
  });

  it('refuses --onchain 0 and --max-unchecked at or above --onchain', async () => {
    await installBand(100, 199);
    await assert.rejects(run({ onchain: '0' }), /--onchain 0 is refused/);
    await assert.rejects(
      run({ onchain: '5', maxUnchecked: '5' }),
      /--max-unchecked must be below/,
    );
  });

  it('refuses while ClickHouse holds nothing to import beneath', async () => {
    await installBand(100, 199);
    await assert.rejects(run({}, heldWithTop(undefined)), /holds no rows/);
  });

  it('refuses to import a band without --publication, and writes nothing', async () => {
    await installBand(100, 199);
    await assert.rejects(run({}), /--publication is required/);
    assert.deepEqual(ledgerRows(), []);
    assert.deepEqual(
      await fs.readdir(path.join(jobsDir, 'queue')).catch(() => []),
      [],
    );
  });

  it('leaves bands above ClickHouse for later, without verifying anything', async () => {
    const { id } = await installBand(100, 199);
    const result = (await run({}, heldWithTop(50))) as Record<string, unknown>;
    assert.equal(result.imported, 0);
    assert.deepEqual(result.aboveCeiling, [id]);
  });

  it('writes nothing while the queue is full', async () => {
    await installBand(100, 199);
    const { id: queued, band: b } = await installBand(200, 299);
    const db = new Sqlite(bundlesDb);
    db.prepare(
      `INSERT INTO parquet_l2_imports (band_id, target, index_name, publisher, height_from, height_to, band_digest, job, started_at, queued_at)
       VALUES (?, 'clickhouse', 'ardrive-l2', ?, 200, 299, ?, 'job-1', 1, 1)`,
    ).run(queued, PUBLISHER, bandTablesDigest(b));
    db.close();
    await fs.mkdir(path.join(jobsDir, 'queue', 'job-1'), { recursive: true });
    const result = (await run({ maxQueued: '1' })) as Record<string, unknown>;
    assert.equal(result.imported, 0);
    assert.equal(result.waiting, 1);
    assert.equal(result.pending, 1);
  });

  it('skips a band the ledger says is imported up to the ceiling', async () => {
    const { id, band: b } = await installBand(100, 199);
    const db = new Sqlite(bundlesDb);
    db.prepare(
      `INSERT INTO parquet_l2_imports (band_id, target, index_name, publisher, height_from, height_to, band_digest, job, started_at, completed_at)
       VALUES (?, 'clickhouse', 'ardrive-l2', ?, 100, 199, ?, NULL, 1, 2)`,
    ).run(id, PUBLISHER, bandTablesDigest(b));
    db.close();
    const result = (await run({})) as Record<string, unknown>;
    assert.equal(result.done, 1);
    assert.equal(result.imported, 0);
  });

  it('imports again a band imported only up to an earlier ceiling', async () => {
    const { id, band: b } = await installBand(100, 199);
    const db = new Sqlite(bundlesDb);
    db.prepare(
      `INSERT INTO parquet_l2_imports (band_id, target, index_name, publisher, height_from, height_to, band_digest, job, started_at, completed_at)
       VALUES (?, 'clickhouse', 'ardrive-l2', ?, 100, 150, ?, NULL, 1, 2)`,
    ).run(id, PUBLISHER, bandTablesDigest(b));
    db.close();
    // Pending again, so it gets as far as needing a publication.
    await assert.rejects(run({}), /--publication is required/);
  });

  it('refuses a band that does not verify, and queues nothing', async () => {
    const { id } = await installBand(100, 199);
    const l1 = path.join(root, 'l1');
    await fs.mkdir(l1);
    // A publication, properly signed, whose files are not the band's.
    const key = crypto.generateKeyPairSync('ed25519');
    const keyAddress = getSolanaAddress(key.publicKey);
    const publication = path.join(root, 'publication.json');
    await fs.writeFile(
      publication,
      serializeIndexPublication(
        signIndexPublication(
          {
            version: 1,
            publisher: PUBLISHER,
            sequence: 1,
            previousManifestSha256: null,
            issuedAt: '2026-10-20T00:00:00Z',
            expiresAt: '2099-01-01T00:00:00Z',
            indexes: [
              {
                name: 'ardrive-l2',
                kind: 'parquet-l2',
                // The band, with files that are not what it holds.
                bands: [
                  {
                    id,
                    files: [BAND_FILE, 'data_items.parquet'].map((name) => ({
                      name,
                      size: 1,
                      sha256: hex64(name),
                    })),
                  },
                ],
              },
            ],
          },
          key.privateKey,
          keyAddress,
        ),
      ),
    );
    await assert.rejects(
      run({
        publication,
        publisherKey: keyAddress,
        l1BandsDir: l1,
        onchain: '1',
      }),
      (refusal: { refused?: string; refusal?: string }) => {
        assert.match(String(refusal.refused), new RegExp(`^${id}: `));
        assert.equal(refusal.refusal, 'refused');
        return true;
      },
    );
    assert.deepEqual(ledgerRows(), []);
    assert.deepEqual(
      await fs.readdir(path.join(jobsDir, 'queue')).catch(() => []),
      [],
    );
    assert.deepEqual(
      await fs.readdir(path.join(jobsDir, '.partial')).catch(() => []),
      [],
    );
  });

  it('refuses to forget a band whose job still waits in the queue', async () => {
    await fs.mkdir(path.join(jobsDir, 'queue', 'band-x.20261028T000000Z'), {
      recursive: true,
    });
    await assert.rejects(run({ forget: 'band-x' }), /waiting to load/);
    await assert.rejects(
      run({ forget: 'band-y' }),
      /not in the ledger and has no loaded or failed job/,
    );
  });

  it('forgets every job of a band, loaded or failed, in one delete', async () => {
    const writeJob = async (
      dir: string,
      heights: [number, number],
      ids: string[],
    ) => {
      const jobDir = path.join(jobsDir, dir);
      await fs.mkdir(jobDir, { recursive: true });
      await fs.writeFile(
        path.join(jobDir, 'job.json'),
        JSON.stringify({ indexedAt: 1_790_000_000, heightRange: heights }),
      );
      const duck = await Database.create(':memory:');
      await duck.exec(
        `COPY (SELECT from_hex(id) AS id, 150::UBIGINT AS height FROM (VALUES ${ids.map((i) => `('${i}')`).join(',')}) t(id)) TO '${path.join(jobDir, 'written.parquet')}' (FORMAT PARQUET)`,
      );
      await duck.close();
    };
    const a = 'AA'.repeat(32);
    const b = 'BB'.repeat(32);
    const c = 'CC'.repeat(32);
    await writeJob('done/band-z.20261028T000000Z', [100, 150], [a, b]);
    await writeJob('failed/band-z.20261028T010000Z', [100, 199], [b, c]);
    const db = new Sqlite(bundlesDb);
    db.prepare(
      `INSERT INTO parquet_l2_imports (band_id, target, index_name, publisher, height_from, height_to, band_digest, job, started_at, completed_at)
       VALUES ('band-z', 'clickhouse', 'ardrive-l2', ?, 100, 199, x'00', NULL, 1, 2)`,
    ).run(PUBLISHER);
    db.close();
    const calls: unknown[] = [];
    const result = (await indexL2ImportCLICommand(
      {
        target: 'clickhouse',
        bandsDir,
        bundlesDb,
        jobsDir,
        tmpDir,
        forget: 'band-z',
      },
      {
        log,
        env,
        held: heldWithTop(1),
        forget: {
          async forget(args) {
            calls.push(args);
            return { matched: 3 };
          },
        },
      },
    )) as Record<string, unknown>;
    assert.deepEqual(calls, [
      { from: 100, to: 199, indexedAt: 1_790_000_000, ids: [a, b, c] },
    ]);
    assert.equal(result.ids, 3);
    assert.deepEqual(ledgerRows(), []);
    assert.deepEqual(
      (await fs.readdir(path.join(jobsDir, 'forgotten'))).sort(),
      ['band-z.20261028T000000Z', 'band-z.20261028T010000Z'],
    );
  });
});
