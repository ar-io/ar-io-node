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

import { exportL1Band } from '../../index-export/kinds/parquet-l1/export.js';
import { LEDGER_MIGRATION } from '../../lib/parquet-l1/import.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { indexL1ImportCLICommand } from './indexL1ImportCommands.js';

const log = createTestLogger({ suite: 'index-l1-import' });
const FIRST = 1_900_000;
const MIGRATION =
  'migrations/2026.10.04T12.00.00.core.add-parquet-l1-imports.sql';

describe('indexL1ImportCLICommand', () => {
  let dir: string;
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
    await buildCoreDb(source, FIRST, 31);
    const out = await exportL1Band({
      coreDbPath: source,
      workDir,
      from: FIRST,
      to: FIRST + 19,
    });
    await fsp.rename(
      out.dir,
      path.join(
        bandsDir,
        `l1-h${FIRST}-${FIRST + 19}-f5b1208c-${'0'.repeat(12)}`,
      ),
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

  it('imports the bands and answers in the documented shape', async () => {
    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb },
      { log },
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

  it('does nothing the second time', async () => {
    await indexL1ImportCLICommand({ bandsDir, coreDb }, { log });
    const again = (await indexL1ImportCLICommand(
      { bandsDir, coreDb },
      { log },
    )) as Record<string, unknown>;
    assert.equal(again.imported, 0);
    assert.deepEqual(again.skipped, [
      { heightRange: [FIRST, FIRST + 19], reason: 'already_imported' },
    ]);
    assert.equal(again.haveTo, FIRST + 19);
  });

  it('stops after --max-bands', async () => {
    const second = path.join(dir, 'work2');
    await fsp.mkdir(second);
    const out = await exportL1Band({
      coreDbPath: path.join(dir, 'source.db'),
      workDir: second,
      from: FIRST + 20,
      to: FIRST + 29,
    });
    await fsp.rename(
      out.dir,
      path.join(
        bandsDir,
        `l1-h${FIRST + 20}-${FIRST + 29}-f5b1208c-${'1'.repeat(12)}`,
      ),
    );

    const result = (await indexL1ImportCLICommand(
      { bandsDir, coreDb, maxBands: '1' },
      { log },
    )) as Record<string, unknown>;
    assert.equal(result.imported, 1);
    assert.equal(result.haveTo, FIRST + 19, 'stopped after the first band');
    // Without this the test passes whether or not the second band was
    // ever seen: --max-bands has to be what left it, not a name the
    // reader passed over.
    const next = (await indexL1ImportCLICommand(
      { bandsDir, coreDb },
      { log },
    )) as Record<string, unknown>;
    assert.equal(
      next.haveTo,
      FIRST + 29,
      'the second band was there all along, and the next run took it',
    );
  });

  it('fails the command when a band is refused, keeping what landed', async () => {
    // The bands below the failure are imported and kept, but the run did
    // not do what was asked, so it must exit 1 rather than print a
    // success a script would believe.
    const file = path.join(
      bandsDir,
      `l1-h${FIRST}-${FIRST + 19}-f5b1208c-${'0'.repeat(12)}`,
      'band.json',
    );
    const band = JSON.parse(await fsp.readFile(file, 'utf8'));
    band.tables.transactions.rowDigest = 'f'.repeat(64);
    await fsp.writeFile(file, JSON.stringify(band));

    let thrown: Record<string, unknown> | undefined;
    try {
      await indexL1ImportCLICommand({ bandsDir, coreDb }, { log });
    } catch (error) {
      thrown = error as Record<string, unknown>;
    }
    assert.ok(thrown !== undefined, 'the command failed');
    assert.ok(!(thrown instanceof Error), 'and threw the result, not an Error');
    assert.equal(thrown.imported, 0);
    assert.match(String(thrown.refused), /digest/);
    assert.deepEqual(JSON.parse(JSON.stringify(thrown)), thrown);
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
