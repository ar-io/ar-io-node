/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The column-binding guard (`column-bindings.ts`): every column the
 * importer writes has a declared binding, every binding names a column
 * that exists, the table in docs/cli.md is the declared one, and a column
 * declared `chain`, `checkpoint` or `canonical` cannot be changed in a
 * witnessed band without `verifyBands` failing.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Database } from 'duckdb-async';

import {
  exportBands,
  republish,
  rewriteTable,
  witnessTestBand,
} from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { FORK_2_0 } from './chain.js';
import {
  type Binding,
  COLUMN_BINDINGS,
  DERIVED_CORE_COLUMNS,
  ERAS,
  renderBindingsTable,
} from './column-bindings.js';
import { IMPORT_SQL } from './import.js';
import { PARQUET_L1_TABLES, PARQUET_L1_WITNESSES } from './layout.js';
import { verifyBands } from './verify-bands.js';

/**
 * `table.column` for every column a statement the importer runs writes:
 * an `INSERT ... INTO table (columns)` or an `UPDATE table SET column = …`.
 */
function writtenColumns(): Set<string> {
  const out = new Set<string>();
  for (const statement of Object.values(IMPORT_SQL)) {
    const insert = /INSERT\b[^(]*?INTO\s+(\w+)\s*\(([^)]*)\)/s.exec(statement);
    const update =
      /UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\bFROM\b|\bWHERE\b|$)/.exec(
        statement,
      );
    if (insert !== null) {
      for (const column of insert[2].split(',').map((c) => c.trim())) {
        out.add(`${insert[1]}.${column}`);
      }
    } else if (update !== null) {
      // `a = …, b = …`: the names before each `=` at the top level.
      for (const m of update[2].matchAll(/(?:^|,)\s*(\w+)\s*=/g)) {
        out.add(`${update[1]}.${m[1]}`);
      }
    } else {
      assert.fail(`a write statement the guard cannot read: ${statement}`);
    }
  }
  return out;
}

describe('the declared column bindings', () => {
  it('name every column a band carries, and only those', () => {
    const declared = new Set(
      COLUMN_BINDINGS.map((b) => `${b.table}.${b.column}`),
    );
    const layout = new Set(
      [...PARQUET_L1_TABLES, ...PARQUET_L1_WITNESSES].flatMap((t) =>
        t.columns.map((c) => `${t.name}.${c.name}`),
      ),
    );
    assert.deepEqual(
      [...layout].filter((c) => !declared.has(c)),
      [],
      'band columns with no binding',
    );
    assert.deepEqual(
      [...declared].filter((c) => !layout.has(c)),
      [],
      'bindings of columns no band carries',
    );
  });

  it('cover every core.db column the importer writes, and only those', () => {
    const written = writtenColumns();
    const covered = new Set([
      ...COLUMN_BINDINGS.flatMap((b) => b.core),
      ...Object.keys(DERIVED_CORE_COLUMNS),
    ]);
    assert.deepEqual(
      [...written].filter((c) => !covered.has(c)).sort(),
      [],
      'columns the importer writes with no binding',
    );
    assert.deepEqual(
      [...covered].filter((c) => !written.has(c)).sort(),
      [],
      'bindings of core.db columns the importer does not write',
    );
  });

  it('name the stored spelling of every column a value could be spelt two ways in', () => {
    // Text holding a number, and bytes where absence has two spellings.
    for (const column of [
      'diff',
      'cumulative_diff',
      'reward_pool',
      'reward_addr',
      'wallet_list',
      'hash_list_merkle',
      'previous_block',
      'tx_root',
    ]) {
      const b = COLUMN_BINDINGS.find(
        (x) => x.table === 'blocks' && x.column === column,
      );
      assert.ok(b?.representation !== undefined, `blocks.${column}`);
    }
    for (const t of PARQUET_L1_TABLES) {
      for (const c of t.columns.filter((c) => c.type === 'VARCHAR')) {
        const b = COLUMN_BINDINGS.find(
          (x) => x.table === t.name && x.column === c.name,
        );
        assert.ok(
          b?.representation !== undefined ||
            ERAS.every((era) => b?.bindings[era] === 'canonical'),
          `${t.name}.${c.name}: text with no stated spelling`,
        );
      }
    }
  });

  it('leave no column bound by nothing', () => {
    // Every column written is bound, or unbound behind a flag.
    assert.deepEqual(
      COLUMN_BINDINGS.filter((b) =>
        ERAS.some((era) => b.bindings[era] === 'none'),
      ).map((b) => `${b.table}.${b.column}`),
      [],
    );
  });

  it('give each column one binding per era, with a reason', () => {
    for (const b of COLUMN_BINDINGS) {
      assert.deepEqual(Object.keys(b.bindings).sort(), [...ERAS].sort());
      assert.ok(b.reason.length > 20, `${b.table}.${b.column}`);
    }
  });

  it('are the table docs/cli.md shows', () => {
    const doc = fs.readFileSync('docs/cli.md', 'utf8');
    const m =
      /<!-- column-bindings:start -->\n([\s\S]*?)\n<!-- column-bindings:end -->/.exec(
        doc,
      );
    assert.ok(m !== null, 'docs/cli.md has no column-bindings table');
    assert.equal(m[1], renderBindingsTable());
  });
});

