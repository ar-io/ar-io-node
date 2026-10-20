/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Exports one height range of an index's selected data items as a
 * `parquet-l2` band (layout in `src/lib/parquet-l2/layout.ts`), checked and
 * ready to publish, in memory that follows a window of the source, never
 * the band: the largest band, 100,000 heights of ArDrive items, holds 69M
 * items and 518M tag rows.
 *
 * - **Windows, in height order.** The source gives a window of heights at a
 *   time (split until it holds at most a bounded number of items). Each
 *   window's items are located (`assemble.ts`) and their roots placed on
 *   the chain (`roots.ts`). An item's height is its root's, so a window's
 *   `data_items` and `tags` rows are every row of its heights, but for
 *   items the source filed under a lower height of the band: those are
 *   held (a bounded number) until their window comes.
 * - **Distinct rows, in order, per window.** A window's rows are kept
 *   distinct (an item the index holds twice at one height collapses once
 *   both copies carry their root's position), an unlocated row of an
 *   (id, root) that also has a located one is dropped, and the rest sorted
 *   by the table's order (`order.ts`). Whatever is left must be one row per
 *   key of the order: two unlocated rows of one item in one root, or two
 *   rows of one place, that still differ refuse the band rather than be
 *   tie-broken. Rows are digested as they are sorted, and appended to the
 *   build's own DuckDB database (a file in the staging directory), which
 *   writes each table's Parquet in that order. No sort of the band.
 * - **`parents` and `wallets`** (a row per nested bundle, per owner) are
 *   gathered in the database too, kept distinct and sorted there.
 * - **Lookups** (`PARQUET_L2_LOOKUPS`) are derived by DuckDB from the
 *   tables' Parquet once it is written, sorted by their keys, under the same
 *   limits and spill.
 * - **DuckDB** runs with a memory limit, a thread count and a spill
 *   directory in the staging directory, capped (`L2DuckLimits`).
 * - **Checks before anything publishes**: every location all set or all
 *   null, the layout arithmetic of every located row, `tag_count` against
 *   the tag rows, every root at its L1 position (against the L1 bands
 *   themselves when those gave the positions), one row per key, every
 *   key's SHA-256 its address; every table read back from its Parquet,
 *   in order, to the digest written; and every lookup read back to its
 *   digest and found to hold exactly the rows its tables give.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Database } from 'duckdb-async';

import { BandSampleEntry, Reservoir } from '../../../lib/index-band/build.js';
import { HEADER_CHECK_POOL_FACTOR } from '../../../lib/index-band/verify.js';
import { toB64Url } from '../../../lib/encoding.js';
import {
  checkParquetDir,
  ParquetStructureError,
} from '../../../lib/parquet/check.js';
import { RowDigest } from '../../../lib/parquet/digest.js';
import type { TableSpec } from '../../../lib/parquet-l1/layout.js';
import {
  BAND_FILE,
  orderByClause,
  canonicalTagNames,
  PARQUET_L2_SCHEMA,
  ParquetL2LookupLayout,
  PARQUET_L2_TABLES,
  ParquetL2Band,
  ParquetL2Selection,
  serializeBandFile,
} from '../../../lib/parquet-l2/layout.js';
import {
  verifyBandLookups,
  writeBandLookups,
} from '../../../lib/parquet-l2/lookups.js';
import { decodeColumn, encodeField } from '../parquet-l1/export.js';
import type { L1PublishedBand } from '../parquet-l1/kind.js';
import type {
  PlacementClass,
  UnlocatedReason,
} from '../root-tx/sources/item-location.js';
import {
  AssembledItem,
  assembleWindow,
  keyCandidate,
  L2Proofs,
} from './assemble.js';
import {
  GatewayReads,
  ReadBudgetError,
  ReadUnavailableError,
} from './gateway-reads.js';
import { rowComparator, rowIdentity } from '../../../lib/parquet-l2/order.js';
import { digestL2Table, L2TableError } from '../../../lib/parquet-l2/tables.js';
import { positionsByRoot, RootResolver, rootResolver } from './roots.js';
import { selectionMatcher } from './selection.js';
import type { L2ItemSource, RootPosition } from './source.js';
import {
  openWalletsDb,
  OWNER_NOTE_COLUMNS,
  OwnerKeyStats,
  OwnerNotes,
  resolveOwnerKeys,
} from './wallets.js';

/**
 * Header-check samples: how many entries to read, general and per placement
 * or normalisation. Each is drawn {@link HEADER_CHECK_POOL_FACTOR} times
 * over, a pool the check walks until that many are read, passing over roots
 * the gateway no longer has.
 */
export const L2_SAMPLE_SIZE = 150;
export const L2_STRATUM_SAMPLE_SIZE = 50;

