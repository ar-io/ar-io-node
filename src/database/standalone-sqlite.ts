import {
  ChainDatabase,
  JsonBlock,
  JsonTransaction,
  GqlQueryable,
} from '../types.js';
import {
  toB64Url,
  fromB64Url,
  b64UrlToUtf8,
  utf8ToB64Url,
} from '../lib/utils.js';
import Sqlite from 'better-sqlite3';
import crypto from 'crypto';
import { MAX_FORK_DEPTH } from '../arweave/constants.js';
import sql from 'sql-bricks';
import { ValidationError } from 'apollo-server-express';

const STABLE_FLUSH_INTERVAL = 50;
const NEW_TX_CLEANUP_WAIT_SECS = 60 * 60 * 24;

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

export class StandaloneSqliteDatabase implements ChainDatabase, GqlQueryable {
  private db: Sqlite.Database;

  // Lookup table inserts
  private walletInsertStmt: Sqlite.Statement;
  private tagNamesInsertStmt: Sqlite.Statement;
  private tagValuesInsertStmt: Sqlite.Statement;

  // "new_*" (and related) inserts
  private newBlocksInsertStmt: Sqlite.Statement;
  private newBlockHeightsInsertStmt: Sqlite.Statement;
  private newBlockTxsInsertStmt: Sqlite.Statement;
  private newTxTagsInsertStmt: Sqlite.Statement;
  private newTxsInsertStmt: Sqlite.Statement;
  private missingTxsInsertStmt: Sqlite.Statement;

  // "new_*" to "stable_*" copy
  private saveStableBlockRangeStmt: Sqlite.Statement;
  private saveStableBlockTxsRangeStmt: Sqlite.Statement;
  private saveStableTxsRangeStmt: Sqlite.Statement;
  private saveStableTxTagsRangeStmt: Sqlite.Statement;

  // Stale "new_*" data cleanup
  private deleteStaleNewTxTagsStmt: Sqlite.Statement;
  private deleteStaleNewTxsByHeightStmt: Sqlite.Statement;
  private deleteStaleNewTxsByTimestampStmt: Sqlite.Statement;
  private deleteStaleNewBlockTxsStmt: Sqlite.Statement;
  private deleteStaleNewBlocksStmt: Sqlite.Statement;
  private deleteStaleNewBlockHeightsStmt: Sqlite.Statement;

  // Internal accessors
  private getMaxStableHeightAndTimestampStmt: Sqlite.Statement;

  // Public accessors
  private getMaxHeightStmt: Sqlite.Statement;
  private getNewBlockHashByHeightStmt: Sqlite.Statement;

  // Height reset
  private resetToHeightStmt: Sqlite.Statement;

  // GraphQL
  private getNewTransactionTagsStmt: Sqlite.Statement;
  private getStableTransactionTagsStmt: Sqlite.Statement;

  // Transactions
  insertBlockAndTxsFn: Sqlite.Transaction;
  saveStableBlockRangeFn: Sqlite.Transaction;
  deleteStaleNewDataFn: Sqlite.Transaction;

