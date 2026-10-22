/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Regression tests for the L1 importer's fail-open findings (audit C,
 * 2026-10-22): each imported, or left rows behind, or exited 0, at
 * 3b32f2ea, and must now be refused with nothing written.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { exportBands } from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
} from '../../../test/parquet-l1-headers.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { indexL1ImportCLICommand } from '../../cli/commands/indexL1ImportCommands.js';
import {
  bandDigest,
  importBand,
  LEDGER_MIGRATION,
  planImport,
  readBands,
  runImport,
} from './import.js';

const log = createTestLogger({ suite: 'l1-import-fail-closed' });
const FIRST = 1_900_000;

function migratedCore(file: string): void {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(LEDGER_MIGRATION);
  db.close();
}

/** Copies `source`'s blocks at `from` and above into `target`, as a gateway that began there holds them. */
function holdBlocksFrom(source: string, target: string, from: number): void {
  const s = new Sqlite(source, { readonly: true });
  const rows = s
    .prepare('SELECT * FROM stable_blocks WHERE height >= ?')
    .all(from) as Array<Record<string, unknown>>;
  s.close();
  const db = new Sqlite(target);
  const cols = Object.keys(rows[0]);
  const insert = db.prepare(
    `INSERT INTO stable_blocks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  );
  for (const r of rows) insert.run(...cols.map((c) => r[c]));
  db.close();
}

const count = (file: string, table: string) => {
  const db = new Sqlite(file, { readonly: true });
  try {
    return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  } finally {
    db.close();
  }
};

describe('index-l1-import fails closed', () => {
  let dir: string;
  let bandsDir: string;
  let source: string;
  let core: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-import-closed-'));
    bandsDir = path.join(dir, 'bands');
    source = path.join(dir, 'source.db');
    core = path.join(dir, 'core.db');
    await buildCoreDb(source, FIRST, 30, { verifiable: true });
    migratedCore(core);
  });
  afterEach(async () => {
    await fsp.chmod(bandsDir, 0o755).catch(() => undefined);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('C F1: refuses an offline import nothing binds to the chain, writing nothing', async () => {
    await exportBands(source, bandsDir, [
      [FIRST, FIRST + 9],
      [FIRST + 10, FIRST + 19],
    ]);
    const out = (await indexL1ImportCLICommand(
      { bandsDir, coreDb: core },
      { log },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(out.imported, 0);
    assert.match(out.refused, /nothing binds heights/);
    assert.equal(count(core, 'stable_blocks'), 0);
    assert.equal(count(core, 'parquet_l1_imports'), 0);
  });

  it('C F1: refuses bands of another chain under a real anchor', async () => {
    // The bands are a fabricated chain; the sources serve the real one.
    const fake = path.join(dir, 'fake.db');
    await buildCoreDb(fake, FIRST, 30, { verifiable: true });
    await exportBands(fake, bandsDir, [[FIRST, FIRST + 9]]);
    const out = (await indexL1ImportCLICommand(
      { bandsDir, coreDb: core, anchorFrom: 'http://a.test,http://b.test' },
      {
        log,
        fetch: scriptedFetch({
          'http://a.test': chainNode(source),
          'http://b.test': chainNode(source),
        }),
        lookupAll: scriptedLookup(),
      },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(out.imported, 0);
    assert.match(out.refused, /is not anchored/);
    assert.equal(count(core, 'stable_blocks'), 0);
  });

  it('C F2: refuses a band whose name is not its digest, and re-imports a republished band', async () => {
    const [band] = await exportBands(source, bandsDir, [[FIRST, FIRST + 19]]);
    const wrong = band.id.replace(/-[0-9a-f]{12}$/, `-${'0'.repeat(12)}`);
    await fsp.rename(band.dir, path.join(bandsDir, wrong));
    await assert.rejects(readBands(bandsDir), /names digest/);
    // A ledger row under an id whose band now digests otherwise is not held.
    const { steps } = planImport([{ ...band }], {
      haveTo: FIRST + 19,
      held: new Map([[band.id, Buffer.alloc(32)]]),
      from: FIRST,
    });
    assert.deepEqual(
      steps.map((s) => s.id),
      [band.id],
    );
    const held = planImport([{ ...band }], {
      haveTo: FIRST + 19,
      held: new Map([[band.id, bandDigest(band.band)]]),
      from: FIRST,
    });
    assert.deepEqual(held.steps, []);
  });

  it('C F3: clears a band refused part way and reports the hole it leaves', async () => {
    const bands = await exportBands(source, bandsDir, [
      [FIRST, FIRST + 9],
      [FIRST + 10, FIRST + 19],
      [FIRST + 20, FIRST + 29],
    ]);
    const db = new Sqlite(core);
    const { Database: D } = await import('duckdb-async');
    const duck: Database = await D.create(':memory:');
    try {
      // The gateway already holds the top band.
      await importBand(db, duck, bands[2], { log });
      // The second band's tags file is swapped after the check and before
      // it is written (bands live on a shared volume): its rows no longer
      // hold, part way through the band, after blocks and transactions
      // were committed.
      const run = await runImport({
        db,
        duck,
        bandsDir,
        log,
        from: FIRST,
        commitEvery: 5,
        batchRows: 3,
        onBand: (outcome) => {
          if (outcome.heightRange[0] === FIRST) {
            fs.copyFileSync(
              path.join(bands[0].dir, 'tags.parquet'),
              path.join(bands[1].dir, 'tags.parquet'),
            );
          }
        },
      });
      assert.deepEqual(
        run.outcomes.map((o) => o.result),
        ['imported', 'refused'],
      );
      assert.deepEqual(run.holes, [[FIRST + 10, FIRST + 19]]);
      const left = db
        .prepare(
          'SELECT COUNT(*) FROM stable_blocks WHERE height BETWEEN ? AND ?',
        )
        .pluck()
        .get(FIRST + 10, FIRST + 19);
      assert.equal(left, 0, 'nothing of the refused band is left');
      assert.equal(
        db
          .prepare('SELECT COUNT(*) FROM parquet_l1_imports WHERE band_id = ?')
          .pluck()
          .get(bands[1].id),
        0,
      );
    } finally {
      db.pragma('locking_mode = NORMAL');
      db.close();
      await duck.close();
    }
  });

  it('C F4: fails --fill on a missing or unreadable bands directory, never idle', async () => {
    holdBlocksFrom(source, core, FIRST + 10);
    await exportBands(source, bandsDir, [[FIRST, FIRST + 9]]);
    await assert.rejects(
      indexL1ImportCLICommand(
        { bandsDir: path.join(dir, 'nope'), coreDb: core, fill: true },
        { log },
      ),
      /ENOENT/,
    );
    await fsp.chmod(bandsDir, 0o000);
    await assert.rejects(
      indexL1ImportCLICommand({ bandsDir, coreDb: core, fill: true }, { log }),
      /EACCES/,
    );
    await fsp.chmod(bandsDir, 0o755);
    const filled = (await indexL1ImportCLICommand(
      { bandsDir, coreDb: core, fill: true },
      { log },
    )) as Record<string, any>;
    assert.equal(filled.filled, 1, 'and fills once it can read it');
  });

  it('C F7: refuses to fill a band of another chain beneath held blocks', async () => {
    holdBlocksFrom(source, core, FIRST + 10);
    const other = path.join(dir, 'other.db');
    await buildCoreDb(other, FIRST, 10, { padded: false });
    await exportBands(other, bandsDir, [[FIRST, FIRST + 9]]);
    const out = (await indexL1ImportCLICommand(
      { bandsDir, coreDb: core, fill: true },
      { log },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(out.filled, 0);
    assert.match(out.refused, /does not build on it/);
    assert.equal(count(core, 'stable_blocks'), 20, 'only the blocks it held');
  });
});
