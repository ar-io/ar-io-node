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
  NormalizedDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

// Number of recent heights kept in the in-memory block-context map. Sized
// to cover the streamer's TTL window comfortably (4h ≈ 240 blocks at
// ~1 block/min). Cheap to keep generous — each entry is one block's
// metadata plus its tx-id list.
const BLOCK_CONTEXT_RETENTION_HEIGHTS = 480;

interface BlockContext {
  height: number;
  indep_hash: string;
  timestamp: number;
  previous_block: string;
  txs: string[];
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
  owner: Buffer | null;
  signature: Buffer | null;
  signature_type: number | null;
  root_transaction_id: Buffer | null;
  root_parent_offset: number | null;
  tags: Array<[Buffer, Buffer]>;
  tags_count: number;
}

const NEW_TRANSACTION_COLUMNS = [
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
  // Tag tuple: pair of Buffers.
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

  // The most recent BLOCK_INDEXED — populated synchronously and consumed
  // by the BLOCK_TX_INDEXED handler that fires immediately after on the
  // same event-loop tick (see block-importer.ts:160-164). Cleared on
  // reorg if the current tip is no longer valid.
  private currentBlock: BlockContext | null = null;

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

  // Start sequence: validate schema (fail closed if tables missing),
  // register event listeners, start the flush timer.
  async start(): Promise<void> {
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

  queueDepth(): number {
    return this.blockBuffer.length + this.txBuffer.length;
  }

  // Fail closed at startup if either table is missing. The streamer is
  // not the schema authority; pointing the operator at clickhouse-import
  // is more diagnosable than column-mismatch errors on the first INSERT.
  private async validateSchema(): Promise<void> {
    const result = await this.clickhouseClient.query({
      query:
        'SELECT name FROM system.tables ' +
        'WHERE database = currentDatabase() ' +
        "AND name IN ('new_blocks', 'new_transactions')",
      format: 'JSONEachRow',
    });
    const rows = (await result.json<{ name: string }>()) as { name: string }[];
    const present = new Set(rows.map((r) => r.name));
    const missing = ['new_blocks', 'new_transactions'].filter(
      (t) => !present.has(t),
    );
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
    const ctx: BlockContext = {
      height: block.height,
      indep_hash: block.indep_hash,
      timestamp: block.timestamp,
      previous_block: block.previous_block ?? '',
      txs: block.txs,
    };
    this.blocksByHeight.set(block.height, ctx);
    this.currentBlock = ctx;
    this.evictOldBlockContexts(block.height);

    this.blockBuffer.push({
      height: block.height,
      indep_hash: fromB64Url(block.indep_hash),
      inserted_at: currentUnixTimestamp(),
    });
    this.enforceQueueCapAndMaybeFlush();
  }

  private handleBlockTxIndexed(tx: PartialJsonTransaction): void {
    if (this.currentBlock === null) {
      // BLOCK_TX_INDEXED before any BLOCK_INDEXED — only happens on
      // restart while the current block's indexing is mid-flight, or
      // after a reorg cleared currentBlock. Skip; the row will land
      // via the stable pipeline.
      return;
    }
    const blockTxIndex = this.currentBlock.txs.indexOf(tx.id);
    if (blockTxIndex < 0) {
      // tx wasn't in the most recent block's txs[] — block-importer
      // emit ordering says this shouldn't happen, but skip rather
      // than write a row with a wrong index.
      this.log.warn('BLOCK_TX_INDEXED tx not found in currentBlock.txs', {
        txId: tx.id,
        currentHeight: this.currentBlock.height,
      });
      return;
    }

    this.txContextsById.set(tx.id, {
      height: this.currentBlock.height,
      blockTransactionIndex: blockTxIndex,
    });

    this.txBuffer.push(this.buildL1TxRow(tx, this.currentBlock, blockTxIndex));
    this.enforceQueueCapAndMaybeFlush();
  }

  private handleDataItemIndexed(item: NormalizedDataItem): void {
    if (item.root_tx_id === null || item.root_tx_id === undefined) {
      // Optimistic data items have no root_tx_id yet — they'll be
      // re-emitted with one once the bundle is mined. Skip.
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
    // Bounded DELETE on new_blocks; orphan rows in new_transactions are
    // filtered out at query time by the (height, block_indep_hash) join
    // and age out via TTL.
    try {
      await this.clickhouseClient.command({
        query: `ALTER TABLE new_blocks DELETE WHERE height > ${forkHeight}`,
      });
    } catch (err: any) {
      this.log.error(
        'CHAIN_REORG: failed to prune new_blocks; the orphan join keeps ' +
          'query results correct, but the unstable head retains stale block ' +
          'rows until the next successful prune or TTL expiry.',
        { forkHeight, message: err?.message },
      );
    }

    // Drop in-memory contexts for heights above the fork.
    for (const h of Array.from(this.blocksByHeight.keys())) {
      if (h > forkHeight) this.blocksByHeight.delete(h);
    }
    for (const [txId, ctx] of Array.from(this.txContextsById.entries())) {
      if (ctx.height > forkHeight) this.txContextsById.delete(txId);
    }
    if (this.currentBlock !== null && this.currentBlock.height > forkHeight) {
      this.currentBlock = null;
    }

    // Best-effort: drop any pending unstable rows above the fork from
    // the in-memory buffer so we don't INSERT them post-prune.
    this.blockBuffer = this.blockBuffer.filter((r) => r.height <= forkHeight);
    this.txBuffer = this.txBuffer.filter((r) => r.height <= forkHeight);
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
    let contentType: string | null = null;
    const tagPairs: Array<[Buffer, Buffer]> = [];
    for (const tag of tx.tags) {
      const name = fromB64Url(tag.name);
      const value = fromB64Url(tag.value);
      if (contentType === null && isContentTypeTag(name)) {
        contentType = value.toString('utf8');
      }
      tagPairs.push([name, value]);
    }
    const ownerBuf = fromB64Url(tx.owner);
    return {
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
      block_indep_hash: fromB64Url(block.indep_hash),
      block_timestamp: block.timestamp,
      block_previous_block:
        block.previous_block !== '' ? fromB64Url(block.previous_block) : null,
      indexed_at: currentUnixTimestamp(),
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
    let contentType: string | null = null;
    const tagPairs: Array<[Buffer, Buffer]> = [];
    for (const tag of item.tags) {
      const name = fromB64Url(tag.name);
      const value = fromB64Url(tag.value);
      if (contentType === null && isContentTypeTag(name)) {
        contentType = value.toString('utf8');
      }
      tagPairs.push([name, value]);
    }
    if (contentType === null && item.content_type !== undefined) {
      contentType = item.content_type;
    }
    return {
      height: txCtx.height,
      // Data items inherit their parent L1 tx's block_transaction_index
      // (matches how the stable Parquet path projects them into
      // `transactions`).
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
      block_indep_hash: fromB64Url(block.indep_hash),
      block_timestamp: block.timestamp,
      block_previous_block:
        block.previous_block !== '' ? fromB64Url(block.previous_block) : null,
      indexed_at: currentUnixTimestamp(),
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
    // Bounded buffer: drop oldest on overflow. Drops are intentional —
    // streaming is best-effort and the stable Parquet pipeline is the
    // backstop. Dropped rows will appear once they stabilize.
    if (this.txBuffer.length > this.maxQueueSize) {
      const drop = this.txBuffer.length - this.maxQueueSize;
      this.txBuffer.splice(0, drop);
      this.log.warn('Streamer buffer over cap; dropped oldest rows', {
        droppedRows: drop,
        bufferSize: this.txBuffer.length,
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
        if (blocksToFlush.length > 0) {
          await this.insertBlocks(blocksToFlush);
        }
        if (txsToFlush.length > 0) {
          await this.insertTransactions(txsToFlush);
        }
      } catch (err: any) {
        this.log.error('ClickHouseStreamer flush failed', {
          message: err?.message,
          blocks: blocksToFlush.length,
          transactions: txsToFlush.length,
        });
      } finally {
        this.flushInFlight = null;
      }
    })();

    return this.flushInFlight;
  }

  private async insertBlocks(rows: NewBlockRow[]): Promise<void> {
    const values = rows.map((r) => `(${blockRowValuesLiteral(r)})`).join(', ');
    const sql = `INSERT INTO new_blocks (height, indep_hash, inserted_at) VALUES ${values}`;
    await this.clickhouseClient.command({ query: sql });
  }

  private async insertTransactions(rows: NewTransactionRow[]): Promise<void> {
    const values = rows.map((r) => `(${rowValuesLiteral(r)})`).join(', ');
    const sql = `INSERT INTO new_transactions (${NEW_TRANSACTION_COLUMNS.join(', ')}) VALUES ${values}`;
    await this.clickhouseClient.command({ query: sql });
  }
}