  constructor(db: Sqlite.Database) {
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('page_size = 4096'); // may depend on OS and FS

    // Lookup table inserts
    this.walletInsertStmt = this.db.prepare(`
      INSERT INTO wallets (address, public_modulus)
      VALUES (@address, @public_modulus)
      ON CONFLICT DO NOTHING
    `);

    this.tagNamesInsertStmt = this.db.prepare(`
      INSERT INTO tag_names (hash, name)
      VALUES (@hash, @name)
      ON CONFLICT DO NOTHING
    `);

    this.tagValuesInsertStmt = this.db.prepare(`
      INSERT INTO tag_values (hash, value)
      VALUES (@hash, @value)
      ON CONFLICT DO NOTHING
    `);

    // "new_*" (and related) inserts
    // TODO are the CASTs necessary
    this.newBlocksInsertStmt = this.db.prepare(`
      INSERT INTO new_blocks (
        indep_hash, height, previous_block, nonce, hash,
        block_timestamp, diff,
        cumulative_diff, last_retarget,
        reward_addr, reward_pool,
        block_size, weave_size,
        usd_to_ar_rate_dividend,
        usd_to_ar_rate_divisor,
        scheduled_usd_to_ar_rate_dividend,
        scheduled_usd_to_ar_rate_divisor,
        hash_list_merkle, wallet_list, tx_root,
        tx_count, missing_tx_count
      ) VALUES (
        @indep_hash, @height, @previous_block, @nonce, @hash,
        CAST(@block_timestamp AS INTEGER), @diff,
        @cumulative_diff, CAST(@last_retarget AS INTEGER),
        @reward_addr, CAST(@reward_pool AS INTEGER),
        CAST(@block_size AS INTEGER), CAST(@weave_size AS INTEGER),
        CAST(@usd_to_ar_rate_dividend AS INTEGER),
        CAST(@usd_to_ar_rate_divisor AS INTEGER),
        CAST(@scheduled_usd_to_ar_rate_dividend AS INTEGER),
        CAST(@scheduled_usd_to_ar_rate_divisor AS INTEGER),
        @hash_list_merkle, @wallet_list, @tx_root,
        @tx_count, @missing_tx_count
      ) ON CONFLICT DO NOTHING
    `);

    this.newBlockHeightsInsertStmt = this.db.prepare(`
      INSERT INTO new_block_heights (
        height, block_indep_hash
      ) VALUES (
        @height, @block_indep_hash
      ) ON CONFLICT DO NOTHING
    `);

    this.newBlockTxsInsertStmt = this.db.prepare(`
      INSERT INTO new_block_transactions (
        block_indep_hash, transaction_id, block_transaction_index
      ) VALUES (
        @block_indep_hash, @transaction_id, @block_transaction_index
      ) ON CONFLICT DO NOTHING
    `);

    this.newTxTagsInsertStmt = this.db.prepare(`
      INSERT INTO new_transaction_tags (
        tag_name_hash, tag_value_hash,
        transaction_id, transaction_tag_index
      ) VALUES (
        @tag_name_hash, @tag_value_hash,
        @transaction_id, @transaction_tag_index
      ) ON CONFLICT DO NOTHING
    `);

    this.newTxsInsertStmt = this.db.prepare(`
      INSERT INTO new_transactions (
        id, signature, format, last_tx, owner_address,
        target, quantity, reward, data_size, data_root,
        tag_count, content_type, created_at
      ) VALUES (
        @id, @signature, @format, @last_tx, @owner_address,
        @target, @quantity, @reward, @data_size, @data_root,
        @tag_count, @content_type, @created_at
      ) ON CONFLICT DO NOTHING
    `);

    this.missingTxsInsertStmt = this.db.prepare(`
      INSERT INTO missing_transactions (
        block_indep_hash, transaction_id, height
      ) VALUES (
        @block_indep_hash, @transaction_id, @height
      ) ON CONFLICT DO NOTHING
    `);

    // "new_*" to "stable_*" copy
    this.saveStableBlockRangeStmt = this.db.prepare(`
      INSERT INTO stable_blocks (
        height, indep_hash, previous_block, nonce, hash,
        block_timestamp, diff, cumulative_diff, last_retarget,
        reward_addr, reward_pool, block_size, weave_size,
        usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
        scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
        hash_list_merkle, wallet_list, tx_root,
        tx_count, missing_tx_count
      ) SELECT
        nbh.height, nb.indep_hash, nb.previous_block, nb.nonce, nb.hash,
        nb.block_timestamp, nb.diff, nb.cumulative_diff, nb.last_retarget,
        nb.reward_addr, nb.reward_pool, nb.block_size, nb.weave_size,
        nb.usd_to_ar_rate_dividend, nb.usd_to_ar_rate_divisor,
        nb.scheduled_usd_to_ar_rate_dividend, nb.scheduled_usd_to_ar_rate_divisor,
        nb.hash_list_merkle, nb.wallet_list, nb.tx_root,
        nb.tx_count, missing_tx_count
      FROM new_blocks nb
      JOIN new_block_heights nbh ON nbh.block_indep_hash = nb.indep_hash
      WHERE nbh.height >= @start_height AND nbh.height < @end_height
      ON CONFLICT DO NOTHING
    `);

    this.saveStableBlockTxsRangeStmt = this.db.prepare(`
      INSERT INTO stable_block_transactions (
        block_indep_hash, transaction_id, block_transaction_index
      ) SELECT
        nbt.block_indep_hash, nbt.transaction_id, nbt.block_transaction_index
      FROM new_block_transactions nbt
      JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
      WHERE nbh.height >= @start_height AND nbh.height < @end_height
      ON CONFLICT DO NOTHING
    `);

    this.saveStableTxsRangeStmt = this.db.prepare(`
      INSERT INTO stable_transactions (
        id, height, block_transaction_index, signature,
        format, last_tx, owner_address, target, quantity,
        reward, data_size, data_root, content_type, tag_count
      ) SELECT
        nt.id, nbh.height, nbt.block_transaction_index, nt.signature,
        nt.format, nt.last_tx, nt.owner_address, nt.target, nt.quantity,
        nt.reward, nt.data_size, nt.data_root, nt.content_type, nt.tag_count
      FROM new_transactions nt
      JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
      JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
      WHERE nbh.height >= @start_height AND nbh.height < @end_height
      ON CONFLICT DO NOTHING
    `);

    this.saveStableTxTagsRangeStmt = this.db.prepare(`
      INSERT INTO stable_transaction_tags (
        tag_name_hash, tag_value_hash, height,
        block_transaction_index, transaction_tag_index,
        transaction_id
      ) SELECT
        ntt.tag_name_hash, ntt.tag_value_hash, nbh.height,
        nbt.block_transaction_index, ntt.transaction_tag_index,
        ntt.transaction_id
      FROM new_transaction_tags ntt
      JOIN new_block_transactions nbt ON nbt.transaction_id = ntt.transaction_id
      JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
      WHERE nbh.height >= @start_height AND nbh.height < @end_height
      ON CONFLICT DO NOTHING
    `);

    // Stale "new_*" data cleanup
    this.deleteStaleNewTxTagsStmt = this.db.prepare(`
      DELETE FROM new_transaction_tags
      WHERE transaction_id IN (
        SELECT nbt.transaction_id
        FROM new_block_transactions nbt
        JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
        WHERE nbh.height < @height_threshold
      )
    `);

    this.deleteStaleNewTxsByHeightStmt = this.db.prepare(`
      DELETE FROM new_transactions
      WHERE id IN (
        SELECT nbt.transaction_id
        FROM new_block_transactions nbt
        JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
        WHERE nbh.height < @height_threshold
      )
    `);

    this.deleteStaleNewBlockTxsStmt = this.db.prepare(`
      DELETE FROM new_block_transactions
      WHERE transaction_id IN (
        SELECT nbt.transaction_id
        FROM new_block_transactions nbt
        JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
        WHERE nbh.height < @height_threshold
      ) OR transaction_id IN (
        SELECT transaction_id
        FROM new_transactions
        WHERE created_at < @created_at_threshold
      )
    `);

    this.deleteStaleNewBlocksStmt = this.db.prepare(`
      DELETE FROM new_blocks
      WHERE height < @height_threshold
    `);

    this.deleteStaleNewBlockHeightsStmt = this.db.prepare(`
      DELETE FROM new_block_heights
      WHERE height < @height_threshold
    `);

    this.deleteStaleNewTxsByTimestampStmt = this.db.prepare(`
      DELETE FROM new_transactions
      WHERE created_at < @created_at_threshold
    `);

    // Internal accessors
    this.getMaxStableHeightAndTimestampStmt = this.db.prepare(`
      SELECT
        IFNULL(MAX(height), -1) AS height,
        IFNULL(MAX(block_timestamp), 0) AS block_timestamp
      FROM stable_blocks
    `);

    // Public accessors
    this.getMaxHeightStmt = this.db.prepare(`
      SELECT MAX(height) AS height
      FROM (
        SELECT MAX(height) AS height
        FROM new_block_heights
        UNION
        SELECT MAX(height) AS height
        FROM stable_blocks
      )
    `);

    this.getNewBlockHashByHeightStmt = this.db.prepare(`
      SELECT block_indep_hash
      FROM new_block_heights
      WHERE height = @height
    `);

    // Height reset
    this.resetToHeightStmt = this.db.prepare(`
      DELETE FROM new_block_heights
      WHERE height > @height
    `);

    // Get new transaction tags (for GQL)
    this.getNewTransactionTagsStmt = this.db.prepare(`
      SELECT name, value
      FROM new_transaction_tags
      JOIN tag_names ON tag_name_hash = tag_names.hash
      JOIN tag_values ON tag_value_hash = tag_values.hash
      WHERE transaction_id = @transaction_id
    `);

    // Get stable transaction tags (for GQL)
    this.getStableTransactionTagsStmt = this.db.prepare(`
      SELECT name, value
      FROM stable_transaction_tags
      JOIN tag_names ON tag_name_hash = tag_names.hash
      JOIN tag_values ON tag_value_hash = tag_values.hash
      WHERE transaction_id = @transaction_id
    `);

    // Transactions
    this.insertBlockAndTxsFn = this.db.transaction(
      (block: JsonBlock, txs: JsonTransaction[], missingTxIds: string[]) => {
        const indepHash = Buffer.from(block.indep_hash, 'base64');
        const previousBlock = Buffer.from(block.previous_block ?? '', 'base64');
        const nonce = Buffer.from(block.nonce, 'base64');
        const hash = Buffer.from(block.hash, 'base64');
        const rewardAddr = Buffer.from(block.reward_addr ?? '', 'base64');
        const hashListMerkle =
          block.hash_list_merkle &&
          Buffer.from(block.hash_list_merkle, 'base64');
        const walletList = Buffer.from(block.wallet_list, 'base64');
        const txRoot = block.tx_root && Buffer.from(block.tx_root, 'base64');

        this.newBlocksInsertStmt.run({
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

        this.newBlockHeightsInsertStmt.run({
          height: block.height,
          block_indep_hash: indepHash,
        });

        let blockTransactionIndex = 0;
        for (const txIdStr of block.txs) {
          const txId = Buffer.from(txIdStr, 'base64');

          this.newBlockTxsInsertStmt.run({
            transaction_id: txId,
            block_indep_hash: indepHash,
            block_transaction_index: blockTransactionIndex,
          });

          blockTransactionIndex++;
        }

        for (const tx of txs) {
          let contentType: string | undefined;
          const txId = Buffer.from(tx.id, 'base64');

          let transactionTagIndex = 0;
          for (const tag of tx.tags) {
            const tagName = Buffer.from(tag.name, 'base64');
            const tagNameHash = crypto
              .createHash('sha1')
              .update(tagName)
              .digest();

            this.tagNamesInsertStmt.run({
              hash: tagNameHash,
              name: tagName,
            });

            const tagValue = Buffer.from(tag.value, 'base64');
            const tagValueHash = crypto
              .createHash('sha1')
              .update(tagValue)
              .digest();

            this.tagValuesInsertStmt.run({
              hash: tagValueHash,
              value: tagValue,
            });

            if (tagName.toString('utf8').toLowerCase() === 'content-type') {
              contentType = tagValue.toString('utf8');
            }

            this.newTxTagsInsertStmt.run({
              tag_name_hash: tagNameHash,
              tag_value_hash: tagValueHash,
              transaction_id: txId,
              transaction_tag_index: transactionTagIndex,
            });

            transactionTagIndex++;
          }

          const ownerBuffer = Buffer.from(tx.owner, 'base64');
          const ownerAddressBuffer = crypto
            .createHash('sha256')
            .update(ownerBuffer)
            .digest();

          this.walletInsertStmt.run({
            address: ownerAddressBuffer,
            public_modulus: ownerBuffer,
          });

          this.newTxsInsertStmt.run({
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
          });
        }

        for (const txIdStr of missingTxIds) {
          const txId = Buffer.from(txIdStr, 'base64');

          this.missingTxsInsertStmt.run({
            block_indep_hash: indepHash,
            transaction_id: txId,
            height: block.height,
          });
        }
      },
    );

    this.saveStableBlockRangeFn = this.db.transaction(
      (startHeight: number, endHeight: number) => {
        this.saveStableBlockRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight,
        });

        this.saveStableBlockTxsRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight,
        });

        this.saveStableTxsRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight,
        });

        this.saveStableTxTagsRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight,
        });
      },
    );

    this.deleteStaleNewDataFn = this.db.transaction(
      (heightThreshold: number, createdAtThreshold: number) => {
        this.deleteStaleNewTxTagsStmt.run({
          height_threshold: heightThreshold,
        });

        this.deleteStaleNewTxsByHeightStmt.run({
          height_threshold: heightThreshold,
        });

        this.deleteStaleNewBlockTxsStmt.run({
          height_threshold: heightThreshold,
          created_at_threshold: createdAtThreshold,
        });

        this.deleteStaleNewBlocksStmt.run({
          height_threshold: heightThreshold,
        });

        this.deleteStaleNewBlockHeightsStmt.run({
          height_threshold: heightThreshold,
        });

        this.deleteStaleNewTxsByTimestampStmt.run({
          created_at_threshold: createdAtThreshold,
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
    return hash ? hash.toString('base64url') : undefined;
  }

  async resetToHeight(height: number): Promise<void> {
    this.resetToHeightStmt.run({ height });
  }

  async saveBlockAndTxs(
    block: JsonBlock,
    txs: JsonTransaction[],
    missingTxIds: string[],
  ): Promise<void> {
    // TODO add metrics to track timing

    this.insertBlockAndTxsFn(block, txs, missingTxIds);

    if (block.height % STABLE_FLUSH_INTERVAL === 0) {
      const { height: startHeight, block_timestamp: maxStableTimestamp } =
        this.getMaxStableHeightAndTimestampStmt.get();
      const endHeight = block.height - MAX_FORK_DEPTH;

      if (startHeight < endHeight) {
        this.saveStableBlockRangeFn(startHeight, endHeight);
      }

      this.deleteStaleNewDataFn(
        endHeight,
        maxStableTimestamp - NEW_TX_CLEANUP_WAIT_SECS,
      );
    }
  }

  async getDebugInfo() {
    const walletCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM wallets')
      .get().cnt as number;
    const tagNameCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM tag_names')
      .get().cnt as number;
    const tagValueCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM tag_values')
      .get().cnt as number;
    const stableTxCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM stable_transactions')
      .get().cnt as number;
    const stableBlockCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM stable_blocks')
      .get().cnt as number;
    const stableBlockTxCount = this.db
      .prepare('SELECT SUM(tx_count) AS cnt FROM stable_blocks')
      .get().cnt as number;
    const newTxCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM new_transactions')
      .get().cnt as number;
    const newBlockCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM new_blocks')
      .get().cnt as number;
    const missingTxCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM missing_transactions')
      .get().cnt as number;
    const minStableHeight = this.db
      .prepare('SELECT MIN(height) AS min_height FROM stable_blocks')
      .get().min_height as number;
    const maxStableHeight = this.db
      .prepare('SELECT MAX(height) AS max_height FROM stable_blocks')
      .get().max_height as number;
    const minNewBlockHeight = this.db
      .prepare('SELECT MIN(height) AS min_height FROM new_block_heights')
      .get().min_height as number;
    const maxNewBlockHeight = this.db
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
    const tags = this.getNewTransactionTagsStmt.all({
      transaction_id: txId,
    });

    return tags.map((tag) => ({
      name: tag.name.toString('utf8'),
      value: tag.value.toString('utf8'),
    }));
  }

  getGqlStableTransactionTags(txId: Buffer) {
    const tags = this.getStableTransactionTagsStmt.all({
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

    if (source === 'stable') {
      txTableAlias = 'st';
      heightTableAlias = 'st';
      blockTransactionIndexTableAlias = 'st';
      tagsTable = 'stable_transaction_tags';
      heightSortTableAlias = 'st';
      blockTransactionIndexSortTableAlias = 'st';
    } else {
      txTableAlias = 'nt';
      heightTableAlias = 'nb';
      blockTransactionIndexTableAlias = 'nbt';
      tagsTable = 'new_transaction_tags';
      heightSortTableAlias = 'nb';
      blockTransactionIndexSortTableAlias = 'nbt';
    }

    if (ids.length > 0) {
      query.where(
        sql.in(
          `${txTableAlias}.id`,
          ids.map((v) => Buffer.from(v, 'base64')),
        ),
      );
    }

    if (recipients.length > 0) {
      query.where(
        sql.in(
          `${txTableAlias}.target`,
          recipients.map((v) => Buffer.from(v, 'base64')),
        ),
      );
    }

    if (owners.length > 0) {
      query.where(
        sql.in(
          `${txTableAlias}.owner_address`,
          owners.map((v) => Buffer.from(v, 'base64')),
        ),
      );
    }

    if (minHeight >= 0) {
      query.where(sql.gte(`${heightTableAlias}.height`, minHeight));
    }

    if (maxHeight >= 0) {
      query.where(sql.lte(`${heightTableAlias}.height`, maxHeight));
    }

    if (tags) {
      tags.forEach((tag, index) => {
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

    return this.db
      .prepare(`${sql} LIMIT ${pageSize + 1}`)
      .all(sqliteParams)
      .map((tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        id: tx.id.toString('base64url'),
        anchor: tx.last_tx.toString('base64url'),
        signature: tx.signature.toString('base64url'),
        recipient: tx.target?.toString('base64url'),
        ownerAddress: tx.owner_address.toString('base64url'),
        ownerKey: tx.public_modulus.toString('base64url'),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        tags: this.getGqlNewTransactionTags(tx.id),
        contentType: tx.content_type,
        blockIndepHash: tx.block_indep_hash.toString('base64url'),
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: tx.block_previous_block.toString('base64url'),
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

    return this.db
      .prepare(`${sql} LIMIT ${pageSize + 1}`)
      .all(sqliteParams)
      .map((tx) => ({
        height: tx.height,
        blockTransactionIndex: tx.block_transaction_index,
        id: tx.id.toString('base64url'),
        anchor: tx.last_tx.toString('base64url'),
        signature: tx.signature.toString('base64url'),
        recipient: tx.target?.toString('base64url'),
        ownerAddress: tx.owner_address.toString('base64url'),
        ownerKey: tx.public_modulus.toString('base64url'),
        fee: tx.reward,
        quantity: tx.quantity,
        dataSize: tx.data_size,
        tags: this.getGqlStableTransactionTags(tx.id),
        contentType: tx.content_type,
        blockIndepHash: tx.block_indep_hash.toString('base64url'),
        blockTimestamp: tx.block_timestamp,
        blockPreviousBlock: tx.block_previous_block.toString('base64url'),
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

    const blocks = this.db
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

    return this.db
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
