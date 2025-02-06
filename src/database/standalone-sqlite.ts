/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { ValidationError } from 'apollo-server-express';
import Sqlite from 'better-sqlite3';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';
import * as R from 'ramda';
import sql from 'sql-bricks';
import * as winston from 'winston';
import CircuitBreaker from 'opossum';
import NodeCache from 'node-cache';

// TODO enable eslint
/* eslint-disable */
// @ts-ignore
// TODO sort out types
import { default as yesql } from 'yesql';

import { MAX_FORK_DEPTH } from '../arweave/constants.js';
import {
  b64UrlToUtf8,
  fromB64Url,
  toB64Url,
  utf8ToB64Url,
} from '../lib/encoding.js';
import { MANIFEST_CONTENT_TYPE } from '../lib/encoding.js';
import { currentUnixTimestamp } from '../lib/time.js';
import log from '../log.js';
import * as metrics from '../metrics.js';
import {
  DataBlockListValidator,
  NameBlockListValidator,
  BundleIndex,
  BundleSaveResult,
  BundleRecord,
  ChainIndex,
  ChainOffsetIndex,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataParent,
  DataItemAttributes,
  GqlQueryable,
  GqlTransaction,
  NestedDataIndexWriter,
  NormalizedDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
  TransactionAttributes,
} from '../types.js';
import * as config from '../config.js';
import { DetailedError } from '../lib/error.js';

const CPU_COUNT = os.cpus().length;
const MAX_WORKER_COUNT = 12;

const MAX_WORKER_ERRORS = 100;

const STABLE_FLUSH_INTERVAL = 5;
const NEW_TX_CLEANUP_WAIT_SECS = 60 * 60 * 2;
const NEW_DATA_ITEM_CLEANUP_WAIT_SECS = 60 * 60 * 2;
const BUNDLE_REPROCESS_WAIT_SECS = 60 * 15;

export function encodeTransactionGqlCursor({
  height,
  blockTransactionIndex,
  dataItemId,
  indexedAt,
  id,
}: {
  height: number | null;
  blockTransactionIndex: number | null;
  dataItemId: string | null;
  indexedAt: number | null;
  id: string | null;
}) {
  return utf8ToB64Url(
    JSON.stringify([height, blockTransactionIndex, dataItemId, indexedAt, id]),
  );
}

export function decodeTransactionGqlCursor(cursor: string | undefined) {
  try {
    if (!cursor) {
      return {
        height: null,
        blockTransactionIndex: null,
        dataItemId: null,
        indexedAt: null,
        id: null,
      };
    }

    const [height, blockTransactionIndex, dataItemId, indexedAt, id] =
      JSON.parse(b64UrlToUtf8(cursor)) as [
        number | null,
        number | null,
        string | null,
        number | null,
        string | null,
      ];

    return { height, blockTransactionIndex, dataItemId, indexedAt, id };
  } catch (error) {
    throw new ValidationError('Invalid transaction cursor');
  }
}

export function encodeBlockGqlCursor({ height }: { height: number }) {
  return utf8ToB64Url(JSON.stringify([height]));
}

export function decodeBlockGqlCursor(cursor: string | undefined) {
  try {
    if (!cursor) {
      return { height: null };
    }

    const [height] = JSON.parse(b64UrlToUtf8(cursor)) as [number];

    return { height };
  } catch (error) {
    throw new ValidationError('Invalid block cursor');
  }
}

export function toSqliteParams(sqlBricksParams: { values: any[] }) {
  return sqlBricksParams.values
    .map((v, i) => [i + 1, v])
    .reduce(
      (acc, [i, v]) => {
        acc[i] = v;
        return acc;
      },
      {} as { [key: string]: any },
    );
}

function hashTagPart(value: Buffer) {
  return crypto.createHash('sha1').update(value).digest();
}

function isContentTypeTag(tagName: Buffer) {
  return tagName.toString('utf8').toLowerCase() === 'content-type';
}

function isContentEncodingTag(tagName: Buffer) {
  return tagName.toString('utf8').toLowerCase() === 'content-encoding';
}

function ownerToAddress(owner: Buffer) {
  return crypto.createHash('sha256').update(owner).digest();
}

export function txToDbRows(tx: PartialJsonTransaction, height?: number) {
  const tagNames = [] as { name: Buffer; hash: Buffer }[];
  const tagValues = [] as { value: Buffer; hash: Buffer }[];
  const newTxTags = [] as {
    tag_name_hash: Buffer;
    tag_value_hash: Buffer;
    transaction_id: Buffer;
    transaction_tag_index: number;
    indexed_at: number;
  }[];
  const wallets = [] as { address: Buffer; public_modulus: Buffer }[];

  let contentType: string | undefined;
  let contentEncoding: string | undefined;

  const txId = fromB64Url(tx.id);

  let transactionTagIndex = 0;
  for (const tag of tx.tags) {
    const tagName = fromB64Url(tag.name);
    const tagNameHash = hashTagPart(tagName);
    tagNames.push({ name: tagName, hash: tagNameHash });

    const tagValue = fromB64Url(tag.value);
    const tagValueHash = hashTagPart(tagValue);
    tagValues.push({ value: tagValue, hash: tagValueHash });

    if (isContentTypeTag(tagName)) {
      contentType = tagValue.toString('utf8');
    }

    if (isContentEncodingTag(tagName)) {
      contentEncoding = tagValue.toString('utf8');
    }

    newTxTags.push({
      tag_name_hash: tagNameHash,
      tag_value_hash: tagValueHash,
      transaction_id: txId,
      transaction_tag_index: transactionTagIndex,
      indexed_at: currentUnixTimestamp(),
    });

    transactionTagIndex++;
  }

  const ownerBuffer = fromB64Url(tx.owner);
  const ownerAddressBuffer = ownerToAddress(ownerBuffer);

  wallets.push({ address: ownerAddressBuffer, public_modulus: ownerBuffer });

  return {
    tagNames,
    tagValues,
    newTxTags,
    wallets,
    newTx: {
      id: txId,
      signature: tx.signature !== null ? fromB64Url(tx.signature) : null,
      format: tx.format,
      last_tx: fromB64Url(tx.last_tx),
      owner_address: ownerAddressBuffer,
      target: fromB64Url(tx.target),
      quantity: tx.quantity,
      reward: tx.reward,
      data_size: tx.data_size,
      data_root: fromB64Url(tx.data_root),
      content_type: contentType,
      content_encoding: contentEncoding,
      tag_count: tx.tags.length,
      indexed_at: currentUnixTimestamp(),
      height: height,
    },
  };
}

export function dataItemToDbRows(item: NormalizedDataItem, height?: number) {
  const tagNames = [] as { name: Buffer; hash: Buffer }[];
  const tagValues = [] as { value: Buffer; hash: Buffer }[];
  const newDataItemTags = [] as {
    tag_name_hash: Buffer;
    tag_value_hash: Buffer;
    root_transaction_id: Buffer | null;
    data_item_id: Buffer;
    data_item_tag_index: number;
    indexed_at: number;
  }[];
  const wallets = [] as { address: Buffer; public_modulus: Buffer }[];

  let contentType: string | undefined;
  let contentEncoding: string | undefined;

  const id = fromB64Url(item.id);

  let dataItemTagIndex = 0;
  for (const tag of item.tags) {
    const tagName = fromB64Url(tag.name);
    const tagNameHash = hashTagPart(tagName);
    tagNames.push({ name: tagName, hash: tagNameHash });

    const tagValue = fromB64Url(tag.value);
    const tagValueHash = hashTagPart(tagValue);
    tagValues.push({ value: tagValue, hash: tagValueHash });

    if (isContentTypeTag(tagName)) {
      contentType = tagValue.toString('utf8');
    }

    if (isContentEncodingTag(tagName)) {
      contentEncoding = tagValue.toString('utf8');
    }

    newDataItemTags.push({
      tag_name_hash: tagNameHash,
      tag_value_hash: tagValueHash,
      root_transaction_id: item.root_tx_id ? fromB64Url(item.root_tx_id) : null,
      data_item_id: id,
      data_item_tag_index: dataItemTagIndex,
      indexed_at: currentUnixTimestamp(),
    });

    dataItemTagIndex++;
  }

  const ownerBuffer = fromB64Url(item.owner);
  const ownerAddressBuffer = fromB64Url(item.owner_address);

  wallets.push({ address: ownerAddressBuffer, public_modulus: ownerBuffer });

  const parentId = item.parent_id ? fromB64Url(item.parent_id) : null;
  const rootTxId = item.root_tx_id ? fromB64Url(item.root_tx_id) : null;

  // We do not insert bundle data item rows for opimistically indexed data
  // items
  let bundleDataItem;
  if (rootTxId) {
    bundleDataItem = {
      id,
      parent_id: parentId,
      parent_index: item.parent_index,
      root_transaction_id: rootTxId,
      indexed_at: currentUnixTimestamp(),
      filter: item.filter,
    };
  }

  return {
    tagNames,
    tagValues,
    newDataItemTags,
    wallets,
    bundleDataItem,
    newDataItem: {
      anchor: fromB64Url(item.anchor),
      content_encoding: contentEncoding ?? item.content_encoding,
      content_type: contentType ?? item.content_type,
      data_offset: item.data_offset,
      data_size: item.data_size,
      height: height,
      id,
      indexed_at: currentUnixTimestamp(),
      offset: item.offset,
      owner_address: ownerAddressBuffer,
      owner_offset: item.owner_offset,
      owner_size: item.owner_size,
      parent_id: parentId,
      root_parent_offset: item.root_parent_offset,
      root_transaction_id: rootTxId,
      signature: item.signature !== null ? fromB64Url(item.signature) : null,
      signature_offset: item.signature_offset,
      signature_size: item.signature_size,
      signature_type: item.signature_type,
      size: item.size,
      tag_count: item.tags.length,
      target: fromB64Url(item.target),
    },
  };
}

type DebugInfo = {
  counts: {
    wallets: number;
    tagNames: number;
    tagValues: number;
    stableTxs: number;
    stableBlocks: number;
    stableBlockTxs: number;
    missingStableBlocks: number;
    missingStableTxs: number;
    missingTxs: number;
    newBlocks: number;
    newTxs: number;
    bundleDataItems: number;
    matchedDataItems: number;
    dataItems: number;
  };
  heights: {
    minStable: number;
    maxStable: number;
    minNew: number;
    maxNew: number;
    minStableDataItem: number;
    maxStableDataItem: number;
    minNewDataItem: number;
    maxNewDataItem: number;
  };
  timestamps: {
    now: number;
    maxBundleQueuedAt: number;
    maxBundleSkippedAt: number;
    maxBundleUnbundledAt: number;
    maxBundleFullyIndexedAt: number;
    maxStableDataItemIndexedAt: number;
    maxNewDataItemIndexedAt: number;
  };
  errors: string[];
  warnings: string[];
};

export class StandaloneSqliteDatabaseWorker {
  private log: winston.Logger;

  private dbs: {
    core: Sqlite.Database;
    data: Sqlite.Database;
    moderation: Sqlite.Database;
    bundles: Sqlite.Database;
  };
  private stmts: {
    core: { [stmtName: string]: Sqlite.Statement };
    data: { [stmtName: string]: Sqlite.Statement };
    moderation: { [stmtName: string]: Sqlite.Statement };
    bundles: { [stmtName: string]: Sqlite.Statement };
  };
  private bundleFormatIds: { [filter: string]: number } = {};
  private filterIds: { [filter: string]: number } = {};

  private insertDataHashCache: NodeCache;

  private tagSelectivity: Record<string, number>;

  // Transactions
  resetBundlesToHeightFn: Sqlite.Transaction;
  resetCoreToHeightFn: Sqlite.Transaction;
  insertTxFn: Sqlite.Transaction;
  insertDataItemFn: Sqlite.Transaction;
  insertBlockAndTxsFn: Sqlite.Transaction;
  saveCoreStableDataFn: Sqlite.Transaction;
  saveBundlesStableDataFn: Sqlite.Transaction;
  deleteCoreStaleNewDataFn: Sqlite.Transaction;
  deleteBundlesStaleNewDataFn: Sqlite.Transaction;

