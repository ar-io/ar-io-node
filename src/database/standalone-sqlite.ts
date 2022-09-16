/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import crypto from 'crypto';
import * as R from 'ramda';
import sql from 'sql-bricks';

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
import {
  ChainDatabase,
  GqlQueryable,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

const STABLE_FLUSH_INTERVAL = 50;
const NEW_TX_CLEANUP_WAIT_SECS = 60 * 60 * 24;

const JOIN_LAST_TAG_NAMES = new Set(['App-Name', 'Content-Type']);

function tagJoinSortPriority(tag: { name: string; values: string[] }) {
  return JOIN_LAST_TAG_NAMES.has(tag.name) ? 1 : 0;
}

export function encodeTransactionGqlCursor({
  height,
  blockTransactionIndex,
}: {
  height: number;
  blockTransactionIndex: number;
}) {
  return utf8ToB64Url(JSON.stringify([height, blockTransactionIndex]));
}

export function decodeTransactionGqlCursor(cursor: string | undefined) {
  try {
    if (!cursor) {
      return { height: undefined, blockTransactionIndex: undefined };
    }

    const [height, blockTransactionIndex] = JSON.parse(
      b64UrlToUtf8(cursor),
    ) as [number, number];

    return { height, blockTransactionIndex };
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
      return { height: undefined };
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
    .reduce((acc, [i, v]) => {
      acc[i] = v;
      return acc;
    }, {} as { [key: string]: any });
}

export function txToDbRows(tx: PartialJsonTransaction) {
  const tagNames = [] as { name: Buffer; hash: Buffer }[];
  const tagValues = [] as { value: Buffer; hash: Buffer }[];
  const newTxTags = [] as {
    tag_name_hash: Buffer;
    tag_value_hash: Buffer;
    transaction_id: Buffer;
    transaction_tag_index: number;
  }[];
  const wallets = [] as { address: Buffer; public_modulus: Buffer }[];

  let contentType: string | undefined;
  const txId = fromB64Url(tx.id);

  let transactionTagIndex = 0;
  for (const tag of tx.tags) {
    const tagName = fromB64Url(tag.name);
    const tagNameHash = crypto.createHash('sha1').update(tagName).digest();
    tagNames.push({ name: tagName, hash: tagNameHash });

    const tagValue = fromB64Url(tag.value);
    const tagValueHash = crypto.createHash('sha1').update(tagValue).digest();
    tagValues.push({ value: tagValue, hash: tagValueHash });

    if (tagName.toString('utf8').toLowerCase() === 'content-type') {
      contentType = tagValue.toString('utf8');
    }

    newTxTags.push({
      tag_name_hash: tagNameHash,
      tag_value_hash: tagValueHash,
      transaction_id: txId,
      transaction_tag_index: transactionTagIndex,
    });

    transactionTagIndex++;
  }

  const ownerBuffer = fromB64Url(tx.owner);
  const ownerAddressBuffer = crypto
    .createHash('sha256')
    .update(ownerBuffer)
    .digest();

  wallets.push({ address: ownerAddressBuffer, public_modulus: ownerBuffer });

  return {
    tagNames,
    tagValues,
    newTxTags,
    wallets,
    newTx: {
      id: txId,
      signature: Buffer.from(tx.signature, 'base64'),
      format: tx.format,
      last_tx: Buffer.from(tx.last_tx, 'base64'),
      owner_address: ownerAddressBuffer,
      target: Buffer.from(tx.target, 'base64'),
      quantity: tx.quantity,
      reward: tx.reward,
      data_size: tx.data_size,
      data_root: Buffer.from(tx.data_root, 'base64'),
      content_type: contentType,
      tag_count: tx.tags.length,
      created_at: (Date.now() / 1000).toFixed(0),
    },
  };
}

export class StandaloneSqliteDatabase implements ChainDatabase, GqlQueryable {
  private dbs: {
    core: Sqlite.Database;
  };
  private stmts: {
    core: { [key: string]: Sqlite.Statement };
  };

  // Internal accessors
  private getMaxStableTimestampStmt: Sqlite.Statement;

  // Public accessors
  private getMaxHeightStmt: Sqlite.Statement;
  private getNewBlockHashByHeightStmt: Sqlite.Statement;
  private getMissingTxIdsStmt: Sqlite.Statement;

  // GraphQL
  private getMaxStableBlockHeightStmt: Sqlite.Statement;

  // Transactions
  insertTxFn: Sqlite.Transaction;
  insertBlockAndTxsFn: Sqlite.Transaction;
  saveStableDataFn: Sqlite.Transaction;
  deleteStaleNewDataFn: Sqlite.Transaction;

  constructor({ coreDb }: { coreDb: Sqlite.Database }) {
    this.dbs = { core: coreDb };
    this.dbs.core.pragma('journal_mode = WAL');
    this.dbs.core.pragma('page_size = 4096'); // may depend on OS and FS

    this.stmts = { core: {} };
    const sqlUrl = new URL('./sql/core', import.meta.url);
    const coreSql = yesql(sqlUrl.pathname) as { [key: string]: string };
    for (const [k, sql] of Object.entries(coreSql)) {
      if (!k.endsWith('.sql')) {
        this.stmts.core[k] = this.dbs.core.prepare(sql);
      }
    }

    // Internal accessors
    this.getMaxStableTimestampStmt = this.dbs.core.prepare(`
      SELECT IFNULL(MAX(block_timestamp), 0) AS block_timestamp
      FROM stable_blocks
    `);

    // Public accessors
    this.getMaxHeightStmt = this.dbs.core.prepare(`
      SELECT MAX(height) AS height
      FROM (
        SELECT MAX(height) AS height
        FROM new_block_heights
        UNION
        SELECT MAX(height) AS height
        FROM stable_blocks
      )
    `);

    this.getNewBlockHashByHeightStmt = this.dbs.core.prepare(`
      SELECT block_indep_hash
      FROM new_block_heights
      WHERE height = @height
    `);

    this.getMissingTxIdsStmt = this.dbs.core.prepare(`
      SELECT transaction_id
      FROM missing_transactions
      LIMIT @limit
    `);

    // Max stable block height (for GQL)
    this.getMaxStableBlockHeightStmt = this.dbs.core.prepare(`
      SELECT MAX(height) AS height
      FROM stable_blocks
    `);

    // Transactions
    this.insertTxFn = this.dbs.core.transaction(
      (tx: PartialJsonTransaction) => {
        // Insert the transaction
        const rows = txToDbRows(tx);

        for (const row of rows.tagNames) {
          this.stmts.core.insertOrIgnoreTagName.run(row);
        }

        for (const row of rows.tagValues) {
          this.stmts.core.insertOrIgnoreTagValue.run(row);
        }

        for (const row of rows.newTxTags) {
          this.stmts.core.insertOrIgnoreNewTransactionTag.run(row);
        }

        for (const row of rows.wallets) {
          this.stmts.core.insertOrIgnoreWallet.run(row);
        }

        this.stmts.core.insertOrIgnoreNewTransaction.run(rows.newTx);

        // Upsert the transaction to block assocation
        this.stmts.core.insertAsyncNewBlockTransaction.run({
          transaction_id: rows.newTx.id,
        });

        this.stmts.core.insertAsyncNewBlockHeight.run({
          transaction_id: rows.newTx.id,
        });

        // Remove missing transaction ID if it exists
        this.stmts.core.deleteMissingTransaction.run({
          transaction_id: rows.newTx.id,
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
        const rewardAddr = fromB64Url(block.reward_addr ?? '');
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

        this.stmts.core.insertOrIgnoreNewBlockHeight.run({
          height: block.height,
          block_indep_hash: indepHash,
        });

        let blockTransactionIndex = 0;
        for (const txIdStr of block.txs) {
          const txId = fromB64Url(txIdStr);

          this.stmts.core.insertOrIgnoreNewBlockTransaction.run({
            transaction_id: txId,
            block_indep_hash: indepHash,
            block_transaction_index: blockTransactionIndex,
          });

          blockTransactionIndex++;
        }

        for (const tx of txs) {
          const rows = txToDbRows(tx);

          for (const row of rows.tagNames) {
            this.stmts.core.insertOrIgnoreTagName.run(row);
          }

          for (const row of rows.tagValues) {
            this.stmts.core.insertOrIgnoreTagValue.run(row);
          }

          for (const row of rows.newTxTags) {
            this.stmts.core.insertOrIgnoreNewTransactionTag.run(row);
          }

          for (const row of rows.wallets) {
            this.stmts.core.insertOrIgnoreWallet.run(row);
          }

          this.stmts.core.insertOrIgnoreNewTransaction.run(rows.newTx);
        }

        for (const txIdStr of missingTxIds) {
          const txId = fromB64Url(txIdStr);

          this.stmts.core.insertOrIgnoreMissingTransaction.run({
            block_indep_hash: indepHash,
            transaction_id: txId,
            height: block.height,
          });
        }
      },
    );

    this.saveStableDataFn = this.dbs.core.transaction((endHeight: number) => {
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
    });

    this.deleteStaleNewDataFn = this.dbs.core.transaction(
      (heightThreshold: number, createdAtThreshold: number) => {
        this.stmts.core.deleteStaleNewTransactionTags.run({
          height_threshold: heightThreshold,
        });

        this.stmts.core.deleteStaleNewTransactionsByHeight.run({
          height_threshold: heightThreshold,
        });

        this.stmts.core.deleteStaleNewBlockTransactions.run({
          height_threshold: heightThreshold,
          created_at_threshold: createdAtThreshold,
        });

        this.stmts.core.deleteStaleNewBlocks.run({
          height_threshold: heightThreshold,
        });

        this.stmts.core.deleteStaleNewBlockHeights.run({
          height_threshold: heightThreshold,
        });

        this.stmts.core.deleteStaleNewTransactionsByCreatedAt.run({
          created_at_threshold: createdAtThreshold,
        });

        this.stmts.core.deleteForkedOutMissingTransactions.run({
          height_threshold: heightThreshold,
        });
      },
    );
  }

  async getMaxHeight(): Promise<number> {
    return this.getMaxHeightStmt.get().height ?? -1;
  }

  async getNewBlockHashByHeight(height: number): Promise<string | undefined> {
    if (height < 0) {
      throw new Error(`Invalid height ${height}, must be >= 0.`);
    }
    const hash = this.getNewBlockHashByHeightStmt.get({
      height,
    })?.block_indep_hash;
    return hash ? toB64Url(hash) : undefined;
  }

  async getMissingTxIds(limit = 20): Promise<string[]> {
    const missingTxIds = this.getMissingTxIdsStmt.all({
      limit,
    });

    return missingTxIds.map((row): string => toB64Url(row.transaction_id));
  }

  async resetToHeight(height: number): Promise<void> {
    this.stmts.core.truncateNewBlockHeightsAt.run({ height });
  }

  async saveTx(tx: PartialJsonTransaction): Promise<void> {
    this.insertTxFn(tx);
  }

  async saveBlockAndTxs(
    block: PartialJsonBlock,
    txs: PartialJsonTransaction[],
    missingTxIds: string[],
  ): Promise<void> {
    // TODO add metrics to track timing

    this.insertBlockAndTxsFn(block, txs, missingTxIds);

    if (block.height % STABLE_FLUSH_INTERVAL === 0) {
      const {
        block_timestamp: maxDbStableTimestamp,
      } = this.getMaxStableTimestampStmt.get();
      const endHeight = block.height - MAX_FORK_DEPTH;

      this.saveStableDataFn(endHeight);

      this.deleteStaleNewDataFn(
        endHeight,
        maxDbStableTimestamp - NEW_TX_CLEANUP_WAIT_SECS,
      );
    }
  }

  async getDebugInfo() {
    const walletCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM wallets')
      .get().cnt as number;
    const tagNameCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM tag_names')
      .get().cnt as number;
    const tagValueCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM tag_values')
      .get().cnt as number;
    const stableTxCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM stable_transactions')
      .get().cnt as number;
    const stableBlockCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM stable_blocks')
      .get().cnt as number;
    const stableBlockTxCount = this.dbs.core
      .prepare('SELECT SUM(tx_count) AS cnt FROM stable_blocks')
      .get().cnt as number;
    const newTxCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM new_transactions')
      .get().cnt as number;
    const newBlockCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM new_blocks')
      .get().cnt as number;
    const missingTxCount = this.dbs.core
      .prepare('SELECT COUNT(*) AS cnt FROM missing_transactions')
      .get().cnt as number;
    const minStableHeight = this.dbs.core
      .prepare('SELECT MIN(height) AS min_height FROM stable_blocks')
      .get().min_height as number;
    const maxStableHeight = this.dbs.core
      .prepare('SELECT MAX(height) AS max_height FROM stable_blocks')
      .get().max_height as number;
    const minNewBlockHeight = this.dbs.core
      .prepare('SELECT MIN(height) AS min_height FROM new_block_heights')
      .get().min_height as number;
    const maxNewBlockHeight = this.dbs.core
      .prepare('SELECT MAX(height) AS max_height FROM new_block_heights')
      .get().max_height as number;

    const missingStableBlockCount =
      maxStableHeight - (minStableHeight - 1) - stableBlockCount;

    return {
      counts: {
        wallets: walletCount,
        tagNames: tagNameCount,
        tagValues: tagValueCount,
        stableTxs: stableTxCount,
        stableBlocks: stableBlockCount,
        stableBlockTxs: stableBlockTxCount,
        missingStableBlocks: missingStableBlockCount,
        missingTxs: missingTxCount,
        newTxs: newTxCount,
        newBlocks: newBlockCount,
      },
      heights: {
        minStable: minStableHeight,
        maxStable: maxStableHeight,
        minNew: minNewBlockHeight,
        maxNew: maxNewBlockHeight,
      },
    };
  }

  getGqlNewTransactionTags(txId: Buffer) {
    const tags = this.stmts.core.getNewTransactionTags.all({
      transaction_id: txId,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlStableTransactionTags(txId: Buffer) {
    const tags = this.stmts.core.getStableTransactionTags.all({
      transaction_id: txId,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlNewTransactionsBaseSql() {
    return sql
      .select(
        'nbh.height AS height',
        'nbt.block_transaction_index AS block_transaction_index',
        'id',
        'last_tx',
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
      )
      .from('new_transactions nt')
      .join('new_block_transactions nbt', {
        'nbt.transaction_id': 'nt.id',
      })
      .join('new_blocks nb', {
        'nb.indep_hash': 'nbt.block_indep_hash',
      })
      .join('new_block_heights nbh', {
        'nbh.block_indep_hash': 'nb.indep_hash',
      })
      .join('wallets w', {
        'nt.owner_address': 'w.address',
      });
  }

  getGqlStableTransactionsBaseSql() {
    return sql
      .select(
        'st.height AS height',
        'st.block_transaction_index AS block_transaction_index',
        'id',
        'last_tx',
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
      )
      .from('stable_transactions st')
      .join('stable_blocks sb', {
        'st.height': 'sb.height',
      })
      .join('wallets w', {
        'st.owner_address': 'w.address',
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
    tags = [],
  }: {
    query: sql.SelectStatement;
    source: 'stable' | 'new';
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    tags: { name: string; values: string[] }[];
  }) {
    let txTableAlias: string;
    let heightTableAlias: string;
    let blockTransactionIndexTableAlias: string;
    let tagsTable: string;
    let heightSortTableAlias: string;
    let blockTransactionIndexSortTableAlias: string;
    let maxDbHeight = Infinity;

    if (source === 'stable') {
      txTableAlias = 'st';
      heightTableAlias = 'st';
      blockTransactionIndexTableAlias = 'st';
      tagsTable = 'stable_transaction_tags';
      heightSortTableAlias = 'st';
      blockTransactionIndexSortTableAlias = 'st';
      maxDbHeight = this.getMaxStableBlockHeightStmt.get().height as number;
    } else {
      txTableAlias = 'nt';
      heightTableAlias = 'nb';
      blockTransactionIndexTableAlias = 'nbt';
      tagsTable = 'new_transaction_tags';
      heightSortTableAlias = 'nb';
      blockTransactionIndexSortTableAlias = 'nbt';
    }

    if (ids.length > 0) {
      query.where(sql.in(`${txTableAlias}.id`, ids.map(fromB64Url)));
    }

    if (recipients.length > 0) {
      query.where(sql.in(`${txTableAlias}.target`, recipients.map(fromB64Url)));
    }

    if (owners.length > 0) {
      query.where(
        sql.in(`${txTableAlias}.owner_address`, owners.map(fromB64Url)),
      );
    }

    if (tags) {
      const sortByTagJoinPriority = R.sortBy(tagJoinSortPriority);
      sortByTagJoinPriority(tags).forEach((tag, index) => {
        const tagAlias = `"${index}_${index}"`;
        let joinCond: { [key: string]: string };
        if (source === 'stable') {
          heightSortTableAlias = tagAlias;
          blockTransactionIndexSortTableAlias = tagAlias;
          joinCond = {
            [`${blockTransactionIndexTableAlias}.block_transaction_index`]: `${tagAlias}.block_transaction_index`,
            [`${heightTableAlias}.height`]: `${tagAlias}.height`,
          };
        } else {
          joinCond = {
            [`${txTableAlias}.id`]: `${tagAlias}.transaction_id`,
          };
        }

        query.join(`${tagsTable} AS ${tagAlias}`, joinCond);

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

    if (minHeight > 0) {
      query.where(sql.gte(`${heightTableAlias}.height`, minHeight));
    }

    if (maxHeight >= 0 && maxHeight < maxDbHeight) {
      query.where(sql.lte(`${heightTableAlias}.height`, maxHeight));
    }

    const {
      height: cursorHeight,
      blockTransactionIndex: cursorBlockTransactionIndex,
    } = decodeTransactionGqlCursor(cursor);

    if (sortOrder === 'HEIGHT_DESC') {
      if (cursorHeight) {
        query.where(
          sql.lt(
            `${heightSortTableAlias}.height * 1000 + ${blockTransactionIndexSortTableAlias}.block_transaction_index`,
            cursorHeight * 1000 + cursorBlockTransactionIndex ?? 0,
          ),
        );
      }
      query.orderBy(
        `${heightSortTableAlias}.height DESC, ${blockTransactionIndexSortTableAlias}.block_transaction_index DESC`,
      );
    } else {
      if (cursorHeight) {
        query.where(
          sql.gt(
            `${heightSortTableAlias}.height * 1000 + ${blockTransactionIndexSortTableAlias}.block_transaction_index`,
            cursorHeight * 1000 + cursorBlockTransactionIndex ?? 0,
          ),
        );
      }
      query.orderBy(
        `${heightSortTableAlias}.height ASC, ${blockTransactionIndexSortTableAlias}.block_transaction_index ASC`,
      );
    }
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
    tags?: { name: string; values: string[] }[];
  }) {
    const query = this.getGqlNewTransactionsBaseSql();

    this.addGqlTransactionFilters({
      query,
      source: 'new',
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      tags,
    });

    const queryParams = query.toParams();
    const sql = queryParams.text;
    const sqliteParams = toSqliteParams(queryParams);

    return this.dbs.core
      .prepare(`${sql} LIMIT ${pageSize + 1}`)
      .all(sqliteParams)
      .map((tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        id: toB64Url(tx.id),
        anchor: toB64Url(tx.last_tx),
        signature: toB64Url(tx.signature),
        recipient: tx.target ? toB64Url(tx.target) : undefined,
        ownerAddress: toB64Url(tx.owner_address),
        ownerKey: toB64Url(tx.public_modulus),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        tags: this.getGqlNewTransactionTags(tx.id),
        contentType: tx.content_type,
        blockIndepHash: toB64Url(tx.block_indep_hash),
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: toB64Url(tx.block_previous_block),
      }));
  }

  async getGqlStableTransactions({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
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
    tags?: { name: string; values: string[] }[];
  }) {
    const query = this.getGqlStableTransactionsBaseSql();

    this.addGqlTransactionFilters({
      query,
      source: 'stable',
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      tags,
    });

    const queryParams = query.toParams();
    const sql = queryParams.text;
    const sqliteParams = toSqliteParams(queryParams);

    return this.dbs.core
      .prepare(`${sql} LIMIT ${pageSize + 1}`)
      .all(sqliteParams)
      .map((tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        id: toB64Url(tx.id),
        anchor: toB64Url(tx.last_tx),
        signature: toB64Url(tx.signature),
        recipient: tx.target ? toB64Url(tx.target) : undefined,
        ownerAddress: toB64Url(tx.owner_address),
        ownerKey: toB64Url(tx.public_modulus),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        tags: this.getGqlStableTransactionTags(tx.id),
        contentType: tx.content_type,
        blockIndepHash: toB64Url(tx.block_indep_hash),
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: toB64Url(tx.block_previous_block),
      }));
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
    tags?: { name: string; values: string[] }[];
  }) {
    let txs;

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
        tags,
      });

      if (txs.length < pageSize) {
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
              txs.length > 0 ? txs[txs.length - 1].height - 1 : maxHeight,
            tags,
          }),
        );
      }
    } else {
      txs = await this.getGqlStableTransactions({
        pageSize,
        cursor,
        sortOrder,
        ids,
        recipients,
        owners,
        minHeight,
        maxHeight,
        tags,
      });

      if (txs.length < pageSize) {
        txs = txs.concat(
          await this.getGqlNewTransactions({
            pageSize,
            cursor,
            sortOrder,
            ids,
            recipients,
            owners,
            minHeight:
              txs.length > 0 ? txs[txs.length - 1].height + 1 : minHeight,
            maxHeight,
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

  async getGqlTransaction({ id }: { id: string }) {
    let tx = (
      await this.getGqlStableTransactions({ pageSize: 1, ids: [id] })
    )[0];
    if (!tx) {
      tx = (await this.getGqlNewTransactions({ pageSize: 1, ids: [id] }))[0];
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
      .from('new_blocks AS b')
      .join('new_block_heights nbh', {
        'b.indep_hash': 'nbh.block_indep_hash',
      });
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

    if (minHeight >= 0) {
      query.where(sql.gte('b.height', minHeight));
    }

    if (maxHeight >= 0) {
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

  async getGqlNewBlocks({
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

  async getGqlStableBlocks({
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
  }) {
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

  async getGqlBlock({ id }: { id: string }) {
    let block = (await this.getGqlStableBlocks({ pageSize: 1, ids: [id] }))[0];
    if (!block) {
      block = (await this.getGqlNewBlocks({ pageSize: 1, ids: [id] }))[0];
    }

    return block;
  }
}
