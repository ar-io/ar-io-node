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

import * as winston from 'winston';
import {
  BundleRecord,
  ChainIndex,
  GqlTransaction,
  NormalizedDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../../types';
import { MAX_FORK_DEPTH } from '../../arweave/constants.js';
import { fromB64Url, MANIFEST_CONTENT_TYPE, toB64Url } from '../../lib/encoding.js';
import { default as yesql } from 'yesql';
import pkg, { QueryConfig } from 'pg';
import {
  dataItemToDbRows,
  // decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  encodeTransactionGqlCursor,
  decodeBlockGqlCursor,
  txToDbRows,
  decodeTransactionGqlCursor,
} from './PostgressDatabaseHelpers.js';
import { currentUnixTimestamp } from '../../lib/time.js';
import {
  blockDataInput,
  databaseWorkerInterface, getGqlBlockInput,
  GqlTransactionsFilters,
  saveNestedDataHashInput,
  saveNestedDataHashOutput, saveNestedDataIdInput,
  tagsMatch,
  STMTS,
} from './PostgressDatabaseTypes.js';
import { DATABASE_HOST, DATABASE_PASSWORD, DATABASE_PORT, DATABASE_USERNAME } from '../../config.js';

const STABLE_FLUSH_INTERVAL = 5;
const NEW_TX_CLEANUP_WAIT_SECS = 60 * 60 * 2;
const NEW_DATA_ITEM_CLEANUP_WAIT_SECS = 60 * 60 * 2;
const BUNDLE_REPROCESS_WAIT_SECS = 60 * 60 * 4;

const { Pool } = pkg;

export class PostgressDatabaseWorker implements databaseWorkerInterface, ChainIndex {
  private log: winston.Logger;
  private readonly dbPool!: pkg.Pool;

  private readonly stmts!: {
    core: STMTS,
    data: STMTS,
    moderation: STMTS,
    bundles: STMTS
  };
  private bundleFormatIds: {
    [filter: string]: number
  } = {};
  private filterIds: {
    [filter: string]: number
  } = {};

  // Transactions functions
  resetBundlesToHeightFn: (height: number) => void;
  resetCoreToHeightFn: (height: number) => void;
  insertTxFn: (tx: PartialJsonTransaction, height?: number) => void;
  insertDataItemFn: (item: NormalizedDataItem, height?: number) => void;
  insertBlockAndTxsFn: (block: PartialJsonBlock, txs: PartialJsonTransaction[], missingTxIds: string[]) => Promise<void>;
  saveCoreStableDataFn: (endHeight: number) => Promise<void>;
  saveBundlesStableDataFn: (endHeight: number) => Promise<void>;
  deleteCoreStaleNewDataFn: (heightThreshold: number, createdAtThreshold: number) => Promise<void>;
  deleteBundlesStaleNewDataFn: (heightThreshold: number, indexedAtThreshold: number) => Promise<void>;

  constructor({ log }: {
    log: winston.Logger
  }) {
    this.log = log;

    this.dbPool = new Pool({
      user: DATABASE_USERNAME,
      password: DATABASE_PASSWORD,
      host: DATABASE_HOST,
      port: Number(DATABASE_PORT),
      database: 'core',
      max: 100,
    });

      this.dbPool.connect().catch((err: any) => log.error(`Failed to connect to database:`, err))

    this.stmts = { core: {}, data: {}, bundles: {}, moderation: {} };
    for (const [stmtsKey, stmts] of Object.entries(this.stmts)) {
      const sqlUrl = new URL(`../pgql/${stmtsKey}`, import.meta.url);
      const coreSql = yesql(sqlUrl.pathname) as unknown as {
        [key: string]: string
      };

      for (const [k, sql] of Object.entries(coreSql)) {
        if (!k.endsWith('.sql')) {
          if (stmtsKey === 'core' || stmtsKey === 'data' || stmtsKey === 'moderation' || stmtsKey === 'bundles') {
            stmts[k] = { name: k, text: sql };
          } else {
            throw new Error(`Unexpected statement key: ${stmtsKey}`);
          }
        }
      }
    }

    this.resetBundlesToHeightFn = async (height: number) => {
    //  const client: pkg.PoolClient = await this.dbPool.connect();

      try {
        await this.dbPool.query('BEGIN');

        await this.dbPool.query(this.transformQuery(this.stmts.bundles.clearHeightsOnNewDataItems, { height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.bundles.clearHeightsOnNewDataItemTags, { height: height }));

        await this.dbPool.query('COMMIT');
      } catch (e: any) {
        await this.dbPool.query('ROLLBACK');
        this.log.info('resetBundlesToHeightFn did a rollback.');
      } finally {
        //client.release();
      }
    };
    this.resetCoreToHeightFn = async (height: number) => {
    //  const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        await this.dbPool.query('BEGIN');

        await this.dbPool.query(this.transformQuery(this.stmts.core.clearHeightsOnNewTransactions, { height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.clearHeightsOnNewTransactionTags, { height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.clearHeightsOnNewTransactionTags, { height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.truncateNewBlocksAt, { height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.truncateNewBlockTransactionsAt, { height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.truncateMissingTransactionsAt, { height: height }));

        await this.dbPool.query('COMMIT');
      } catch (e) {
        await this.dbPool.query('ROLLBACK');
        this.log.info('resetCoreToHeightFn did a rollback.');
      } finally {
       // client.release();
      }
    };
    this.insertTxFn = async (tx: PartialJsonTransaction, height?: number) => {
    //  const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        const rows = txToDbRows(tx, height);

        await this.dbPool.query('BEGIN');

        if (height !== undefined) {
          await this.dbPool.query(this.transformQuery(this.stmts.core.updateNewDataItemHeights, { height: height, transaction_id: rows.newTx.id }));
          await this.dbPool.query(this.transformQuery(this.stmts.core.updateNewDataItemTagHeights, { height: height, transaction_id: rows.newTx.id }));
        }

        for (const row of rows.tagNames) {
          await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreTagName, row));
        }

        for (const row of rows.tagValues) {
          await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreTagValue, row));
        }

        for (const row of rows.newTxTags) {
          await this.dbPool.query(this.transformQuery(this.stmts.core.upsertNewTransactionTag, { ...row, height }));
        }

        for (const row of rows.wallets) {
          await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreWallet, row));
        }

        await this.dbPool.query(this.transformQuery(this.stmts.core.upsertNewTransaction, { ...rows.newTx, height: height }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.insertAsyncNewBlockTransaction, { transaction_id: rows.newTx.id }));

        await this.dbPool.query('COMMIT');
      } catch (error) {
        await this.dbPool.query('ROLLBACK');
        this.log.info('insertTxFn did a rollback.');
      } finally {
       // client.release();
      }
    };
    this.insertDataItemFn = async (item: NormalizedDataItem, height?: number) => {
    //  const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        const rows = dataItemToDbRows(item, height);

        await this.dbPool.query('BEGIN');

        for (const row of rows.tagNames) {
          await this.dbPool.query(this.transformQuery(this.stmts.bundles.insertOrIgnoreTagName, row));
        }

        for (const row of rows.tagValues) {
          await this.dbPool.query(this.transformQuery(this.stmts.bundles.insertOrIgnoreTagValue, row));
        }

        for (const row of rows.newDataItemTags) {
          await this.dbPool.query(this.transformQuery(this.stmts.bundles.upsertNewDataItemTag, { ...row, height }));
        }

        for (const row of rows.wallets) {
          await this.dbPool.query(this.transformQuery(this.stmts.bundles.insertOrIgnoreWallet, row));
        }

        const filterID = this.getFilterId(rows.bundleDataItem.filter);
        await this.dbPool.query(this.transformQuery(this.stmts.bundles.upsertBundleDataItem, { ...rows.bundleDataItem, filterID }));
        await this.dbPool.query(this.transformQuery(this.stmts.bundles.upsertBundleDataItem, { ...rows.bundleDataItem, filterID }));
        await this.dbPool.query(this.transformQuery(this.stmts.bundles.upsertNewDataItem, { height: height }));

        await this.dbPool.query('COMMIT');
      } catch (error) {
        await this.dbPool.query('ROLLBACK');
        this.log.info('insertDataItemFn did a rollback.');
      } finally {
      //  client.release();
      }
    };
    this.insertBlockAndTxsFn = async (block: PartialJsonBlock, txs: PartialJsonTransaction[], missingTxIds: string[]) => {
    //  const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        await this.dbPool.query('BEGIN');

        const indepHash = fromB64Url(block.indep_hash);
        const previousBlock = fromB64Url(block.previous_block ?? '');
        const nonce = fromB64Url(block.nonce);
        const hash = fromB64Url(block.hash);
        const rewardAddr = fromB64Url(block.reward_addr !== 'unclaimed' ? block.reward_addr : '');
        const hashListMerkle = block.hash_list_merkle && fromB64Url(block.hash_list_merkle);
        const walletList = fromB64Url(block.wallet_list);
        const txRoot = block.tx_root && fromB64Url(block.tx_root);

        await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreNewBlock,
          {
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
            scheduled_usd_to_ar_rate_dividend: (block.scheduled_usd_to_ar_rate ?? [])[0],
            scheduled_usd_to_ar_rate_divisor: (block.scheduled_usd_to_ar_rate ?? [])[1],
            hash_list_merkle: hashListMerkle,
            wallet_list: walletList,
            tx_root: txRoot,
            tx_count: block.txs.length,
            missing_tx_count: missingTxIds.length,
          }));


        let blockTransactionIndex = 0;
        for (const txIdStr of block.txs) {
          const txId = fromB64Url(txIdStr);
          await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreNewBlockTransaction, {
            block_indep_hash: indepHash,
            transaction_id: txId,
            block_transaction_index: blockTransactionIndex,
            height: block.height,
          }));

          blockTransactionIndex++;
        }

        for (const tx of txs) {
          const rows = txToDbRows(tx, block.height);

          await this.dbPool.query(this.transformQuery({
            text: `UPDATE new_data_items
                   SET height = @height
                   WHERE root_transaction_id = @transaction_id`,
          }, { height: block.height, transaction_id: rows.newTx.id }));
          await this.dbPool.query(this.transformQuery({
            text: `UPDATE new_data_item_tags
                   SET height = @height
                   WHERE root_transaction_id = @transaction_id`,
          }, { height: block.height, transaction_id: rows.newTx.id }));

          for (const row of rows.tagNames) {
            await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreTagName, row));
          }

          for (const row of rows.tagValues) {
            await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreTagValue, row));
          }

          for (const row of rows.newTxTags) {
            await this.dbPool.query(this.transformQuery(this.stmts.core.upsertNewTransactionTag, { ...row, height: block.height }));
          }

          for (const row of rows.wallets) {
            await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreWallet, row));
          }
          await this.dbPool.query(this.transformQuery(this.stmts.core.upsertNewTransaction, rows.newTx));
        }
        for (const txIdStr of missingTxIds) {
          const txId = fromB64Url(txIdStr);
          await this.dbPool.query(this.transformQuery(this.stmts.core.updateNewDataItemHeights, { height: block.height, transaction_id: txId }));
          await this.dbPool.query(this.transformQuery(this.stmts.core.updateNewDataItemTagHeights, { height: block.height, transaction_id: txId }));
          await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreMissingTransaction, { block_indep_hash: indepHash, transaction_id: txId, height: block.height }));
        }

        await this.dbPool.query('COMMIT');
      } catch (error) {
        await this.dbPool.query('ROLLBACK');
        this.log.info('insertBlockAndTxsFn did a rollback.');
      } finally {
       // client.release();
      }
    };
    this.saveCoreStableDataFn = async (endHeight: number) => {
     // const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        await this.dbPool.query('BEGIN');

        await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreStableBlocks, { end_height: endHeight }));

        await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreStableBlockTransactions, { end_height: endHeight }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreStableTransactions, { end_height: endHeight }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.insertOrIgnoreStableTransactionTags, { end_height: endHeight }));

        await this.dbPool.query('COMMIT');
      } catch (e) {
        await this.dbPool.query('ROLLBACK');
        this.log.info('saveCoreStableDataFn did a rollback.');
      }
    };
    this.saveBundlesStableDataFn = async (endHeight: number): Promise<void> => {
      try {
        await this.dbPool.query('BEGIN');

        await this.dbPool.query(this.transformQuery(this.stmts.bundles.insertOrIgnoreStableDataItems, { end_height: endHeight }));
        await this.dbPool.query(this.transformQuery(this.stmts.bundles.insertOrIgnoreStableDataItemTags, { end_height: endHeight }));

        await this.dbPool.query('COMMIT');
      } catch (e) {
        await this.dbPool.query('ROLLBACK').catch((e: any) => console.error('Rollback failed:', e));
        this.log.info('saveBundlesStableDataFn did a rollback.',e);
      } finally {
       // client.release();
      }
    };
    this.deleteCoreStaleNewDataFn = async (heightThreshold: number, createdAtThreshold: number) => {
    //  const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        await this.dbPool.query('BEGIN');

        await this.dbPool.query(this.transformQuery(this.stmts.core.deleteStaleMissingTransactions, { height_threshold: heightThreshold }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.deleteStaleNewTransactionTags, { height_threshold: heightThreshold, indexed_at_threshold: createdAtThreshold }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.deleteStaleNewTransactions, { height_threshold: heightThreshold, indexed_at_threshold: createdAtThreshold }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.deleteStaleNewBlockTransactions, { height_threshold: heightThreshold }));
        await this.dbPool.query(this.transformQuery(this.stmts.core.deleteStaleNewBlocks, { height_threshold: heightThreshold }));

        await this.dbPool.query('COMMIT;');
      } catch (e) {
        await this.dbPool.query('ROLLBACK;').catch((rollbackError: any) => console.error('Rollback failed:', rollbackError));
        this.log.info('deleteCoreStaleNewDataFn did a rollback.');
      } finally {
      //  client.release();
      }
    };
    this.deleteBundlesStaleNewDataFn = async (heightThreshold: number, indexedAtThreshold: number) => {
     // const client: pkg.PoolClient = await this.dbPool.connect();
      try {
        await this.dbPool.query('BEGIN');

        await this.dbPool.query(this.transformQuery(this.stmts.bundles.deleteStaleNewDataItems, { height_threshold: heightThreshold, indexed_at_threshold: indexedAtThreshold }));
        await this.dbPool.query(this.transformQuery(this.stmts.bundles.deleteStaleNewDataItemTags, { height_threshold: heightThreshold, indexed_at_threshold: indexedAtThreshold }));

        await this.dbPool.query('COMMIT');
      } catch (e) {
        await this.dbPool.query('ROLLBACK;').catch((rollbackError: any) => console.error('Rollback failed:', rollbackError));
        this.log.info('deleteBundlesStaleNewDataFn did a rollback.');
      } finally {
       // client.release();
      }
    };
  }

  async runQuery(query: pkg.QueryConfig): Promise<pkg.QueryResult | undefined> {
    try {
      return await this.dbPool.query(query);
    } catch (error) {
      this.log.error('Query error', { query: query });
    }

    return undefined;
  }

  //@ts-ignore
  transformQuery(query: QueryConfig, params) {
    const keys = Object.keys(params);

    let transformedQuery = query;
    let values: any[] = [];

    keys.forEach((key, index) => {
      const positionalIndex = index + 1;
      const regex = new RegExp(`@${key}\\b`, 'g');
      transformedQuery.text = transformedQuery.text.replace(regex, `$${positionalIndex}`);
      values.push(params[key]);
    });

    transformedQuery.text = transformedQuery.text
      .replace(/\bINTEGER\b/g, 'BIGINT')
      .replace(/\bIFNULL\b/g, 'COALESCE');
    transformedQuery.values = values;

    return transformedQuery;
  };

  async getMaxHeight(): Promise<number> {
    try {
      const result = await this.dbPool.query(this.stmts.core.selectMaxHeight);
      const height = result?.rows[0]?.height;
      return height !== undefined ? Number(height) : -1;
    } catch (error) {
      return 0;
    }
  }

  // @ts-ignore
  async getBlockHashByHeight(height: number): Promise<string | null> {
    if (height < 0) {
      throw new Error(`Invalid height ${height}, must be >= 0.`);
    }

    const queryResult = await this.runQuery({ ...this.stmts.core.selectMaxHeight, values: [height] });

    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return toB64Url(queryResult.rows[0].indep_hash);
    }

    return null;
  }

  async getMissingTxIds(limit: number): Promise<string[]> {
    const queryResult: pkg.QueryResult | undefined = await this.runQuery({
      ...this.stmts.core.selectMaxHeight,
      values: [limit],
    });
    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map((row): string => toB64Url(row.transaction_id));
    }
    return [];
  }

  async getFailedBundleIds(limit: number): Promise<string[]> {
    const queryResult: pkg.QueryResult | undefined = await this.runQuery(
      {
        ...this.stmts.bundles.selectFailedBundleIds,
        values: [limit, currentUnixTimestamp() - BUNDLE_REPROCESS_WAIT_SECS],
      });
    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map((row): string => toB64Url(row.id));
    }
    return [];
  }

  async backfillBundles(): Promise<void> {
    await this.runQuery(this.stmts.bundles.insertMissingBundles);
  }

  async updateBundlesFullyIndexedAt(): Promise<void> {
    await this.runQuery(
      {
        ...this.stmts.bundles.updateFullyIndexedAt,
        values: [currentUnixTimestamp],
      });
  }

  async updateBundlesForFilterChange(unbundleFilter: string, indexFilter: string): Promise<void> {
    await this.runQuery(
      {
        ...this.stmts.bundles.updateForFilterChange,
        values: [unbundleFilter, indexFilter],
      });
  }

  async resetToHeight(height: number): Promise<void> {
    this.resetBundlesToHeightFn(height);
    this.resetCoreToHeightFn(height);
  }

  async saveTx(tx: PartialJsonTransaction): Promise<void> {
    const txId = fromB64Url(tx.id);
    const queryResult = await this.runQuery({ ...this.stmts.core.selectMissingTransactionHeight, values: [txId] });

    if (queryResult !== undefined && queryResult.rows.length > 0) {
      this.insertTxFn(tx, queryResult.rows[0]?.height);
      await this.runQuery({ ...this.stmts.core.deleteNewMissingTransaction, values: [txId] });
    }
  }

  async getTxIdsMissingOffsets(limit: number): Promise<string[]> {
    const queryResult = await this.runQuery(this.transformQuery(this.stmts.core.selectStableTransactionIdsMissingOffsets, { limit: limit }));

    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map((row): string => toB64Url(row.id));
    }
    return [];
  }

  async saveTxOffset(id: string, offset: number): Promise<void> {
    await this.runQuery({
      ...this.stmts.core.updateStableTransactionOffset,
      values: [fromB64Url(id), offset],
    });
  }

  async getBundleFormatId(format: string | undefined): Promise<number | undefined> {
    let id: number | undefined;
    if (format != undefined) {
      id = this.bundleFormatIds[format];
      if (id == undefined) {
        const queryResult = await this.runQuery({ ...this.stmts.core.selectFormatId, values: [format] });
        if (queryResult !== undefined && queryResult.rows.length > 0) {
          id = queryResult.rows[0]?.id;
        }
        if (id != undefined) {
          this.bundleFormatIds[format] = id;
        }
      }
    }
    return id;
  }

  async getFilterId(filter: string | undefined): Promise<number | undefined> {
    let id: number | undefined;

    if (filter != undefined) {
      id = this.filterIds[filter];

      if (id == undefined) {
        const db = this.dbPool;

        if (db && typeof db.query === 'function') {
          const queryResult = await db.query(this.transformQuery(this.stmts.bundles.selectFilterId, { filter: filter }));

          if (queryResult !== undefined && queryResult.rows.length > 0) {
            id = queryResult.rows[0]?.id;
          }

          if (id != undefined) {
            this.filterIds[filter] = id;
          }
        }
      }
    }
    return id;
  }

  async saveDataItem(item: NormalizedDataItem): Promise<void> {
    const rootTxId = fromB64Url(item.root_tx_id);
    const queryResult = await this.runQuery({ ...this.stmts.bundles.selectTransactionHeight, values: [rootTxId] });
    if (queryResult !== undefined && queryResult.rows.length > 0) {
      this.insertDataItemFn(item, queryResult.rows[0]?.height);
    }
  }

  async saveBundle({
                     id,
                     rootTransactionId,
                     format,
                     unbundleFilter,
                     indexFilter,
                     dataItemCount,
                     matchedDataItemCount,
                     queuedAt,
                     skippedAt,
                     unbundledAt,
                     fullyIndexedAt,
                   }: BundleRecord) {
    const idBuffer = fromB64Url(id);
    let rootTxId: Buffer | undefined;
    if (rootTransactionId != undefined) {
      rootTxId = fromB64Url(rootTransactionId);
    }

    await this.runQuery({
      ...this.stmts.bundles.upsertBundle,
      values: [
        idBuffer,
        rootTxId,
        await this.getBundleFormatId(format),
        await this.getFilterId(unbundleFilter),
        await this.getFilterId(indexFilter),
        dataItemCount,
        matchedDataItemCount,
        queuedAt,
        skippedAt,
        unbundledAt,
        fullyIndexedAt,
      ],
    });
  }

  async saveBlockAndTxs(block: PartialJsonBlock, txs: PartialJsonTransaction[], missingTxIds: string[]) {
    await this.insertBlockAndTxsFn(block, txs, missingTxIds);

    let maxStableBlockTimestamp = null;

    if (block.height % STABLE_FLUSH_INTERVAL === 0) {

      const queryResult = await this.runQuery(this.stmts.core.selectMaxStableBlockTimestamp);
      if (queryResult !== undefined && queryResult.rows.length > 0) {
        maxStableBlockTimestamp = queryResult.rows[0]?.block_timestamp;
      }
      const endHeight = block.height - MAX_FORK_DEPTH;

      await this.saveCoreStableDataFn(endHeight);
      await this.saveBundlesStableDataFn(endHeight);

      await this.deleteCoreStaleNewDataFn(endHeight, maxStableBlockTimestamp - NEW_TX_CLEANUP_WAIT_SECS);
      await this.deleteBundlesStaleNewDataFn(endHeight, maxStableBlockTimestamp - NEW_DATA_ITEM_CLEANUP_WAIT_SECS);
    }
  }

  async getDataAttributes(id: string) {
    const queryResultCore = await this.runQuery({ ...this.stmts.core.selectDataAttributes, values: [fromB64Url(id)] });
    const coreRow = queryResultCore?.rows[0];

    const queryResultData = await this.runQuery({ ...this.stmts.data.selectDataAttributes, values: [fromB64Url(id), coreRow?.data_root] });
    const dataRow = queryResultData?.rows[0];


    if (coreRow === undefined && dataRow === undefined) {
      return undefined;
    }

    const contentType =
      coreRow?.content_type ?? dataRow?.original_source_content_type;
    const hash = dataRow?.hash;
    const dataRoot = coreRow?.data_root;

    return {
      hash: hash ? toB64Url(hash) : undefined,
      dataRoot: dataRoot ? toB64Url(dataRoot) : undefined,
      size: coreRow?.data_size ?? dataRow?.data_size,
      contentType,
      isManifest: contentType === MANIFEST_CONTENT_TYPE,
      stable: coreRow?.stable === true,
      verified: dataRow?.verified === true,
    };
  }

  async getDataParent(id: string) {
    const queryResultData = await this.runQuery({ ...this.stmts.data.selectDataParent, values: [fromB64Url(id)] });
    const dataRow = queryResultData?.rows[0];

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

  async getDebugInfo() {
    const chainStats = (await this.runQuery(this.stmts.core.selectChainStats))?.rows[0];
    const bundleStats = (await this.runQuery(this.stmts.core.selectBundleStats))?.rows[0];
    const dataItemStats = (await this.runQuery(this.stmts.core.selectDataItemStats))?.rows[0];

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
      const error = ` Stable block count (${chainStats.stable_blocks_count}) does not match stable block height range (${chainStats.stable_blocks_min_height} to ${chainStats.stable_blocks_max_height}).`
        .replace(/\s+/g, ' ');
      errors.push(error);
    }

    const missingStableTxCount = chainStats.stable_block_txs_count - chainStats.stable_txs_count;

    if (missingStableTxCount > 0) {
      const error = `Stable transaction count (${chainStats.stable_txs_count}) does not match stable block transaction count (${chainStats.stable_block_txs_count}).`
        .replace(/\s+/g, ' ')
        .trim();
      errors.push(error);
    }

    if (now - bundleStats.last_fully_indexed_at > 60 * 60 * 24) {
      const warning = ` Last bundle fully indexed more than 24 hours ago.`
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

  async saveDataContentAttributes({ id, dataRoot, hash, dataSize, contentType, cachedAt }: {
    id: string;
    dataRoot?: string;
    hash: string;
    dataSize: number;
    contentType?: string;
    cachedAt?: number;
  }) {
    const hashBuffer = fromB64Url(hash);
    await this.runQuery({ ...this.stmts.data.insertDataHash, values: [hashBuffer, dataSize, contentType, currentUnixTimestamp(), cachedAt] });
    await this.runQuery({ ...this.stmts.data.insertDataId, values: [fromB64Url(id), hashBuffer, currentUnixTimestamp()] });

    if (dataRoot !== undefined) {
      await this.runQuery({ ...this.stmts.data.insertDataRoot, values: [fromB64Url(dataRoot), hashBuffer, currentUnixTimestamp()] });
    }
  }

  async getGqlNewTransactionTags(txId: Buffer) {
    const queryResult = await this.runQuery(this.transformQuery(this.stmts.core.selectNewTransactionTags, { transaction_id: txId }));

    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map(tag => ({ name: tag.name.toString('utf8'), value: tag.value.toString('utf8') }));
    }

    return [];
  }

  async getGqlNewDataItemTags(id: Buffer) {
    const queryResult = await this.runQuery(this.transformQuery(this.stmts.core.selectNewDataItemTags, { id: id }));
    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map(tag => ({ name: tag.name.toString('utf8'), value: tag.value.toString('utf8') }));
    }

    return [];
  }

  async getGqlStableTransactionTags(txId: Buffer) {
    const queryResult = await this.runQuery(this.transformQuery(this.stmts.core.selectStableTransactionTags, { transaction_id: txId }));

    this.log.info('getGqlStableTransactionTags', queryResult);


    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map(tag => ({ name: tag.name.toString('utf8'), value: tag.value.toString('utf8') }));
    }

    return [];
  }

  async getGqlStableDataItemTags(id: Buffer) {
    const queryResult = await this.runQuery(this.transformQuery(this.stmts.bundles.selectStableDataItemTags, { id: id }));
    if (queryResult !== undefined && queryResult.rows.length > 0) {
      return queryResult.rows.map(tag => ({ name: tag.name.toString('utf8'), value: tag.value.toString('utf8') }));
    }

    return [];
  }