  constructor({
    log,
    coreDbPath,
    dataDbPath,
    moderationDbPath,
    bundlesDbPath,
    tagSelectivity,
  }: {
    log: winston.Logger;
    coreDbPath: string;
    dataDbPath: string;
    moderationDbPath: string;
    bundlesDbPath: string;
    tagSelectivity: Record<string, number>;
  }) {
    this.log = log;

    const timeout = 30000;
    this.dbs = {
      core: new Sqlite(coreDbPath, { timeout }),
      data: new Sqlite(dataDbPath, { timeout }),
      moderation: new Sqlite(moderationDbPath, { timeout }),
      bundles: new Sqlite(bundlesDbPath, { timeout }),
    };
    for (const db of Object.values(this.dbs)) {
      db.pragma('journal_mode = WAL');
      db.pragma('page_size = 4096'); // may depend on OS and FS
    }

    this.dbs.core.exec(`ATTACH DATABASE '${bundlesDbPath}' AS bundles`);
    this.dbs.data.exec(`ATTACH DATABASE '${bundlesDbPath}' AS bundles`);
    this.dbs.bundles.exec(`ATTACH DATABASE '${coreDbPath}' AS core`);

    this.stmts = { core: {}, data: {}, moderation: {}, bundles: {} };

    for (const [stmtsKey, stmts] of Object.entries(this.stmts)) {
      const sqlUrl = new URL(`./sql/${stmtsKey}`, import.meta.url);
      const coreSql = yesql(sqlUrl.pathname) as { [key: string]: string };
      for (const [k, sql] of Object.entries(coreSql)) {
        // Skip the key containing the complete file
        if (!k.endsWith('.sql')) {
          // Guard against unexpected statement keys
          if (
            stmtsKey === 'core' ||
            stmtsKey === 'data' ||
            stmtsKey === 'moderation' ||
            stmtsKey === 'bundles'
          ) {
            stmts[k] = this.dbs[stmtsKey].prepare(sql);
          } else {
            throw new Error(`Unexpected statement key: ${stmtsKey}`);
          }
        }
      }
    }

    // Transactions
    this.resetBundlesToHeightFn = this.dbs.bundles.transaction(
      (height: number) => {
        this.stmts.bundles.clearHeightsOnNewDataItems.run({ height });
        this.stmts.bundles.clearHeightsOnNewDataItemTags.run({ height });
      },
    );

    this.resetCoreToHeightFn = this.dbs.core.transaction((height: number) => {
      this.stmts.core.clearHeightsOnNewTransactions.run({ height });
      this.stmts.core.clearHeightsOnNewTransactionTags.run({ height });
      this.stmts.core.truncateNewBlocksAt.run({ height });
      this.stmts.core.truncateNewBlockTransactionsAt.run({ height });
      this.stmts.core.truncateMissingTransactionsAt.run({ height });
    });

    this.insertTxFn = this.dbs.core.transaction(
      (tx: PartialJsonTransaction, height?: number) => {
        const rows = txToDbRows(tx, height);

        if (height !== undefined) {
          this.stmts.core.updateNewDataItemHeights.run({
            height,
            transaction_id: rows.newTx.id,
          });

          this.stmts.core.updateNewDataItemTagHeights.run({
            height,
            transaction_id: rows.newTx.id,
          });
        }

        for (const row of rows.tagNames) {
          this.stmts.core.insertOrIgnoreTagName.run(row);
        }

        for (const row of rows.tagValues) {
          this.stmts.core.insertOrIgnoreTagValue.run(row);
        }

        for (const row of rows.newTxTags) {
          this.stmts.core.upsertNewTransactionTag.run({
            ...row,
            height,
          });
        }

        for (const row of rows.wallets) {
          this.stmts.core.insertOrIgnoreWallet.run(row);
        }

        this.stmts.core.upsertNewTransaction.run({
          ...rows.newTx,
          height,
        });

        this.stmts.core.insertAsyncNewBlockTransaction.run({
          transaction_id: rows.newTx.id,
        });
      },
    );

    this.insertDataItemFn = this.dbs.bundles.transaction(
      (item: NormalizedDataItem, height?: number) => {
        const rows = dataItemToDbRows(item, height);

        for (const row of rows.tagNames) {
          this.stmts.bundles.insertOrIgnoreTagName.run(row);
        }

        for (const row of rows.tagValues) {
          this.stmts.bundles.insertOrIgnoreTagValue.run(row);
        }

        for (const row of rows.newDataItemTags) {
          this.stmts.bundles.upsertNewDataItemTag.run({
            ...row,
            height,
          });
        }

        for (const row of rows.wallets) {
          this.stmts.bundles.insertOrIgnoreWallet.run(row);
        }

        // We do not insert bundle data item rows for opimistically indexed
        // data items
        if (rows.bundleDataItem) {
          this.stmts.bundles.upsertBundleDataItem.run({
            ...rows.bundleDataItem,
            filter_id: this.getFilterId(rows.bundleDataItem.filter),
          });
        }

        this.stmts.bundles.upsertNewDataItem.run({
          ...rows.newDataItem,
          height,
        });
      },
    );

    this.insertBlockAndTxsFn = this.dbs.core.transaction(
      (
        block: PartialJsonBlock,
        txs: PartialJsonTransaction[],
        missingTxIds: string[],
      ) => {
        const indepHash = fromB64Url(block.indep_hash);
        const previousBlock = fromB64Url(block.previous_block ?? '');
        const nonce = fromB64Url(block.nonce);
        const hash = fromB64Url(block.hash);
        const rewardAddr = fromB64Url(
          block.reward_addr !== 'unclaimed' ? block.reward_addr : '',
        );
        const hashListMerkle =
          block.hash_list_merkle && fromB64Url(block.hash_list_merkle);
        const walletList = fromB64Url(block.wallet_list);
        const txRoot = block.tx_root && fromB64Url(block.tx_root);

        this.stmts.core.insertOrIgnoreNewBlock.run({
          indep_hash: indepHash,
          height: block.height,
          previous_block: previousBlock,
          nonce: nonce,
          hash: hash,
          block_timestamp: block.timestamp,
          diff: block.diff,
          cumulative_diff: block.cumulative_diff,
          last_retarget: block.last_retarget,
          reward_addr: rewardAddr,
          reward_pool: block.reward_pool,
          block_size: block.block_size,
          weave_size: block.weave_size,
          usd_to_ar_rate_dividend: (block.usd_to_ar_rate ?? [])[0],
          usd_to_ar_rate_divisor: (block.usd_to_ar_rate ?? [])[1],
          scheduled_usd_to_ar_rate_dividend: (block.scheduled_usd_to_ar_rate ??
            [])[0],
          scheduled_usd_to_ar_rate_divisor: (block.scheduled_usd_to_ar_rate ??
            [])[1],
          hash_list_merkle: hashListMerkle,
          wallet_list: walletList,
          tx_root: txRoot,
          tx_count: block.txs.length,
          missing_tx_count: missingTxIds.length,
        });

        let blockTransactionIndex = 0;
        for (const txIdStr of block.txs) {
          const txId = fromB64Url(txIdStr);

          this.stmts.core.insertOrIgnoreNewBlockTransaction.run({
            block_indep_hash: indepHash,
            transaction_id: txId,
            block_transaction_index: blockTransactionIndex,
            height: block.height,
          });

          blockTransactionIndex++;
        }

        for (const tx of txs) {
          if (config.WRITE_TRANSACTION_DB_SIGNATURES === false) {
            tx.signature = null;
          }
          const rows = txToDbRows(tx, block.height);

          this.stmts.core.updateNewDataItemHeights.run({
            height: block.height,
            transaction_id: rows.newTx.id,
          });

          this.stmts.core.updateNewDataItemTagHeights.run({
            height: block.height,
            transaction_id: rows.newTx.id,
          });

          for (const row of rows.tagNames) {
            this.stmts.core.insertOrIgnoreTagName.run(row);
          }

          for (const row of rows.tagValues) {
            this.stmts.core.insertOrIgnoreTagValue.run(row);
          }

          for (const row of rows.newTxTags) {
            this.stmts.core.upsertNewTransactionTag.run({
              ...row,
              height: block.height,
            });
          }

          for (const row of rows.wallets) {
            this.stmts.core.insertOrIgnoreWallet.run(row);
          }

          this.stmts.core.upsertNewTransaction.run(rows.newTx);
        }

        for (const txIdStr of missingTxIds) {
          const txId = fromB64Url(txIdStr);

          this.stmts.core.updateNewDataItemHeights.run({
            height: block.height,
            transaction_id: txId,
          });

          this.stmts.core.updateNewDataItemTagHeights.run({
            height: block.height,
            transaction_id: txId,
          });

          this.stmts.core.insertOrIgnoreMissingTransaction.run({
            block_indep_hash: indepHash,
            transaction_id: txId,
            height: block.height,
          });
        }
      },
    );

    this.saveCoreStableDataFn = this.dbs.core.transaction(
      (endHeight: number) => {
        this.stmts.core.insertOrIgnoreStableBlocks.run({
          end_height: endHeight,
        });

        this.stmts.core.insertOrIgnoreStableBlockTransactions.run({
          end_height: endHeight,
        });

        this.stmts.core.insertOrIgnoreStableTransactions.run({
          end_height: endHeight,
        });

        this.stmts.core.insertOrIgnoreStableTransactionTags.run({
          end_height: endHeight,
        });
      },
    );

    this.saveBundlesStableDataFn = this.dbs.bundles.transaction(
      (endHeight: number) => {
        this.stmts.bundles.insertOrIgnoreStableDataItems.run({
          end_height: endHeight,
        });

        this.stmts.bundles.insertOrIgnoreStableDataItemTags.run({
          end_height: endHeight,
        });
      },
    );

    this.deleteCoreStaleNewDataFn = this.dbs.core.transaction(
      (heightThreshold: number, createdAtThreshold: number) => {
        // Deletes missing_transactions that have been inserted asyncronously
        this.stmts.core.deleteStaleMissingTransactions.run({
          height_threshold: heightThreshold,
        });

        this.stmts.core.deleteStaleNewTransactionTags.run({
          height_threshold: heightThreshold,
          indexed_at_threshold: createdAtThreshold,
        });

        this.stmts.core.deleteStaleNewTransactions.run({
          height_threshold: heightThreshold,
          indexed_at_threshold: createdAtThreshold,
        });

        this.stmts.core.deleteStaleNewBlockTransactions.run({
          height_threshold: heightThreshold,
        });

        this.stmts.core.deleteStaleNewBlocks.run({
          height_threshold: heightThreshold,
        });
      },
    );

    this.deleteBundlesStaleNewDataFn = this.dbs.bundles.transaction(
      (heightThreshold: number, indexedAtThreshold: number) => {
        this.stmts.bundles.deleteStaleNewDataItems.run({
          height_threshold: heightThreshold,
          indexed_at_threshold: indexedAtThreshold,
        });

        this.stmts.bundles.deleteStaleNewDataItemTags.run({
          height_threshold: heightThreshold,
          indexed_at_threshold: indexedAtThreshold,
        });
      },
    );

    this.insertDataHashCache = new NodeCache({
      stdTTL: 60 * 7, // 7 minutes
      checkperiod: 60, // 1 minute
      useClones: false,
    });

    this.tagSelectivity = tagSelectivity;
  }

  getMaxHeight() {
    return this.stmts.core.selectMaxHeight.get().height ?? -1;
  }

  getMaxStableBlockTimestamp() {
    return (
      this.stmts.core.selectMaxStableBlockTimestamp.get().block_timestamp ?? -1
    );
  }

  getBlockHashByHeight(height: number): string | undefined {
    if (height < 0) {
      throw new Error(`Invalid height ${height}, must be >= 0.`);
    }
    const hash = this.stmts.core.selectBlockHashByHeight.get({
      height,
    })?.indep_hash;
    return hash ? toB64Url(hash) : undefined;
  }

  getMissingTxIds(limit: number) {
    const rows = this.stmts.core.selectMissingTransactionIds.all({
      limit,
    });

    return rows.map((row): string => toB64Url(row.transaction_id));
  }