/**
 * Items held for a later window at most (their root sits above the height
 * the source filed them under); past it the band is refused.
 */
export const MAX_STRAYS = 100_000;

const SAMPLE = 20;

/** The build's DuckDB: memory, threads and spill, all bounded. */
export interface L2DuckLimits {
  /** DuckDB's `memory_limit`, e.g. `2GB`. */
  memoryLimit: string;
  threads: number;
  /** The most it may spill, in GB, into the staging directory. */
  spillMaxGb: number;
}

export const DEFAULT_L2_DUCK_LIMITS: L2DuckLimits = {
  memoryLimit: '2GB',
  threads: 2,
  spillMaxGb: 256,
};

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
  proofs: L2Proofs;
  /** Requests to the gateway, proofs and keys (against INDEX_EXPORT_L2_MAX_READS). */
  reads: number;
  /** Requests answered 404, and reads of those roots answered without asking. */
  readsNotFound: number;
  readsNotFoundRemembered: number;
  /** Requests that ran past their root. */
  readsOutOfRange: number;
  /** Ambiguous items proven by a header whose tag count field is wrong. */
  malformedTags: number;
  owners: OwnerKeyStats;
  /** data_items rows: written by the windows, distinct, kept. */
  rows: { written: number; distinct: number; kept: number };
  /**
   * Located rows by how they were placed, one class each: `proven` (by a
   * header read), `repaired` (relative offsets under a root_parent_offset of
   * 0), `absolute`, `deep`, `nested`, `top`; a row some copy of which was
   * proven or repaired counts there.
   */
  placedBy: Record<PlacementClass, number>;
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
  /** The staging directory once the band is written: its database and the band. */
  stagingBytes: number;
  seconds: number;
}

const tableSpec = (name: string): TableSpec =>
  PARQUET_L2_TABLES.find((t) => t.name === name) as TableSpec;

const DATA_ITEMS = tableSpec('data_items');
const TAGS = tableSpec('tags');
const PARENTS = tableSpec('parents');
const WALLETS = tableSpec('wallets');

const quoted = (columns: Array<{ name: string }>) =>
  columns.map((c) => `"${c.name}"`).join(', ');
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Opens the build's DuckDB: a database file in the staging directory, so
 * the band's rows live on disk rather than in memory, under `limits`, its
 * spill beside it. Insertion order is kept: tables are written in it.
 */
export async function withL2Duck<T>(
  staging: string,
  limits: L2DuckLimits,
  run: (duck: Database) => Promise<T>,
  { inMemory = false }: { inMemory?: boolean } = {},
): Promise<T> {
  const { Database } = await import('duckdb-async');
  const spill = path.join(staging, inMemory ? 'spill-compare' : 'spill');
  const file = path.join(staging, 'build.duckdb');
  await fs.mkdir(spill, { recursive: true });
  const duck = await Database.create(inMemory ? ':memory:' : file);
  try {
    await duck.exec(
      `SET memory_limit = ${sqlString(limits.memoryLimit)}; SET threads = ${limits.threads}; SET preserve_insertion_order = true; SET temp_directory = ${sqlString(spill)}; SET max_temp_directory_size = '${limits.spillMaxGb}GB'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`,
    );
    return await run(duck);
  } finally {
    await duck.close();
    await fs.rm(spill, { recursive: true, force: true });
    if (!inMemory) {
      await fs.rm(file, { force: true });
      await fs.rm(`${file}.wal`, { force: true });
    }
  }
}

/** Lines a scratch file holds in memory before they are appended to it. */
const SCRATCH_CHUNK_LINES = 20_000;

/**
 * One scratch file of hex-encoded rows: lines gathered in memory a chunk at
 * a time (no promise a row), appended to the file, then loaded into a table
 * of the build's database in order.
 */
class Scratch {
  rows = 0;
  private lines: string[] = [];

  constructor(
    readonly file: string,
    readonly columns: Array<{ name: string; type: string }>,
  ) {}

  /** Adds a row; {@link flush} when {@link full}. */
  add(values: unknown[]): void {
    this.lines.push(
      values
        .map((value, i) => encodeField(value, this.columns[i].type))
        .join(','),
    );
    this.rows += 1;
  }

  get full(): boolean {
    return this.lines.length >= SCRATCH_CHUNK_LINES;
  }

  /** Appends the lines held to the file. */
  async flush(): Promise<void> {
    if (this.lines.length === 0) return;
    const text = `${this.lines.join('\n')}\n`;
    this.lines = [];
    await fs.appendFile(this.file, text);
  }

  async close(): Promise<void> {
    this.lines = [];
  }