//todo put this into a sql file, and load in stmts
  getGqlNewTransactionsBaseSql() {

    return `SELECT DISTINCT nt.height                   AS height,
                            nbt.block_transaction_index AS block_transaction_index,
                            '\\\x00'                    AS data_item_id,
                            nt.indexed_at               AS indexed_at,
                            nt.id,
                            last_tx                     AS anchor,
                            signature,
                            target,
                            CAST(reward AS TEXT)        AS reward,
                            CAST(quantity AS TEXT)      AS quantity,
                            CAST(data_size AS TEXT)     AS data_size,
                            content_type,
                            owner_address,
                            public_modulus,
                            nb.indep_hash               AS block_indep_hash,
                            nb.block_timestamp          AS block_timestamp,
                            nb.previous_block           AS block_previous_block,
                            ''                          AS parent_id
            FROM new_transactions nt
                     LEFT JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
                     LEFT JOIN new_blocks nb ON nb.indep_hash = nbt.block_indep_hash
                     LEFT JOIN new_transaction_tags ntt ON ntt.transaction_id = nbt.transaction_id
                     LEFT JOIN tag_names tn ON tn.hash = ntt.tag_name_hash
                     LEFT JOIN tag_values tv ON tv.hash = ntt.tag_value_hash
                     JOIN wallets w ON nt.owner_address = w.address`;
  }