  getFailedBundleIds(limit: number) {
    const rows = this.stmts.bundles.selectFailedBundleIds.all({
      limit,
      reprocess_cutoff: currentUnixTimestamp() - BUNDLE_REPROCESS_WAIT_SECS,
    });

    return rows.map((row): string => toB64Url(row.id));
  }

  backfillBundles() {
    this.stmts.bundles.insertMissingBundles.run();
  }

  updateBundlesFullyIndexedAt() {
    this.stmts.bundles.updateFullyIndexedAt.run({
      fully_indexed_at: currentUnixTimestamp(),
    });
  }

  updateBundlesForFilterChange(unbundleFilter: string, indexFilter: string) {
    this.stmts.bundles.updateForFilterChange.run({
      unbundle_filter: unbundleFilter,
      index_filter: indexFilter,
    });
  }

  resetToHeight(height: number) {
    this.resetBundlesToHeightFn(height);
    this.resetCoreToHeightFn(height);
  }

  saveTx(tx: PartialJsonTransaction) {
    const txId = fromB64Url(tx.id);
    const maybeTxHeight = this.stmts.core.selectMissingTransactionHeight.get({
      transaction_id: txId,
    })?.height;

    if (config.WRITE_TRANSACTION_DB_SIGNATURES === false) {
      tx.signature = null;
    }

    this.insertTxFn(tx, maybeTxHeight);
    this.stmts.core.deleteNewMissingTransaction.run({ transaction_id: txId });
  }

  getTxIdsMissingOffsets(limit: number) {
    const rows = this.stmts.core.selectStableTransactionIdsMissingOffsets.all({
      limit,
    });

    return rows.map((row): string => toB64Url(row.id));
  }

  saveTxOffset(id: string, offset: number) {
    this.stmts.core.updateStableTransactionOffset.run({
      id: fromB64Url(id),
      offset,
    });
  }

  getBundleFormatId(format: string | undefined) {
    let id: number | undefined;
    if (format != undefined) {
      id = this.bundleFormatIds[format];
      if (id == undefined) {
        id = this.stmts.bundles.selectFormatId.get({ format })?.id;
        if (id != undefined) {
          this.bundleFormatIds[format] = id;
        }
      }
    }
    return id;
  }

  getFilterId(filter: string | undefined) {
    let id: number | undefined;
    if (filter != undefined) {
      id = this.filterIds[filter];
      if (id == undefined) {
        this.stmts.bundles.insertOrIgnoreFilter.run({ filter });
        id = this.stmts.bundles.selectFilterId.get({ filter })?.id;
        if (id != undefined) {
          this.filterIds[filter] = id;
        }
      }
    }
    return id;
  }

  saveDataItem(item: NormalizedDataItem) {
    const rootTxId = item.root_tx_id ? fromB64Url(item.root_tx_id) : null;
    const maybeTxHeight = this.stmts.bundles.selectTransactionHeight.get({
      transaction_id: rootTxId,
    })?.height;

    if (config.WRITE_ANS104_DATA_ITEM_DB_SIGNATURES === false) {
      item.signature = null;
    }
    this.insertDataItemFn(item, maybeTxHeight);
  }

  saveBundleRetries(rootTransactionId: string) {
    const rootTxId = fromB64Url(rootTransactionId);
    this.stmts.bundles.updateBundleRetry.run({
      root_transaction_id: rootTxId,
      current_timestamp: currentUnixTimestamp(),
    });
  }

  saveBundle({
    id,
    rootTransactionId,
    format,
    unbundleFilter,
    indexFilter,
    dataItemCount,
    matchedDataItemCount,
    duplicatedDataItemCount,
    queuedAt,
    skippedAt,
    unbundledAt,
    fullyIndexedAt,
  }: BundleRecord): BundleSaveResult {
    const idBuffer = fromB64Url(id);
    let rootTxId: Buffer | undefined;
    if (rootTransactionId != undefined) {
      rootTxId = fromB64Url(rootTransactionId);
    }

    const {
      unbundle_filter_id,
      index_filter_id,
      previous_unbundle_filter_id,
      previous_index_filter_id,
      last_fully_indexed_at,
    } = this.stmts.bundles.upsertBundle.get({
      id: idBuffer,
      root_transaction_id: rootTxId,
      format_id: this.getBundleFormatId(format),
      unbundle_filter_id: this.getFilterId(unbundleFilter),
      index_filter_id: this.getFilterId(indexFilter),
      data_item_count: dataItemCount,
      matched_data_item_count: matchedDataItemCount,
      duplicated_data_item_count: duplicatedDataItemCount,
      queued_at: queuedAt,
      skipped_at: skippedAt,
      unbundled_at: unbundledAt,
      fully_indexed_at: fullyIndexedAt,
    });

    return {
      unbundleFilterId: unbundle_filter_id,
      indexFilterId: index_filter_id,
      previousUnbundleFilterId: previous_unbundle_filter_id,
      previousIndexFilterId: previous_index_filter_id,
      lastFullyIndexedAt: last_fully_indexed_at,
    };
  }

  saveBlockAndTxs(
    block: PartialJsonBlock,
    txs: PartialJsonTransaction[],
    missingTxIds: string[],
  ) {
    this.insertBlockAndTxsFn(block, txs, missingTxIds);

    if (block.height % STABLE_FLUSH_INTERVAL === 0) {
      const { block_timestamp: maxStableBlockTimestamp } =
        this.stmts.core.selectMaxStableBlockTimestamp.get();
      const endHeight = block.height - MAX_FORK_DEPTH;

      this.saveCoreStableDataFn(endHeight);

      this.deleteCoreStaleNewDataFn(
        endHeight,
        maxStableBlockTimestamp - NEW_TX_CLEANUP_WAIT_SECS,
      );

      return { endHeight, maxStableBlockTimestamp };
    }

    return {};
  }

  flushStableDataItems(endHeight: number, maxStableBlockTimestamp: number) {
    this.saveBundlesStableDataFn(endHeight);

    this.deleteBundlesStaleNewDataFn(
      endHeight,
      maxStableBlockTimestamp - NEW_DATA_ITEM_CLEANUP_WAIT_SECS,
    );
  }

  getDataAttributes(id: string) {
    const coreRow = this.stmts.core.selectDataAttributes.get({
      id: fromB64Url(id),
    });

    const dataRow = this.stmts.data.selectDataAttributes.get({
      id: fromB64Url(id),
      data_root: coreRow?.data_root,
    });

    if (coreRow === undefined && dataRow === undefined) {
      return undefined;
    }

    const contentType =
      coreRow?.content_type ?? dataRow?.original_source_content_type;
    const hash = dataRow?.hash;
    const dataRoot = coreRow?.data_root;

    const rootTransactionId =
      coreRow?.root_transaction_id !== null &&
      coreRow?.root_transaction_id !== undefined
        ? toB64Url(coreRow.root_transaction_id)
        : undefined;

    return {
      hash: hash ? toB64Url(hash) : undefined,
      dataRoot: dataRoot ? toB64Url(dataRoot) : undefined,
      size: coreRow?.data_size ?? dataRow?.data_size,
      contentEncoding: coreRow?.content_encoding,
      contentType,
      rootTransactionId,
      rootParentOffset: coreRow?.root_parent_offset,
      dataOffset: coreRow?.data_offset,
      isManifest: contentType === MANIFEST_CONTENT_TYPE,
      stable: coreRow?.stable === true,
      verified: dataRow?.verified === 1,
    };
  }

  getDataItemAttributes(id: string) {
    const row = this.stmts.bundles.selectDataItemAttributes.get({
      id: fromB64Url(id),
    });

    if (row === undefined) {
      return undefined;
    }

    return {
      parentId: row.parent_id ? toB64Url(row.parent_id) : null,
      signature: row.signature ? toB64Url(row.signature) : null,
      signatureOffset: row.signature_offset,
      signatureSize: row.signature_size,
    };
  }

  getTransactionAttributes(id: string) {
    const row = this.stmts.core.selectTransactionAttributes.get({
      id: fromB64Url(id),
    });

    if (row === undefined) {
      return undefined;
    }

    return {
      signature: row.signature ? toB64Url(row.signature) : null,
    };
  }

  getDataParent(id: string) {
    const dataRow = this.stmts.data.selectDataParent.get({
      id: fromB64Url(id),
    });

    if (dataRow === undefined) {
      return undefined;
    }

    return {
      parentId: toB64Url(dataRow.parent_id),
      parentHash: dataRow?.parent_hash
        ? toB64Url(dataRow?.parent_hash)
        : undefined,
      offset: dataRow?.data_offset,
      size: dataRow?.data_size,
    };
  }

  getDebugInfo() {
    const chainStats = this.stmts.core.selectChainStats.get();
    const bundleStats = this.stmts.bundles.selectBundleStats.get();
    const dataItemStats = this.stmts.bundles.selectDataItemStats.get();

    const now = currentUnixTimestamp();

    const warnings: string[] = [];
    const errors: string[] = [];

    let missingStableBlockCount = 0;
    if (chainStats.stable_blocks_max_height != undefined) {
      missingStableBlockCount =
        (chainStats.stable_blocks_max_height ?? 0) -
        (chainStats.stable_blocks_min_height
          ? chainStats.stable_blocks_min_height - 1
          : 0) -
        chainStats.stable_blocks_count;
    }

    if (missingStableBlockCount > 0) {
      const error = `
        Stable block count (${chainStats.stable_blocks_count}) does not match
        stable block height range (${chainStats.stable_blocks_min_height} to
        ${chainStats.stable_blocks_max_height}).
      `.replace(/\s+/g, ' ');
      errors.push(error);
    }

    const missingStableTxCount =
      chainStats.stable_block_txs_count - chainStats.stable_txs_count;

    if (missingStableTxCount > 0) {
      const error = `
        Stable transaction count (${chainStats.stable_txs_count}) does not match
        stable block transaction count (${chainStats.stable_block_txs_count}).
      `
        .replace(/\s+/g, ' ')
        .trim();
      errors.push(error);
    }

    if (now - bundleStats.last_fully_indexed_at > 60 * 60 * 24) {
      const warning = `
        Last bundle fully indexed more than 24 hours ago.
      `
        .replace(/\s+/g, ' ')
        .trim();
      warnings.push(warning);
    }

    return {
      counts: {
        wallets: chainStats.wallets_count,
        tagNames: chainStats.tag_names_count,
        tagValues: chainStats.tag_values_count,
        stableTxs: chainStats.stable_txs_count,
        stableBlocks: chainStats.stable_blocks_count,
        stableBlockTxs: chainStats.stable_block_txs_count,
        missingStableBlocks: missingStableBlockCount,
        missingStableTxs: missingStableTxCount,
        missingTxs: chainStats.missing_txs_count,
        newBlocks: chainStats.new_blocks_count,
        newTxs: chainStats.new_txs_count,
        bundleCount: bundleStats.count,
        bundleDataItems: bundleStats.data_item_count,
        matchedDataItems: bundleStats.matched_data_item_count,
        dataItems: dataItemStats.data_item_count,
        nestedDataItems: dataItemStats.nested_data_item_count,
      },
      heights: {
        minStable: chainStats.stable_blocks_min_height ?? -1,
        maxStable: chainStats.stable_blocks_max_height ?? -1,
        minNew: chainStats.new_blocks_min_height ?? -1,
        maxNew: chainStats.new_blocks_max_height ?? -1,
        minStableDataItem: dataItemStats.min_stable_height ?? -1,
        maxStableDataItem: dataItemStats.max_stable_height ?? -1,
        minNewDataItem: dataItemStats.min_new_height ?? -1,
        maxNewDataItem: dataItemStats.max_new_height ?? -1,
      },
      timestamps: {
        now: currentUnixTimestamp(),
        maxBundleQueuedAt: bundleStats.max_queued_at,
        maxBundleSkippedAt: bundleStats.max_skipped_at,
        maxBundleUnbundledAt: bundleStats.max_unbundled_at,
        maxBundleFullyIndexedAt: bundleStats.max_fully_indexed_at,
        maxNewDataItemIndexedAt: dataItemStats.max_new_indexed_at,
        maxStableDataItemIndexedAt: dataItemStats.max_stable_indexed_at,
      },
      errors,
      warnings,
    };
  }