/** A change to one cell of a band's table that cannot be a no-op. */
const forge = (type: string, column: string): string =>
  // A height moved onto another block's would not republish at all.
  column === 'height'
    ? 'height + 1000'
    : type === 'BLOB'
      ? `from_hex(repeat('ab', ${column === 'indep_hash' || column === 'previous_block' || column === 'hash_list_merkle' || column === 'wallet_list' ? 48 : 32}))`
      : type === 'VARCHAR'
        ? `coalesce("${column}", '') || '1'`
        : `coalesce("${column}", 0) + 1`;

const typeOf = (table: string, column: string): string =>
  PARQUET_L1_TABLES.find((t) => t.name === table)!.columns.find(
    (c) => c.name === column,
  )!.type;

const bound = (b: Binding) =>
  b === 'chain' || b === 'checkpoint' || b === 'canonical';

describe('a column declared bound cannot change unnoticed', () => {
  let root: string;
  let duck: Database;
  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-bindings-'));
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  after(async () => {
    await duck.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** One chain, its band, and its pins; then the case's change, republished, verified. */
  async function mutate(
    first: number,
    witnessed: boolean,
    table: string,
    where: string,
    set: string,
    column: string,
  ) {
    const dir = await fsp.mkdtemp(path.join(root, 'case-'));
    const core = path.join(dir, 'core.db');
    const bandsDir = path.join(dir, 'bands');
    await buildCoreDb(core, first, 10, { verifiable: true, padded: false });
    const [band] = await exportBands(core, bandsDir, [[first, first + 9]]);
    const foldPins = witnessed
      ? await witnessTestBand(duck, core, band.dir)
      : undefined;
    await rewriteTable(
      duck,
      band.dir,
      table,
      `SELECT * REPLACE (CASE WHEN ${where} THEN ${set} ELSE "${column}" END AS "${column}") FROM SRC`,
    );
    await republish(duck, band.dir);
    const out = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true },
      ...(foldPins !== undefined ? { foldPins } : {}),
    });
    await fsp.rm(dir, { recursive: true, force: true });
    return out;
  }

  // Below the 2.0 fork: every block column declared bound there.
  const V1 = 100_000;
  const pre = COLUMN_BINDINGS.filter(
    (b) => b.table === 'blocks' && bound(b.bindings['1.6–2.0']),
  );
  for (const b of pre) {
    it(`pre-2.0 blocks.${b.column} (${b.bindings['1.6–2.0']})`, async () => {
      const out = await mutate(
        V1,
        true,
        'blocks',
        `height = ${V1 + 5}`,
        forge(typeOf('blocks', b.column), b.column),
        b.column,
      );
      const failing = out.checks.filter((c) => !c.ok).map((c) => c.name);
      assert.equal(out.ok, false, `blocks.${b.column} changed unnoticed`);
      assert.ok(
        failing.some((name) => name !== 'anchor'),
        failing.join(),
      );
    });
  }

  // One spelling per value: re-spelt numbers and absent values fail.
  for (const [column, set] of [
    ['diff', "'00' || diff"],
    ['cumulative_diff', "cumulative_diff || '.000'"],
    ['reward_pool', "'0' || reward_pool"],
    ['reward_addr', 'NULL'],
    ['reward_addr', "'unclaimed'::BLOB"],
    ['wallet_list', 'NULL'],
  ] as const) {
    it(`pre-2.0 blocks.${column} spelt ${set}`, async () => {
      const out = await mutate(
        V1,
        true,
        'blocks',
        `height = ${V1 + 5}`,
        set,
        column,
      );
      assert.equal(out.ok, false, `blocks.${column} := ${set} passed`);
      assert.ok(
        out.checks.find((c) => c.name === 'canonical')?.ok === false,
        out.checks
          .filter((c) => !c.ok)
          .map((c) => c.name)
          .join(),
      );
    });
  }

  // Transactions below the fork, and the format-1 data_root.
  for (const [column, set] of [
    ['data_size', 'data_size + 1'],
    ['content_type', "'image/png'"],
    ['content_encoding', "'gzip'"],
    ['offset', '"offset" + 1'],
    ['format', '2'],
    ['id', "from_hex(repeat('ab', 32))"],
    ['data_root', "from_hex(repeat('de', 32))"],
  ] as const) {
    it(`pre-2.0 transactions.${column}`, async () => {
      const out = await mutate(
        V1,
        true,
        'transactions',
        `height = ${V1 + 5} AND block_transaction_index = 0`,
        set,
        column,
      );
      assert.equal(out.ok, false, `transactions.${column} changed unnoticed`);
    });
  }

  // From the 2.0 fork: the chain-bound columns of a 2.9-era chain.
  const P2 = 1_900_000;
  for (const [table, column, set] of [
    ['blocks', 'tx_root', "from_hex(repeat('ab', 32))"],
    ['blocks', 'weave_size', 'weave_size + 1'],
    ['blocks', 'indep_hash', "from_hex(repeat('ab', 48))"],
    ['blocks', 'hash_list_merkle', "from_hex(repeat('ab', 48))"],
    ['transactions', 'data_size', 'data_size + 1'],
    ['transactions', 'data_root', "from_hex(repeat('de', 32))"],
    ['transactions', 'content_type', "'image/png'"],
    ['transactions', 'content_encoding', "'gzip'"],
    ['transactions', 'offset', '"offset" + 1'],
  ] as const) {
    it(`post-2.0 ${table}.${column}`, async () => {
      const out = await mutate(
        P2,
        false,
        table,
        table === 'blocks'
          ? `height = ${P2 + 5}`
          : `height = ${P2 + 5} AND block_transaction_index = 0`,
        set,
        column,
      );
      const failing = out.checks.filter((c) => !c.ok).map((c) => c.name);
      assert.equal(out.ok, false, `${table}.${column} changed unnoticed`);
      assert.ok(
        failing.some((name) => name !== 'anchor'),
        failing.join(),
      );
    });
  }

  it('names the sample-bound and unbound columns in its assurance', async () => {
    const out = await mutate(P2, false, 'blocks', 'false', 'NULL', 'nonce');
    const text = out.assurance.join('\n');
    for (const b of COLUMN_BINDINGS) {
      for (const era of ERAS) {
        if (b.bindings[era] === 'sample' || b.bindings[era] === 'none') {
          assert.ok(
            text.includes(`${b.table}.${b.column}`),
            `${b.table}.${b.column} (${b.bindings[era]}) not in the assurance`,
          );
        }
      }
    }
    // reward_pool, the column that once rounded: checkpointed below 2.0,
    // sampled above.
    assert.equal(
      COLUMN_BINDINGS.find((b) => b.column === 'reward_pool')?.bindings['2.5+'],
      'sample',
    );
    assert.ok(FORK_2_0 > V1);
  });
});
