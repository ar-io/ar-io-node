/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as EventEmitter from 'node:events';
import * as winston from 'winston';
import { ClickHouseClient } from '@clickhouse/client';

import * as events from '../events.js';
import { fromB64Url } from '../lib/encoding.js';
import { currentUnixTimestamp } from '../lib/time.js';
import {
  isContentTypeTag,
  ownerToAddress,
} from '../database/standalone-sqlite.js';
import {
  B64uTag,
  NormalizedDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

// Number of recent heights kept in the in-memory block-context map. Sized
// to cover the streamer's TTL window comfortably (4h ≈ 240 blocks at
// ~1 block/min). Cheap to keep generous — each entry is one block's
// metadata plus its tx-id list.
const BLOCK_CONTEXT_RETENTION_HEIGHTS = 480;

// Streaming-pipeline ClickHouse table names. Both must exist in the
// configured database — `validateSchema` checks this at startup and the
// INSERT/DELETE paths reference these constants so a rename only needs
// to land here.
const TABLE_NEW_BLOCKS = 'new_blocks';
const TABLE_NEW_TRANSACTIONS = 'new_transactions';

interface BlockContext {
  height: number;
  indep_hash: string;
  timestamp: number;
  previous_block: string;
  // L1-tx-id → block_transaction_index. Built once at BLOCK_INDEXED time
  // so per-tx lookups in handleBlockTxIndexed are O(1) instead of an
  // O(N) `indexOf` (which makes a full BLOCK_TX_INDEXED sweep O(N²) in
  // the number of L1 txs in the block).
  txIndexById: Map<string, number>;
}

interface TxContext {
  height: number;
  blockTransactionIndex: number;
}

interface NewBlockRow {
  height: number;
  indep_hash: Buffer;
  inserted_at: number;
}

// Mirrors the column order in `new_transactions` so row construction and
// the INSERT column list stay in lockstep. Binary fields are Buffer or
// null; numeric / string fields are typed as themselves.
//
// `inserted_at` MUST be written explicitly (not relying on a CH default)
// because the table's TTL is keyed off it as `inserted_at + INTERVAL N
// MINUTE`. A missing inserted_at defaults to epoch 0, which makes the
// row immediately TTL-expired and silently dropped on the next merge.
interface NewTransactionRow {
  height: number;
  block_transaction_index: number;
  is_data_item: boolean;
  id: Buffer;
  anchor: Buffer;
  owner_address: Buffer | null;
  target: Buffer | null;
  quantity: string; // Decimal(20,0) as string
  reward: string;
  data_size: string;
  content_type: string | null;
  format: number;
  data_root: Buffer | null;
  parent_id: Buffer | null;
  block_indep_hash: Buffer | null;
  block_timestamp: number | null;
  block_previous_block: Buffer | null;
  indexed_at: number;
  inserted_at: number; // anchors TTL — must be set, not defaulted
  owner: Buffer | null;
  signature: Buffer | null;
  signature_type: number | null;
  root_transaction_id: Buffer | null;
  root_parent_offset: number | null;
  tags: Array<[Buffer, Buffer]>;
  tags_count: number;
}

/**
 * Column list for `INSERT INTO new_transactions` — the order MUST
 * match {@link NewTransactionRow} field order and the order produced
 * by {@link rowValuesLiteral}, since the SQL is positional.
 *
 * `inserted_at` MUST be present here — without it CH defaults the
 * column to epoch 0 and the table's `inserted_at + INTERVAL N MINUTE`
 * TTL drops every row on the next merge. Exported so tests can assert
 * the coupling stays intact.
 */
export const NEW_TRANSACTION_COLUMNS = [
  'height',
  'block_transaction_index',
  'is_data_item',
  'id',
  'anchor',
  'owner_address',
  'target',
  'quantity',
  'reward',
  'data_size',
  'content_type',
  'format',
  'data_root',
  'parent_id',
  'block_indep_hash',
  'block_timestamp',
  'block_previous_block',
  'indexed_at',
  'inserted_at',
  'owner',
  'signature',
  'signature_type',
  'root_transaction_id',
  'root_parent_offset',
  'tags',
  'tags_count',
];

// Render a value as a SQL literal suitable for embedding inside an
// `INSERT ... VALUES (...)` clause. Buffers are emitted as
// `unhex('<hex>')` so binary data is preserved without depending on
// JSONEachRow's BLOB handling. The escaping for strings is the
// minimal set required (single quote, backslash) — values come from
// indexed payloads, not user-supplied SQL.
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `unhex('${value.toString('hex')}')`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(sqlLiteral).join(', ')}]`;
  }
  throw new Error(`sqlLiteral: unsupported value type: ${typeof value}`);
}

function tagTupleLiteral(tag: [Buffer, Buffer]): string {
  return `(${sqlLiteral(tag[0])}, ${sqlLiteral(tag[1])})`;
}

function tagsArrayLiteral(tags: Array<[Buffer, Buffer]>): string {
  return `[${tags.map(tagTupleLiteral).join(', ')}]`;
}

function rowValuesLiteral(row: NewTransactionRow): string {
  return [
    row.height,
    row.block_transaction_index,
    row.is_data_item,
    row.id,
    row.anchor,
    row.owner_address,
    row.target,
    row.quantity,
    row.reward,
    row.data_size,
    row.content_type,
    row.format,
    row.data_root,
    row.parent_id,
    row.block_indep_hash,
    row.block_timestamp,
    row.block_previous_block,
    row.indexed_at,
    row.inserted_at,
    row.owner,
    row.signature,
    row.signature_type,
    row.root_transaction_id,
    row.root_parent_offset,
  ]
    .map(sqlLiteral)
    .concat([tagsArrayLiteral(row.tags), sqlLiteral(row.tags_count)])
    .join(', ');
}

function blockRowValuesLiteral(row: NewBlockRow): string {
  return [row.height, row.indep_hash, row.inserted_at]
    .map(sqlLiteral)
    .join(', ');
}

// Single pass over a data item's or L1 tx's tags: emits the
// `Array(Tuple(BLOB, BLOB))` pair list that `new_transactions.tags`
// expects, and pulls out the first Content-Type tag value (the schema
// stores it denormalized into its own column for fast filtering).
// `fallbackContentType` is the data-item-only escape hatch: when an
// item has no Content-Type tag but the indexer sniffed one from the
// payload, we promote that into the column so it's never blank.
function parseTagsAndContentType(
  tags: B64uTag[],
  fallbackContentType?: string,
): { tagPairs: Array<[Buffer, Buffer]>; contentType: string | null } {
  let contentType: string | null = null;
  const tagPairs: Array<[Buffer, Buffer]> = [];
  for (const tag of tags) {
    const name = fromB64Url(tag.name);
    const value = fromB64Url(tag.value);
    if (contentType === null && isContentTypeTag(name)) {
      contentType = value.toString('utf8');
    }
    tagPairs.push([name, value]);
  }
  if (contentType === null && fallbackContentType !== undefined) {
    contentType = fallbackContentType;
  }
  return { tagPairs, contentType };
}

// Fields that the row inherits unmodified from its containing block
// (L1 txs and data items both denormalize block context onto every
// `new_transactions` row). Centralizing them here means a future
// block-derived column only needs a single edit; the two row builders
// spread the result into their full row shape. `indexed_at` and
// `inserted_at` are taken from the same `now` so they're equal per
// row (the TTL is keyed off `inserted_at`).
function buildBlockDerivedFields(block: BlockContext): {
  block_indep_hash: Buffer;
  block_timestamp: number;
  block_previous_block: Buffer | null;
  indexed_at: number;
  inserted_at: number;
} {
  const now = currentUnixTimestamp();
  return {
    block_indep_hash: fromB64Url(block.indep_hash),
    block_timestamp: block.timestamp,
    block_previous_block:
      block.previous_block !== '' ? fromB64Url(block.previous_block) : null,
    indexed_at: now,
    inserted_at: now,
  };
}

/**
 * Streams the indexer's unstable head (~18 confirmations of recent
 * blocks, transactions, and ANS-104 data items) into ClickHouse
 * `new_blocks` / `new_transactions` so CH becomes a complete read
 * store. Sits alongside — not in place of — the existing Parquet
 * pipeline: stable rows still land in `transactions` via
 * parquet-export, the unstable copy ages out via TTL once a row
 * stabilizes.
 *
 * Subscribes to:
 * - `BLOCK_INDEXED` — caches block context for the L1-tx handlers
 *   that fire next on the same event-loop tick, and buffers a
 *   `new_blocks` row.
 * - `BLOCK_TX_INDEXED` — buffers a `new_transactions` row with
 *   `is_data_item=false`, denormalizing block fields from the
 *   matching `BLOCK_INDEXED`. Caches `tx.id → { height,
 *   blockTransactionIndex }` so child data items can resolve their
 *   parent's row context later.
 * - `ANS104_DATA_ITEM_INDEXED` — buffers a `new_transactions` row
 *   with `is_data_item=true`, inheriting `block_transaction_index`
 *   from its parent L1 transaction (looked up in the in-memory
 *   cache). Skips if parent isn't cached (cold-start gap, intentional
 *   trade-off — those rows land via the stable pipeline once they
 *   stabilize).
 * - `CHAIN_REORG` — issues a bounded `ALTER TABLE new_blocks DELETE`
 *   and evicts in-memory state. Orphan `new_transactions` rows are
 *   filtered at query time by the `(height, block_indep_hash)` join
 *   and age out via TTL — no DELETE needed there.
 *
 * Buffering is size-triggered (`CLICKHOUSE_STREAMER_BATCH_SIZE`) or
 * time-triggered (`CLICKHOUSE_STREAMER_FLUSH_INTERVAL_MS`). A
 * single-flight flush serializes overlapping triggers. The buffer is
 * bounded (`CLICKHOUSE_STREAMER_QUEUE_MAX_SIZE`); on overflow the
 * streamer drops oldest rows with a warning — those rows still land
 * via the stable Parquet pipeline.
 *
 * Streaming is best-effort by design: ClickHouse availability is not
 * required for indexing to make progress. Flush errors are logged
 * and swallowed; the rows for that batch are dropped, since retrying
 * could amplify load during a CH outage.
 *
 * See `clickhouse-pipeline.md` and PR #699 for the design rationale.
 */
export class ClickHouseStreamer {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private clickhouseClient: ClickHouseClient;

  // Config
  private batchSize: number;
  private flushIntervalMs: number;
  private maxQueueSize: number;

  // Listener registry — kept for clean removal on stop().
  private listenerReferences: Map<string, (data: any) => void | Promise<void>>;

  // Buffers awaiting flush.
  private blockBuffer: NewBlockRow[] = [];
  private txBuffer: NewTransactionRow[] = [];

  // Block-context map, populated from BLOCK_INDEXED. Used for data-item
  // lookups (which fire asynchronously, much later than block import).
  private blocksByHeight = new Map<number, BlockContext>();

  // Height of the most recent BLOCK_INDEXED — populated synchronously
  // and consumed by the BLOCK_TX_INDEXED handler that fires immediately
  // after on the same event-loop tick (see block-importer.ts:160-164).
  // The full `BlockContext` lives in `blocksByHeight`; storing only the
  // height here means reorg + eviction paths have a single source of
  // truth to keep in sync. Cleared (set to null) on reorg if the current
  // tip is no longer valid.
  private currentBlockHeight: number | null = null;

  // L1-tx-id → { height, blockTransactionIndex }, populated from
  // BLOCK_TX_INDEXED. Consumed by ANS104_DATA_ITEM_INDEXED to denormalize
  // the parent tx's height + position onto the data item's row.
  private txContextsById = new Map<string, TxContext>();

  // Flush coordination.
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;

  private running = false;

  constructor({
    log,
    eventEmitter,
    clickhouseClient,
    batchSize,
    flushIntervalMs,
    maxQueueSize,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    clickhouseClient: ClickHouseClient;
    batchSize: number;
    flushIntervalMs: number;
    maxQueueSize: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.eventEmitter = eventEmitter;
    this.clickhouseClient = clickhouseClient;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.maxQueueSize = maxQueueSize;
    this.listenerReferences = new Map();
  }

  /**
   * Validates that `new_blocks` and `new_transactions` exist in the
   * configured CH database, then registers event listeners and starts
   * the flush timer. Fails closed (throws) if the tables are missing
   * — operators run `scripts/clickhouse-import` once to bootstrap.
   * Called from `app.ts` after `START_WRITERS`-gated workers so a
   * schema mismatch surfaces as a startup error rather than failing
   * silently in the background.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log.warn('ClickHouseStreamer start() called while already running.');
      return;
    }
    await this.validateSchema();
    this.registerListeners();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive solely on the timer.
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
    this.running = true;
    this.log.info('ClickHouseStreamer started.');
  }

  /**
   * Graceful shutdown: stops the flush timer, removes event listeners,
   * waits for any in-flight flush to drain, and issues one final
   * flush so buffered rows aren't lost. Idempotent — calling stop()
   * on an already-stopped streamer is a no-op. Registered as a
   * cleanup handler in `system.ts`.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    for (const [event, listener] of this.listenerReferences) {
      this.eventEmitter.removeListener(event, listener);
    }
    this.listenerReferences.clear();

    // Wait for any in-flight flush, then issue one final flush so a
    // graceful shutdown doesn't drop buffered rows.
    if (this.flushInFlight !== null) {
      await this.flushInFlight.catch(() => {});
    }
    await this.flush();

    this.log.info('ClickHouseStreamer stopped.');
  }

  /**
   * Combined depth of pending block and transaction buffers. Surfaced
   * as the `clickhouseStreamer` Prometheus queue-length gauge so
   * operators can spot CH-side back-pressure or sustained outages
   * (queue grows toward `maxQueueSize`, then drops oldest).
   */
  queueDepth(): number {
    return this.blockBuffer.length + this.txBuffer.length;
  }

  // Fail closed at startup if either table is missing. The streamer is
  // not the schema authority; pointing the operator at clickhouse-import
  // is more diagnosable than column-mismatch errors on the first INSERT.
  private async validateSchema(): Promise<void> {
    const required = [TABLE_NEW_BLOCKS, TABLE_NEW_TRANSACTIONS];
    const result = await this.clickhouseClient.query({
      query:
        'SELECT name FROM system.tables ' +
        'WHERE database = currentDatabase() ' +
        `AND name IN (${required.map((t) => `'${t}'`).join(', ')})`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json<{ name: string }>()) as { name: string }[];
    const present = new Set(rows.map((r) => r.name));
    const missing = required.filter((t) => !present.has(t));
    if (missing.length > 0) {
      throw new Error(
        `ClickHouseStreamer cannot start: required table(s) missing in ` +
          `current database: ${missing.join(', ')}. Run scripts/clickhouse-import ` +
          `once to create them.`,
      );
    }
  }

  private registerListeners(): void {
    const onBlock = (block: PartialJsonBlock) => this.handleBlockIndexed(block);
    const onBlockTx = (tx: PartialJsonTransaction) =>
      this.handleBlockTxIndexed(tx);
    const onDataItem = (item: NormalizedDataItem) =>
      this.handleDataItemIndexed(item);
    const onReorg = (payload: { forkHeight: number }) =>
      void this.handleReorg(payload);

    this.eventEmitter.on(events.BLOCK_INDEXED, onBlock);
    this.eventEmitter.on(events.BLOCK_TX_INDEXED, onBlockTx);
    this.eventEmitter.on(events.ANS104_DATA_ITEM_INDEXED, onDataItem);
    this.eventEmitter.on(events.CHAIN_REORG, onReorg);

    this.listenerReferences.set(events.BLOCK_INDEXED, onBlock);
    this.listenerReferences.set(events.BLOCK_TX_INDEXED, onBlockTx);
    this.listenerReferences.set(events.ANS104_DATA_ITEM_INDEXED, onDataItem);
    this.listenerReferences.set(events.CHAIN_REORG, onReorg);
  }

  private handleBlockIndexed(block: PartialJsonBlock): void {
    const txIndexById = new Map<string, number>();
    for (let i = 0; i < block.txs.length; i++) {
      txIndexById.set(block.txs[i], i);
    }
    const ctx: BlockContext = {
      height: block.height,
      indep_hash: block.indep_hash,
      timestamp: block.timestamp,
      previous_block: block.previous_block ?? '',
      txIndexById,
    };
    this.blocksByHeight.set(block.height, ctx);
    this.currentBlockHeight = block.height;
    this.evictOldBlockContexts(block.height);

    this.blockBuffer.push({
      height: block.height,
      indep_hash: fromB64Url(block.indep_hash),
      inserted_at: currentUnixTimestamp(),
    });
    this.enforceQueueCapAndMaybeFlush();
  }

  private handleBlockTxIndexed(tx: PartialJsonTransaction): void {
    if (this.currentBlockHeight === null) {
      // BLOCK_TX_INDEXED before any BLOCK_INDEXED — only happens on
      // restart while the current block's indexing is mid-flight, or
      // after a reorg cleared currentBlockHeight. Skip; the row will
      // land via the stable pipeline.
      return;
    }
    const currentBlock = this.blocksByHeight.get(this.currentBlockHeight);
    if (currentBlock === undefined) {
      // Would only happen if eviction ran between currentBlockHeight
      // being set and a tx event firing — not possible on the current
      // event-loop ordering, but guard rather than crash.
      this.log.warn('BLOCK_TX_INDEXED: currentBlockHeight not in cache', {
        txId: tx.id,
        currentBlockHeight: this.currentBlockHeight,
      });
      return;
    }
    const blockTxIndex = currentBlock.txIndexById.get(tx.id);
    if (blockTxIndex === undefined) {
      // tx wasn't in the most recent block's txs[] — block-importer
      // emit ordering says this shouldn't happen, but skip rather
      // than write a row with a wrong index.
      this.log.warn('BLOCK_TX_INDEXED tx not found in currentBlock.txs', {
        txId: tx.id,
        currentHeight: currentBlock.height,
      });
      return;
    }

    this.txContextsById.set(tx.id, {
      height: currentBlock.height,
      blockTransactionIndex: blockTxIndex,
    });

    this.txBuffer.push(this.buildL1TxRow(tx, currentBlock, blockTxIndex));
    this.enforceQueueCapAndMaybeFlush();
  }

  private handleDataItemIndexed(item: NormalizedDataItem): void {
    if (item.root_tx_id === null || item.root_tx_id === undefined) {
      // Optimistic data items (admin-API uploads, `routes/ar-io.ts`)
      // emit ANS104_DATA_ITEM_INDEXED with `root_tx_id=null`. Once the
      // bundle is mined and unbundled, `lib/ans-104.ts` emits
      // ANS104_DATA_ITEM_MATCHED → `system.ts` re-queues the same
      // item through `data-item-indexer`, which re-emits
      // ANS104_DATA_ITEM_INDEXED with `root_tx_id` set. So skipping
      // here is correct — we'll get a second event with the full
      // shape. Until then the row only lives in SQLite; queries fall
      // through to the SQLite leg.
      return;
    }
    const txCtx = this.txContextsById.get(item.root_tx_id);
    if (txCtx === undefined) {
      // Cold-start gap: the bundle's L1 tx was indexed before the
      // streamer started, or the cache evicted it. The row will land
      // via the stable pipeline; we accept the brief unstable-head
      // gap rather than synchronously querying SQLite per data item.
      this.log.debug('Data item root_tx_id not in cache; skipping', {
        id: item.id,
        rootTxId: item.root_tx_id,
      });
      return;
    }
    const blockCtx = this.blocksByHeight.get(txCtx.height);
    if (blockCtx === undefined) {
      this.log.debug('Data item block context not in cache; skipping', {
        id: item.id,
        height: txCtx.height,
      });
      return;
    }

    this.txBuffer.push(this.buildDataItemRow(item, blockCtx, txCtx));
    this.enforceQueueCapAndMaybeFlush();
  }

  private async handleReorg({
    forkHeight,
  }: {
    forkHeight: number;
  }): Promise<void> {
    // Step 1: drain any in-flight flush. Without this, a flush started
    // before the reorg signal can INSERT pre-fork rows AFTER our DELETE
    // runs (network ordering at CH, plus they're concurrent HTTP calls),
    // leaving orphan `new_blocks` rows past the fork until TTL drops
    // them ~4h later.
    if (this.flushInFlight !== null) {
      await this.flushInFlight.catch(() => {});
    }

    // Step 2: evict in-memory state past the fork BEFORE issuing the
    // DELETE. The DELETE is async; if a timer-triggered flush fires
    // between this synchronous block and the DELETE returning, we want
    // it to operate on a clean buffer. New event handlers (the next
    // BLOCK_INDEXED from the recursive re-import) re-populate from the
    // new chain.
    for (const h of Array.from(this.blocksByHeight.keys())) {
      if (h > forkHeight) this.blocksByHeight.delete(h);
    }
    for (const [txId, ctx] of Array.from(this.txContextsById.entries())) {
      if (ctx.height > forkHeight) this.txContextsById.delete(txId);
    }
    if (
      this.currentBlockHeight !== null &&
      this.currentBlockHeight > forkHeight
    ) {
      this.currentBlockHeight = null;
    }
    this.blockBuffer = this.blockBuffer.filter((r) => r.height <= forkHeight);
    this.txBuffer = this.txBuffer.filter((r) => r.height <= forkHeight);

    // Step 3: bounded DELETE on new_blocks. Orphan rows in
    // new_transactions are filtered out at query time by the
    // (height, block_indep_hash) join and age out via TTL — no DELETE
    // needed there.
    try {
      await this.clickhouseClient.command({
        query: `ALTER TABLE ${TABLE_NEW_BLOCKS} DELETE WHERE height > ${forkHeight}`,
      });
    } catch (err: any) {
      this.log.error(
        'CHAIN_REORG: failed to prune new_blocks; the orphan join keeps ' +
          'query results correct, but the unstable head retains stale block ' +
          'rows until the next successful prune or TTL expiry.',
        { forkHeight, message: err?.message },
      );
    }
  }

  private evictOldBlockContexts(currentHeight: number): void {
    const cutoff = currentHeight - BLOCK_CONTEXT_RETENTION_HEIGHTS;
    if (cutoff <= 0) return;
    for (const h of Array.from(this.blocksByHeight.keys())) {
      if (h < cutoff) this.blocksByHeight.delete(h);
    }
    for (const [txId, ctx] of Array.from(this.txContextsById.entries())) {
      if (ctx.height < cutoff) this.txContextsById.delete(txId);
    }
  }

  private buildL1TxRow(
    tx: PartialJsonTransaction,
    block: BlockContext,
    blockTxIndex: number,
  ): NewTransactionRow {
    const { tagPairs, contentType } = parseTagsAndContentType(tx.tags);
    const ownerBuf = fromB64Url(tx.owner);
    return {
      ...buildBlockDerivedFields(block),
      height: block.height,
      block_transaction_index: blockTxIndex,
      is_data_item: false,
      id: fromB64Url(tx.id),
      anchor: fromB64Url(tx.last_tx),
      owner_address: ownerToAddress(ownerBuf),
      target: tx.target !== '' ? fromB64Url(tx.target) : null,
      quantity: tx.quantity,
      reward: tx.reward,
      data_size: tx.data_size,
      content_type: contentType,
      format: tx.format,
      data_root: tx.data_root !== '' ? fromB64Url(tx.data_root) : null,
      parent_id: null,
      owner: ownerBuf,
      signature: tx.signature !== null ? fromB64Url(tx.signature) : null,
      signature_type: null,
      root_transaction_id: fromB64Url(tx.id),
      root_parent_offset: null,
      tags: tagPairs,
      tags_count: tx.tags.length,
    };
  }

  private buildDataItemRow(
    item: NormalizedDataItem,
    block: BlockContext,
    txCtx: TxContext,
  ): NewTransactionRow {
    const { tagPairs, contentType } = parseTagsAndContentType(
      item.tags,
      item.content_type,
    );
    return {
      ...buildBlockDerivedFields(block),
      // Data items inherit their parent L1 tx's height and
      // block_transaction_index (matches how the stable Parquet path
      // projects them into `transactions`).
      height: txCtx.height,
      block_transaction_index: txCtx.blockTransactionIndex,
      is_data_item: true,
      id: fromB64Url(item.id),
      anchor: fromB64Url(item.anchor),
      owner_address: fromB64Url(item.owner_address),
      target: item.target ? fromB64Url(item.target) : null,
      // Data items have no quantity/reward; mirror the stable
      // pipeline's NULL for these.
      quantity: '0',
      reward: '0',
      data_size: String(item.data_size),
      content_type: contentType,
      // Format is L1-only (1 or 2). Matching the stable pipeline,
      // data items get 0 here — `format UInt8 NOT NULL` doesn't
      // accept NULL.
      format: 0,
      data_root: null,
      parent_id:
        item.parent_id !== null && item.parent_id !== ''
          ? fromB64Url(item.parent_id)
          : null,
      owner: fromB64Url(item.owner),
      signature: item.signature !== null ? fromB64Url(item.signature) : null,
      signature_type: item.signature_type ?? null,
      root_transaction_id:
        item.root_tx_id !== null && item.root_tx_id !== ''
          ? fromB64Url(item.root_tx_id)
          : null,
      root_parent_offset: item.root_parent_offset ?? null,
      tags: tagPairs,
      tags_count: item.tags.length,
    };
  }

  private enforceQueueCapAndMaybeFlush(): void {
    // Bounded buffers: drop oldest on overflow. Drops are intentional —
    // streaming is best-effort and the stable Parquet pipeline is the
    // backstop. Dropped rows will appear once they stabilize. Block
    // volume is ~1/min so the block buffer overflow is mostly a
    // backstop for symmetry, but if CH is down for hours we'd rather
    // bound both than only one.
    if (this.txBuffer.length > this.maxQueueSize) {
      const drop = this.txBuffer.length - this.maxQueueSize;
      this.txBuffer.splice(0, drop);
      this.log.warn('Streamer tx buffer over cap; dropped oldest rows', {
        droppedRows: drop,
        bufferSize: this.txBuffer.length,
        maxQueueSize: this.maxQueueSize,
      });
    }
    if (this.blockBuffer.length > this.maxQueueSize) {
      const drop = this.blockBuffer.length - this.maxQueueSize;
      this.blockBuffer.splice(0, drop);
      this.log.warn('Streamer block buffer over cap; dropped oldest rows', {
        droppedRows: drop,
        bufferSize: this.blockBuffer.length,
        maxQueueSize: this.maxQueueSize,
      });
    }
    if (this.txBuffer.length + this.blockBuffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  // Single-flight flush: serializes overlapping calls so a slow CH
  // INSERT doesn't pile up multiple in-flight requests. Errors are
  // logged + swallowed (best-effort streaming); buffered rows in the
  // failed batch are dropped, since retrying could amplify load
  // during a CH outage and the stable pipeline will land them later.
  private async flush(): Promise<void> {
    if (this.flushInFlight !== null) {
      return this.flushInFlight;
    }
    if (this.blockBuffer.length === 0 && this.txBuffer.length === 0) {
      return;
    }

    const blocksToFlush = this.blockBuffer.splice(0);
    const txsToFlush = this.txBuffer.splice(0);

    this.flushInFlight = (async () => {
      try {
        // The two INSERTs target unrelated tables with no ordering
        // dependency, so run them in parallel — flush latency directly
        // caps the unstable head's freshness window. allSettled (not
        // all) so one leg's failure doesn't mask the other's outcome
        // in logs; both rejections are still effectively "log + drop"
        // under best-effort semantics.
        const [blocksResult, txsResult] = await Promise.allSettled([
          blocksToFlush.length > 0
            ? this.insertBlocks(blocksToFlush)
            : Promise.resolve(),
          txsToFlush.length > 0
            ? this.insertTransactions(txsToFlush)
            : Promise.resolve(),
        ]);
        if (blocksResult.status === 'rejected') {
          this.log.error('ClickHouseStreamer flush failed: insertBlocks', {
            message: blocksResult.reason?.message,
            blocks: blocksToFlush.length,
          });
        }
        if (txsResult.status === 'rejected') {
          this.log.error(
            'ClickHouseStreamer flush failed: insertTransactions',
            {
              message: txsResult.reason?.message,
              transactions: txsToFlush.length,
            },
          );
        }
      } finally {
        this.flushInFlight = null;
      }
    })();

    return this.flushInFlight;
  }

  private async insertBlocks(rows: NewBlockRow[]): Promise<void> {
    const values = rows.map((r) => `(${blockRowValuesLiteral(r)})`).join(', ');
    const sql = `INSERT INTO ${TABLE_NEW_BLOCKS} (height, indep_hash, inserted_at) VALUES ${values}`;
    await this.clickhouseClient.command({ query: sql });
  }

  private async insertTransactions(rows: NewTransactionRow[]): Promise<void> {
    const values = rows.map((r) => `(${rowValuesLiteral(r)})`).join(', ');
    const sql = `INSERT INTO ${TABLE_NEW_TRANSACTIONS} (${NEW_TRANSACTION_COLUMNS.join(', ')}) VALUES ${values}`;
    await this.clickhouseClient.command({ query: sql });
  }
}