  saveDataContentAttributes({
    id,
    parentId,
    dataRoot,
    hash,
    dataSize,
    contentType,
    cachedAt,
    verified,
  }: {
    id: string;
    parentId?: string;
    dataRoot?: string;
    hash: string;
    dataSize: number;
    contentType?: string;
    cachedAt?: number;
    verified?: boolean;
  }) {
    const hashBuffer = fromB64Url(hash);
    const currentTimestamp = currentUnixTimestamp();
    const isVerified = verified ? 1 : 0;

    this.stmts.data.insertDataId.run({
      id: fromB64Url(id),
      parent_id: parentId ? fromB64Url(parentId) : null,
      contiguous_data_hash: hashBuffer,
      indexed_at: currentTimestamp,
      verified: isVerified,
      verified_at: currentTimestamp,
    });

    if (dataRoot !== undefined) {
      this.stmts.data.insertDataRoot.run({
        data_root: fromB64Url(dataRoot),
        contiguous_data_hash: hashBuffer,
        indexed_at: currentTimestamp,
        verified: isVerified,
        verified_at: currentTimestamp,
      });
    }

    if (this.insertDataHashCache.get(hash)) {
      return;
    }
    this.insertDataHashCache.set(hash, true);

    this.stmts.data.insertDataHash.run({
      hash: hashBuffer,
      data_size: dataSize,
      original_source_content_type: contentType,
      indexed_at: currentTimestamp,
      cached_at: cachedAt,
    });
  }

