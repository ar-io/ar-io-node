/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Exports one height range of an index's selected data items as a
 * `parquet-l2` band (layout in `src/lib/parquet-l2/layout.ts`), checked and
 * ready to publish.
 *
 * - **Windows.** The source is read a window of heights at a time; each
 *   window's items are located (`assemble.ts`), their roots placed on the
 *   chain (`roots.ts`), and their rows written to scratch, hex-encoded, as
 *   the L1 exporter writes its scratch. Memory follows a window, the
 *   band's distinct owners, and the few items whose root sits at another
 *   height than the source filed them under.
 * - **Distinct rows.** DuckDB loads the scratch, keeps distinct rows (an
 *   item the index holds twice at one height collapses once both copies
 *   carry their root's position), and drops an unlocated row of an
 *   (id, root) that also has a located one. Whatever is left must be one
 *   row per key of each table's order: two unlocated rows of one item in
 *   one root, or two rows of one place, that still differ refuse the band
 *   rather than be tie-broken.
 * - **Checks before anything publishes**: every location all set or all
 *   null, the layout arithmetic of every located row, `tag_count` against
 *   the tag rows, every root at its L1 position (against the L1 bands
 *   themselves when those gave the positions), one row per key, and every
 *   key's SHA-256 its address.
 * - **Row digests** are taken by reading each written table back in its
 *   order (`orderByClause`), so they are the digests an importer computes.
 */
import crypto from 'node:crypto';
import { createWriteStream, WriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { once } from 'node:events';
import * as path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Database } from 'duckdb-async';

import { BandSampleEntry, Reservoir } from '../../../lib/index-band/build.js';
import { toB64Url } from '../../../lib/encoding.js';
import { RowDigest } from '../../../lib/parquet/digest.js';
import type { TableSpec } from '../../../lib/parquet-l1/layout.js';
import {
  BAND_FILE,
  orderByClause,
  PARQUET_L2_SCHEMA,
  PARQUET_L2_TABLES,
  ParquetL2Band,
  ParquetL2Selection,
  serializeBandFile,
} from '../../../lib/parquet-l2/layout.js';
import {
  decodeColumn,
  encodeField,
  withBandWriter,
} from '../parquet-l1/export.js';
import type { L1PublishedBand } from '../parquet-l1/kind.js';
import {
  AssembledItem,
  assembleWindow,
  keyCandidate,
  RowFaults,
} from './assemble.js';
import {
  GatewayReads,
  ReadBudgetError,
  ReadUnavailableError,
} from './gateway-reads.js';
import { positionsByRoot, RootResolver, rootResolver } from './roots.js';
import { selectionMatcher } from './selection.js';
import type { L2ItemSource, RootPosition } from './source.js';
import { openWalletsDb, OwnerKeys, OwnerKeyStats } from './wallets.js';

/** Header-check samples: general, and per placement or normalisation. */
export const L2_SAMPLE_SIZE = 150;
export const L2_STRATUM_SAMPLE_SIZE = 50;

/** Items held for a band-wide root lookup at most; past it the band is refused. */
export const MAX_STRAYS = 100_000;

const SAMPLE = 20;

/** A band refused over its rows: the same rows would be refused again. */
export class L2CheckError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/** A band that couldn't be built for a reason that passes: retried later. */
export class L2UnavailableError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface L2BandStats {
  /** Where the roots' positions came from. */
  roots: RootResolver['via'];
  windows: number;
  /** Item rows the source gave. */
  sourceRows: number;
  /** Selected items whose root is the item itself, left out. */
  rootIsItem: number;
  /** Items whose root sits at another height of the band than the source filed them under. */
  movedHeight: number;
  /** Ambiguous items, by how their header reads came out. */
  proofs: { relative: number; absolute: number; none: number; both: number };
  /** Reads from the gateway, proofs and keys. */
  reads: number;
  /** Ambiguous items proven by a header whose tag count field is wrong. */
  malformedTags: number;
  owners: OwnerKeyStats;
  /** data_items rows: written, distinct, kept. */
  rows: { written: number; distinct: number; kept: number };
}

export interface L2ExportResult {
  /** The build's scratch directory, holding the band: the caller removes it. */
  staging: string;
  /** The finished band, inside `staging`. */
  dir: string;
  band: ParquetL2Band;
  stats: L2BandStats;
  /** Located rows to header-check before publishing. */
  sample: BandSampleEntry[];
  bandBytes: number;
  seconds: number;
}

const tableSpec = (name: string): TableSpec =>
  PARQUET_L2_TABLES.find((t) => t.name === name) as TableSpec;

/** Columns a data_items scratch row carries beyond the band's. */
const DATA_ITEM_EXTRA = [
  { name: 'unlocated_reason', type: 'VARCHAR' },
  { name: 'placement', type: 'VARCHAR' },
  { name: 'normalised', type: 'BOOLEAN' },
];

/** One scratch file of hex-encoded rows. */
class Scratch {
  rows = 0;
  private readonly stream: WriteStream;
  private error?: Error;

  constructor(
    readonly file: string,
    readonly columns: Array<{ name: string; type: string }>,
  ) {
    this.stream = createWriteStream(file);
    this.stream.on('error', (error) => {
      this.error ??= error;
    });
  }

  async write(values: unknown[]): Promise<void> {
    if (this.error !== undefined) throw this.error;
    const line = values
      .map((value, i) => encodeField(value, this.columns[i].type))
      .join(',');
    this.rows += 1;
    if (!this.stream.write(`${line}\n`)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.stream.end((error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (this.error !== undefined) throw this.error;
  }

  /** The DuckDB source reading it back, typed. */
  select(): string {
    const columns = this.columns
      .map((c) => `'${c.name}': 'VARCHAR'`)
      .join(', ');
    const decoded = this.columns
      .map((c) => decodeColumn(c.name, c.type))
      .join(', ');
    return `SELECT ${decoded} FROM read_csv('${this.file.replace(/'/g, "''")}', header = false, delim = ',', quote = '', escape = '', auto_detect = false, nullstr = '\\N', columns = {${columns}})`;
  }
}

/** A data_items row, in the layout's column order, then the scratch extras. */
function dataItemValues(
  item: AssembledItem,
  position: RootPosition,
): unknown[] {
  const l = item.location;
  const values: Record<string, unknown> = {
    id: item.id,
    height: position.height,
    block_transaction_index: position.blockTransactionIndex,
    root_transaction_id: item.rootTxId,
    parent_id: item.parentId,
    owner_address: item.ownerAddress,
    target: item.target,
    anchor: item.anchor,
    signature_type: item.signatureType,
    data_size: item.dataSize,
    content_type: item.contentType,
    content_encoding: item.contentEncoding,
    tag_count: item.tags.length,
    root_parent_offset: l?.rootParentOffset ?? null,
    offset: l?.offset ?? null,
    size: l?.size ?? null,
    data_offset: l?.dataOffset ?? null,
    owner_offset: l?.ownerOffset ?? null,
    owner_size: l?.ownerSize ?? null,
    signature_offset: l?.signatureOffset ?? null,
    signature_size: l?.signatureSize ?? null,
  };
  return [
    ...tableSpec('data_items').columns.map((c) => values[c.name]),
    item.unlocated ?? null,
    item.placement ?? null,
    item.normalised,
  ];
}

const quoted = (columns: Array<{ name: string }>) =>
  columns.map((c) => `"${c.name}"`).join(', ');

const LOCATION = [
  'root_parent_offset',
  'offset',
  'size',
  'data_offset',
  'owner_offset',
  'owner_size',
  'signature_offset',
  'signature_size',
].map((c) => `"${c}"`);

async function count(duck: Database, sql: string): Promise<number> {
  const [row] = (await duck.all(sql)) as Array<{ n: bigint | number }>;
  return Number(row?.n ?? 0);
}

async function sampleIds(duck: Database, sql: string): Promise<string[]> {
  const rows = (await duck.all(`${sql} LIMIT ${SAMPLE}`)) as Array<{
    id: Buffer;
  }>;
  return rows.map((row) => toB64Url(Buffer.from(row.id)));
}

/** Refuses the band when `sql` (a `SELECT ... AS id` query) finds anything. */
async function refuseIfAny(
  duck: Database,
  reason: string,
  what: string,
  sql: string,
): Promise<void> {
  const n = await count(duck, `SELECT count(*) AS n FROM (${sql})`);
  if (n === 0) return;
  const sample = await sampleIds(duck, sql);
  throw new L2CheckError(reason, `${n} ${what}`, sample);
}

/**
 * Exports `[from, to]` of one index into a new directory under `workDir`,
 * checks it, and returns it ready to publish. The staging directory is the
 * caller's to remove (the band can be renamed out of it first).
 *
 * @throws L2CheckError when the rows can't make a band (rejected);
 *   L2UnavailableError, or a source's error, when it couldn't be built now.
 */
export async function exportL2Band({
  selection,
  from,
  to,
  source,
  l1Bands,
  walletsDbPath,
  reads,
  workDir,
}: {
  selection: ParquetL2Selection;
  from: number;
  to: number;
  source: L2ItemSource;
  /** This publisher's live `parquet-l1` bands, for the roots' positions. */
  l1Bands: L1PublishedBand[];
  /** The gateway's `bundles.db`, for owners' keys; skipped when absent. */
  walletsDbPath?: string;
  /** The gateway the proofs and keys are read through. */
  reads: GatewayReads;
  workDir: string;
}): Promise<L2ExportResult> {
  const started = Date.now();
  await fs.mkdir(workDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(workDir, '.band-build-l2-'));
  try {
    const scratchDir = path.join(staging, 'scratch');
    const bandDir = path.join(staging, 'band');
    await fs.mkdir(scratchDir);
    await fs.mkdir(bandDir);
    const result = await withBandWriter(staging, (duck) =>
      build(duck, {
        selection,
        from,
        to,
        source,
        l1Bands,
        walletsDbPath,
        reads,
        scratchDir,
        bandDir,
      }),
    );
    await fs.rm(scratchDir, { recursive: true, force: true });
    return {
      staging,
      dir: bandDir,
      ...result,
      bandBytes: await directoryBytes(bandDir),
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    if (error instanceof ReadBudgetError) {
      throw new L2CheckError('read_budget', error.message);
    }
    if (error instanceof ReadUnavailableError) {
      throw new L2UnavailableError(
        'gateway',
        `A read through the header-check gateway failed: ${error.message}`,
      );
    }
    throw error;
  }
}

async function build(
  duck: Database,
  {
    selection,
    from,
    to,
    source,
    l1Bands,
    walletsDbPath,
    reads,
    scratchDir,
    bandDir,
  }: {
    selection: ParquetL2Selection;
    from: number;
    to: number;
    source: L2ItemSource;
    l1Bands: L1PublishedBand[];
    walletsDbPath?: string;
    reads: GatewayReads;
    scratchDir: string;
    bandDir: string;
  },
): Promise<Pick<L2ExportResult, 'band' | 'stats' | 'sample'>> {
  const resolver = rootResolver(duck, l1Bands, source, from, to);
  if (resolver === undefined) {
    throw new L2UnavailableError(
      'no_l1',
      `No L1 data places the roots of heights ${from}-${to}: this publisher's parquet-l1 bands don't cover them, and the source holds no L1 rows`,
    );
  }
  const scratch = {
    data_items: new Scratch(path.join(scratchDir, 'data_items.csv'), [
      ...tableSpec('data_items').columns,
      ...DATA_ITEM_EXTRA,
    ]),
    tags: new Scratch(
      path.join(scratchDir, 'tags.csv'),
      tableSpec('tags').columns,
    ),
    parents: new Scratch(
      path.join(scratchDir, 'parents.csv'),
      tableSpec('parents').columns,
    ),
    wallets: new Scratch(
      path.join(scratchDir, 'wallets.csv'),
      tableSpec('wallets').columns,
    ),
  };
  let walletsDb: ReturnType<typeof openWalletsDb> = undefined;
  try {
    walletsDb = openWalletsDb(walletsDbPath);
    const selected = selectionMatcher(selection);
    const owners = new OwnerKeys(walletsDb);
    const faults: RowFaults = { noRoot: [], badRow: [], notSelected: [] };
    const missing = new Set<string>();
    const ambiguous = new Set<string>();
    const stats = {
      windows: 0,
      sourceRows: 0,
      rootIsItem: 0,
      movedHeight: 0,
      proofs: { relative: 0, absolute: 0, none: 0, both: 0 },
    };
    const general = new Reservoir<BandSampleEntry>(L2_SAMPLE_SIZE, Math.random);
    const strata = new Map<string, Reservoir<BandSampleEntry>>();
    const offerSample = (item: AssembledItem) => {
      const l = item.location;
      if (l === null) return;
      const entry = (tag?: string): BandSampleEntry => ({
        id: toB64Url(item.id),
        rootTxId: toB64Url(item.rootTxId),
        rootOffset: l.rootParentOffset + l.offset,
        rootDataOffset: l.rootParentOffset + l.dataOffset,
        ...(tag !== undefined ? { tag } : {}),
      });
      general.offer(entry());
      const tags = [
        ...(item.placement !== undefined &&
        item.placement !== 'top' &&
        item.placement !== 'nested'
          ? [item.placement]
          : []),
        ...(item.normalised ? ['normalised'] : []),
      ];
      for (const tag of tags) {
        let reservoir = strata.get(tag);
        if (reservoir === undefined) {
          reservoir = new Reservoir(L2_STRATUM_SAMPLE_SIZE, Math.random);
          strata.set(tag, reservoir);
        }
        reservoir.offer(entry(tag));
      }
    };

    const writeItem = async (item: AssembledItem, position: RootPosition) => {
      await scratch.data_items.write(dataItemValues(item, position));
      for (const [index, tag] of item.tags.entries()) {
        await scratch.tags.write([
          position.height,
          item.id,
          index,
          tag.name,
          tag.value,
        ]);
      }
      offerSample(item);
    };

    // Items whose root wasn't at their window's heights: looked up across
    // the band once every window is read.
    const strays: AssembledItem[] = [];
    for await (const window of source.windows(from, to, selection)) {
      stats.windows += 1;
      stats.sourceRows += window.items.length;
      const assembled = await assembleWindow(window, {
        selected,
        probe: (root, offset, bytes, id) =>
          reads.headerIs(root, offset, bytes, id),
      });
      stats.rootIsItem += assembled.rootIsItem;
      for (const k of ['relative', 'absolute', 'none', 'both'] as const) {
        stats.proofs[k] += assembled.proofs[k];
      }
      for (const k of ['noRoot', 'badRow', 'notSelected'] as const) {
        faults[k].push(...assembled.faults[k].slice(0, SAMPLE));
      }
      const { one, ambiguous: twice } = positionsByRoot(
        await resolver.lookup(
          assembled.items.map((item) => item.rootTxId),
          window.from,
          window.to,
        ),
      );
      for (const item of assembled.items) {
        const k = item.rootTxId.toString('hex');
        owners.note(item.ownerAddress, item.ownerKey, keyCandidate(item));
        if (twice.has(k)) {
          ambiguous.add(k);
          continue;
        }
        const position = one.get(k);
        if (position === undefined) {
          strays.push(item);
          if (strays.length > MAX_STRAYS) {
            throw new L2CheckError(
              'roots',
              `More than ${MAX_STRAYS} items of heights ${from}-${to} have their root at another height than the source files them under`,
            );
          }
          continue;
        }
        await writeItem(item, position);
      }
      for (const parent of assembled.parents) {
        const l = parent.location;
        await scratch.parents.write([
          parent.id,
          parent.rootTxId,
          l.rootParentOffset,
          l.offset,
          l.size,
          l.dataOffset,
        ]);
      }
      // Let the heartbeat and anything else in the process run.
      await setImmediate();
    }

    if (strays.length > 0) {
      const { one, ambiguous: twice } = positionsByRoot(
        await resolver.lookup(
          strays.map((item) => item.rootTxId),
          from,
          to,
        ),
      );
      for (const item of strays) {
        const k = item.rootTxId.toString('hex');
        if (twice.has(k)) {
          ambiguous.add(k);
          continue;
        }
        const position = one.get(k);
        if (position === undefined) {
          missing.add(k);
          continue;
        }
        stats.movedHeight += 1;
        await writeItem(item, position);
      }
    }

    const bad: string[] = [];
    if (faults.notSelected.length > 0) {
      throw new L2CheckError(
        'selection_mismatch',
        `The source gave items the selection doesn't take (${faults.notSelected.length} or more)`,
        faults.notSelected.slice(0, SAMPLE),
      );
    }
    if (faults.noRoot.length > 0) {
      bad.push(
        `items without a root id: ${faults.noRoot.slice(0, 5).join(', ')}`,
      );
    }
    if (faults.badRow.length > 0) {
      bad.push(
        `items without a 32-byte parent id or owner address: ${faults.badRow.slice(0, 5).join(', ')}`,
      );
    }
    if (bad.length > 0) {
      throw new L2CheckError('bad_rows', bad.join('; '));
    }
    if (missing.size > 0 || ambiguous.size > 0) {
      const name = (k: string) => toB64Url(Buffer.from(k, 'hex'));
      throw new L2CheckError(
        'roots',
        [
          missing.size > 0
            ? `${missing.size} root transactions are not in the L1 data (${resolver.via}) at heights ${from}-${to}`
            : '',
          ambiguous.size > 0
            ? `${ambiguous.size} root transactions sit at more than one position`
            : '',
        ]
          .filter((s) => s.length > 0)
          .join('; '),
        [
          ...[...missing].slice(0, SAMPLE).map(name),
          ...[...ambiguous].slice(0, SAMPLE).map((k) => `${name(k)} (twice)`),
        ],
      );
    }

    const keys = await owners.resolve(reads);
    for (const [k, key] of [...keys.keys.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      await scratch.wallets.write([Buffer.from(k, 'latin1'), key]);
    }
    for (const file of Object.values(scratch)) await file.close();

    const createdAt = await resolver.bandTime(to);
    if (createdAt === undefined) {
      throw new L2CheckError(
        'block_time',
        `No time for block ${to} in the L1 data (${resolver.via}) to date the band by`,
      );
    }

    const tables = await finishTables(duck, {
      scratch,
      bandDir,
      resolver,
      from,
      to,
    });
    const band: ParquetL2Band = {
      version: 1,
      schema: PARQUET_L2_SCHEMA,
      heightRange: [from, to],
      selection,
      tables: tables.tables,
      checks: tables.checks,
      createdAt,
    };
    await fs.writeFile(path.join(bandDir, BAND_FILE), serializeBandFile(band));
    const sample = [
      ...new Map(
        [general, ...strata.values()]
          .flatMap((reservoir) => reservoir.items)
          .map((entry) => [
            `${entry.id}:${entry.rootTxId}:${entry.rootOffset}`,
            entry,
          ]),
      ).values(),
    ];
    return {
      band,
      sample,
      stats: {
        roots: resolver.via,
        ...stats,
        reads: reads.reads,
        malformedTags: reads.malformedTags,
        owners: keys.stats,
        rows: tables.rows,
      },
    };
  } finally {
    walletsDb?.close();
    for (const file of Object.values(scratch)) {
      await file.close().catch(() => undefined);
    }
  }
}

/**
 * Loads the scratch into DuckDB, keeps what a band holds, checks it, writes
 * each table's Parquet in its order, and reads each back for its digest.
 */
async function finishTables(
  duck: Database,
  {
    scratch,
    bandDir,
    resolver,
    from,
    to,
  }: {
    scratch: Record<'data_items' | 'tags' | 'parents' | 'wallets', Scratch>;
    bandDir: string;
    resolver: RootResolver;
    from: number;
    to: number;
  },
): Promise<{
  tables: ParquetL2Band['tables'];
  checks: Record<string, unknown>;
  rows: L2BandStats['rows'];
}> {
  const items = tableSpec('data_items');
  const itemColumns = quoted(items.columns);

  // data_items: distinct rows, extras aggregated so they can't split one.
  await duck.exec(`CREATE TABLE di_raw AS ${scratch.data_items.select()}`);
  await duck.exec(`
    CREATE TABLE di AS
    SELECT ${itemColumns}, min(unlocated_reason) AS unlocated_reason,
      min(placement) AS placement, bool_or(normalised) AS normalised
    FROM di_raw GROUP BY ${itemColumns}`);
  // An unlocated row of an (id, root) that has a located one says less.
  await duck.exec(`
    CREATE TABLE di_final AS
    SELECT * FROM di WHERE "offset" IS NOT NULL
    UNION ALL
    SELECT d.* FROM di d WHERE d."offset" IS NULL AND NOT EXISTS (
      SELECT 1 FROM di l WHERE l."offset" IS NOT NULL
        AND l.id = d.id AND l.root_transaction_id = d.root_transaction_id)`);
  const rows = {
    written: await count(duck, 'SELECT count(*) AS n FROM di_raw'),
    distinct: await count(duck, 'SELECT count(*) AS n FROM di'),
    kept: await count(duck, 'SELECT count(*) AS n FROM di_final'),
  };
  await duck.exec('DROP TABLE di_raw; DROP TABLE di;');

  // Location all or none, and the arithmetic of every located row.
  await refuseIfAny(
    duck,
    'partial_location',
    'data items have part of a location',
    `SELECT id FROM di_final WHERE NOT ((${LOCATION.map((c) => `${c} IS NULL`).join(' AND ')}) OR (${LOCATION.map((c) => `${c} IS NOT NULL`).join(' AND ')}))`,
  );
  await refuseIfAny(
    duck,
    'layout',
    "located data items' offsets don't describe one data item",
    `SELECT id FROM di_final WHERE "offset" IS NOT NULL AND NOT (
      size > 0 AND data_offset + data_size = "offset" + size
      AND signature_offset = "offset" + 2
      AND owner_offset = signature_offset + signature_size
      AND data_offset >= owner_offset + owner_size)`,
  );
  // One row per key of the order, or the order (and digest) isn't defined.
  await refuseIfAny(
    duck,
    'unlocated_conflict',
    'items are held unlocated twice in one root, differently',
    `SELECT id FROM di_final WHERE "offset" IS NULL
     GROUP BY id, root_transaction_id HAVING count(*) > 1`,
  );
  await refuseIfAny(
    duck,
    'conflict',
    'items are held twice at one place, differently',
    `SELECT id FROM di_final
     GROUP BY height, block_transaction_index, id, root_parent_offset, "offset"
     HAVING count(*) > 1`,
  );
  if (resolver.blockTransactionFiles !== undefined) {
    const files = `[${resolver.blockTransactionFiles.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')}]`;
    await refuseIfAny(
      duck,
      'roots',
      'roots are not at their L1 position',
      `SELECT d.root_transaction_id AS id FROM (
         SELECT DISTINCT root_transaction_id, height, block_transaction_index
         FROM di_final) d
       ANTI JOIN (
         SELECT transaction_id, height, block_transaction_index
         FROM read_parquet(${files}) WHERE height BETWEEN ${from} AND ${to}) l
       ON l.transaction_id = d.root_transaction_id AND l.height = d.height
         AND l.block_transaction_index = d.block_transaction_index`,
    );
  }

  // tags: distinct, one per key, and as many per item as it says.
  await duck.exec(
    `CREATE TABLE tg AS SELECT DISTINCT * FROM (${scratch.tags.select()})`,
  );
  await refuseIfAny(
    duck,
    'tag_conflict',
    'items have two tags at one position',
    'SELECT id FROM tg GROUP BY height, id, tag_index HAVING count(*) > 1',
  );
  await refuseIfAny(
    duck,
    'tag_count',
    "items' tag_count isn't their number of tags",
    `SELECT d.id FROM di_final d LEFT JOIN (
       SELECT height, id, count(*) AS n FROM tg GROUP BY height, id) t
     ON t.height = d.height AND t.id = d.id
     WHERE coalesce(t.n, 0) != d.tag_count`,
  );
  await refuseIfAny(
    duck,
    'tag_orphan',
    'tags belong to no data item of the band',
    `SELECT t.id FROM (SELECT DISTINCT height, id FROM tg) t
     ANTI JOIN di_final d ON d.height = t.height AND d.id = t.id`,
  );

  await duck.exec(
    `CREATE TABLE pa AS SELECT DISTINCT * FROM (${scratch.parents.select()})`,
  );
  await refuseIfAny(
    duck,
    'parent_conflict',
    'nested bundles are held twice at one place, differently',
    `SELECT id FROM pa GROUP BY id, root_transaction_id, root_parent_offset, "offset"
     HAVING count(*) > 1`,
  );
  await refuseIfAny(
    duck,
    'parent_layout',
    "nested bundles' offsets don't describe one bundle",
    `SELECT id FROM pa WHERE NOT (size > 0 AND data_offset >= "offset"
      AND data_offset <= "offset" + size)`,
  );

  // The keys of the owners of the rows kept, and no others.
  await duck.exec(
    `CREATE TABLE wa AS SELECT DISTINCT * FROM (${scratch.wallets.select()})
     WHERE address IN (SELECT owner_address FROM di_final)`,
  );
  await refuseIfAny(
    duck,
    'wallet_conflict',
    'owners have two keys',
    'SELECT address AS id FROM wa GROUP BY address HAVING count(*) > 1',
  );

  // What the builder checked, for band.json.
  const [summary] = (await duck.all(`
    SELECT
      count(*) FILTER (WHERE "offset" IS NOT NULL) AS located,
      count(*) FILTER (WHERE "offset" IS NOT NULL AND normalised) AS normalised,
      count(*) FILTER (WHERE placement = 'repaired') AS repaired,
      count(*) FILTER (WHERE placement = 'proven') AS proven,
      count(*) FILTER (WHERE "offset" IS NULL AND unlocated_reason = 'ambiguous') AS ambiguous_unlocated
    FROM di_final`)) as Array<Record<string, bigint | number>>;
  const reasons = (await duck.all(`
    SELECT coalesce(unlocated_reason, 'unknown') AS reason, count(*) AS n
    FROM di_final WHERE "offset" IS NULL GROUP BY 1 ORDER BY 1`)) as Array<{
    reason: string;
    n: bigint | number;
  }>;
  const withoutKey = await count(
    duck,
    `SELECT count(DISTINCT owner_address) AS n FROM di_final
     WHERE owner_address NOT IN (SELECT address FROM wa)`,
  );
  const checks = {
    located: Number(summary.located),
    unlocated: Object.fromEntries(reasons.map((r) => [r.reason, Number(r.n)])),
    normalised: Number(summary.normalised),
    repaired: Number(summary.repaired),
    ambiguousProven: Number(summary.proven),
    ambiguousUnlocated: Number(summary.ambiguous_unlocated),
    ownersWithoutKey: withoutKey,
  };

  const sources: Record<string, string> = {
    data_items: 'di_final',
    tags: 'tg',
    parents: 'pa',
    wallets: 'wa',
  };
  const tables: ParquetL2Band['tables'] = {};
  for (const spec of PARQUET_L2_TABLES) {
    const target = path.join(bandDir, spec.file).replace(/'/g, "''");
    await duck.exec(
      `COPY (SELECT ${quoted(spec.columns)} FROM ${sources[spec.name]} ORDER BY ${orderByClause(spec)}) TO '${target}' (FORMAT PARQUET, COMPRESSION 'zstd')`,
    );
    tables[spec.name] = await digestTable(duck, bandDir, spec);
  }
  return { tables, checks, rows };
}

/**
 * Reads a written table back in its order and digests it, as an importer
 * does. Each `wallets` key is checked against its address on the way.
 */
export async function digestTable(
  duck: Database,
  bandDir: string,
  spec: TableSpec,
): Promise<{ rows: number; rowDigest: string }> {
  const file = path.join(bandDir, spec.file).replace(/'/g, "''");
  const digest = new RowDigest(spec.columns);
  const names = spec.columns.map((c) => c.name);
  const stream = await duck.stream(
    `SELECT ${quoted(spec.columns)} FROM read_parquet('${file}') ORDER BY ${orderByClause(spec)}`,
  );
  for await (const row of stream) {
    const values = names.map((n) => (row as Record<string, unknown>)[n]);
    if (spec.name === 'wallets') {
      const [address, key] = values as [Buffer, Buffer];
      if (
        !crypto
          .createHash('sha256')
          .update(Buffer.from(key))
          .digest()
          .equals(Buffer.from(address))
      ) {
        throw new L2CheckError(
          'wallet_hash',
          "an owner's key doesn't hash to its address",
          [toB64Url(Buffer.from(address))],
        );
      }
    }
    digest.add(values);
  }
  return { rows: digest.rows, rowDigest: digest.hex() };
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await fs.readdir(dir)) {
    total += (await fs.stat(path.join(dir, name))).size;
  }
  return total;
}