//todo put this into a sql file, and load in stmts
  getGqlNewDataItemsBaseSql() {
    return `SELECT DISTINCT ndi.height                  AS height,
                            nbt.block_transaction_index AS block_transaction_index,
                            id                          AS data_item_id,
                            ndi.indexed_at              AS indexed_at,
                            id,
                            anchor,
                            signature,
                            target,
                            ''                          AS reward,
                            ''                          AS quantity,
                            CAST(data_size AS TEXT)     AS data_size,
                            content_type,
                            owner_address,
                            public_modulus,
                            nb.indep_hash               AS block_indep_hash,
                            nb.block_timestamp          AS block_timestamp,
                            nb.previous_block           AS block_previous_block,
                            ndi.parent_id
            FROM new_data_items ndi
                     LEFT JOIN new_block_transactions nbt ON nbt.transaction_id = ndi.root_transaction_id
                     LEFT JOIN new_blocks nb ON nb.indep_hash = nbt.block_indep_hash
                     JOIN new_transaction_tags ntt on ntt.transaction_id = nbt.transaction_id
                     JOIN tag_names tn ON tn.hash = ntt.tag_name_hash
                     JOIN tag_values tv ON tv.hash = ntt.tag_value_hash
                     JOIN wallets w ON ndi.owner_address = w.address`;
  }