  getGqlNewTransactionTags(txId: Buffer) {
    const tags = this.stmts.core.selectNewTransactionTags.all({
      transaction_id: txId,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlNewDataItemTags(id: Buffer) {
    const tags = this.stmts.bundles.selectNewDataItemTags.all({
      id: id,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlStableTransactionTags(txId: Buffer) {
    const tags = this.stmts.core.selectStableTransactionTags.all({
      transaction_id: txId,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlStableDataItemTags(id: Buffer) {
    const tags = this.stmts.bundles.selectStableDataItemTags.all({
      id: id,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlNewTransactionsBaseSql() {
    return sql
      .select()
      .distinct(
        'nt.height AS height',
        'nbt.block_transaction_index AS block_transaction_index',
        "x'00' AS data_item_id",
        'nt.indexed_at AS indexed_at',
        'id',
        'last_tx AS anchor',
        'signature',
        'target',
        'CAST(reward AS TEXT) AS reward',
        'CAST(quantity AS TEXT) AS quantity',
        'CAST(data_size AS TEXT) AS data_size',
        'content_type',
        'owner_address',
        'public_modulus',
        'nb.indep_hash AS block_indep_hash',
        'nb.block_timestamp AS block_timestamp',
        'nb.previous_block AS block_previous_block',
        "'' AS parent_id",
      )
      .from('new_transactions nt')
      .leftJoin('new_block_transactions nbt', {
        'nbt.transaction_id': 'nt.id',
      })
      .leftJoin('new_blocks nb', {
        'nb.indep_hash': 'nbt.block_indep_hash',
      })
      .join('wallets w', {
        'nt.owner_address': 'w.address',
      });
  }

  getGqlNewDataItemsBaseSql() {
    return sql
      .select()
      .distinct(
        'ndi.height AS height',
        'nbt.block_transaction_index AS block_transaction_index',
        'id AS data_item_id',
        'ndi.indexed_at AS indexed_at',
        'id',
        'anchor',
        'signature',
        'target',
        "'' AS reward",
        "'' AS quantity",
        'CAST(data_size AS TEXT) AS data_size',
        'content_type',
        'owner_address',
        'public_modulus',
        'nb.indep_hash AS block_indep_hash',
        'nb.block_timestamp AS block_timestamp',
        'nb.previous_block AS block_previous_block',
        'ndi.parent_id',
      )
      .from('new_data_items ndi')
      .leftJoin('new_block_transactions nbt', {
        'nbt.transaction_id': 'ndi.root_transaction_id',
      })
      .leftJoin('new_blocks nb', {
        'nb.indep_hash': 'nbt.block_indep_hash',
      })
      .join('bundles.wallets w', {
        'ndi.owner_address': 'w.address',
      });
  }

  getGqlStableTransactionsBaseSql() {
    return sql
      .select()
      .distinct(
        'st.height AS height',
        'st.block_transaction_index AS block_transaction_index',
        "x'00' AS data_item_id",
        '0 AS indexed_at',
        'id',
        'last_tx AS anchor',
        'signature',
        'target',
        'CAST(reward AS TEXT) AS reward',
        'CAST(quantity AS TEXT) AS quantity',
        'CAST(data_size AS TEXT) AS data_size',
        'content_type',
        'owner_address',
        'public_modulus',
        'sb.indep_hash AS block_indep_hash',
        'sb.block_timestamp AS block_timestamp',
        'sb.previous_block AS block_previous_block',
        "'' AS parent_id",
      )
      .from('stable_transactions st')
      .join('stable_blocks sb', {
        'st.height': 'sb.height',
      })
      .join('wallets w', {
        'st.owner_address': 'w.address',
      });
  }

  getGqlStableDataItemsBaseSql() {
    return sql
      .select()
      .distinct(
        'sdi.height AS height',
        'sdi.block_transaction_index AS block_transaction_index',
        'sdi.id AS data_item_id',
        'sdi.indexed_at AS indexed_at',
        'id',
        'anchor',
        'signature',
        'target',
        "'' AS reward",
        "'' AS quantity",
        'CAST(data_size AS TEXT) AS data_size',
        'content_type',
        'owner_address',
        'public_modulus',
        'sb.indep_hash AS block_indep_hash',
        'sb.block_timestamp AS block_timestamp',
        'sb.previous_block AS block_previous_block',
        'sdi.parent_id',
      )
      .from('bundles.stable_data_items sdi')
      .join('stable_blocks sb', {
        'sdi.height': 'sb.height',
      })
      .join('bundles.wallets w', {
        'sdi.owner_address': 'w.address',
      });
  }

  addGqlTransactionFilters({
    query,
    source,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    query: sql.SelectStatement;
    source: 'stable_txs' | 'stable_items' | 'new_txs' | 'new_items';
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[] | null;
    tags: { name: string; values: string[] }[];
  }) {
    let txTableAlias: string;
    let heightTableAlias: string;
    let blockTransactionIndexTableAlias: string;
    let tagsTable: string;
    let tagIdColumn: string;
    let tagJoinIndex: string;
    let heightSortTableAlias: string;
    let blockTransactionIndexSortTableAlias: string;
    let dataItemSortTableAlias: string | undefined = undefined;
    let maxDbHeight = Infinity;

    if (source === 'stable_txs') {
      txTableAlias = 'st';
      heightTableAlias = 'st';
      blockTransactionIndexTableAlias = 'st';
      tagsTable = 'stable_transaction_tags';
      tagIdColumn = 'transaction_id';
      tagJoinIndex = 'stable_transaction_tags_transaction_id_idx';
      heightSortTableAlias = 'st';
      blockTransactionIndexSortTableAlias = 'st';
      maxDbHeight = this.stmts.core.selectMaxStableBlockHeight.get()
        .height as number;
    } else if (source === 'stable_items') {
      txTableAlias = 'sdi';
      heightTableAlias = 'sdi';
      blockTransactionIndexTableAlias = 'sdi';
      tagsTable = 'stable_data_item_tags';
      tagIdColumn = 'data_item_id';
      tagJoinIndex = 'stable_data_item_tags_data_item_id_idx';
      heightSortTableAlias = 'sdi';
      blockTransactionIndexSortTableAlias = 'sdi';
      maxDbHeight = this.stmts.core.selectMaxStableBlockHeight.get()
        .height as number;
    } else if (source === 'new_txs') {
      txTableAlias = 'nt';
      heightTableAlias = 'nt';
      blockTransactionIndexTableAlias = 'nbt';
      tagsTable = 'new_transaction_tags';
      tagIdColumn = 'transaction_id';
      heightSortTableAlias = 'nt';
      blockTransactionIndexSortTableAlias = 'nbt';
    } else {
      txTableAlias = 'ndi';
      heightTableAlias = 'ndi';
      blockTransactionIndexTableAlias = 'nbt';
      tagsTable = 'new_data_item_tags';
      tagIdColumn = 'data_item_id';
      heightSortTableAlias = 'ndi';
      blockTransactionIndexSortTableAlias = 'nbt';
    }

    if (ids?.length > 0) {
      query.where(sql.in(`${txTableAlias}.id`, ids.map(fromB64Url)));
    }

    if (recipients?.length > 0) {
      query.where(sql.in(`${txTableAlias}.target`, recipients.map(fromB64Url)));
    }

    if (owners?.length > 0) {
      query.where(
        sql.in(`${txTableAlias}.owner_address`, owners.map(fromB64Url)),
      );
    }

    if (tags) {
      // Order tag joins by selectivity (most selective first) to narrow
      // results as early as possible
      const sortByTagSelectivity = R.sortBy(
        (tag: { name: string; values: string[] }) => {
          return -(this.tagSelectivity[tag.name] ?? 0);
        },
      );
      sortByTagSelectivity(tags).forEach((tag, index) => {
        const tagAlias = `"${index}_${index}"`;
        let joinCond: { [key: string]: string };
        if (source === 'stable_txs' || source === 'stable_items') {
          if (index === 0) {
            if (
              // Order results by selective tags ...
              this.tagSelectivity[tag.name] >= 0 ||
              // ... or non-selective tags if neither recipients nor owners
              // were specified
              (recipients?.length === 0 && owners?.length === 0)
            ) {
              heightSortTableAlias = tagAlias;
              blockTransactionIndexSortTableAlias = tagAlias;
              dataItemSortTableAlias = tagAlias;
            }
            joinCond = {
              [`${blockTransactionIndexTableAlias}.block_transaction_index`]: `${tagAlias}.block_transaction_index`,
              [`${heightTableAlias}.height`]: `${tagAlias}.height`,
            };
            if (source === 'stable_items') {
              joinCond[`${txTableAlias}.id`] = `${tagAlias}.${tagIdColumn}`;
            }

            query.join(`${tagsTable} AS ${tagAlias}`, joinCond);
          } else {
            const previousTagAlias = `"${index - 1}_${index - 1}"`;
            query.where(
              `${tagAlias}.${tagIdColumn}`,
              sql(`${previousTagAlias}.${tagIdColumn}`),
            );

            // We want the user to be able to control join order, so we use a
            // CROSS JOIN to force it. We also force the use of the ID based
            // index since we know it's always a reasonable choice and the
            // optimizer will sometimes make very bad choices if we don't.
            query.crossJoin(
              `${tagsTable} AS ${tagAlias} INDEXED BY ${tagJoinIndex}`,
            );
          }
        } else {
          joinCond = {
            [`${txTableAlias}.id`]: `${tagAlias}.${tagIdColumn}`,
          };

          query.join(`${tagsTable} AS ${tagAlias}`, joinCond);
        }

        const nameHash = crypto
          .createHash('sha1')
          .update(Buffer.from(tag.name, 'utf8'))
          .digest();
        query.where({ [`${tagAlias}.tag_name_hash`]: nameHash });

        query.where(
          sql.in(
            `${tagAlias}.tag_value_hash`,
            tag.values.map((value) => {
              return crypto
                .createHash('sha1')
                .update(Buffer.from(value, 'utf8'))
                .digest();
            }),
          ),
        );
      });
    }

    if (minHeight != null && minHeight > 0) {
      query.where(sql.gte(`${heightSortTableAlias}.height`, minHeight));
    }

    if (maxHeight != null && maxHeight >= 0 && maxHeight < maxDbHeight) {
      query.where(sql.lte(`${heightSortTableAlias}.height`, maxHeight));
    }

    if (
      Array.isArray(bundledIn) &&
      (source === 'stable_items' || source === 'new_items')
    ) {
      query.where(
        sql.in(`${txTableAlias}.parent_id`, bundledIn.map(fromB64Url)),
      );
    }

    const {
      height: cursorHeight,
      blockTransactionIndex: cursorBlockTransactionIndex,
      dataItemId: cursorDataItemId,
      indexedAt: cursorIndexedAt,
      id: cursorId,
    } = decodeTransactionGqlCursor(cursor);

    if (sortOrder === 'HEIGHT_DESC') {
      if (
        ['new_txs', 'new_items'].includes(source) &&
        cursorHeight == null &&
        cursorIndexedAt != null
      ) {
        query.where(
          sql.or(
            sql.and(
              // indexed_at is only considered when the height is null
              sql.isNull(`${heightSortTableAlias}.height`),
              sql.or(
                // If the indexed_at is less than the cursor, the ID is not
                // considered
                sql.lt(`${txTableAlias}.indexed_at`, cursorIndexedAt),
                sql.and(
                  // If the indexedAt is the same as the cursor, the ID is
                  // compared
                  sql.lte(`${txTableAlias}.indexed_at`, cursorIndexedAt),
                  sql.lt(
                    'id',
                    cursorId ? fromB64Url(cursorId) : Buffer.from([0]),
                  ),
                ),
              ),
            ),
            // Non-null heights are always after pending transactions and data
            // items when sorting in descending order
            sql.isNotNull(`${heightSortTableAlias}.height`),
          ),
        );
      } else if (cursorHeight != null && cursorBlockTransactionIndex != null) {
        let dataItemIdField = source === 'stable_items' ? 'sdi.id' : "x'00'";
        query.where(
          sql.lte(`${heightSortTableAlias}.height`, cursorHeight),
          sql.or(
            sql.lt(`${heightSortTableAlias}.height`, cursorHeight),
            sql.and(
              sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
              sql.lt(
                `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
                cursorBlockTransactionIndex,
              ),
            ),
            sql.and(
              sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
              sql.eq(
                `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
                cursorBlockTransactionIndex,
              ),
              sql.lt(
                dataItemIdField,
                cursorDataItemId
                  ? fromB64Url(cursorDataItemId)
                  : Buffer.from([0]),
              ),
            ),
          ),
        );
      }
      let orderBy = `${heightSortTableAlias}.height DESC NULLS FIRST`;
      orderBy += `, ${blockTransactionIndexSortTableAlias}.block_transaction_index DESC NULLS FIRST`;
      if (source === 'stable_items' && dataItemSortTableAlias !== undefined) {
        orderBy += `, ${dataItemSortTableAlias}.data_item_id DESC`;
      } else {
        orderBy += `, 3 DESC`;
      }
      orderBy += `, indexed_at DESC`;
      orderBy += `, 5 DESC`;
      query.orderBy(orderBy);
    } else {
      if (
        ['new_txs', 'new_items'].includes(source) &&
        cursorHeight == null &&
        cursorIndexedAt != null
      ) {
        query.where(
          // indexed_at is only considered when the height is null
          sql.isNull(`${heightSortTableAlias}.height`),
          sql.or(
            // If the indexed_at is greater than the cursor, the ID is not
            // considered
            sql.gt(`${txTableAlias}.indexed_at`, cursorIndexedAt),
            sql.and(
              // If the indexed_at is the same as the cursor, the ID is
              // compared
              sql.gte(`${txTableAlias}.indexed_at`, cursorIndexedAt),
              sql.gt('id', cursorId ? fromB64Url(cursorId) : Buffer.from([0])),
            ),
          ),
        );
      } else if (
        cursorHeight != undefined &&
        cursorBlockTransactionIndex != undefined
      ) {
        let dataItemIdField = source === 'stable_items' ? 'sdi.id' : "x'00'";
        query.where(
          sql.gte(`${heightSortTableAlias}.height`, cursorHeight),
          sql.or(
            sql.gt(`${heightSortTableAlias}.height`, cursorHeight),
            sql.and(
              sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
              sql.gt(
                `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
                cursorBlockTransactionIndex,
              ),
            ),
            sql.and(
              sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
              sql.eq(
                `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
                cursorBlockTransactionIndex,
              ),
              sql.gt(
                dataItemIdField,
                cursorDataItemId
                  ? fromB64Url(cursorDataItemId)
                  : Buffer.from([0]),
              ),
            ),
          ),
        );
      }
      let orderBy = `${heightSortTableAlias}.height ASC NULLS LAST`;
      orderBy += `, ${blockTransactionIndexSortTableAlias}.block_transaction_index ASC NULLS LAST`;
      if (source === 'stable_items' && dataItemSortTableAlias !== undefined) {
        orderBy += `, ${dataItemSortTableAlias}.data_item_id ASC`;
      } else {
        orderBy += `, 3 ASC`;
      }
      orderBy += `, indexed_at ASC`;
      orderBy += `, 5 ASC`;
      query.orderBy(orderBy);
    }
  }

  getGqlNewTransactions({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[] | null;
    tags?: { name: string; values: string[] }[];
  }): GqlTransaction[] {
    const txsQuery = this.getGqlNewTransactionsBaseSql();

    this.addGqlTransactionFilters({
      query: txsQuery,
      source: 'new_txs',
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      tags,
    });

    const txsQueryParams = txsQuery.toParams();
    const txsSql = txsQueryParams.text;
    const txsFinalSql = `${txsSql} LIMIT ${pageSize + 1}`;

    const itemsQuery = this.getGqlNewDataItemsBaseSql();

    this.addGqlTransactionFilters({
      query: itemsQuery,
      source: 'new_items',
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      bundledIn,
      tags,
    });

    const itemsQueryParams = itemsQuery.toParams();
    const itemsSql = itemsQueryParams.text;
    const itemsFinalSql = `${itemsSql} LIMIT ${pageSize + 1}`;

    const sqlSortOrder = sortOrder === 'HEIGHT_DESC' ? 'DESC' : 'ASC';
    const sqlParts = [];
    if (bundledIn === undefined || bundledIn === null) {
      sqlParts.push(`SELECT * FROM (${txsFinalSql})`);
    }
    if (bundledIn === undefined) {
      sqlParts.push('UNION');
    }
    if (bundledIn === undefined || Array.isArray(bundledIn)) {
      sqlParts.push(`SELECT * FROM (${itemsFinalSql})`);
    }

    sqlParts.push(
      `ORDER BY 1 ${sqlSortOrder}, 2 ${sqlSortOrder}, 3 ${sqlSortOrder}, 4 ${sqlSortOrder}, 5 ${sqlSortOrder}`,
    );
    sqlParts.push(`LIMIT ${pageSize + 1}`);
    const sql = sqlParts.join(' ');
    const sqliteParams = toSqliteParams(itemsQueryParams);

    this.log.debug('Querying new transactions...', { sql, sqliteParams });

    return this.dbs.core
      .prepare(sql)
      .all(sqliteParams)
      .map((tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        dataItemId: tx.data_item_id ? toB64Url(tx.data_item_id) : null,
        indexedAt: tx.indexed_at,
        id: toB64Url(tx.id),
        anchor: toB64Url(tx.anchor),
        signature: tx.signature !== null ? toB64Url(tx.signature) : null,
        recipient: tx.target ? toB64Url(tx.target) : null,
        ownerAddress: toB64Url(tx.owner_address),
        ownerKey: toB64Url(tx.public_modulus),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        tags:
          tx.data_item_id.length > 1
            ? this.getGqlNewDataItemTags(tx.id)
            : this.getGqlNewTransactionTags(tx.id),
        contentType: tx.content_type,
        blockIndepHash: tx.block_indep_hash
          ? toB64Url(tx.block_indep_hash)
          : null,
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: tx.block_previous_block
          ? toB64Url(tx.block_previous_block)
          : null,
        parentId: tx.parent_id ? toB64Url(tx.parent_id) : null,
        isDataItem: tx.data_item_id.length > 1,
      }));
  }

  getGqlStableTransactions({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[] | null;
    tags?: { name: string; values: string[] }[];
  }): GqlTransaction[] {
    const txsQuery = this.getGqlStableTransactionsBaseSql();

    this.addGqlTransactionFilters({
      query: txsQuery,
      source: 'stable_txs',
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      bundledIn,
      tags,
    });

    const txsQueryParams = txsQuery.toParams();
    const txsSql = txsQueryParams.text;
    const txsFinalSql = `${txsSql} LIMIT ${pageSize + 1}`;

    const itemsQuery = this.getGqlStableDataItemsBaseSql();

    this.addGqlTransactionFilters({
      query: itemsQuery,
      source: 'stable_items',
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      bundledIn,
      tags,
    });

    const itemsQueryParams = itemsQuery.toParams();
    const itemsSql = itemsQueryParams.text;
    const itemsFinalSql = `${itemsSql} LIMIT ${pageSize + 1}`;

    const sqlSortOrder = sortOrder === 'HEIGHT_DESC' ? 'DESC' : 'ASC';
    const sqlParts = [];
    if (bundledIn === undefined || bundledIn === null) {
      sqlParts.push(`SELECT * FROM (${txsFinalSql})`);
    }
    if (bundledIn === undefined) {
      sqlParts.push('UNION');
    }
    if (bundledIn === undefined || Array.isArray(bundledIn)) {
      sqlParts.push(`SELECT * FROM (${itemsFinalSql})`);
    }
    sqlParts.push(
      `ORDER BY 1 ${sqlSortOrder}, 2 ${sqlSortOrder}, 3 ${sqlSortOrder}`,
    );
    sqlParts.push(`LIMIT ${pageSize + 1}`);
    const sql = sqlParts.join(' ');
    const sqliteParams = toSqliteParams(itemsQueryParams);

    this.log.debug('Querying stable transactions...', { sql, sqliteParams });

    return this.dbs.core
      .prepare(sql)
      .all(sqliteParams)
      .map((tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        dataItemId: tx.data_item_id ? toB64Url(tx.data_item_id) : null,
        indexedAt: tx.indexed_at,
        id: toB64Url(tx.id),
        anchor: toB64Url(tx.anchor),
        signature: tx.signature !== null ? toB64Url(tx.signature) : null,
        recipient: tx.target ? toB64Url(tx.target) : null,
        ownerAddress: toB64Url(tx.owner_address),
        ownerKey: toB64Url(tx.public_modulus),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        tags:
          tx.data_item_id.length > 1
            ? this.getGqlStableDataItemTags(tx.id)
            : this.getGqlStableTransactionTags(tx.id),
        contentType: tx.content_type,
        blockIndepHash: toB64Url(tx.block_indep_hash),
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: toB64Url(tx.block_previous_block),
        parentId: tx.parent_id ? toB64Url(tx.parent_id) : null,
        isDataItem: tx.data_item_id.length > 1,
      }));
  }

  getGqlTransactions({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[] | null;
    tags?: { name: string; values: string[] }[];
  }) {
    let txs: GqlTransaction[] = [];

    if (sortOrder === 'HEIGHT_DESC') {
      txs = this.getGqlNewTransactions({
        pageSize,
        cursor,
        sortOrder,
        ids,
        recipients,
        owners,
        minHeight,
        maxHeight,
        bundledIn,
        tags,
      });

      if (txs.length < pageSize) {
        const lastTxHeight = txs[txs.length - 1]?.height;
        txs = txs.concat(
          this.getGqlStableTransactions({
            pageSize,
            cursor,
            sortOrder,
            ids,
            recipients,
            owners,
            minHeight,
            maxHeight:
              txs.length > 0 && lastTxHeight ? lastTxHeight - 1 : maxHeight,
            bundledIn,
            tags,
          }),
        );
      }
    } else {
      txs = this.getGqlStableTransactions({
        pageSize,
        cursor,
        sortOrder,
        ids,
        recipients,
        owners,
        minHeight,
        maxHeight,
        bundledIn,
        tags,
      });

      if (txs.length < pageSize) {
        const lastTxHeight = txs[txs.length - 1]?.height;
        txs = txs.concat(
          this.getGqlNewTransactions({
            pageSize,
            cursor,
            sortOrder,
            ids,
            recipients,
            owners,
            minHeight:
              txs.length > 0 && lastTxHeight ? lastTxHeight : minHeight,
            maxHeight,
            bundledIn,
            tags,
          }),
        );
      }
    }

    return {
      pageInfo: {
        hasNextPage: txs.length > pageSize,
      },
      edges: txs.slice(0, pageSize).map((tx) => {
        return {
          cursor: encodeTransactionGqlCursor(tx),
          node: tx,
        };
      }),
    };
  }

  getGqlTransaction({ id }: { id: string }): GqlTransaction {
    let tx = this.getGqlStableTransactions({ pageSize: 1, ids: [id] })[0];
    if (!tx) {
      tx = this.getGqlNewTransactions({ pageSize: 1, ids: [id] })[0];
    }

    return tx;
  }

  getGqlStableBlocksBaseSql() {
    return sql
      .select(
        'b.indep_hash AS id',
        'b.previous_block AS previous',
        'b.block_timestamp AS "timestamp"',
        'b.height AS height',
      )
      .from('stable_blocks AS b');
  }

  getGqlNewBlocksBaseSql() {
    return sql
      .select(
        'b.indep_hash AS id',
        'b.previous_block AS previous',
        'b.block_timestamp AS "timestamp"',
        'b.height AS height',
      )
      .from('new_blocks AS b');
  }

  addGqlBlockFilters({
    query,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    minHeight = -1,
    maxHeight = -1,
  }: {
    query: sql.SelectStatement;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    if (ids.length > 0) {
      query.where(
        sql.in(
          'b.indep_hash',
          ids.map((id) => fromB64Url(id)),
        ),
      );
    }

    if (minHeight != null && minHeight >= 0) {
      query.where(sql.gte('b.height', minHeight));
    }

    if (maxHeight != null && maxHeight >= 0) {
      query.where(sql.lte('b.height', maxHeight));
    }

    const { height: cursorHeight } = decodeBlockGqlCursor(cursor);

    if (sortOrder === 'HEIGHT_DESC') {
      if (cursorHeight) {
        query.where(sql.lt('b.height', cursorHeight));
      }
      query.orderBy('b.height DESC');
    } else {
      if (cursorHeight) {
        query.where(sql.gt('b.height', cursorHeight));
      }
      query.orderBy('b.height ASC');
    }
  }

  getGqlNewBlocks({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    minHeight = -1,
    maxHeight = -1,
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    const query = this.getGqlNewBlocksBaseSql();

    this.addGqlBlockFilters({
      query,
      cursor,
      sortOrder,
      ids,
      minHeight,
      maxHeight,
    });

    const queryParams = query.toParams();
    const sql = queryParams.text;
    const sqliteParams = toSqliteParams(queryParams);

    this.log.debug('Querying new blocks...', { sql, sqliteParams });

    const blocks = this.dbs.core
      .prepare(`${sql} LIMIT ${pageSize + 1}`)
      .all(sqliteParams)
      .map((block) => ({
        id: toB64Url(block.id),
        timestamp: block.timestamp,
        height: block.height,
        previous: toB64Url(block.previous),
      }));

    return blocks;
  }

  getGqlStableBlocks({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    minHeight = -1,
    maxHeight = -1,
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    const query = this.getGqlStableBlocksBaseSql();

    this.addGqlBlockFilters({
      query,
      cursor,
      sortOrder,
      ids,
      minHeight,
      maxHeight,
    });

    const queryParams = query.toParams();
    const sql = queryParams.text;
    const sqliteParams = toSqliteParams(queryParams);

    this.log.debug('Querying stable blocks...', { sql, sqliteParams });

    return this.dbs.core
      .prepare(`${sql} LIMIT ${pageSize + 1}`)
      .all(sqliteParams)
      .map((block) => ({
        id: toB64Url(block.id),
        timestamp: block.timestamp,
        height: block.height,
        previous: toB64Url(block.previous),
      }));
  }

  getGqlBlocks({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    minHeight = -1,
    maxHeight = -1,
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    let blocks;

    if (sortOrder === 'HEIGHT_DESC') {
      blocks = this.getGqlNewBlocks({
        pageSize,
        cursor,
        sortOrder,
        ids,
        minHeight,
        maxHeight,
      });

      if (blocks.length < pageSize) {
        blocks = blocks.concat(
          this.getGqlStableBlocks({
            pageSize,
            cursor,
            sortOrder,
            ids,
            minHeight,
            maxHeight:
              blocks.length > 0
                ? blocks[blocks.length - 1].height - 1
                : maxHeight,
          }),
        );
      }
    } else {
      blocks = this.getGqlStableBlocks({
        pageSize,
        cursor,
        sortOrder,
        ids,
        minHeight,
        maxHeight,
      });

      if (blocks.length < pageSize) {
        blocks = blocks.concat(
          this.getGqlNewBlocks({
            pageSize,
            cursor,
            sortOrder,
            ids,
            minHeight:
              blocks.length > 0
                ? blocks[blocks.length - 1].height + 1
                : minHeight,
            maxHeight,
          }),
        );
      }
    }

    return {
      pageInfo: {
        hasNextPage: blocks.length > pageSize,
      },
      edges: blocks.slice(0, pageSize).map((block) => {
        return {
          cursor: encodeBlockGqlCursor(block),
          node: block,
        };
      }),
    };
  }

  getGqlBlock({ id }: { id: string }) {
    let block = this.getGqlStableBlocks({ pageSize: 1, ids: [id] })[0];
    if (!block) {
      block = this.getGqlNewBlocks({ pageSize: 1, ids: [id] })[0];
    }

    return block;
  }

  isIdBlocked(id: string | undefined): boolean {
    if (typeof id === 'string' && id.length > 0) {
      const row = this.stmts.moderation.isIdBlocked.get({
        id: fromB64Url(id),
      });
      return row?.is_blocked === 1;
    }
    return false;
  }

  isHashBlocked(hash: string | undefined): boolean {
    if (typeof hash === 'string' && hash.length > 0) {
      const row = this.stmts.moderation.isHashBlocked.get({
        hash: fromB64Url(hash),
      });
      return row?.is_blocked === 1;
    }
    return false;
  }

  isNameBlocked(name: string): boolean {
    if (name.length > 0) {
      const row = this.stmts.moderation.isNameBlocked.get({
        name,
      });
      return row?.is_blocked === 1;
    }
    return false;
  }

  getBlockedNames(): string[] {
    return this.stmts.moderation.selectBlockedNames
      .all()
      .map((row) => row.name);
  }

  blockData({
    id,
    hash,
    source,
    notes,
  }: {
    id?: string;
    hash?: string;
    source?: string;
    notes?: string;
  }) {
    let sourceId = undefined;
    if (source !== undefined) {
      this.stmts.moderation.insertSource.run({
        name: source,
        created_at: currentUnixTimestamp(),
      });
      sourceId = this.stmts.moderation.getSourceByName.get({
        name: source,
      })?.id;
    }
    if (id !== undefined) {
      this.stmts.moderation.insertBlockedId.run({
        id: fromB64Url(id),
        block_source_id: sourceId,
        notes,
        blocked_at: currentUnixTimestamp(),
      });
    } else if (hash !== undefined) {
      this.stmts.moderation.insertBlockedHash.run({
        hash: fromB64Url(hash),
        block_source_id: sourceId,
        notes,
        blocked_at: currentUnixTimestamp(),
      });
    }
  }

  blockName({
    name,
    source,
    notes,
  }: {
    name: string;
    source?: string;
    notes?: string;
  }) {
    let sourceId = undefined;
    if (source !== undefined) {
      this.stmts.moderation.insertSource.run({
        name: source,
        created_at: currentUnixTimestamp(),
      });
      sourceId = this.stmts.moderation.getSourceByName.get({
        name: source,
      })?.id;
    }

    this.stmts.moderation.insertBlockedName.run({
      name,
      block_source_id: sourceId,
      notes,
      blocked_at: currentUnixTimestamp(),
    });
  }

  unblockName({ name }: { name: string }) {
    this.stmts.moderation.deleteBlockedName.run({ name });
  }

  async saveNestedDataId({
    id,
    parentId,
    dataOffset,
    dataSize,
  }: {
    id: string;
    parentId: string;
    dataOffset: number;
    dataSize: number;
  }) {
    this.stmts.data.insertNestedDataId.run({
      id: fromB64Url(id),
      parent_id: fromB64Url(parentId),
      data_offset: dataOffset,
      data_size: dataSize,
      indexed_at: currentUnixTimestamp(),
    });
  }

  async saveNestedDataHash({
    hash,
    parentId,
    dataOffset,
  }: {
    hash: string;
    parentId: string;
    dataOffset: number;
  }) {
    this.stmts.data.insertNestedDataHash.run({
      hash: fromB64Url(hash),
      parent_id: fromB64Url(parentId),
      data_offset: dataOffset,
      indexed_at: currentUnixTimestamp(),
    });
  }

  getVerifiableDataIds() {
    const dataIds = this.stmts.data.selectVerifiableContiguousDataIds.all();
    return dataIds.map((row) => toB64Url(row.id));
  }

  getRootTxId(id: string) {
    const row = this.stmts.core.selectRootTxId.get({ id: fromB64Url(id) });
    if (row.root_transaction_id) {
      return toB64Url(row.root_transaction_id);
    }

    return;
  }

  async saveVerificationStatus(id: string) {
    this.stmts.data.updateDataItemVerificationStatus.run({
      id: fromB64Url(id),
      verified_at: currentUnixTimestamp(),
    });
  }

  cleanupWal(dbName: 'core' | 'bundles' | 'data' | 'moderation') {
    const walCheckpoint = this.dbs[dbName].pragma('wal_checkpoint(TRUNCATE)');

    return walCheckpoint[0];
  }

  pruneStableDataItems(indexedAtThreshold: number) {
    this.stmts.bundles.deleteStableDataItemsLessThanIndexedAt.run({
      indexed_at_threshold: indexedAtThreshold,
    });
  }
}

type WorkerPoolName =
  | 'core'
  | 'data'
  | 'gql'
  | 'debug'
  | 'moderation'
  | 'bundles';
const WORKER_POOL_NAMES: Array<WorkerPoolName> = [
  'core',
  'data',
  'gql',
  'debug',
  'moderation',
  'bundles',
];

type WorkerMethodName = keyof StandaloneSqliteDatabaseWorker;

type WorkerRoleName = 'read' | 'write';
const WORKER_ROLE_NAMES: Array<WorkerRoleName> = ['read', 'write'];

type WorkerPoolSizes = {
  [key in WorkerPoolName]: { [key in WorkerRoleName]: number };
};
const WORKER_POOL_SIZES: WorkerPoolSizes = {
  core: { read: 1, write: 1 },
  data: { read: 2, write: 1 },
  gql: { read: Math.min(CPU_COUNT, MAX_WORKER_COUNT), write: 0 },
  debug: { read: 1, write: 0 },
  moderation: { read: 1, write: 1 },
  bundles: { read: 1, write: 1 },
};

export class StandaloneSqliteDatabase
  implements
    BundleIndex,
    DataBlockListValidator,
    NameBlockListValidator,
    ChainIndex,
    ChainOffsetIndex,
    ContiguousDataIndex,
    GqlQueryable,
    NestedDataIndexWriter
{
  log: winston.Logger;

  private workers: {
    core: { read: any[]; write: any[] };
    data: { read: any[]; write: any[] };
    gql: { read: any[]; write: any[] };
    debug: { read: any[]; write: any[] };
    moderation: { read: any[]; write: any[] };
    bundles: { read: any[]; write: any[] };
  } = {
    core: { read: [], write: [] },
    data: { read: [], write: [] },
    gql: { read: [], write: [] },
    debug: { read: [], write: [] },
    moderation: { read: [], write: [] },
    bundles: { read: [], write: [] },
  };
  private workQueues: {
    core: { read: any[]; write: any[] };
    data: { read: any[]; write: any[] };
    gql: { read: any[]; write: any[] };
    debug: { read: any[]; write: any[] };
    moderation: { read: any[]; write: any[] };
    bundles: { read: any[]; write: any[] };
  } = {
    core: { read: [], write: [] },
    data: { read: [], write: [] },
    gql: { read: [], write: [] },
    debug: { read: [], write: [] },
    moderation: { read: [], write: [] },
    bundles: { read: [], write: [] },
  };

  // Data index circuit breakers
  private getDataParentCircuitBreaker: CircuitBreaker<
    Parameters<StandaloneSqliteDatabase['getDataParent']>,
    Awaited<ReturnType<StandaloneSqliteDatabase['getDataParent']>>
  >;
  private getDataAttributesCircuitBreaker: CircuitBreaker<
    Parameters<StandaloneSqliteDatabase['getDataAttributes']>,
    Awaited<ReturnType<StandaloneSqliteDatabase['getDataAttributes']>>
  >;

  private getDataItemAttributesCircuitBreaker: CircuitBreaker<
    Parameters<StandaloneSqliteDatabase['getDataItemAttributes']>,
    Awaited<ReturnType<StandaloneSqliteDatabase['getDataItemAttributes']>>
  >;

  private getTransactionAttributesCircuitBreaker: CircuitBreaker<
    Parameters<StandaloneSqliteDatabase['getTransactionAttributes']>,
    Awaited<ReturnType<StandaloneSqliteDatabase['getTransactionAttributes']>>
  >;

  private saveDataContentAttributesCache: NodeCache;

  private newDataItemsCount: number = 0;
  private lastFlushDataItemsTime: number = Date.now();

  constructor({
    log,
    coreDbPath,
    dataDbPath,
    moderationDbPath,
    bundlesDbPath,
    tagSelectivity,
  }: {
    log: winston.Logger;
    coreDbPath: string;
    dataDbPath: string;
    moderationDbPath: string;
    bundlesDbPath: string;
    tagSelectivity: Record<string, number>;
  }) {
    this.log = log.child({ class: `${this.constructor.name}` });

    //
    // Initialize data index circuit breakers
    //

    const dataIndexCircuitBreakerOptions = {
      timeout: config.GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage: 50,
      rollingCountTimeout: 5000,
      resetTimeout: 10000,
    };

    this.getDataParentCircuitBreaker = new CircuitBreaker(
      (id: string) => {
        return this.queueRead('data', `getDataParent`, [id]);
      },
      {
        name: 'getDataParent',
        ...dataIndexCircuitBreakerOptions,
      },
    );

    this.getDataAttributesCircuitBreaker = new CircuitBreaker(
      (id: string) => {
        return this.queueRead('data', `getDataAttributes`, [id]);
      },
      {
        name: 'getDataAttributes',
        ...dataIndexCircuitBreakerOptions,
      },
    );

    this.getDataItemAttributesCircuitBreaker = new CircuitBreaker(
      (id: string) => {
        return this.queueRead('bundles', `getDataItemAttributes`, [id]);
      },
      {
        name: 'getDataItemAttributes',
        ...dataIndexCircuitBreakerOptions,
      },
    );

    this.getTransactionAttributesCircuitBreaker = new CircuitBreaker(
      (id: string) => {
        return this.queueRead('core', `getTransactionAttributes`, [id]);
      },
      {
        name: 'getTransactionAttributes',
        ...dataIndexCircuitBreakerOptions,
      },
    );

    metrics.circuitBreakerMetrics.add([
      this.getDataParentCircuitBreaker,
      this.getDataAttributesCircuitBreaker,
      this.getDataItemAttributesCircuitBreaker,
      this.getTransactionAttributesCircuitBreaker,
    ]);

    //
    // Initialize method caches
    //

    this.saveDataContentAttributesCache = new NodeCache({
      stdTTL: 60 * 7, // 7 minutes
      checkperiod: 60, // 1 minute
      useClones: false,
    });

    //
    // Initialize workers
    //

    const self = this;

    function spawn(pool: WorkerPoolName, role: WorkerRoleName) {
      const workerUrl = new URL('./standalone-sqlite.js', import.meta.url);
      const worker = new Worker(workerUrl, {
        workerData: {
          coreDbPath,
          dataDbPath,
          moderationDbPath,
          bundlesDbPath,
          tagSelectivity: tagSelectivity,
        },
      });

      let job: any = null; // Current item from the queue
      let error: any = null; // Error that caused the worker to crash

      function takeWork() {
        if (!job && self.workQueues[pool][role].length) {
          // If there's a job in the queue, send it to the worker
          job = self.workQueues[pool][role].shift();
          worker.postMessage(job.message);
        }
      }

      worker
        .on('online', () => {
          self.workers[pool][role].push({ takeWork });
          takeWork();
        })
        .on('message', async (result) => {
          if (result && result.stack) {
            const { message, stack, workerMethod, workerArgs } = result;
            const error = new DetailedError(message, {
              stack,
              workerMethod,
              workerArgs,
            });
            job.reject(error);
          } else {
            job.resolve(result);
          }
          job = null;
          takeWork(); // Check if there's more work to do
        })
        .on('error', (err) => {
          self.log.error('Worker error', err);
          error = err;
        })
        .on('exit', (code) => {
          self.workers[pool][role] = self.workers[pool][role].filter(
            (w) => w.takeWork !== takeWork,
          );
          if (job) {
            job.reject(error || new Error('worker died'));
          }
          if (code !== 0) {
            self.log.error('Worker stopped with exit code ' + code, {
              exitCode: code,
            });
            spawn(pool, role); // Worker died, so spawn a new one
          }
        });
    }

    WORKER_POOL_NAMES.forEach((pool) => {
      // Spawn readers
      for (let i = 0; i < WORKER_POOL_SIZES[pool].read; i++) {
        spawn(pool, 'read');
      }

      // Spawn writers
      for (let i = 0; i < WORKER_POOL_SIZES[pool].write; i++) {
        spawn(pool, 'write');
      }
    });
  }

  async stop() {
    const log = this.log.child({ method: 'stop' });
    const promises: Promise<void>[] = [];

    for (const pool of WORKER_POOL_NAMES) {
      for (const role of WORKER_ROLE_NAMES) {
        if (this.workers[pool][role] !== undefined) {
          for (const _ of this.workers[pool][role]) {
            if (
              this.workQueues[pool][role] &&
              typeof this.workQueues[pool][role].push === 'function'
            ) {
              log.debug('Creating stop job for worker', { pool, role });
              promises.push(
                new Promise((resolve) => {
                  this.workQueues[pool][role].push({
                    resolve,
                    // by always resolving, we prevent shutdown procedure from
                    // perpetually waiting for a response from the worker
                    reject: resolve,
                    message: {
                      method: 'terminate',
                    },
                  });
                }),
              );
              this.drainQueue();
            }
          }
        }
      }
    }
    await Promise.all(promises);

    log.debug('Stopped successfully.');
  }

  drainQueue() {
    WORKER_POOL_NAMES.forEach((pool) => {
      WORKER_ROLE_NAMES.forEach((role) => {
        for (const worker of this.workers[pool][role]) {
          worker.takeWork();
        }
      });
    });
  }

  queueWork(
    workerName: WorkerPoolName,
    role: WorkerRoleName,
    method: WorkerMethodName,
    args: any,
  ): Promise<any> {
    metrics.sqliteInFlightOps.inc({
      worker: workerName,
      role,
    });
    const end = metrics.sqliteMethodDurationSummary.startTimer({
      worker: workerName,
      role,
      method,
    });
    const ret = new Promise((resolve, reject) => {
      this.workQueues[workerName][role].push({
        resolve,
        reject,
        message: {
          method,
          args,
        },
      });
      this.drainQueue();
    });
    ret.finally(() => {
      metrics.sqliteInFlightOps.dec({
        worker: workerName,
        role,
      });
      end();
    });
    return ret;
  }

  queueRead(
    pool: WorkerPoolName,
    method: WorkerMethodName,
    args: any,
  ): Promise<any> {
    return this.queueWork(pool, 'read', method, args);
  }

  queueWrite(
    pool: WorkerPoolName,
    method: WorkerMethodName,
    args: any,
  ): Promise<any> {
    return this.queueWork(pool, 'write', method, args);
  }

  getMaxHeight(): Promise<number> {
    return this.queueRead('core', 'getMaxHeight', undefined);
  }

  getMaxStableBlockTimestamp(): Promise<number> {
    return this.queueRead('core', 'getMaxStableBlockTimestamp', undefined);
  }

  getBlockHashByHeight(height: number): Promise<string | undefined> {
    return this.queueRead('core', 'getBlockHashByHeight', [height]);
  }

  getMissingTxIds(limit: number): Promise<string[]> {
    return this.queueRead('core', 'getMissingTxIds', [limit]);
  }

  getFailedBundleIds(limit: number): Promise<string[]> {
    return this.queueRead('bundles', 'getFailedBundleIds', [limit]);
  }

  backfillBundles() {
    return this.queueRead('bundles', 'backfillBundles', undefined);
  }

  updateBundlesFullyIndexedAt(): Promise<void> {
    return this.queueRead('bundles', 'updateBundlesFullyIndexedAt', undefined);
  }

  updateBundlesForFilterChange(unbundleFilter: string, indexFilter: string) {
    return this.queueWrite('bundles', 'updateBundlesForFilterChange', [
      unbundleFilter,
      indexFilter,
    ]);
  }

  resetToHeight(height: number): Promise<void> {
    return this.queueWrite('core', 'resetToHeight', [height]);
  }

  saveTx(tx: PartialJsonTransaction): Promise<void> {
    return this.queueWrite('core', 'saveTx', [tx]);
  }

  getTxIdsMissingOffsets(limit: number): Promise<string[]> {
    return this.queueRead('core', 'getTxIdsMissingOffsets', [limit]);
  }

  saveTxOffset(id: string, offset: number) {
    return this.queueWrite('core', 'saveTxOffset', [id, offset]);
  }

  async saveDataItem(item: NormalizedDataItem): Promise<void> {
    if (this.shouldFlushDataItems()) {
      await this.flushStableDataItems();
    }

    this.newDataItemsCount++;
    return this.queueWrite('bundles', 'saveDataItem', [item]);
  }

  saveBundleRetries(rootTransactionId: string): Promise<void> {
    return this.queueWrite('bundles', 'saveBundleRetries', [rootTransactionId]);
  }

  saveBundle(bundle: BundleRecord): Promise<BundleSaveResult> {
    return this.queueWrite('bundles', 'saveBundle', [bundle]);
  }

  async flushStableDataItems(
    endHeight?: number,
    maxStableBlockTimestamp?: number,
  ): Promise<void> {
    this.newDataItemsCount = 0;
    this.lastFlushDataItemsTime = Date.now();

    endHeight = endHeight || (await this.getMaxHeight());
    maxStableBlockTimestamp =
      maxStableBlockTimestamp || (await this.getMaxStableBlockTimestamp());

    return this.queueWrite('bundles', 'flushStableDataItems', [
      endHeight,
      maxStableBlockTimestamp,
    ]);
  }

  shouldFlushDataItems(): boolean {
    const flushIntervalExceeded =
      Date.now() - this.lastFlushDataItemsTime >
      config.MAX_FLUSH_INTERVAL_SECONDS * 1000;
    const newDataItemsCountExceeded =
      this.newDataItemsCount >= config.DATA_ITEM_FLUSH_COUNT_THRESHOLD;

    return flushIntervalExceeded || newDataItemsCountExceeded;
  }

  async saveBlockAndTxs(
    block: PartialJsonBlock,
    txs: PartialJsonTransaction[],
    missingTxIds: string[],
  ): Promise<void> {
    const { endHeight, maxStableBlockTimestamp } = await this.queueWrite(
      'core',
      'saveBlockAndTxs',
      [block, txs, missingTxIds],
    );

    const heightAndMaxStableExists =
      endHeight !== undefined && maxStableBlockTimestamp !== undefined;

    if (heightAndMaxStableExists || this.shouldFlushDataItems()) {
      await this.flushStableDataItems(endHeight, maxStableBlockTimestamp);
    }
  }

  async getDataAttributes(
    id: string,
  ): Promise<ContiguousDataAttributes | undefined> {
    try {
      return await this.getDataAttributesCircuitBreaker.fire(id);
    } catch (_) {
      return undefined;
    }
  }

  async getDataItemAttributes(
    id: string,
  ): Promise<DataItemAttributes | undefined> {
    try {
      return await this.getDataItemAttributesCircuitBreaker.fire(id);
    } catch (_) {
      return undefined;
    }
  }

  async getTransactionAttributes(
    id: string,
  ): Promise<TransactionAttributes | undefined> {
    try {
      return await this.getTransactionAttributesCircuitBreaker.fire(id);
    } catch (_) {
      return undefined;
    }
  }

  async getDataParent(id: string): Promise<ContiguousDataParent | undefined> {
    try {
      return await this.getDataParentCircuitBreaker.fire(id);
    } catch (_) {
      return undefined;
    }
  }

  getDebugInfo(): Promise<DebugInfo> {
    return this.queueRead('debug', 'getDebugInfo', undefined);
  }

  saveDataContentAttributes({
    id,
    parentId,
    dataRoot,
    hash,
    dataSize,
    contentType,
    verified,
  }: {
    id: string;
    parentId?: string;
    dataRoot?: string;
    hash: string;
    dataSize: number;
    contentType?: string;
    verified?: boolean;
  }) {
    if (this.saveDataContentAttributesCache.get(id)) {
      metrics.sqliteMethodDuplicateCallsCounter.inc({
        method: 'saveDataContentAttributes',
      });
      return Promise.resolve();
    }

    this.saveDataContentAttributesCache.set(id, true);

    return this.queueWrite('data', 'saveDataContentAttributes', [
      {
        id,
        parentId,
        dataRoot,
        hash,
        dataSize,
        contentType,
        verified,
      },
    ]);
  }

  getGqlTransactions({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[];
    tags?: { name: string; values: string[] }[];
  }) {
    return this.queueRead('gql', 'getGqlTransactions', [
      {
        pageSize,
        cursor,
        sortOrder,
        ids,
        recipients,
        owners,
        minHeight,
        maxHeight,
        bundledIn,
        tags,
      },
    ]);
  }

  async getGqlTransaction({ id }: { id: string }) {
    return this.queueRead('gql', 'getGqlTransaction', [{ id }]);
  }

  getGqlBlocks({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    minHeight = -1,
    maxHeight = -1,
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    return this.queueRead('gql', 'getGqlBlocks', [
      {
        pageSize,
        cursor,
        sortOrder,
        ids,
        minHeight,
        maxHeight,
      },
    ]);
  }

  getGqlBlock({ id }: { id: string }) {
    return this.queueRead('gql', 'getGqlBlock', [{ id }]);
  }

  async isIdBlocked(id: string | undefined): Promise<boolean> {
    return this.queueRead('moderation', 'isIdBlocked', [id]);
  }

  async isHashBlocked(hash: string | undefined): Promise<boolean> {
    return this.queueRead('moderation', 'isHashBlocked', [hash]);
  }

  async isNameBlocked(name: string): Promise<boolean> {
    return this.queueRead('moderation', 'isNameBlocked', [name]);
  }

  async getBlockedNames(): Promise<string[]> {
    return this.queueRead('moderation', 'getBlockedNames', undefined);
  }

  async blockData({
    id,
    hash,
    source,
    notes,
  }: {
    id?: string;
    hash?: string;
    source?: string;
    notes?: string;
  }): Promise<void> {
    return this.queueWrite('moderation', 'blockData', [
      {
        id,
        hash,
        source,
        notes,
      },
    ]);
  }

  async blockName({
    name,
    source,
    notes,
  }: {
    name: string;
    source?: string;
    notes?: string;
  }): Promise<void> {
    return this.queueWrite('moderation', 'blockName', [
      {
        name,
        source,
        notes,
      },
    ]);
  }

  async unblockName({ name }: { name: string }): Promise<void> {
    return this.queueWrite('moderation', 'unblockName', [{ name }]);
  }

  async saveNestedDataId({
    id,
    parentId,
    dataOffset,
    dataSize,
  }: {
    id: string;
    parentId: string;
    dataOffset: number;
    dataSize: number;
  }): Promise<void> {
    return this.queueWrite('data', 'saveNestedDataId', [
      {
        id,
        parentId,
        dataOffset,
        dataSize,
      },
    ]);
  }

  async saveNestedDataHash({
    hash,
    parentId,
    dataOffset,
  }: {
    hash: string;
    parentId: string;
    dataOffset: number;
  }): Promise<void> {
    return this.queueWrite('data', 'saveNestedDataHash', [
      {
        hash,
        parentId,
        dataOffset,
      },
    ]);
  }

  async getVerifiableDataIds() {
    return this.queueRead('data', 'getVerifiableDataIds', undefined);
  }

  async getRootTxId(id: string) {
    return this.queueRead('core', 'getRootTxId', [id]);
  }

  async saveVerificationStatus(id: string) {
    return this.queueWrite('data', 'saveVerificationStatus', [id]);
  }

  async pruneStableDataItems(indexedAtThreshold: number): Promise<void> {
    return this.queueWrite('bundles', 'pruneStableDataItems', [
      indexedAtThreshold,
    ]);
  }

  async cleanupWal(dbName: WorkerPoolName): Promise<void> {
    return this.queueWrite(dbName, 'cleanupWal', [dbName]).then(
      (walCheckpoint) => {
        this.log.info('WAL checkpoint', {
          dbName,
          walCheckpoint,
        });

        metrics.sqliteWalCheckpointPages.set(
          { db: dbName, type: 'busy' },
          walCheckpoint.busy,
        );
        metrics.sqliteWalCheckpointPages.set(
          { db: dbName, type: 'log' },
          walCheckpoint.log,
        );
        metrics.sqliteWalCheckpointPages.set(
          { db: dbName, type: 'checkpointed' },
          walCheckpoint.checkpointed,
        );
      },
    );
  }
}

type WorkerMessage = {
  method: keyof StandaloneSqliteDatabaseWorker | 'terminate';
  args: any[];
};

if (!isMainThread) {
  const worker = new StandaloneSqliteDatabaseWorker({
    log,
    coreDbPath: workerData.coreDbPath,
    dataDbPath: workerData.dataDbPath,
    moderationDbPath: workerData.moderationDbPath,
    bundlesDbPath: workerData.bundlesDbPath,
    tagSelectivity: workerData.tagSelectivity,
  });

  let errorCount = 0;

  parentPort?.on('message', ({ method, args }: WorkerMessage) => {
    try {
      switch (method) {
        case 'getMaxHeight':
          const maxHeight = worker.getMaxHeight();
          parentPort?.postMessage(maxHeight);
          break;
        case 'getMaxStableBlockTimestamp':
          const maxStableBlockTimestamp = worker.getMaxStableBlockTimestamp();
          parentPort?.postMessage(maxStableBlockTimestamp);
          break;
        case 'getBlockHashByHeight':
          const newBlockHash = worker.getBlockHashByHeight(args[0]);
          parentPort?.postMessage(newBlockHash);
          break;
        case 'getMissingTxIds':
          parentPort?.postMessage(worker.getMissingTxIds(args[0]));
          break;
        case 'getFailedBundleIds':
          const failedBundleIds = worker.getFailedBundleIds(args[0]);
          parentPort?.postMessage(failedBundleIds);
          break;
        case 'backfillBundles':
          worker.backfillBundles();
          parentPort?.postMessage(null);
          break;
        case 'updateBundlesFullyIndexedAt':
          worker.updateBundlesFullyIndexedAt();
          parentPort?.postMessage(null);
          break;
        case 'updateBundlesForFilterChange':
          const [unbundleFilter, indexFilter] = args;
          worker.updateBundlesForFilterChange(unbundleFilter, indexFilter);
          parentPort?.postMessage(null);
          break;
        case 'resetToHeight':
          worker.resetToHeight(args[0]);
          parentPort?.postMessage(undefined);
          break;
        case 'saveTx':
          worker.saveTx(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'getTxIdsMissingOffsets':
          const txIdsMissingOffsets = worker.getTxIdsMissingOffsets(args[0]);
          parentPort?.postMessage(txIdsMissingOffsets);
          break;
        case 'saveTxOffset':
          worker.saveTxOffset(args[0], args[1]);
          parentPort?.postMessage(null);
          break;
        case 'saveDataItem':
          worker.saveDataItem(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'saveBundleRetries':
          worker.saveBundleRetries(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'saveBundle':
          {
            const bundle = worker.saveBundle(args[0]);
            parentPort?.postMessage(bundle);
          }
          break;
        case 'saveBlockAndTxs':
          {
            const [block, txs, missingTxIds] = args;
            const ret = worker.saveBlockAndTxs(block, txs, missingTxIds);
            parentPort?.postMessage(ret);
          }
          break;
        case 'flushStableDataItems':
          {
            const [endHeight, maxStableBlockTimestamp] = args;
            worker.flushStableDataItems(endHeight, maxStableBlockTimestamp);
            parentPort?.postMessage(null);
          }
          break;
        case 'getDataAttributes':
          const dataAttributes = worker.getDataAttributes(args[0]);
          parentPort?.postMessage(dataAttributes);
          break;
        case 'getDataItemAttributes':
          const dataItemAttributes = worker.getDataItemAttributes(args[0]);
          parentPort?.postMessage(dataItemAttributes);
          break;
        case 'getTransactionAttributes':
          const transactionAttributes = worker.getTransactionAttributes(
            args[0],
          );
          parentPort?.postMessage(transactionAttributes);
          break;
        case 'getDataParent':
          const dataParent = worker.getDataParent(args[0]);
          parentPort?.postMessage(dataParent);
          break;
        case 'getDebugInfo':
          const debugInfo = worker.getDebugInfo();
          parentPort?.postMessage(debugInfo);
          break;
        case 'saveDataContentAttributes':
          worker.saveDataContentAttributes(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'getGqlTransactions':
          const gqlTransactions = worker.getGqlTransactions(args[0]);
          parentPort?.postMessage(gqlTransactions);
          break;
        case 'getGqlTransaction':
          const gqlTransaction = worker.getGqlTransaction(args[0]);
          parentPort?.postMessage(gqlTransaction);
          break;
        case 'getGqlBlocks':
          const gqlBlocks = worker.getGqlBlocks(args[0]);
          parentPort?.postMessage(gqlBlocks);
          break;
        case 'getGqlBlock':
          const gqlBlock = worker.getGqlBlock(args[0]);
          parentPort?.postMessage(gqlBlock);
          break;
        case 'isIdBlocked':
          const isIdBlocked = worker.isIdBlocked(args[0]);
          parentPort?.postMessage(isIdBlocked);
          break;
        case 'isHashBlocked':
          const isHashBlocked = worker.isHashBlocked(args[0]);
          parentPort?.postMessage(isHashBlocked);
          break;
        case 'isNameBlocked':
          const isNameBlocked = worker.isNameBlocked(args[0]);
          parentPort?.postMessage(isNameBlocked);
          break;
        case 'getBlockedNames':
          const blockedNames = worker.getBlockedNames();
          parentPort?.postMessage(blockedNames);
          break;
        case 'blockData':
          worker.blockData(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'blockName':
          worker.blockName(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'unblockName':
          worker.unblockName(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'saveNestedDataId':
          worker.saveNestedDataId(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'saveNestedDataHash':
          worker.saveNestedDataHash(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'getVerifiableDataIds':
          const ids = worker.getVerifiableDataIds();
          parentPort?.postMessage(ids);
          break;
        case 'getRootTxId':
          const rootTxId = worker.getRootTxId(args[0]);
          parentPort?.postMessage(rootTxId);
          break;
        case 'saveVerificationStatus':
          worker.saveVerificationStatus(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'pruneStableDataItems':
          worker.pruneStableDataItems(args[0]);
          parentPort?.postMessage(null);
          break;
        case 'cleanupWal':
          const walCheckpoint = worker.cleanupWal(args[0]);
          parentPort?.postMessage(walCheckpoint);
          break;
        case 'terminate':
          parentPort?.postMessage(null);
          process.exit(0);
      }
    } catch (e: any) {
      if (errorCount > MAX_WORKER_ERRORS) {
        log.error('Too many errors in StandaloneSqlite worker, exiting.');
        process.exit(1);
      }

      const error = new DetailedError('Error in StandaloneSqlite worker', {
        stack: e.stack,
      });

      log.error(error.message, {
        message: error.message,
        stack: error.stack,
        workerMethod: method,
        workerArgs: args,
      });
      errorCount++;
      parentPort?.postMessage({
        message: error.message,
        stack: error.stack,
        workerMethod: method,
        workerArgs: args,
      });
    }
  });
}
