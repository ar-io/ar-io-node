/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import {
  exportBands,
  republish,
  rewriteTable,
} from '../../../test/parquet-l1-bands.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
} from '../../../test/parquet-l1-headers.js';
import { GENERATION_SEPARATOR } from '../../index-swarm/subscriber.js';
import { LEDGER_MIGRATION } from '../../lib/parquet-l1/import.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { createTestLogger } from '../../../test/test-logger.js';
import {
  indexL1ImportCLICommand,
  takeImportLock,
} from './indexL1ImportCommands.js';

const log = createTestLogger({ suite: 'index-l1-import' });
const FIRST = 1_900_000;
const MIGRATION = `migrations/${LEDGER_MIGRATION}`;

describe('indexL1ImportCLICommand', () => {
  let dir: string;
  let id: string;
  let bandsDir: string;
  let coreDb: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-import-cli-'));
    bandsDir = path.join(dir, 'bands');
    coreDb = path.join(dir, 'core.db');
    const workDir = path.join(dir, 'work');
    const source = path.join(dir, 'source.db');
    await fsp.mkdir(bandsDir);
    await fsp.mkdir(workDir);
    await buildCoreDb(source, FIRST, 31, { verifiable: true });
    [id] = (await exportBands(source, bandsDir, [[FIRST, FIRST + 19]])).map(
      (b) => b.id,
    );

    const db = new Sqlite(coreDb);
    db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
    db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(
      LEDGER_MIGRATION,
    );
    db.close();
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('imports the bands, anchored at their top, and answers in the documented shape', async () => {
    const source = path.join(dir, 'source.db');
    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, anchorFrom: 'http://a.test,http://b.test' },
      {
        log,
        fetch: scriptedFetch({
          'http://a.test': chainNode(source),
          'http://b.test': chainNode(source),
        }),
        lookupAll: scriptedLookup(),
      },
    )) as Record<string, unknown>;

    assert.equal(result.imported, 1);
    assert.equal(result.haveTo, FIRST + 19);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.missingTransactions, 0);
    assert.ok((result.rows as number) > 0);
    assert.equal(result.coreDb, coreDb);
    assert.deepEqual(
      (result.bands as Array<Record<string, unknown>>)[0].heightRange,
      [FIRST, FIRST + 19],
    );
    // Everything it reports must survive JSON, which is the CLI's contract.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it('imports bands as the index-swarm sidecar installs them, keyed by band id', async () => {
    await fsp.rename(
      path.join(bandsDir, id),
      path.join(bandsDir, `${id}${GENERATION_SEPARATOR}${'a'.repeat(12)}`),
    );
    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, allowUnanchored: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(result.imported, 1);
    assert.equal(result.haveTo, FIRST + 19);
    // The ledger names the band, not the directory it was installed in.
    const db = new Sqlite(coreDb, { readonly: true });
    try {
      assert.deepEqual(
        db.prepare('SELECT band_id FROM parquet_l1_imports').pluck().all(),
        [id],
      );
    } finally {
      db.close();
    }
  });

  it('--fill fills beneath a gateway that holds the top of the chain, and answers in the documented shape', async () => {
    // The gateway began at FIRST + 10 and indexed up from there itself.
    const db = new Sqlite(coreDb);
    try {
      const source = path.join(dir, 'source.db').replace(/'/g, "''");
      db.exec(`ATTACH DATABASE '${source}' AS src`);
      db.exec(`
        INSERT INTO stable_blocks SELECT * FROM src.stable_blocks
          WHERE height >= ${FIRST + 10};
        INSERT INTO stable_transactions SELECT * FROM src.stable_transactions
          WHERE height >= ${FIRST + 10};
      `);
      db.exec('DETACH DATABASE src');
    } finally {
      db.close();
    }
    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, fill: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(result.mode, 'fill');
    assert.equal(result.ceiling, FIRST + 30);
    assert.equal(result.filled, 1);
    assert.ok((result.rows as number) > 0);
    // The test's chain starts at FIRST; a real one has bands from 0.
    assert.deepEqual(result.uncovered, [[0, FIRST - 1]]);
    assert.deepEqual(
      (result.ranges as Array<Record<string, unknown>>).map((r) => [
        r.heightRange,
        r.heights,
        r.result,
      ]),
      [[[FIRST, FIRST + 19], [FIRST, FIRST + 9], 'imported']],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it('refuses to run while another import or fill holds the database', async () => {
    const held = takeImportLock(coreDb);
    try {
      for (const fill of [false, true]) {
        await assert.rejects(
          indexL1ImportCLICommand(
            { bandsDir, coreDb, fill, allowUnanchored: true },
            { log },
          ),
          /Another import or fill is running/,
        );
      }
    } finally {
      held.close();
    }
    // Released with the process that held it, or here with its handle.
    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, allowUnanchored: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(result.imported, 1);
  });

  it('clears the spill directory a killed run left behind', async () => {
    const stale = path.join(dir, '.duckdb-import-killed');
    await fsp.mkdir(stale);
    await fsp.writeFile(path.join(stale, 'spill.tmp'), 'x');
    // Its heartbeat stopped two days ago: a run that was killed.
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await fsp.utimes(stale, old, old);
    await indexL1ImportCLICommand(
      { bandsDir, coreDb, allowUnanchored: true },
      { log },
    );
    assert.equal(fs.existsSync(stale), false);
    assert.deepEqual(
      (await fsp.readdir(dir)).filter((n) => n.startsWith('.duckdb-import')),
      [],
    );
  });

  it('does nothing the second time', async () => {
    await indexL1ImportCLICommand(
      { bandsDir, coreDb, allowUnanchored: true },
      { log },
    );
    const again = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, allowUnanchored: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(again.imported, 0);
    assert.deepEqual(again.skipped, [
      { heightRange: [FIRST, FIRST + 19], reason: 'already_imported' },
    ]);
    assert.equal(again.haveTo, FIRST + 19);
  });

  it('stops after --max-bands', async () => {
    await exportBands(path.join(dir, 'source.db'), bandsDir, [
      [FIRST + 20, FIRST + 29],
    ]);

    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, maxBands: '1', allowUnanchored: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(result.imported, 1);
    assert.equal(result.haveTo, FIRST + 19, 'stopped after the first band');
    // Without this the test passes whether or not the second band was
    // ever seen: --max-bands has to be what left it, not a name the
    // reader passed over.
    const next = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, allowUnanchored: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(
      next.haveTo,
      FIRST + 29,
      'the second band was there all along, and the next run took it',
    );
  });

  it('fails the command when a band is refused, writing nothing of it', async () => {
    // A band whose rows were changed and republished self-consistently:
    // refused by the check before writing, and the run must exit 1.
    const { Database } = await import('duckdb-async');
    const duck = await Database.create(':memory:');
    await rewriteTable(
      duck,
      path.join(bandsDir, id),
      'transactions',
      `SELECT * REPLACE (data_size + 1 AS data_size) FROM SRC`,
    );
    await republish(duck, path.join(bandsDir, id));
    await duck.close();

    let thrown: Record<string, unknown> | undefined;
    try {
      await indexL1ImportCLICommand(
        { bandsDir, coreDb, allowUnanchored: true },
        { log },
      );
    } catch (error) {
      thrown = error as Record<string, unknown>;
    }
    assert.ok(thrown !== undefined, 'the command failed');
    assert.ok(!(thrown instanceof Error), 'and threw the result, not an Error');
    assert.equal(thrown.imported, 0);
    assert.match(String(thrown.refused), /do not verify/);
    assert.deepEqual(JSON.parse(JSON.stringify(thrown)), thrown);
    const db = new Sqlite(coreDb, { readonly: true });
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM stable_blocks').pluck().get(),
      0,
    );
    db.close();
  });

  it('refuses a cache size it cannot act on', async () => {
    await assert.rejects(
      indexL1ImportCLICommand({ bandsDir, coreDb, cacheMib: '0' }, { log }),
      /--cache-mib/,
    );
    await assert.rejects(
      indexL1ImportCLICommand({ bandsDir, coreDb, cacheMib: 'lots' }, { log }),
      /--cache-mib/,
    );
  });

  it('imports with an explicit cache size', async () => {
    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, cacheMib: '16', allowUnanchored: true },
      { log },
    )) as Record<string, unknown>;
    assert.equal(result.imported, 1);
  });

  it('refuses the options it cannot act on', async () => {
    await assert.rejects(
      indexL1ImportCLICommand({ coreDb }, { log }),
      /--bands-dir/,
    );
    await assert.rejects(
      indexL1ImportCLICommand({ bandsDir }, { log }),
      /--core-db/,
    );
    await assert.rejects(
      indexL1ImportCLICommand({ bandsDir, coreDb, maxBands: 'all' }, { log }),
      /--max-bands must be a positive whole number/,
    );
    await assert.rejects(
      indexL1ImportCLICommand(
        { bandsDir, coreDb: path.join(dir, 'absent.db') },
        { log },
      ),
      /Cannot open/,
    );
  });
});