//todo put this into a sql file, and load in stmts
  getGqlStableTransactionsBaseSql() {
    return `SELECT DISTINCT st.height                  AS height,
                            st.block_transaction_index AS block_transaction_index,
                            x'00'                      AS data_item_id,
                            0                          AS indexed_at,
                            id,
                            last_tx                    AS anchor,
                            signature,
                            target,
                            CAST(reward AS TEXT)       AS reward,
                            CAST(quantity AS TEXT)     AS quantity,
                            CAST(data_size AS TEXT)    AS data_size,
                            content_type,
                            owner_address,
                            public_modulus,
                            sb.indep_hash              AS block_indep_hash,
                            sb.block_timestamp         AS block_timestamp,
                            sb.previous_block          AS block_previous_block,
                            ''                         AS parent_id
            FROM stable_transactions st
                     JOIN stable_blocks sb ON st.height = sb.height
                     LEFT JOIN stable_transaction_tags stt ON stt.transaction_id = st.id
                     LEFT JOIN tag_names tn ON tn.hash = stt.tag_name_hash
                     LEFT JOIN tag_values tv ON tv.hash = stt.tag_value_hash
                     JOIN wallets w ON st.owner_address = w.address`;
  }

//todo put this into a sql file, and load in stmts
  getGqlStableDataItemsBaseSql() {
    return `SELECT DISTINCT sdi.height                  AS height,
                            sdi.block_transaction_index AS block_transaction_index,
                            sdi.id                      AS data_item_id,
                            sdi.indexed_at              AS indexed_at,
                            id,
                            anchor,
                            signature,
                            target,
                            ''                          AS reward,
                            ''                          AS quantity,
                            CAST(data_size AS TEXT)     AS data_size,
                            content_type,
                            owner_address,
                            public_modulus,
                            sb.indep_hash               AS block_indep_hash,
                            sb.block_timestamp          AS block_timestamp,
                            sb.previous_block           AS block_previous_block,
                            sdi.parent_id
            FROM stable_data_items sdi
                     JOIN stable_blocks sb ON sdi.height = sb.height
                     LEFT JOIN stable_data_item_tags sdit ON sdit.data_item_id = sdi.id
                     LEFT JOIN tag_names tn ON tn.hash = sdit.tag_name_hash
                     LEFT JOIN tag_values tv ON tv.hash = sdit.tag_value_hash
                     JOIN wallets w ON sdi.owner_address = w.address`;
  }

