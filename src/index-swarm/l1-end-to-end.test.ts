/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * L1 history, from a publisher into a subscribing gateway's `core.db`, the
 * way an operator's gateway does it, with nothing standing in for anything
 * but the chain's gateway registry.
 *
 * One gateway builds a `parquet-l1` band and its sidecar publishes it over
 * the real /ar-io/indexes routes. A second gateway's sidecar subscribes and
 * installs it, under the directory names the sidecar really uses. That
 * gateway's `core.db` is built by the real migrator, and holds the top of
 * the chain itself, as a gateway that began mid-chain does. Its L1 band
 * import worker then runs the real CLI in a child process while a writer
 * keeps writing as the gateway's block importer would, and the result is
 * checked with `index-l1-verify`.
 *
 * Two bugs reached operators because no test took this path: the importer
 * looked for its migration under a name the migrator never records, and
 * took the sidecar's `<band id>~<generation>` directories for something
 * other than bands. Either fails this test.
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import express from 'express';

import { indexL1VerifyCLICommand } from '../cli/commands/indexL1VerifyCommands.js';
import { exportL1Band } from '../index-export/kinds/parquet-l1/export.js';
import { l1BandId } from '../index-export/kinds/parquet-l1/kind.js';
import { getSolanaAddress } from '../lib/httpsig.js';
import { createMigrator } from '../migrator.js';
import { createIndexesRouter } from '../routes/indexes.js';
import { L1BandImportWorker } from '../workers/l1-band-import-worker.js';
import { buildCoreDb } from '../../test/parquet-l1-core-db.js';
import { createTestLogger } from '../../test/test-logger.js';
import { createKindRegistry } from './kinds/registry.js';
import { Publisher } from './publisher.js';
import { StateStore } from './state.js';
import { GENERATION_SEPARATOR, Subscriber } from './subscriber.js';

const log = createTestLogger({ suite: 'L1 bands end to end' });

/** The band's heights: a tip band, the only shape a short test chain can publish. */
const FIRST = 1_900_000;
const BAND_TO = FIRST + 29;
/** Where the subscribing gateway began indexing the chain itself. */
const BEGAN = FIRST + 20;
const TOP = FIRST + 30;

