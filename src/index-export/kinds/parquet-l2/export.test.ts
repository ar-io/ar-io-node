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
import { after, before, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import {
  ARDRIVE,
  buildRoot,
  FixtureRoot,
  gatewayOf,
  MemoryL2Source,
  PUBLISHER,
  signers,
  sourceRow,
  writeL1Band,
} from '../../../../test/parquet-l2-fixture.js';
import { createTestLogger } from '../../../../test/test-logger.js';
import { toB64Url } from '../../../lib/encoding.js';
import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { RowDigest } from '../../../lib/parquet/digest.js';
import {
  bandTablesDigest,
  l2BandId,
  PARQUET_L2_TABLES,
  parseBandFile,
  serializeBandFile,
} from '../../../lib/parquet-l2/layout.js';
import { verifyBandLookups } from '../../../lib/parquet-l2/lookups.js';
import { sqlPath } from '../../../lib/parquet/lookups.js';
import { ParquetL2Kind } from '../../../index-swarm/kinds/parquet-l2.js';
import { withBandWriter } from '../parquet-l1/export.js';
import { deriveL1Bands } from '../parquet-l1/kind.js';
import { exportL2Band, L2CheckError, L2UnavailableError } from './export.js';
import { GatewayReads } from './gateway-reads.js';
import type { L2SourceRow } from './source.js';

const log = createTestLogger({ suite: 'parquet-l2 export' });

const tag = (name: string, value: string) => ({ name, value });
const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest();

describe('exportL2Band', () => {
  let dir: string;
  let r1: FixtureRoot;
  let r2: FixtureRoot;

  before(async () => {
    // r1 at 100,500: three selected items, one not, and a nested bundle
    // (first, so its payload starts early) of three selected items.
    r1 = await buildRoot(
      'r1',
      [
        {
          name: 'n1',
          tags: [tag('App-Name', 'Bundler')],
          nested: [
            {
              name: 'b1',
              tags: [
                tag('App-Name', 'ArDrive-App'),
                tag('Content-Type', 'a/b'),
              ],
            },
            { name: 'b2', tags: [tag('App-Name', 'ArDrive-Web')] },
            { name: 'b3', tags: [tag('App-Name', 'ArDrive-Core')] },
          ],
        },
        {
          name: 'a1',
          tags: [
            tag('App-Name', 'ArDrive-App'),
            tag('content-type', 'text/plain'),
            tag('Content-Type', 'second'),
          ],
        },
        {
          name: 'a2',
          signer: signers.two,
          tags: [tag('App-Name', 'ArDrive-Web'), tag('Content-Encoding', '')],
        },
        {
          name: 'a3',
          tags: [tag('App-Name', 'Other'), tag('App-Name', 'ArDrive-CLI')],
        },
        { name: 'x1', tags: [tag('App-Name', 'ArDriver-Thing')] },
      ],
      100_500,
      3,
    );
    // r2 at 100,600: one selected item.
    r2 = await buildRoot(
      'r2',
      [{ name: 'c1', tags: [tag('App-Name', 'ArDrive-App')] }],
      100_600,
      0,
    );
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-export-'));
  });
  after(async () => undefined);

  const l1Dir = () => path.join(dir, 'published', 'parquet-l1');
  const withL1 = async () => {
    await writeL1Band(l1Dir(), 100_000, 199_999, [r1, r2]);
    return deriveL1Bands(l1Dir(), PUBLISHER);
  };
  const rows = (): L2SourceRow[] => [
    sourceRow(r1, 'a1'),
    sourceRow(r1, 'a2'),
    sourceRow(r1, 'a3'),
    sourceRow(r1, 'b1'),
    sourceRow(r1, 'b2'),
    sourceRow(r1, 'b3'),
    sourceRow(r2, 'c1'),
  ];
  const ancestors = () => [sourceRow(r1, 'n1')];
  const reads = (roots = [r1, r2], maxReads = 1000) =>
    new GatewayReads(gatewayOf(roots).openRoot, {
      maxReads,
      retryDelayMs: 1,
    });

  const exportBand = async (
    source: MemoryL2Source,
    more: Partial<Parameters<typeof exportL2Band>[0]> = {},
  ) =>
    exportL2Band({
      selection: ARDRIVE,
      from: 100_000,
      to: 104_999,
      source,
      l1Bands: await withL1(),
      reads: reads(),
      workDir: path.join(dir, 'work'),
      ...more,
    });

  /** The rows of a table, in its order, as an importer reads them. */
  const tableRows = async (bandDir: string, table: string) =>
    withBandWriter(path.join(dir, 'read'), async (duck) => {
      const spec = PARQUET_L2_TABLES.find((t) => t.name === table)!;
      const file = path.join(bandDir, spec.file).replace(/'/g, "''");
      return (await duck.all(
        `SELECT * FROM read_parquet('${file}') ORDER BY ${spec.orderBy.map((c) => `"${c}"`).join(', ')}`,
      )) as Array<Record<string, any>>;
    });

  it('exports the selected items, located, with their tags, parents and keys', async () => {
    const source = new MemoryL2Source(rows(), ancestors());
    const result = await exportBand(source);
    try {
      const { band } = result;
      assert.equal(band.tables.data_items.rows, 7);
      assert.equal(band.tables.parents.rows, 1);
      // Both owners' keys, read from the roots (the source holds none).
      assert.equal(band.tables.wallets.rows, 2);
      assert.equal(result.stats.roots, 'parquet-l1');
      assert.equal(
        band.createdAt,
        new Date((1_600_000_000 + 104_999) * 1000).toISOString(),
      );
      assert.deepEqual(band.checks, {
        located: 7,
        unlocated: {},
        normalised: 0,
        repaired: 0,
        ambiguousProven: 0,
        ambiguousUnlocated: 0,
        ownersWithoutKey: 0,
      });

      const items = await tableRows(result.dir, 'data_items');
      const byId = new Map(items.map((row) => [toB64Url(row.id), row]));
      const a1 = byId.get(toB64Url(r1.items.get('a1')!.id))!;
      // The root's position from L1, the first Content-Type by position,
      // whatever its case.
      assert.equal(Number(a1.height), 100_500);
      assert.equal(a1.block_transaction_index, 3);
      assert.equal(a1.content_type, 'text/plain');
      assert.equal(a1.content_encoding, null);
      assert.equal(a1.tag_count, 3);
      assert.equal(Number(a1.root_parent_offset), 0);
      assert.equal(Number(a1.offset), r1.items.get('a1')!.offset);
      // An empty Content-Encoding is present, not null.
      const a2 = byId.get(toB64Url(r1.items.get('a2')!.id))!;
      assert.equal(a2.content_encoding, '');
      assert.equal(a2.signature_type, 3);
      assert.equal(a2.target, null);
      assert.equal(a2.anchor, null);
      // A nested item: offsets in its bundle's payload, under its start.
      const b1 = byId.get(toB64Url(r1.items.get('b1')!.id))!;
      const placed = r1.items.get('b1')!;
      assert.equal(Number(b1.root_parent_offset), placed.payloadStart);
      assert.equal(Number(b1.offset), placed.offset);
      assert.deepEqual(Buffer.from(b1.parent_id), r1.items.get('n1')!.id);
      // Every key hashes to its address.
      for (const wallet of await tableRows(result.dir, 'wallets')) {
        assert.ok(
          sha256(Buffer.from(wallet.public_modulus)).equals(
            Buffer.from(wallet.address),
          ),
        );
      }
      const [n1] = await tableRows(result.dir, 'parents');
      assert.deepEqual(Buffer.from(n1.id), r1.items.get('n1')!.id);
      assert.equal(Number(n1.root_parent_offset), 0);
      assert.equal(Number(n1.offset), r1.items.get('n1')!.offset);
      // x1 (ArDriver) is not in it; nor is n1 (not selected).
      assert.equal(byId.has(toB64Url(r1.items.get('x1')!.id)), false);
      assert.equal(byId.has(toB64Url(r1.items.get('n1')!.id)), false);
    } finally {
      await fs.rm(result.staging, { recursive: true, force: true });
    }
  });

  it('writes a band the parquet-l2 kind validates', async () => {
    const result = await exportBand(new MemoryL2Source(rows(), ancestors()));
    const id = l2BandId(result.band, bandPublisherTag(PUBLISHER));
    const bandDir = path.join(dir, 'published', 'ardrive-l2', id);
    await fs.mkdir(path.dirname(bandDir), { recursive: true });
    await fs.rename(result.dir, bandDir);
    await fs.rm(result.staging, { recursive: true, force: true });
    const kind = new ParquetL2Kind({ log });
    const descriptor = await kind.describe(bandDir);
    assert.equal(descriptor.id, id);
    await kind.validate(descriptor, bandDir, {
      name: 'ardrive-l2',
      kind: 'parquet-l2',
      bands: [descriptor],
    } as never);
  });

  it('writes lookups its tables give, checked, and left out of its id', async () => {
    const result = await exportBand(new MemoryL2Source(rows(), ancestors()));
    try {
      const { band } = result;
      // Seven items, one height each, all signed by their owner; the tag
      // pairs as their items carry them.
      assert.equal(band.lookups.id.rows, 7);
      assert.ok(band.lookups.wallet.rows >= 7);
      assert.ok(band.lookups.tag.rows > 0);
      const files = await fs.readdir(result.dir);
      for (const file of [
        'lookup_id.parquet',
        'lookup_wallet.parquet',
        'lookup_tag.parquet',
      ]) {
        assert.ok(files.includes(file), file);
      }
      assert.deepEqual(
        parseBandFile(
          await fs.readFile(path.join(result.dir, 'band.json'), 'utf8'),
        ).lookups,
        band.lookups,
      );
      assert.equal(
        l2BandId(band, bandPublisherTag(PUBLISHER)),
        l2BandId({ ...band, lookups: {} }, bandPublisherTag(PUBLISHER)),
      );
      await withBandWriter(path.join(dir, 'read'), async (duck) => {
        assert.deepEqual(await verifyBandLookups(duck, result.dir, band), []);
        // A lookup another row longer is refused, against its band and
        // against its tables.
        const file = path.join(result.dir, 'lookup_id.parquet');
        await duck.exec(
          `COPY (SELECT * FROM read_parquet(${sqlPath(file)})
                 UNION ALL SELECT 1::UBIGINT, 100000::UBIGINT)
           TO ${sqlPath(`${file}.tampered`)} (FORMAT PARQUET)`,
        );
        await fs.rename(`${file}.tampered`, file);
        const problems = await verifyBandLookups(duck, result.dir, band);
        assert.equal(problems.length, 2, problems.join('\n'));
        assert.match(problems[0], /holds 8 rows .* its band says 7 rows/);
        assert.match(problems[1], /1 rows that its tables do not give/);
      });
    } finally {
      await fs.rm(result.staging, { recursive: true, force: true });
    }
  });

  it('gives the same band.json and id whatever order the source gives its rows in', async () => {
    const first = await exportBand(new MemoryL2Source(rows(), ancestors()));
    const shuffled = new MemoryL2Source([...rows()].reverse(), ancestors());
    shuffled.windowBlocks = 7;
    const second = await exportBand(shuffled);
    try {
      assert.equal(
        serializeBandFile(first.band),
        serializeBandFile(second.band),
      );
      const tag = bandPublisherTag(PUBLISHER);
      assert.equal(l2BandId(first.band, tag), l2BandId(second.band, tag));
      // An item the source holds twice (two block positions of its own)
      // is one row once both carry their root's.
      const twice = new MemoryL2Source(
        [...rows(), sourceRow(r1, 'a1', { height: 100_500 })],
        ancestors(),
      );
      const third = await exportBand(twice);
      assert.equal(
        serializeBandFile(third.band),
        serializeBandFile(first.band),
      );
      await fs.rm(third.staging, { recursive: true, force: true });
    } finally {
      await fs.rm(first.staging, { recursive: true, force: true });
      await fs.rm(second.staging, { recursive: true, force: true });
    }
  });

  it('digests a tiny band as RowDigest does by hand', async () => {
    const result = await exportBand(new MemoryL2Source([sourceRow(r2, 'c1')]));
    try {
      const c1 = r2.items.get('c1')!;
      const row = sourceRow(r2, 'c1');
      const columns = (name: string) =>
        PARQUET_L2_TABLES.find((t) => t.name === name)!.columns;
      const items = new RowDigest(columns('data_items'));
      items.add([
        c1.id,
        100_600,
        0,
        r2.id,
        r2.id,
        row.ownerAddress,
        null,
        null,
        3,
        c1.size - c1.headerSize,
        null,
        null,
        1,
        0,
        c1.offset,
        c1.size,
        c1.offset + c1.headerSize,
        c1.offset + 2 + 65,
        65,
        c1.offset + 2,
        65,
      ]);
      const tags = new RowDigest(columns('tags'));
      tags.add([
        100_600,
        c1.id,
        0,
        Buffer.from('App-Name'),
        Buffer.from('ArDrive-App'),
      ]);
      const wallets = new RowDigest(columns('wallets'));
      wallets.add([row.ownerAddress, c1.item.rawOwner]);
      const parents = new RowDigest(columns('parents'));
      assert.deepEqual(result.band.tables, {
        data_items: { rows: 1, rowDigest: items.hex() },
        tags: { rows: 1, rowDigest: tags.hex() },
        wallets: { rows: 1, rowDigest: wallets.hex() },
        parents: { rows: 0, rowDigest: parents.hex() },
      });
      const digest = crypto
        .createHash('sha256')
        .update(JSON.stringify([100_000, 104_999]))
        .update('\n')
        .update(JSON.stringify(ARDRIVE))
        .update('\n')
        .update(
          ['data_items', 'parents', 'tags', 'wallets']
            .map(
              (t) =>
                `${t}:${result.band.tables[t].rows}:${result.band.tables[t].rowDigest}`,
            )
            .join('\n'),
        )
        .digest();
      assert.ok(digest.equals(bandTablesDigest(result.band)));
      assert.equal(
        parseBandFile(serializeBandFile(result.band)).createdAt,
        result.band.createdAt,
      );
    } finally {
      await fs.rm(result.staging, { recursive: true, force: true });
    }
  });

  it("takes a row's height and position from its root's L1 row, never its own", async () => {
    // Filed under a lower height of the band, in an earlier window: the
    // root's, from L1, wins, and the row waits for its window.
    const source = new MemoryL2Source([
      sourceRow(r2, 'c1', { height: 100_100 }),
      sourceRow(r1, 'a1'),
    ]);
    source.windowBlocks = 250;
    const result = await exportBand(source);
    try {
      const [a1, c1] = await tableRows(result.dir, 'data_items');
      assert.equal(Number(a1.height), 100_500);
      assert.equal(Number(c1.height), 100_600);
      assert.equal(c1.block_transaction_index, 0);
      assert.equal(result.stats.movedHeight, 1);
      const tagRows = await tableRows(result.dir, 'tags');
      assert.deepEqual(
        tagRows.map((row) => Number(row.height)),
        [100_500, 100_500, 100_500, 100_600],
      );
    } finally {
      await fs.rm(result.staging, { recursive: true, force: true });
    }
    // Filed above its root's height, whose window is written: refused.
    const above = new MemoryL2Source([
      sourceRow(r1, 'a1'),
      sourceRow(r2, 'c1', { height: 103_000 }),
    ]);
    above.windowBlocks = 250;
    await assert.rejects(
      exportBand(above),
      (error: unknown) =>
        error instanceof L2CheckError &&
        error.reason === 'roots' &&
        /1 items have their root below the height the source files them under/.test(
          error.message,
        ),
    );
  });

  it('refuses the band when a root is not in the L1 data', async () => {
    const stranger = sourceRow(r2, 'c1', {
      rootTxId: Buffer.alloc(32, 7),
      parentId: Buffer.alloc(32, 7),
    });
    await assert.rejects(
      exportBand(new MemoryL2Source([...rows(), stranger])),
      (error: unknown) =>
        error instanceof L2CheckError &&
        error.reason === 'roots' &&
        /1 items have a root not in the L1 data/.test(error.message) &&
        error.details[0] === toB64Url(Buffer.alloc(32, 7)),
    );
    // Nothing left behind.
    assert.deepEqual(
      (await fs.readdir(path.join(dir, 'work'))).filter((n) =>
        n.startsWith('.band-build'),
      ),
      [],
    );
  });

  it("uses the source's L1 rows when no L1 band covers the heights, and refuses with neither", async () => {
    const source = new MemoryL2Source([sourceRow(r2, 'c1')]);
    source.positions = [
      { id: r2.id, height: 100_600, blockTransactionIndex: 0 },
    ];
    const result = await exportBand(source, { l1Bands: [] });
    assert.equal(result.stats.roots, 'clickhouse');
    await fs.rm(result.staging, { recursive: true, force: true });

    // A root at two positions in the source's rows refuses the band.
    source.positions.push({
      id: r2.id,
      height: 100_601,
      blockTransactionIndex: 4,
    });
    await assert.rejects(
      exportBand(source, { l1Bands: [] }),
      (error: unknown) =>
        error instanceof L2CheckError &&
        /more than one position/.test(error.message),
    );

    await assert.rejects(
      exportBand(new MemoryL2Source([sourceRow(r2, 'c1')]), { l1Bands: [] }),
      (error: unknown) =>
        error instanceof L2UnavailableError && error.reason === 'no_l1',
    );
  });

  it("takes owners' keys from the source, then bundles.db, then the root, keeping only keys that hash to the address", async () => {
    const one = r1.items.get('a1')!.item.rawOwner;
    const two = r1.items.get('a2')!.item.rawOwner;
    const db = path.join(dir, 'bundles.db');
    const sqlite = new Sqlite(db);
    sqlite.exec(
      'CREATE TABLE wallets (address BLOB PRIMARY KEY, public_modulus BLOB)',
    );
    sqlite.prepare('INSERT INTO wallets VALUES (?, ?)').run(sha256(two), two);
    sqlite.close();
    // The source holds owner one's key on one row, and a wrong one on another.
    const source = new MemoryL2Source([
      sourceRow(r1, 'a1', { owner: Buffer.alloc(65, 1) }),
      sourceRow(r1, 'a3', { owner: one }),
      sourceRow(r1, 'a2'),
    ]);
    const gateway = reads();
    const result = await exportBand(source, {
      walletsDbPath: db,
      reads: gateway,
    });
    try {
      assert.equal(result.stats.owners.fromSource, 1);
      assert.equal(result.stats.owners.fromWalletsDb, 1);
      assert.equal(result.stats.owners.fromGateway, 0);
      assert.equal(result.stats.owners.rejectedKeys, 1);
      assert.equal(gateway.reads, 0);
      assert.equal(result.band.tables.wallets.rows, 2);
    } finally {
      await fs.rm(result.staging, { recursive: true, force: true });
    }

    // An owner whose only item is unlocated, and whose key no index holds,
    // has no key: counted, and the band still builds.
    const unlocated = new MemoryL2Source([
      sourceRow(r1, 'a2', { offset: undefined }),
      sourceRow(r1, 'a1'),
    ]);
    const second = await exportBand(unlocated);
    try {
      assert.equal(second.band.tables.wallets.rows, 1);
      assert.equal(second.band.checks?.ownersWithoutKey, 1);
      assert.equal(second.stats.owners.fromGateway, 1);
      assert.deepEqual(second.stats.owners.withoutKeySample, [
        toB64Url(sha256(two)),
      ]);
    } finally {
      await fs.rm(second.staging, { recursive: true, force: true });
    }
  });
});

describe('exportL2Band, locations', () => {
  let dir: string;
  let r3: FixtureRoot;
  let r4: FixtureRoot;

  before(async () => {
    // A nested bundle first, so its payload starts early: the later of its
    // items sit past that start, where relative and absolute offsets read
    // alike, so a row with root_parent_offset 0 is ambiguous.
    r3 = await buildRoot(
      'r3',
      [
        {
          name: 'n1',
          tags: [tag('App-Name', 'Bundler')],
          nested: [
            {
              name: 'b1',
              tags: [tag('App-Name', 'ArDrive-App')],
              data: 'x'.repeat(1000),
            },
            { name: 'b2', tags: [tag('App-Name', 'ArDrive-App')] },
            {
              name: 'b3',
              tags: [tag('App-Name', 'ArDrive-App')],
              data: 'y'.repeat(5000),
            },
          ],
        },
        { name: 'a1', tags: [tag('App-Name', 'ArDrive-App')] },
      ],
      100_700,
      1,
    );
    // Two levels of nesting.
    r4 = await buildRoot(
      'r4',
      [
        {
          name: 'n2',
          tags: [],
          nested: [
            {
              name: 'n3',
              tags: [],
              nested: [{ name: 'd1', tags: [tag('App-Name', 'ArDrive-App')] }],
            },
          ],
        },
      ],
      100_800,
      0,
    );
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-locations-'));
  });

  const exportBand = async (
    items: L2SourceRow[],
    ancestors: L2SourceRow[] = [],
  ) => {
    const l1 = path.join(dir, 'published', 'parquet-l1');
    await fs.rm(l1, { recursive: true, force: true });
    await writeL1Band(l1, 100_000, 199_999, [r3, r4]);
    return exportL2Band({
      selection: ARDRIVE,
      from: 100_000,
      to: 104_999,
      source: new MemoryL2Source(items, ancestors),
      l1Bands: await deriveL1Bands(l1, PUBLISHER),
      reads: new GatewayReads(gatewayOf([r3, r4]).openRoot, {
        maxReads: 1000,
        retryDelayMs: 1,
      }),
      workDir: path.join(dir, 'work'),
    });
  };
  const id = (band: Awaited<ReturnType<typeof exportBand>>) =>
    l2BandId(band.band, bandPublisherTag(PUBLISHER));
  const done = (...results: Array<Awaited<ReturnType<typeof exportBand>>>) =>
    Promise.all(
      results.map((r) => fs.rm(r.staging, { recursive: true, force: true })),
    );

  /** b1-b3 as the index should hold them: relative, under their payload. */
  const right = () => ['b1', 'b2', 'b3'].map((name) => sourceRow(r3, name));
  /** Relative offsets under a root_parent_offset of 0 (#907). */
  const relative = () =>
    ['b1', 'b2', 'b3'].map((name) =>
      sourceRow(r3, name, { rootParentOffset: 0 }),
    );
  /** Absolute offsets under a root_parent_offset of 0 (resolved on demand). */
  const absolute = () =>
    ['b1', 'b2', 'b3'].map((name) => {
      const row = sourceRow(r3, name);
      const start = r3.items.get(name)!.payloadStart;
      return {
        ...row,
        rootParentOffset: 0,
        offset: row.offset! + start,
        dataOffset: row.dataOffset! + start,
        signatureOffset: row.signatureOffset! + start,
        ownerOffset: row.ownerOffset! + start,
      };
    });
  const n1 = () => [sourceRow(r3, 'n1')];

  it('proves ambiguous items by their headers, and writes every reading of the same item the same', async () => {
    const good = await exportBand(right(), n1());
    const rel = await exportBand(relative(), n1());
    const abs = await exportBand(absolute(), n1());
    try {
      assert.equal(good.band.checks?.located, 3);
      // b1 sits before the payload's start: repaired; b2 and b3 proven.
      assert.equal(rel.band.checks?.repaired, 1);
      assert.equal(rel.band.checks?.ambiguousProven, 2);
      assert.deepEqual(rel.stats.proofs, {
        relative: 2,
        absolute: 0,
        none: 0,
        both: 0,
        unproven: 0,
      });
      // b1 and b2 proven absolute; b3 runs past the payload read as
      // relative, so it is absolute without a read.
      assert.equal(abs.band.checks?.ambiguousProven, 2);
      assert.deepEqual(abs.stats.proofs, {
        relative: 0,
        absolute: 2,
        none: 0,
        both: 0,
        unproven: 0,
      });
      // The same rows: the same tables and id.
      assert.deepEqual(rel.band.tables, good.band.tables);
      assert.deepEqual(abs.band.tables, good.band.tables);
      assert.equal(id(rel), id(good));
      assert.equal(id(abs), id(good));
    } finally {
      await done(good, rel, abs);
    }
  });

  it('counts a row placePayload repaired as repaired, whatever another copy of it says', async () => {
    // b1 sits before its bundle's payload starts: relative offsets under a
    // root_parent_offset of 0, repaired without a read.
    const [b1] = relative();
    const alone = await exportBand([b1], n1());
    // The same item held twice at its height (two block positions of its
    // own), once as the unbundler writes it today: one row, still repaired.
    const twice = await exportBand([b1, sourceRow(r3, 'b1')], n1());
    try {
      for (const result of [alone, twice]) {
        assert.equal(result.band.checks?.located, 1);
        assert.equal(result.band.checks?.repaired, 1);
        assert.equal(result.stats.placedBy.repaired, 1);
        // Placed without a header read (the one read is its owner's key).
        assert.equal(result.stats.proofs.relative, 0);
        assert.equal(result.stats.reads, 1);
      }
      assert.deepEqual(twice.band.tables, alone.band.tables);
      assert.equal(twice.stats.rows.distinct, 1);
    } finally {
      await done(alone, twice);
    }
  });

  it('leaves an ambiguous item unlocated when no reading is its header', async () => {
    const [b1, b2, b3] = relative();
    const shifted = {
      ...b2,
      offset: b2.offset! + 1,
      dataOffset: b2.dataOffset! + 1,
      signatureOffset: b2.signatureOffset! + 1,
      ownerOffset: b2.ownerOffset! + 1,
    };
    const result = await exportBand([b1, shifted, b3], n1());
    try {
      assert.equal(result.band.checks?.located, 2);
      assert.deepEqual(result.band.checks?.unlocated, { ambiguous: 1 });
      assert.equal(result.band.checks?.ambiguousUnlocated, 1);
      assert.equal(result.stats.proofs.none, 1);
    } finally {
      await done(result);
    }
  });

  it('normalises item-relative header offsets, and leaves bad layouts unlocated', async () => {
    const plain = await exportBand([sourceRow(r3, 'a1')]);
    const a1 = sourceRow(r3, 'a1');
    const relativeHeader = await exportBand([
      { ...a1, signatureOffset: 2, ownerOffset: 2 + a1.signatureSize! },
    ]);
    const bad = await exportBand([{ ...a1, signatureSize: 64 }]);
    try {
      assert.equal(relativeHeader.band.checks?.normalised, 1);
      assert.deepEqual(relativeHeader.band.tables, plain.band.tables);
      assert.deepEqual(bad.band.checks?.unlocated, { layout: 1 });
      assert.equal(bad.band.checks?.located, 0);
    } finally {
      await done(plain, relativeHeader, bad);
    }
  });

  it('leaves items unlocated when their parent bundle cannot be placed, even where their own row places them', async () => {
    // The parent's only row is inconsistent (the #937 class: here a payload
    // that ends past the row's own end), so it has no place in `parents`.
    // The children carry absolute offsets that would place them on their
    // own; the band must not locate them under a parent it does not
    // describe.
    const broken = { ...n1()[0], size: 1 };
    const result = await exportBand(absolute(), [broken]);
    try {
      assert.equal(result.band.checks?.located, 0);
      assert.deepEqual(result.band.checks?.unlocated, { no_parent: 3 });
      assert.equal(result.band.tables.parents.rows, 0);
    } finally {
      await done(result);
    }
  });

  it('leaves the items of a bundle held in two places, or not held, unlocated', async () => {
    const other = sourceRow(r3, 'n1');
    const twice = await exportBand(right(), [
      ...n1(),
      {
        ...other,
        offset: other.offset! + 7,
        dataOffset: other.dataOffset! + 7,
      },
    ]);
    const orphans = await exportBand(right(), []);
    try {
      assert.deepEqual(twice.band.checks?.unlocated, { parent_two_places: 3 });
      // Both places of the bundle are listed.
      assert.equal(twice.band.tables.parents.rows, 2);
      assert.deepEqual(orphans.band.checks?.unlocated, { no_parent: 3 });
      assert.equal(orphans.band.tables.parents.rows, 0);
    } finally {
      await done(twice, orphans);
    }
  });

  it('places a doubly nested item only on an unbroken chain, and lists every bundle above it', async () => {
    const chain = [sourceRow(r4, 'n2'), sourceRow(r4, 'n3')];
    const whole = await exportBand([sourceRow(r4, 'd1')], chain);
    const broken = await exportBand(
      [sourceRow(r4, 'd1')],
      [sourceRow(r4, 'n2'), sourceRow(r4, 'n3', { rootParentOffset: 0 })],
    );
    try {
      assert.equal(whole.band.checks?.located, 1);
      assert.equal(whole.band.tables.parents.rows, 2);
      assert.deepEqual(broken.band.checks?.unlocated, { deep: 1 });
      // n3 is repaired, so still located.
      assert.equal(broken.band.tables.parents.rows, 2);
    } finally {
      await done(whole, broken);
    }
  });

  it('drops an unlocated copy of a located item, and refuses copies it cannot tell apart', async () => {
    const a1 = sourceRow(r3, 'a1');
    const plain = await exportBand([a1]);
    const dominated = await exportBand([a1, { ...a1, offset: undefined }]);
    try {
      assert.deepEqual(dominated.band.tables, plain.band.tables);
    } finally {
      await done(plain, dominated);
    }
    await assert.rejects(
      exportBand([
        { ...a1, offset: undefined },
        { ...a1, offset: undefined, signatureType: undefined },
      ]),
      (error: unknown) =>
        error instanceof L2CheckError && error.reason === 'unlocated_conflict',
    );
    await assert.rejects(
      exportBand([a1, { ...a1, anchor: Buffer.alloc(32, 5) }]),
      (error: unknown) =>
        error instanceof L2CheckError && error.reason === 'conflict',
    );
  });

  it('refuses items the source gives that the selection does not take', async () => {
    const a1 = sourceRow(r3, 'a1');
    const source = new MemoryL2Source([]);
    // A source that ignores the selection.
    source.windows = async function* () {
      yield {
        from: 100_000,
        to: 104_999,
        items: [
          {
            ...a1,
            tags: [
              {
                name: Buffer.from('App-Name'),
                value: Buffer.from('ArDriver-X'),
              },
            ],
          },
        ],
        ancestors: [],
      };
    };
    const l1 = path.join(dir, 'published', 'parquet-l1');
    await writeL1Band(l1, 100_000, 199_999, [r3]);
    await assert.rejects(
      exportL2Band({
        selection: ARDRIVE,
        from: 100_000,
        to: 104_999,
        source,
        l1Bands: await deriveL1Bands(l1, PUBLISHER),
        reads: new GatewayReads(gatewayOf([r3]).openRoot, { maxReads: 10 }),
        workDir: path.join(dir, 'work'),
      }),
      (error: unknown) =>
        error instanceof L2CheckError && error.reason === 'selection_mismatch',
    );
  });

  it('writes an ambiguous item unproven, and an owner keyless, when the gateway has no such root', async () => {
    const l1 = path.join(dir, 'published', 'parquet-l1');
    await writeL1Band(l1, 100_000, 199_999, [r3]);
    // No such root (a 404): b2 and b3 can't be proven, and a1's owner key
    // can't be read; the band builds.
    const gateway = gatewayOf([]);
    const reads = new GatewayReads(gateway.openRoot, {
      maxReads: 100,
      retryDelayMs: 1,
    });
    const result = await exportL2Band({
      selection: ARDRIVE,
      from: 100_000,
      to: 104_999,
      source: new MemoryL2Source([...relative(), sourceRow(r3, 'a1')], n1()),
      l1Bands: await deriveL1Bands(l1, PUBLISHER),
      reads,
      workDir: path.join(dir, 'work'),
    });
    try {
      // In band.json an unproven item is an unresolved ambiguous one.
      assert.deepEqual(result.band.checks?.unlocated, { ambiguous: 2 });
      // b1 is repaired without a read, a1 is in the root itself.
      assert.equal(result.band.checks?.located, 2);
      assert.equal(result.stats.proofs.unproven, 2);
      assert.equal(result.band.checks?.ownersWithoutKey, 1);
      assert.deepEqual(result.stats.owners.withoutKeyBy, {
        unreadable: 1,
        wrong: 0,
        nowhere: 0,
      });
      assert.equal(result.band.tables.wallets.rows, 0);
      // The root asked for once; every later read answered from memory.
      assert.equal(gateway.reads, 1);
      assert.equal(result.stats.reads, 1);
      assert.equal(result.stats.readsNotFound, 1);
      assert.ok(result.stats.readsNotFoundRemembered >= 2);
    } finally {
      await fs.rm(result.staging, { recursive: true, force: true });
    }
  });

  it('stops a band whose reads fail in transport, rather than writing it unlocated', async () => {
    const l1 = path.join(dir, 'published', 'parquet-l1');
    await writeL1Band(l1, 100_000, 199_999, [r3]);
    for (const failing of [503, 429]) {
      const gateway = gatewayOf([r3], { failing });
      await assert.rejects(
        exportL2Band({
          selection: ARDRIVE,
          from: 100_000,
          to: 104_999,
          source: new MemoryL2Source(relative(), n1()),
          l1Bands: await deriveL1Bands(l1, PUBLISHER),
          reads: new GatewayReads(gateway.openRoot, {
            maxReads: 100,
            retryDelayMs: 1,
          }),
          workDir: path.join(dir, 'work'),
        }),
        (error: unknown) =>
          error instanceof L2UnavailableError &&
          error.reason === 'gateway' &&
          new RegExp(`status code ${failing}`).test(error.message),
      );
      // The first read tried three times before the band stopped.
      assert.ok(gateway.reads >= 3);
    }
    await assert.rejects(
      exportL2Band({
        selection: ARDRIVE,
        from: 100_000,
        to: 104_999,
        source: new MemoryL2Source(relative(), n1()),
        l1Bands: await deriveL1Bands(l1, PUBLISHER),
        reads: new GatewayReads(gatewayOf([r3]).openRoot, { maxReads: 1 }),
        workDir: path.join(dir, 'work'),
      }),
      (error: unknown) =>
        error instanceof L2UnavailableError && error.reason === 'read_budget',
    );
  });
});