//todo this function does not work jet
  async addGqlTransactionFilters({
                                   query,
                                   source,
                                   //@ts-ignore
                                   cursor,
                                   //@ts-ignore
                                   sortOrder = 'HEIGHT_DESC',
                                   ids = [],
                                   recipients = [],
                                   owners = [],
                                   minHeight = -1,
                                   maxHeight = -1,
                                   bundledIn,
                                   tags = [],
                                 }: GqlTransactionsFilters) {
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
      maxDbHeight = (await this.runQuery(this.stmts.core.selectMaxStableBlockHeight))?.rows[0]?.height as number;
    } else if (source === 'stable_items') {
      txTableAlias = 'sdi';
      heightTableAlias = 'sdi';
      blockTransactionIndexTableAlias = 'sdi';
      tagsTable = 'stable_data_item_tags';
      tagIdColumn = 'data_item_id';
      tagJoinIndex = 'stable_data_item_tags_data_item_id_idx';
      heightSortTableAlias = 'sdi';
      blockTransactionIndexSortTableAlias = 'sdi';
      maxDbHeight = (await this.runQuery(this.stmts.core.selectMaxStableBlockHeight))?.rows[0]?.height as number;
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

    const queryWheres: string[] = [];
    //@ts-ignore
    let queryOrderBy!: string;
    let queryParams: {
      [key: string]: (string | number | Buffer | null)
    } = {};

    if (ids?.length > 0) queryWheres.push(`id IN (${ids.map(id => `'${fromB64Url(id)}'`).join(',')})`);
    if (recipients?.length > 0) queryWheres.push(`target IN (${recipients.map(id => `'${fromB64Url(id)}'`).join(',')})`);
    if (owners?.length > 0) queryWheres.push(`owner_address IN (${owners.map(id => `'${fromB64Url(id)}'`).join(',')})`);

    tags.forEach(tag => {
      switch (tag.match) {
        case tagsMatch.WILDCARD: {
          queryWheres.push(`tn.name = \'${tag.name}\'`);
          const wildcardValue: string = tag.values[0].replace('*', '%');
          queryWheres.push(`tv.value LIKE \'${wildcardValue}\'`);
          break;
        }
        case tagsMatch.FUZZY_AND: {
          queryWheres.push(`tn.name = '${tag.name}'`);
          for (const value of tag.values) {
            queryWheres.push(`similarity(convert_from(tv.value,'UTF8'),'${value.replace('*', '')}') > 0.4`);
          }
          break;
        }
        case tagsMatch.FUZZY_OR: {
          queryWheres.push(`tn.name = '${tag.name}'`);
          let queryOr: string[] = [];
          for (const value of tag.values) {
            queryOr.push(`similarity(convert_from(tv.value,'UTF8'),'${value.replace('*', '')}') > 0.4 `);
          }
          queryWheres.push(('(' + queryOr.join(' OR ') + ')'));
          break;
        }
        default: {
          queryWheres.push(`tn.name = \'${tag.name}\'`);
          queryWheres.push(`tv.value IN (\'${tag.values.join(',')}\')`);
        }
      }
    });

    if (minHeight != null && minHeight > 0) {
      //  queryWheres.push(` ${heightSortTableAlias}.height >= @min_height`);
      queryParams = { ...queryParams, min_height: minHeight };
    }

    if (maxHeight != null && maxHeight >= 0 && maxHeight < maxDbHeight) {
      //  queryWheres.push('height <= @max_height');
      queryParams = { ...queryParams, max_height: maxHeight };
    }

    if (Array.isArray(bundledIn) && (source === 'stable_items' || source === 'new_items')) {
      queryWheres.push(`parent_id = ANY(@parent_id)`);
      queryParams = { ...queryParams, parent_id: bundledIn.map(id => fromB64Url(id)).join(',') };
    }

    const {
      height: cursorHeight,
      blockTransactionIndex: cursorBlockTransactionIndex,
      //@ts-ignore
      dataItemId: cursorDataItemId, indexedAt: cursorIndexedAt, id: cursorId,
    } = decodeTransactionGqlCursor(cursor);


    if (sortOrder === 'HEIGHT_DESC') {
      if (['new_txs', 'new_items'].includes(source) && cursorHeight == null) {
        // queryWheres.push(`((${heightSortTableAlias}.height IS NULL AND (${heightSortTableAlias}.indexed_at < @indexed_at OR (${txTableAlias}.indexed_at <=  @indexed_at AND ${txTableAlias}.id < @cursor_id::bytea))) OR nt.height IS NOT NULL)`)
        //   queryParams = { ...queryParams, indexed_at: cursorIndexedAt, cursor_id: cursorId ? Buffer.from(cursorId, 'base64') : Buffer.from([0]) };
      } else if (cursorHeight != null && cursorBlockTransactionIndex != null) {
        //    let dataItemIdField = source === 'stable_items' ? 'sdi.id' : 'x\'00\'';
        //  queryWheres.push(`${heightSortTableAlias}.height <= 63 AND ( ${heightSortTableAlias}.height < @cursor_height OR ( ${heightSortTableAlias}.height = @cursor_height AND ${blockTransactionIndexSortTableAlias}.block_transaction_index < @cursor_block_transactionIndex) OR ( ${heightSortTableAlias}.height = @cursor_height AND ${blockTransactionIndexSortTableAlias}.block_transaction_index = @cursor_block_transactionIndex AND ${dataItemIdField} < @cursor_data_item_id::bytea)`);
        // queryParams = { ...queryParams, cursor_height: cursorHeight, cursor_block_transactionIndex: cursorBlockTransactionIndex,cursor_data_item_id: cursorDataItemId ? Buffer.from(cursorDataItemId, 'base64') : Buffer.from([0]) };
      }
      queryOrderBy = `${heightSortTableAlias}.height DESC NULLS FIRST`;
      queryOrderBy += `, ${blockTransactionIndexSortTableAlias}.block_transaction_index DESC NULLS FIRST`;

      if (source === 'stable_items' && dataItemSortTableAlias !== undefined) {
        queryOrderBy += `, ${dataItemSortTableAlias}.data_item_id DESC`;
      } else {
        queryOrderBy += `, 3 DESC`;
      }
      queryOrderBy += `, indexed_at DESC`;
      queryOrderBy += `, 5 DESC`;
    } else {
      //  let dataItemIdField = source === 'stable_items' ? 'sdi.id' : 'x\'00\'';
      if (['new_txs', 'new_items'].includes(source) && cursorHeight == null) {
        //  queryWheres.push(` ${heightSortTableAlias}.height <= $9 AND (${heightSortTableAlias}.height < $9 OR ( ${heightSortTableAlias}.height = $9 AND ${blockTransactionIndexSortTableAlias}.block_transaction_index < $10) OR ( ${heightSortTableAlias}.height = $9 AND ${blockTransactionIndexSortTableAlias}.block_transaction_index = $10 AND ${dataItemIdField} < $11::bytea)`);
        //queryParams = {...queryParams, }
        //  queryParams.push(cursorHeight, cursorBlockTransactionIndex, cursorDataItemId ? Buffer.from(cursorDataItemId, 'base64') : Buffer.from([0]));
      } else if (
        cursorHeight != undefined &&
        cursorBlockTransactionIndex != undefined
      ) {
        // let dataItemIdField = source === 'stable_items' ? 'sdi.id' : 'x\'00\'';
        //  queryWheres.push(`${heightSortTableAlias}.height >= $12 AND (  ${heightSortTableAlias}.height > $12 OR ( ${heightSortTableAlias}.height = $12 AND ${blockTransactionIndexSortTableAlias}.block_transaction_index > $13 ) OR ( ${heightSortTableAlias}.height = $12 AND ${blockTransactionIndexSortTableAlias}.block_transaction_index = $11 AND ${dataItemIdField} > $13::bytea )`);
        // queryParams.push(cursorHeight, cursorBlockTransactionIndex, cursorDataItemId ? Buffer.from(cursorDataItemId, 'base64') : Buffer.from([0]));
      }
      //   queryOrderBy = `${heightSortTableAlias}.height ASC NULLS LAST`;
      //   queryOrderBy += `, ${blockTransactionIndexSortTableAlias}.block_transaction_index ASC NULLS LAST`;
      if (source === 'stable_items' && dataItemSortTableAlias !== undefined) {
        //  queryOrderBy += `, ${dataItemSortTableAlias}.data_item_id ASC`;
      } else {
        //  queryOrderBy += `, 3 ASC`;
      }
      //  queryOrderBy += `, indexed_at ASC`;
      queryOrderBy += `, 5 ASC`;
    }
    const wheres = queryWheres.join(' AND ');
    let finalQuery = query.text;
    if (wheres.length > 0) {
      finalQuery += ' WHERE ' + wheres + ' ';
    }
    // finalQuery += ` ${queryOrderBy}`;
    const queryConfig = { text: finalQuery, values: queryParams };

    this.log.info('query', finalQuery);

    return queryConfig;
  }


  async getGqlNewTransactions({
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
    tags?: {
      name: string;
      values: string[];
      match?: tagsMatch;
    }[];
  }): Promise<GqlTransaction[]> {
    const txsQueryFilters = await this.addGqlTransactionFilters({
      query: { text: this.getGqlNewTransactionsBaseSql() },
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
    const txsQuery: pkg.QueryConfig = this.transformQuery({ text: `${txsQueryFilters.text}` }, txsQueryFilters.values);

    const itemsQueryFilters = await this.addGqlTransactionFilters({
      query: { text: this.getGqlNewDataItemsBaseSql() },
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
    const itemsQuery: pkg.QueryConfig = this.transformQuery({ text: `${itemsQueryFilters.text}` }, itemsQueryFilters.values);

    // const sqlSortOrder = sortOrder === 'HEIGHT_DESC' ? 'DESC' : 'ASC';
    const sqlParts = [];
    if (bundledIn === undefined || bundledIn === null) {
      sqlParts.push(`${txsQuery.text}`);
    }
    if (bundledIn === undefined) {
      sqlParts.push('UNION');
    }
    if (bundledIn === undefined || Array.isArray(bundledIn)) {
      sqlParts.push(`${itemsQuery.text}`);
    }

    // sqlParts.push(`ORDER BY 1 ${sqlSortOrder}, 2 ${sqlSortOrder}, 3 ${sqlSortOrder}, 4 ${sqlSortOrder}, 5 ${sqlSortOrder}`);
    sqlParts.push(` LIMIT ${pageSize + 1}`);
    const sql = sqlParts.join(' ');

    const query: QueryConfig = { text: sql, values: [...txsQuery.values, ...itemsQuery.values] };
    const queryResult = await this.runQuery(query);
    if (queryResult !== undefined) {
      return await Promise.all(queryResult.rows.map(async (tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        dataItemId: tx.data_item_id ? toB64Url(tx.data_item_id) : null,
        indexedAt: tx.indexed_at,
        id: toB64Url(tx.id),
        anchor: toB64Url(tx.anchor),
        signature: toB64Url(tx.signature),
        recipient: tx.target ? toB64Url(tx.target) : null,
        ownerAddress: toB64Url(tx.owner_address),
        ownerKey: toB64Url(tx.public_modulus),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        contentType: tx.content_type,
        blockIndepHash: tx.block_indep_hash ? toB64Url(tx.block_indep_hash) : null,
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: tx.block_previous_block ? toB64Url(tx.block_previous_block) : null,
        parentId: tx.parent_id ? toB64Url(tx.parent_id) : null,
        tags: [...await this.getGqlNewDataItemTags(tx.id), ...await this.getGqlNewTransactionTags(tx.id)],
      })));
    }
  }

  //@ts-ignore
  async getGqlStableTransactions({ pageSize, cursor, sortOrder = 'HEIGHT_DESC', ids = [], recipients = [], owners = [], minHeight = -1, maxHeight = -1, bundledIn, tags = [] }
                                   :
                                   {
                                     pageSize: number;
                                     cursor?: string;
                                     sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
                                     ids?: string[];
                                     recipients?: string[];
                                     owners?: string[];
                                     minHeight?: number;
                                     maxHeight?: number;
                                     bundledIn?: string[] | null;
                                     tags?: {
                                       name: string;
                                       values: string[];
                                       match?: tagsMatch;
                                     }[];
                                   },
  ): Promise<GqlTransaction[]> {

    const txsQueryFilters = await this.addGqlTransactionFilters({
      query: { text: this.getGqlStableTransactionsBaseSql() },
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
    const txsQuery: pkg.QueryConfig = this.transformQuery({ text: `${txsQueryFilters.text} LIMIT ${pageSize + 1}` }, txsQueryFilters.values);

    const itemsQueryFilters = await this.addGqlTransactionFilters({
      query: { text: this.getGqlStableDataItemsBaseSql() },
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
    const itemsQuery: pkg.QueryConfig = this.transformQuery({ text: `${itemsQueryFilters.text} LIMIT ${pageSize + 1}` }, itemsQueryFilters.values);


    // const itemsQueryParams = itemsQuery.toParams();
    // const itemsSql = itemsQueryParams.text;
    // const itemsFinalSql = `${itemsSql} LIMIT ${pageSize + 1}`;

    //const sqlSortOrder = sortOrder === 'HEIGHT_DESC' ? 'DESC' : 'ASC';
    const sqlParts = [];
    // if (bundledIn === undefined || bundledIn === null) {
    //   sqlParts.push(`SELECT *
    //                  FROM (${txsQuery.text})`);
    // }
    // if (bundledIn === undefined) {
    //   sqlParts.push('UNION');
    // }
    // if (bundledIn === undefined || Array.isArray(bundledIn)) {
    //   sqlParts.push(`SELECT *
    //                  FROM (${itemsQuery.text}) as tt`);
    // }
    // sqlParts.push(
    //   `ORDER BY 1 ${sqlSortOrder}, 2 ${sqlSortOrder}, 3 ${sqlSortOrder}`,
    // );
    //sqlParts.push(`LIMIT ${pageSize + 1}`);
    //const sql = sqlParts.join(' ');
    // const sqliteParams = toSqliteParams(itemsQueryParams);

    this.log.info('Querying stable transactions...', txsQuery?.text?.trim() ?? '');

    const finalQueryConfig: QueryConfig = this.transformQuery({ text: txsQuery.text }, { ...txsQueryFilters.values });

    const result = await this.dbPool.query(finalQueryConfig);
    return await Promise.all(result.rows.map(async (tx) => ({
      height: tx.height,
      blockTransactionIndex: tx.block_transaction_index,
      dataItemId: tx.data_item_id ? toB64Url(tx.data_item_id) : null,
      indexedAt: tx.indexed_at,
      id: toB64Url(tx.id),
      anchor: toB64Url(tx.anchor),
      signature: toB64Url(tx.signature),
      recipient: tx.target ? toB64Url(tx.target) : null,
      ownerAddress: toB64Url(tx.owner_address),
      ownerKey: toB64Url(tx.public_modulus),
      fee: tx.reward,
      quantity: tx.quantity,
      dataSize: tx.data_size,
      //todo optimize
      tags: [...await this.getGqlStableTransactionTags(tx.id), ...await this.getGqlStableDataItemTags(tx.id)],
      contentType: tx.content_type,
      blockIndepHash: toB64Url(tx.block_indep_hash),
      blockTimestamp: tx.block_timestamp,
      blockPreviousBlock: toB64Url(tx.block_previous_block),
      parentId: tx.parent_id ? toB64Url(tx.parent_id) : null,
    })));

    return [];
  }

  async getGqlTransactions({
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
                           }
                             :
                             {
                               pageSize: number;
                               cursor?: string;
                               sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
                               ids?: string[];
                               recipients?: string[];
                               owners?: string[];
                               minHeight?: number;
                               maxHeight?: number;
                               bundledIn?: string[] | null;
                               tags?: {
                                 name: string;
                                 values: string[]
                               }[];
                             },
  ) {
    let txs: GqlTransaction[] = [];

    //this.log.info('getGqlTransactions');

    if (sortOrder === 'HEIGHT_DESC') {
      txs = await this.getGqlNewTransactions({
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
          await this.getGqlStableTransactions({
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
            //@ts-ignore
            tags,
          }),
        );
      }
    } else {
      // txs = await this.getGqlStableTransactions({
      //   pageSize,
      //   cursor,
      //   sortOrder,
      //   ids,
      //   recipients,
      //   owners,
      //   minHeight,
      //   maxHeight,
      //   bundledIn,
      //   tags,
      // });


      if (txs.length < pageSize) {
        const lastTxHeight = txs[txs.length - 1]?.height;
        txs = txs.concat(
          await this.getGqlNewTransactions({
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
            //@ts-ignore
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

  async getGqlTransaction({ id }: {
    id: string;
  }): Promise<GqlTransaction> {
    let tx = (await this.getGqlStableTransactions({ pageSize: 1, ids: [id] }))[0];
    if (!tx) {
      tx = (await this.getGqlNewTransactions({ pageSize: 1, ids: [id] }))[0];
    }

    return tx;
  }

  getGqlStableBlocksBaseSql() {
    return `
        SELECT b.indep_hash      AS id,
               b.previous_block  AS previous,
               b.block_timestamp AS "timestamp",
               b.height          AS height
        FROM stable_blocks AS b;
    `;
  }

  getGqlNewBlocksBaseSql() {
    return `
        SELECT b.indep_hash      AS id,
               b.previous_block  AS previous,
               b.block_timestamp AS "timestamp",
               b.height          AS height
        FROM new_blocks AS b;
    `;
  }

  //@ts-ignore
  addGqlBlockFilters({ query, cursor, sortOrder = 'HEIGHT_DESC', ids = [], minHeight = -1, maxHeight = -1 }:
                       {
                         query: pkg.QueryConfig;
                         cursor?: string;
                         sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
                         ids?: string[];
                         minHeight?: number;
                         maxHeight?: number;
                       },
  ) {
    if (ids.length > 0) {
      // query.where(
      //   sql.in(
      //     "b.indep_hash",
      //     ids.map((id) => fromB64Url(id))
      //   )
      // );
    }

    if (minHeight != null && minHeight >= 0) {
      //query.where(sql.gte("b.height", minHeight));
    }

    if (maxHeight != null && maxHeight >= 0) {
      // query.where(sql.lte("b.height", maxHeight));
    }

    const { height: cursorHeight } = decodeBlockGqlCursor(cursor);

    if (sortOrder === 'HEIGHT_DESC') {
      if (cursorHeight) {
        // query.where(sql.lt('b.height', cursorHeight));
      }
      // query.orderBy('b.height DESC');
    } else {
      if (cursorHeight) {
        //  query.where(sql.gt('b.height', cursorHeight));
      }
      //  query.orderBy('b.height ASC');
    }
  }

  //@ts-ignore
  async getGqlNewBlocks({ pageSize, cursor, sortOrder = 'HEIGHT_DESC', ids = [], minHeight = -1, maxHeight = -1 }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    const query = this.getGqlNewBlocksBaseSql();
    //  this.addGqlBlockFilters({ query, cursor, sortOrder, ids, minHeight, maxHeight });
    const finalQueryConfig = this.transformQuery({ text: `${query} LIMIT ${pageSize + 1}` }, {});

    this.log.info('Querying new blocks...');

    return (await this.runQuery(finalQueryConfig))?.rows.map((block) => ({
      id: toB64Url(block.id),
      timestamp: block.timestamp,
      height: block.height,
      previous: toB64Url(block.previous),
    })) ?? [];
  }

//@ts-ignore
  async getGqlStableBlocks({ pageSize, cursor, sortOrder = 'HEIGHT_DESC', ids = [], minHeight = -1, maxHeight = -1 }:
                             {
                               pageSize: number;
                               cursor?: string;
                               sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
                               ids?: string[];
                               minHeight?: number;
                               maxHeight?: number;
                             }) {
    const query = this.getGqlStableBlocksBaseSql();
    // this.addGqlBlockFilters({ query, cursor, sortOrder, ids, minHeight, maxHeight });

    this.log.info('Querying stable blocks...');

    const queryConfig = { text: `${query} LIMIT ${pageSize + 1}` };
    const queryResult = await this.runQuery(queryConfig);
    if (queryResult !== undefined) {
      return queryResult.rows?.map((block) => ({
        id: toB64Url(block.id),
        timestamp: block.timestamp,
        height: block.height,
        previous: toB64Url(block.previous),
      }));
    }

    return [];
  }

  async getGqlBlocks({
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
                     },
  ) {
    let blocks;

    if (sortOrder === 'HEIGHT_DESC') {
      blocks = await this.getGqlNewBlocks({
        pageSize,
        cursor,
        sortOrder,
        ids,
        minHeight,
        maxHeight,
      });

      if (blocks.length < pageSize) {
        blocks = blocks.concat(
          await this.getGqlStableBlocks({
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
      blocks = await this.getGqlStableBlocks({
        pageSize,
        cursor,
        sortOrder,
        ids,
        minHeight,
        maxHeight,
      });

      if (blocks.length < pageSize) {
        blocks = blocks.concat(
          await this.getGqlNewBlocks({
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

  async getGqlBlock({ id }: getGqlBlockInput): Promise<any> {
    let block = (await this.getGqlStableBlocks({ pageSize: 1, ids: [id] }))[0];

    if (!block)
      block = (await this.getGqlNewBlocks({ pageSize: 1, ids: [id] }))[0];

    return block;
  }

  async isIdBlocked(id: string | undefined): Promise<boolean> {
    if (typeof id === 'string' && id.length > 0) {
      const queryResult = await this.runQuery(this.transformQuery(this.stmts.moderation.isIdBlocked, { id: fromB64Url(id) }));
      return queryResult?.rows[0]?.is_blocked === 1;
    }
    return false;
  }

  async isHashBlocked(hash: string | undefined): Promise<boolean> {
    if (typeof hash === 'string' && hash.length > 0) {
      const queryResult = await this.runQuery(this.transformQuery(this.stmts.moderation.isIdBlocked, { hash: fromB64Url(hash) }));
      return queryResult?.rows[0]?.is_blocked === 1;
    }

    return false;
  }

  async blockData({ id, hash, source, notes }: blockDataInput): Promise<void> {
    let sourceId = undefined;
    if (source !== undefined) {

      await this.runQuery(this.transformQuery(this.stmts.moderation.insertSource, {
        name: source,
        created_at: currentUnixTimestamp(),
      }));

      const sourceIDQueryResult = await this.runQuery(this.transformQuery(this.stmts.moderation.getSourceByName, {
        name: source,
      }));

      if (sourceIDQueryResult !== undefined && sourceIDQueryResult.rows.length > 0) {
        sourceId = sourceIDQueryResult.rows[0]?.id;
      }
    }
    if (id !== undefined) {
      await this.runQuery(this.transformQuery(this.stmts.moderation.insertBlockedId, {
        id: fromB64Url(id),
        block_source_id: sourceId,
        notes,
        blocked_at: currentUnixTimestamp(),
      }));
    } else if (hash !== undefined) {
      await this.runQuery(this.transformQuery(this.stmts.moderation.insertBlockedHash, {
        hash: fromB64Url(hash),
        block_source_id: sourceId,
        notes,
        blocked_at: currentUnixTimestamp(),
      }));
    }
  }

  async saveNestedDataId({ id, parentId, dataOffset, dataSize }: saveNestedDataIdInput): Promise<void> {
    await this.runQuery(this.transformQuery(this.stmts.data.insertNestedDataId, {
      id: fromB64Url(id),
      parent_id: fromB64Url(parentId),
      data_offset: dataOffset,
      data_size: dataSize,
      indexed_at: currentUnixTimestamp(),
    }));
  }

  async saveNestedDataHash({ hash, parentId, dataOffset }: saveNestedDataHashInput): saveNestedDataHashOutput {
    await this.runQuery({
      ...this.stmts.data.insertNestedDataHash, values: [
        fromB64Url(hash),
        fromB64Url(parentId),
        dataOffset,
        currentUnixTimestamp(),
      ],
    });
  }
}