  /**
   * Appends every row added to `table` in the database, in order, and
   * starts the file again.
   */
  async insertInto(duck: Database, table: string): Promise<void> {
    await this.flush();
    if (this.rows === 0) return;
    const columns = this.columns
      .map((c) => `'${c.name}': 'VARCHAR'`)
      .join(', ');
    const decoded = this.columns
      .map((c) => decodeColumn(c.name, c.type))
      .join(', ');
    await duck.exec(
      `INSERT INTO ${table} SELECT ${decoded} FROM read_csv(${sqlString(this.file)}, header = false, delim = ',', quote = '', escape = '', auto_detect = false, nullstr = '\\N', columns = {${columns}})`,
    );
    this.rows = 0;
    await fs.rm(this.file, { force: true });
  }
}

const createTable = (
  name: string,
  columns: Array<{ name: string; type: string }>,
) =>
  `CREATE TABLE ${name} (${columns.map((c) => `"${c.name}" ${c.type}`).join(', ')})`;

/** A data_items row, in the layout's column order. */
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
  return DATA_ITEMS.columns.map((c) => values[c.name]);
}

const col = (name: string) =>
  DATA_ITEMS.columns.findIndex((c) => c.name === name);
const AT = {
  id: col('id'),
  height: col('height'),
  root: col('root_transaction_id'),
  tagCount: col('tag_count'),
  offset: col('offset'),
};

/** What the band's `checks` count, gathered window by window. */
interface Counts {
  located: number;
  unlocated: Partial<Record<UnlocatedReason, number>>;
  normalised: number;
  repaired: number;
  proven: number;
}

/**
 * A data_items row of a window, with what the checks count of it: of every
 * copy of it the source holds (an item filed twice at one height is one
 * row), how each was placed, so a row any copy of which placePayload
 * repaired counts as repaired whatever another copy said.
 */
interface WindowRow {
  values: unknown[];
  item: AssembledItem;
  reason?: UnlocatedReason;
  placements: Set<PlacementClass>;
  normalised: boolean;
}

/** Located rows by how they were placed, one class each, in this order. */
const PLACEMENT_ORDER: PlacementClass[] = [
  'proven',
  'repaired',
  'absolute',
  'deep',
  'nested',
  'top',
];

const minOf = <T extends string>(a: T | undefined, b: T | undefined) =>
  a === undefined ? b : b === undefined ? a : a < b ? a : b;