describe('L1 bands, from a publisher into a subscribing gateway', () => {
  let tempDir: string;
  let server: http.Server;
  let sourceDb: string;
  let coreDb: string;
  let bandsDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l1-e2e-'));
    const gatewayA = path.join(tempDir, 'gateway-a', 'indexes');
    const gatewayB = path.join(tempDir, 'gateway-b');
    const publishedDir = path.join(gatewayA, 'published');

    // --- Gateway A indexed the chain, builds a band, and publishes it. ---
    sourceDb = path.join(tempDir, 'source.db');
    // Unpadded, as index-l1-verify's own fixtures are: the fixture's weave
    // sits below the offset where Arweave began padding data to a chunk.
    await buildCoreDb(sourceDb, FIRST, TOP - FIRST + 1, { padded: false });
    const workDir = path.join(tempDir, 'work');
    await fs.mkdir(workDir);
    const exported = await exportL1Band({
      coreDbPath: sourceDb,
      workDir,
      from: FIRST,
      to: BAND_TO,
    });
    const wallet = crypto.generateKeyPairSync('ed25519');
    const observer = crypto.generateKeyPairSync('ed25519');
    const walletAddress = getSolanaAddress(wallet.publicKey);
    const observerAddress = getSolanaAddress(observer.publicKey);
    await fs.mkdir(path.join(publishedDir, 'parquet-l1'), { recursive: true });
    await fs.rename(
      exported.dir,
      path.join(
        publishedDir,
        'parquet-l1',
        l1BandId(exported.band, walletAddress),
      ),
    );
    await new Publisher({
      log,
      state: new StateStore({
        log,
        filePath: path.join(gatewayA, 'state.json'),
      }),
      kinds: createKindRegistry({ log }),
      signer: {
        privateKey: observer.privateKey,
        keyId: observerAddress,
        wallet: walletAddress,
      },
      publish: [{ name: 'parquet-l1', kind: 'parquet-l1' }],
      publishedDir,
      blobsDir: path.join(publishedDir, 'blobs'),
      publicationFile: path.join(publishedDir, 'publication.json'),
      ttlMs: 86_400_000,
      supersedeGraceMs: 0,
    }).scanOnce();
    const app = express();
    app.use(createIndexesRouter({ log, publishedDir }));
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;

    // --- Gateway B's sidecar subscribes to parquet-l1 and installs it. ---
    await new Subscriber({
      log,
      state: new StateStore({
        log,
        filePath: path.join(gatewayB, 'indexes', 'state.json'),
      }),
      kinds: createKindRegistry({ log }),
      registry: {
        lookup: async (w) =>
          w === walletAddress
            ? { wallet: w, observerAddress, url: origin, status: 'joined' }
            : undefined,
      },
      subscribe: [{ publisher: walletAddress, name: 'parquet-l1' }],
      trustedPublishers: [],
      incomingDir: path.join(gatewayB, 'indexes', 'incoming'),
      installedDir: path.join(gatewayB, 'indexes', 'installed'),
      fetchTimeoutMs: 10_000,
      downloadConcurrency: 4,
      supersedeGraceMs: 0,
    }).pollOnce();
    bandsDir = path.join(gatewayB, 'indexes', 'installed', 'parquet-l1');

    // --- Gateway B's core.db, as its entrypoint's migrator builds it. ---
    const sqliteDir = path.join(gatewayB, 'sqlite');
    await fs.mkdir(sqliteDir, { recursive: true });
    await createMigrator({ sqliteDir, logger: undefined }).up();
    coreDb = path.join(sqliteDir, 'core.db');

    // B began mid-chain: its block importer wrote BEGAN..TOP itself, and
    // holds a block above that it has not flushed yet.
    const db = new Sqlite(coreDb);
    try {
      db.exec(`ATTACH DATABASE '${sourceDb.replace(/'/g, "''")}' AS src`);
      db.exec(`
        INSERT INTO stable_blocks SELECT * FROM src.stable_blocks
          WHERE height BETWEEN ${BEGAN} AND ${TOP};
        INSERT INTO stable_transactions SELECT * FROM src.stable_transactions
          WHERE height BETWEEN ${BEGAN} AND ${TOP};
        INSERT INTO stable_block_transactions
          SELECT * FROM src.stable_block_transactions WHERE block_indep_hash IN
            (SELECT indep_hash FROM src.stable_blocks
              WHERE height BETWEEN ${BEGAN} AND ${TOP});
        INSERT INTO stable_transaction_tags
          SELECT * FROM src.stable_transaction_tags
          WHERE height BETWEEN ${BEGAN} AND ${TOP};
        INSERT OR IGNORE INTO tag_names SELECT * FROM src.tag_names;
        INSERT OR IGNORE INTO tag_values SELECT * FROM src.tag_values;
        INSERT OR IGNORE INTO wallets SELECT * FROM src.wallets;
      `);
      db.exec('DETACH DATABASE src');
      newBlock(db, TOP + 1);
    } finally {
      db.close();
    }
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('installs the band under the name the sidecar gives it', async () => {
    const names = await fs.readdir(bandsDir);
    assert.equal(names.length, 1);
    assert.ok(
      names[0].startsWith(`l1-h${FIRST}-${BAND_TO}-`) &&
        names[0].includes(GENERATION_SEPARATOR),
      names[0],
    );
  });

  it("fills the history beneath the gateway, as the gateway's own worker runs it, while the gateway writes", async () => {
    const worker = new L1BandImportWorker({
      log,
      coreDbPath: coreDb,
      bandsDir,
      intervalMs: 60_000,
      cacheMib: 64,
    });
    // The gateway's block importer, writing alongside the fill with the
    // busy timeout the gateway gives its writers.
    const gateway = new Sqlite(coreDb, { timeout: 30_000 });
    const failures: string[] = [];
    let writes = 0;
    let height = TOP + 2;
    const timer = setInterval(() => {
      try {
        newBlock(gateway, height);
        height += 1;
        writes += 1;
      } catch (error) {
        failures.push((error as Error).message);
      }
    }, 5);
    let summary;
    try {
      summary = await worker.runOnce();
    } finally {
      clearInterval(timer);
      gateway.close();
    }

    assert.ok(summary !== undefined, 'the fill printed no result');
    assert.equal(summary.refused, undefined);
    assert.equal(summary.ceiling, TOP);
    assert.equal(summary.filled, 1);
    assert.ok((summary.rows ?? 0) > 0);
    // The test's chain starts at FIRST; a real one has bands from 0.
    assert.deepEqual(summary.uncovered, [[0, FIRST - 1]]);
    assert.deepEqual(failures, []);
    assert.ok(writes > 0);

    // Every height the source chain has above FIRST is now in B, row for row.
    const db = new Sqlite(coreDb, { readonly: true });
    const src = new Sqlite(sourceDb, { readonly: true });
    try {
      for (const table of [
        'stable_blocks',
        'stable_transactions',
        'stable_transaction_tags',
      ]) {
        const count = (handle: Sqlite.Database) =>
          handle
            .prepare(
              `SELECT COUNT(*) FROM ${table} WHERE height BETWEEN ? AND ?`,
            )
            .pluck()
            .get(FIRST, TOP);
        assert.equal(count(db), count(src), table);
      }
    } finally {
      db.close();
      src.close();
    }
  });

  it('leaves an index that index-l1-verify passes', async () => {
    const result = (await indexL1VerifyCLICommand({ coreDb }, { log })) as {
      ok: boolean;
      heightRange: [number, number];
      checks: unknown;
    };
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.deepEqual(result.heightRange, [FIRST, TOP]);
  });

  it('finds nothing to do on the next run', async () => {
    const summary = await new L1BandImportWorker({
      log,
      coreDbPath: coreDb,
      bandsDir,
      intervalMs: 60_000,
      cacheMib: 64,
    }).runOnce();
    assert.equal(summary?.filled, 0);
  });
});

/** A block the gateway's own importer holds near the tip, not yet flushed. */
function newBlock(db: Sqlite.Database, height: number): void {
  db.prepare(
    `INSERT INTO new_blocks (indep_hash, height, nonce, hash, block_timestamp,
       diff, last_retarget, reward_pool, block_size, weave_size, tx_count,
       missing_tx_count)
     VALUES (?, ?, x'00', x'00', 0, '0', 0, '0', 0, 0, 0, 0)`,
  ).run(Buffer.from(`new-${height}`), height);
}