const compareItems = rowComparator(DATA_ITEMS);
const compareTags = rowComparator(TAGS);

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
  limits = DEFAULT_L2_DUCK_LIMITS,
  random = Math.random,
  keyTags = [],
  statTags = [],
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
  limits?: L2DuckLimits;
  /** Random source for the header-check sample, in [0, 1). */
  random?: () => number;
  /** The tag names the band's key lookup is derived for (`l2-2`). */
  keyTags?: readonly string[];
  /** The tag names its stats count by (`l2-2`). */
  statTags?: readonly string[];
}): Promise<L2ExportResult> {
  const started = Date.now();
  await fs.mkdir(workDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(workDir, '.band-build-l2-'));
  try {
    const scratchDir = path.join(staging, 'scratch');
    const bandDir = path.join(staging, 'band');
    await fs.mkdir(scratchDir);
    await fs.mkdir(bandDir);
    let stagingBytes = 0;
    const result = await withL2Duck(staging, limits, async (duck) => {
      const built = await build(duck, {
        selection,
        from,
        to,
        source,
        l1Bands,
        walletsDbPath,
        reads,
        scratchDir,
        bandDir,
        random,
        keyTags: canonicalTagNames(keyTags),
        statTags: canonicalTagNames(statTags),
      });
      stagingBytes = await treeBytes(staging);
      return built;
    });
    await fs.rm(scratchDir, { recursive: true, force: true });
    return {
      staging,
      dir: bandDir,
      ...result,
      bandBytes: await treeBytes(bandDir),
      stagingBytes,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    if (error instanceof ReadBudgetError) {
      throw new L2UnavailableError('read_budget', error.message);
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
    random,
    keyTags,
    statTags,
  }: {
    keyTags: string[];
    statTags: string[];
    selection: ParquetL2Selection;
    from: number;
    to: number;
    source: L2ItemSource;
    l1Bands: L1PublishedBand[];
    walletsDbPath?: string;
    reads: GatewayReads;
    scratchDir: string;
    bandDir: string;
    random: () => number;
  },
): Promise<Pick<L2ExportResult, 'band' | 'stats' | 'sample'>> {
  const resolver = rootResolver(duck, l1Bands, source, from, to);
  if (resolver === undefined) {
    throw new L2UnavailableError(
      'no_l1',
      `No L1 data places the roots of heights ${from}-${to}: this publisher's parquet-l1 bands don't cover them, and the source holds no L1 rows`,
    );
  }
  for (const [table, spec] of [
    ['di', DATA_ITEMS],
    ['tg', TAGS],
    ['pa_raw', PARENTS],
    ['wa_raw', WALLETS],
  ] as const) {
    await duck.exec(createTable(table, spec.columns));
  }
  await duck.exec(createTable('owner_notes', OWNER_NOTE_COLUMNS));
  const scratch = {
    items: new Scratch(
      path.join(scratchDir, 'data_items.csv'),
      DATA_ITEMS.columns,
    ),
    tags: new Scratch(path.join(scratchDir, 'tags.csv'), TAGS.columns),
    parents: new Scratch(path.join(scratchDir, 'parents.csv'), PARENTS.columns),
    wallets: new Scratch(path.join(scratchDir, 'wallets.csv'), WALLETS.columns),
    owners: new Scratch(
      path.join(scratchDir, 'owners.csv'),
      OWNER_NOTE_COLUMNS,
    ),
  };
  let walletsDb: ReturnType<typeof openWalletsDb> = undefined;
  try {
    walletsDb = openWalletsDb(walletsDbPath);
    const selected = selectionMatcher(selection);
    const itemsDigest = new RowDigest(DATA_ITEMS.columns);
    const tagsDigest = new RowDigest(TAGS.columns);
    let lastItem: unknown[] | undefined;
    let lastTag: unknown[] | undefined;
    const counts: Counts = {
      located: 0,
      unlocated: {},
      normalised: 0,
      repaired: 0,
      proven: 0,
    };
    const rows = { written: 0, distinct: 0, kept: 0 };
    const placedBy: Record<PlacementClass, number> = {
      top: 0,
      nested: 0,
      repaired: 0,
      absolute: 0,
      deep: 0,
      proven: 0,
    };
    const stats = {
      windows: 0,
      sourceRows: 0,
      rootIsItem: 0,
      movedHeight: 0,
      proofs: { relative: 0, absolute: 0, none: 0, both: 0, unproven: 0 },
    };
    let rejectedKeys = 0;
    const roots = {
      missing: 0,
      missingSample: [] as string[],
      ambiguous: 0,
      ambiguousSample: [] as string[],
      below: 0,
      belowSample: [] as string[],
    };
    const general = new Reservoir<BandSampleEntry>(
      L2_SAMPLE_SIZE * HEADER_CHECK_POOL_FACTOR,
      random,
    );
    const strata = new Map<string, Reservoir<BandSampleEntry>>();
    const offerSample = (
      item: AssembledItem,
      placements: Set<PlacementClass>,
      normalised: boolean,
    ) => {
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
        ...[...placements].filter((p) => p !== 'top' && p !== 'nested'),
        ...(normalised ? ['normalised'] : []),
      ];
      for (const tag of tags) {
        let reservoir = strata.get(tag);
        if (reservoir === undefined) {
          reservoir = new Reservoir(
            L2_STRATUM_SAMPLE_SIZE * HEADER_CHECK_POOL_FACTOR,
            random,
          );
          strata.set(tag, reservoir);
        }
        reservoir.offer(entry(tag));
      }
    };

    /**
     * Writes one window's items, every one at a height of the window: kept
     * distinct, unlocated copies of located items dropped, checked one row
     * per key, sorted, digested, appended.
     */
    const writeWindow = async (
      placed: Array<{ item: AssembledItem; position: RootPosition }>,
    ) => {
      const distinct = new Map<string, WindowRow>();
      for (const { item, position } of placed) {
        const values = dataItemValues(item, position);
        rows.written += 1;
        const k = rowIdentity(values);
        const held = distinct.get(k);
        if (held === undefined) {
          distinct.set(k, {
            values,
            item,
            ...(item.unlocated !== undefined ? { reason: item.unlocated } : {}),
            placements: new Set(
              item.placement !== undefined ? [item.placement] : [],
            ),
            normalised: item.normalised,
          });
          continue;
        }
        const reason = minOf(held.reason, item.unlocated);
        if (reason !== undefined) held.reason = reason;
        if (item.placement !== undefined) held.placements.add(item.placement);
        held.normalised ||= item.normalised;
      }
      rows.distinct += distinct.size;
      const pair = (values: unknown[]) =>
        `${(values[AT.id] as Buffer).toString('latin1')}:${(values[AT.root] as Buffer).toString('latin1')}`;
      const locatedPairs = new Set(
        [...distinct.values()]
          .filter((row) => row.values[AT.offset] !== null)
          .map((row) => pair(row.values)),
      );
      const kept = [...distinct.values()].filter(
        (row) =>
          row.values[AT.offset] !== null || !locatedPairs.has(pair(row.values)),
      );
      kept.sort((a, b) => compareItems(a.values, b.values));
      rows.kept += kept.length;

      // Tags: each item's once per height, one per position.
      const tagRows = new Map<string, unknown[]>();
      const tagCounts = new Map<string, number>();
      const conflicts: string[] = [];
      for (const { item, position } of placed) {
        const itemKey = `${position.height}:${item.id.toString('latin1')}`;
        for (const [index, tag] of item.tags.entries()) {
          const k = `${itemKey}:${index}`;
          const held = tagRows.get(k);
          if (held === undefined) {
            tagRows.set(k, [
              position.height,
              item.id,
              index,
              tag.name,
              tag.value,
            ]);
            tagCounts.set(itemKey, (tagCounts.get(itemKey) ?? 0) + 1);
          } else if (
            !(held[3] as Buffer).equals(tag.name) ||
            !(held[4] as Buffer).equals(tag.value)
          ) {
            conflicts.push(toB64Url(item.id));
          }
        }
      }
      if (conflicts.length > 0) {
        throw new L2CheckError(
          'tag_conflict',
          `${conflicts.length} tags of items differ between their copies at one position`,
          [...new Set(conflicts)].slice(0, SAMPLE),
        );
      }

      // One row per key of the order.
      const unlocatedTwice: string[] = [];
      const placeTwice: string[] = [];
      const badCount: string[] = [];
      for (const [i, row] of kept.entries()) {
        const itemKey = `${row.values[AT.height] as number}:${(row.values[AT.id] as Buffer).toString('latin1')}`;
        if ((tagCounts.get(itemKey) ?? 0) !== row.values[AT.tagCount]) {
          badCount.push(toB64Url(row.values[AT.id] as Buffer));
        }
        if (i > 0 && compareItems(kept[i - 1].values, row.values) === 0) {
          (row.values[AT.offset] === null ? unlocatedTwice : placeTwice).push(
            toB64Url(row.values[AT.id] as Buffer),
          );
        }
      }
      if (unlocatedTwice.length > 0) {
        throw new L2CheckError(
          'unlocated_conflict',
          `${unlocatedTwice.length} items are held unlocated twice in one root, differently`,
          unlocatedTwice.slice(0, SAMPLE),
        );
      }
      if (placeTwice.length > 0) {
        throw new L2CheckError(
          'conflict',
          `${placeTwice.length} items are held twice at one place, differently`,
          placeTwice.slice(0, SAMPLE),
        );
      }
      if (badCount.length > 0) {
        throw new L2CheckError(
          'tag_count',
          `${badCount.length} items' tag_count isn't their number of tags`,
          badCount.slice(0, SAMPLE),
        );
      }

      if (
        kept.length > 0 &&
        lastItem !== undefined &&
        compareItems(lastItem, kept[0].values) >= 0
      ) {
        throw new Error(
          'data_items rows of a window precede the window before it',
        );
      }
      for (const row of kept) {
        itemsDigest.add(row.values);
        scratch.items.add(row.values);
        if (scratch.items.full) await scratch.items.flush();
        if (row.values[AT.offset] !== null) {
          counts.located += 1;
          if (row.normalised) counts.normalised += 1;
          if (row.placements.has('repaired')) counts.repaired += 1;
          if (row.placements.has('proven')) counts.proven += 1;
          const placement = PLACEMENT_ORDER.find((p) => row.placements.has(p));
          if (placement !== undefined) placedBy[placement] += 1;
          offerSample(row.item, row.placements, row.normalised);
        } else {
          const reason = row.reason ?? 'no_offsets';
          counts.unlocated[reason] = (counts.unlocated[reason] ?? 0) + 1;
        }
      }
      if (kept.length > 0) lastItem = kept[kept.length - 1].values;

      const sortedTags = [...tagRows.values()].sort(compareTags);
      if (
        sortedTags.length > 0 &&
        lastTag !== undefined &&
        compareTags(lastTag, sortedTags[0]) >= 0
      ) {
        throw new Error('tags of a window precede the window before it');
      }
      for (const row of sortedTags) {
        tagsDigest.add(row);
        scratch.tags.add(row);
        if (scratch.tags.full) await scratch.tags.flush();
      }
      if (sortedTags.length > 0) lastTag = sortedTags[sortedTags.length - 1];
      await scratch.items.insertInto(duck, 'di');
      await scratch.tags.insertInto(duck, 'tg');
    };

    // Items whose root sits above the window the source filed them under:
    // held, by height, until their window.
    const strays = new Map<
      number,
      Array<{ item: AssembledItem; position: RootPosition }>
    >();
    let strayCount = 0;
    const sample = (list: string[], root: Buffer) => {
      if (list.length < SAMPLE) list.push(toB64Url(root));
    };

    for await (const window of source.windows(from, to, selection)) {
      stats.windows += 1;
      stats.sourceRows += window.items.length;
      const assembled = await assembleWindow(window, {
        selected,
        probe: (root, offset, bytes, id) =>
          reads.headerIs(root, offset, bytes, id),
      });
      const { faults } = assembled;
      if (faults.notSelected.length > 0) {
        throw new L2CheckError(
          'selection_mismatch',
          `The source gave ${faults.notSelected.length} items the selection doesn't take`,
          faults.notSelected.slice(0, SAMPLE),
        );
      }
      if (faults.noRoot.length > 0 || faults.badRow.length > 0) {
        throw new L2CheckError(
          'bad_rows',
          [
            faults.noRoot.length > 0
              ? `${faults.noRoot.length} items without a root id`
              : '',
            faults.badRow.length > 0
              ? `${faults.badRow.length} items without a 32-byte parent id or owner address`
              : '',
          ]
            .filter((s) => s.length > 0)
            .join('; '),
          [...faults.noRoot, ...faults.badRow].slice(0, SAMPLE),
        );
      }
      stats.rootIsItem += assembled.rootIsItem;
      for (const k of [
        'relative',
        'absolute',
        'none',
        'both',
        'unproven',
      ] as const) {
        stats.proofs[k] += assembled.proofs[k];
      }

      // Each root's position: at the window's heights, else anywhere in
      // the band (one lookup for the window's misses).
      const local = positionsByRoot(
        await resolver.lookup(
          assembled.items.map((item) => item.rootTxId),
          window.from,
          window.to,
        ),
      );
      const misses = [
        ...new Set(
          assembled.items
            .map((item) => item.rootTxId.toString('hex'))
            .filter((k) => !local.one.has(k) && !local.ambiguous.has(k)),
        ),
      ];
      const wide =
        misses.length === 0
          ? {
              one: new Map<string, RootPosition>(),
              ambiguous: new Set<string>(),
            }
          : positionsByRoot(
              await resolver.lookup(
                misses.map((k) => Buffer.from(k, 'hex')),
                from,
                to,
              ),
            );
      const placed: Array<{ item: AssembledItem; position: RootPosition }> = [];
      const notes = new OwnerNotes();
      for (const item of assembled.items) {
        notes.note(item.ownerAddress, item.ownerKey, keyCandidate(item));
        const k = item.rootTxId.toString('hex');
        if (local.ambiguous.has(k) || wide.ambiguous.has(k)) {
          roots.ambiguous += 1;
          sample(roots.ambiguousSample, item.rootTxId);
          continue;
        }
        const position = local.one.get(k) ?? wide.one.get(k);
        if (position === undefined) {
          roots.missing += 1;
          sample(roots.missingSample, item.rootTxId);
          continue;
        }
        if (position.height < window.from) {
          // Its window is written already.
          roots.below += 1;
          sample(roots.belowSample, item.id);
          continue;
        }
        if (!local.one.has(k)) stats.movedHeight += 1;
        if (position.height > window.to) {
          strayCount += 1;
          if (strayCount > MAX_STRAYS) {
            throw new L2CheckError(
              'roots',
              `More than ${MAX_STRAYS} items of heights ${from}-${to} have their root above the height the source files them under`,
            );
          }
          const held = strays.get(position.height) ?? [];
          held.push({ item, position });
          strays.set(position.height, held);
          continue;
        }
        placed.push({ item, position });
      }
      for (const [height, held] of strays) {
        if (height > window.to) continue;
        placed.push(...held);
        strayCount -= held.length;
        strays.delete(height);
      }
      rejectedKeys += notes.rejectedKeys;
      for (const row of notes.rows()) scratch.owners.add(row);
      await scratch.owners.insertInto(duck, 'owner_notes');
      for (const parent of assembled.parents) {
        const l = parent.location;
        scratch.parents.add([
          parent.id,
          parent.rootTxId,
          l.rootParentOffset,
          l.offset,
          l.size,
          l.dataOffset,
        ]);
      }
      await scratch.parents.insertInto(duck, 'pa_raw');
      // Once a root fails, the band is refused: what's left is read only
      // to count.
      if (roots.missing + roots.ambiguous + roots.below === 0) {
        await writeWindow(placed);
      }
      // Let the heartbeat and anything else in the process run.
      await setImmediate();
    }
    if (strayCount > 0) {
      throw new Error(`${strayCount} items held for a window that never came`);
    }

    if (roots.missing + roots.ambiguous + roots.below > 0) {
      throw new L2CheckError(
        'roots',
        [
          roots.missing > 0
            ? `${roots.missing} items have a root not in the L1 data (${resolver.via}) at heights ${from}-${to}`
            : '',
          roots.ambiguous > 0
            ? `${roots.ambiguous} items have a root at more than one position`
            : '',
          roots.below > 0
            ? `${roots.below} items have their root below the height the source files them under`
            : '',
        ]
          .filter((s) => s.length > 0)
          .join('; '),
        [
          ...roots.missingSample,
          ...roots.ambiguousSample.map((k) => `${k} (twice)`),
          ...roots.belowSample.map((k) => `${k} (below)`),
        ],
      );
    }

    // Owners' keys, from the notes in the database.
    const keyStats = await resolveOwnerKeys(duck, 'owner_notes', {
      ...(walletsDb !== undefined ? { walletsDb } : {}),
      reads,
      write: async (found) => {
        for (const row of found) scratch.wallets.add(row);
        await scratch.wallets.flush();
      },
    });
    await scratch.wallets.insertInto(duck, 'wa_raw');

    const createdAt = await resolver.bandTime(to);
    if (createdAt === undefined) {
      throw new L2CheckError(
        'block_time',
        `No time for block ${to} in the L1 data (${resolver.via}) to date the band by`,
      );
    }

    const tables = await finishTables(duck, {
      bandDir,
      resolver,
      from,
      to,
      written: {
        data_items: { rows: itemsDigest.rows, rowDigest: itemsDigest.hex() },
        tags: { rows: tagsDigest.rows, rowDigest: tagsDigest.hex() },
      },
    });
    // Derived from the tables just written, and checked against them before
    // anything publishes: a lookup that disagrees is this build's fault,
    // not the rows'.
    const layout: ParquetL2LookupLayout = {
      schema: PARQUET_L2_SCHEMA,
      keyTags,
      statTags,
    };
    const lookups = await writeBandLookups(duck, bandDir, { layout });
    const lookupProblems = await verifyBandLookups(duck, bandDir, {
      ...layout,
      lookups,
    });
    if (lookupProblems.length > 0) {
      throw new Error(
        `The band's lookups don't match its tables: ${lookupProblems.join('; ')}`,
      );
    }
    const band: ParquetL2Band = {
      version: 1,
      schema: PARQUET_L2_SCHEMA,
      heightRange: [from, to],
      selection,
      keyTags,
      statTags,
      tables: tables.tables,
      lookups,
      checks: {
        located: counts.located,
        // What the rows and the source determine: an ambiguous item left
        // unlocated because its root was gone (`unproven`) is the row an
        // unresolved ambiguous one is, so both count as `ambiguous` here;
        // the gateway's part is the publisher's own (`.publisher.json`).
        unlocated: ambiguousFolded(counts.unlocated),
        normalised: counts.normalised,
        repaired: counts.repaired,
        ambiguousProven: counts.proven,
        ambiguousUnlocated:
          (counts.unlocated.ambiguous ?? 0) + (counts.unlocated.unproven ?? 0),
        ownersWithoutKey: tables.ownersWithoutKey,
      },
      createdAt,
    };
    // Refuse to publish a band whose files every subscriber would refuse.
    await checkParquetDir(bandDir).catch((error: unknown) => {
      // A footer subscribers refuse rejects the band; an I/O error is retried.
      if (error instanceof ParquetStructureError) {
        throw new L2CheckError('footer', error.message);
      }
      throw error;
    });
    await fs.writeFile(path.join(bandDir, BAND_FILE), serializeBandFile(band));
    const sampled = [
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
      sample: sampled,
      stats: {
        roots: resolver.via,
        ...stats,
        reads: reads.reads,
        readsNotFound: reads.notFound,
        readsNotFoundRemembered: reads.notFoundRemembered,
        readsOutOfRange: reads.outOfRange,
        malformedTags: reads.malformedTags,
        owners: { ...keyStats, rejectedKeys },
        rows,
        placedBy,
      },
    };
  } finally {
    walletsDb?.close();
    for (const file of Object.values(scratch)) {
      await file.close().catch(() => undefined);
    }
  }
}

async function count(duck: Database, sql: string): Promise<number> {
  const [row] = (await duck.all(sql)) as Array<{ n: bigint | number }>;
  return Number(row?.n ?? 0);
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
  const rows = (await duck.all(`${sql} LIMIT ${SAMPLE}`)) as Array<{
    id: Buffer;
  }>;
  throw new L2CheckError(
    reason,
    `${n} ${what}`,
    rows.map((row) => toB64Url(Buffer.from(row.id))),
  );
}

/**
 * Writes each table's Parquet: `data_items` and `tags` as appended (in
 * order already), `parents` and `wallets` distinct and sorted. Then checks
 * what only the whole band shows, and reads every table back for its
 * digest.
 */
async function finishTables(
  duck: Database,
  {
    bandDir,
    resolver,
    from,
    to,
    written,
  }: {
    bandDir: string;
    resolver: RootResolver;
    from: number;
    to: number;
    /** The digests of `data_items` and `tags` as they were appended. */
    written: ParquetL2Band['tables'];
  },
): Promise<{ tables: ParquetL2Band['tables']; ownersWithoutKey: number }> {
  if (resolver.blockTransactionFiles !== undefined) {
    const files = `[${resolver.blockTransactionFiles.map(sqlString).join(', ')}]`;
    await refuseIfAny(
      duck,
      'roots',
      'roots are not at their L1 position',
      `SELECT d.root_transaction_id AS id FROM (
         SELECT DISTINCT root_transaction_id, height, block_transaction_index
         FROM di) d
       ANTI JOIN (
         SELECT transaction_id, height, block_transaction_index
         FROM read_parquet(${files}) WHERE height BETWEEN ${from} AND ${to}) l
       ON l.transaction_id = d.root_transaction_id AND l.height = d.height
         AND l.block_transaction_index = d.block_transaction_index`,
    );
  }

  await duck.exec('CREATE TABLE pa AS SELECT DISTINCT * FROM pa_raw');
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
  await duck.exec(`
    CREATE TABLE wa AS SELECT DISTINCT w.* FROM wa_raw w
    SEMI JOIN (SELECT DISTINCT owner_address FROM di) d
      ON d.owner_address = w.address`);
  await refuseIfAny(
    duck,
    'wallet_conflict',
    'owners have two keys',
    'SELECT address AS id FROM wa GROUP BY address HAVING count(*) > 1',
  );
  const ownersWithoutKey = await count(
    duck,
    `SELECT count(*) AS n FROM (SELECT DISTINCT owner_address FROM di) d
     ANTI JOIN wa ON wa.address = d.owner_address`,
  );

  const sources: Record<string, string> = {
    data_items: 'di',
    tags: 'tg',
    parents: 'pa',
    wallets: 'wa',
  };
  const tables: ParquetL2Band['tables'] = {};
  for (const spec of PARQUET_L2_TABLES) {
    const target = sqlString(path.join(bandDir, spec.file));
    const appended = written[spec.name];
    // Appended in order already: written as they are, never sorted again.
    await duck.exec(
      `COPY (SELECT ${quoted(spec.columns)} FROM ${sources[spec.name]}${appended !== undefined ? '' : ` ORDER BY ${orderByClause(spec)}`}) TO ${target} (FORMAT PARQUET, COMPRESSION 'zstd')`,
    );
    await duck.exec(`DROP TABLE ${sources[spec.name]}`);
    const read = await digestTable(duck, bandDir, spec, {
      inFileOrder: appended !== undefined,
    });
    if (
      appended !== undefined &&
      (read.rows !== appended.rows || read.rowDigest !== appended.rowDigest)
    ) {
      throw new Error(
        `${spec.file} reads back ${read.rows} rows (${read.rowDigest}), not the ${appended.rows} written (${appended.rowDigest})`,
      );
    }
    tables[spec.name] = read;
  }
  return { tables, ownersWithoutKey };
}

/**
 * Reads a written table back and digests it, as an importer does: in its
 * order, every row after the one before it (in file order for a table
 * written in order, so none is sorted again). Each `wallets` key is checked
 * against its address on the way.
 */
export async function digestTable(
  duck: Database,
  bandDir: string,
  spec: TableSpec,
  options: { inFileOrder?: boolean } = {},
): Promise<{ rows: number; rowDigest: string }> {
  try {
    return await digestL2Table(duck, bandDir, spec, options);
  } catch (error) {
    if (error instanceof L2TableError) {
      throw new L2CheckError(error.reason, error.message, error.details);
    }
    throw error;
  }
}

/** Unlocated counts with `unproven` counted as `ambiguous`. */
function ambiguousFolded(
  unlocated: Partial<Record<UnlocatedReason, number>>,
): Partial<Record<UnlocatedReason, number>> {
  const { unproven, ...rest } = unlocated;
  if (unproven === undefined || unproven === 0) return rest;
  return { ...rest, ambiguous: (rest.ambiguous ?? 0) + unproven };
}

/** Bytes under a directory, every level. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => [])) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(at);
    else total += (await fs.stat(at).catch(() => undefined))?.size ?? 0;
  }
  return total;
}
