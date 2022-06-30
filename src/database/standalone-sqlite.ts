import { ChainDatabase, JsonBlock, JsonTransaction } from '../types.js';
import Sqlite from 'better-sqlite3';
import * as crypto from 'crypto';

const MAX_FORK_DEPTH = 50;
const STABLE_FLUSH_INTERVAL = 50;
const NEW_TX_CLEANUP_WAIT_SECS = 60 * 60 * 24;

type DebugInfo = {
  walletCount: number;
  tagNameCount: number;
  tagValueCount: number;
  stableTxCount: number;
  stableBlockCount: number;
  stableBlockTxCount: number;
  maxStableHeight: number;
  minStableHeight: number;
  missingStableBlockCount: number;
  newTxCount: number;
  newBlockCount: number;
};

export class StandaloneSqliteDatabase implements ChainDatabase {
  private db: Sqlite.Database;
  private walletInsertStmt: Sqlite.Statement;
  private tagNamesInsertStmt: Sqlite.Statement;
  private tagValuesInsertStmt: Sqlite.Statement;
  private newTxsInsertStmt: Sqlite.Statement;
  private missingTxsInsertStmt: Sqlite.Statement;
  private newTxTagsInsertStmt: Sqlite.Statement;
  private newBlocksInsertStmt: Sqlite.Statement;
  private newBlockHeightsInsertStmt: Sqlite.Statement;
  private newBlockTxsInsertStmt: Sqlite.Statement;
  private getMaxStableHeightAndTimestampStmt: Sqlite.Statement;
  private getMaxHeightStmt: Sqlite.Statement;
  private saveStableBlockTxsRangeStmt: Sqlite.Statement;
  private saveStableTxsRangeStmt: Sqlite.Statement;
  private saveStableTxTagsRangeStmt: Sqlite.Statement;
  private saveStableBlockRangeStmt: Sqlite.Statement;
  private getNewBlockHashByHeightStmt: Sqlite.Statement;
  private resetToHeightStmt: Sqlite.Statement;
  private insertBlockAndTxsFn: Sqlite.Transaction;
  private saveStableBlockRangeFn: Sqlite.Transaction;

  // Stale "new" data cleanup
  private deleteStaleNewTxTagsStmt: Sqlite.Statement;
  private deleteStaleNewTxsByHeightStmt: Sqlite.Statement;
  private deleteStaleNewTxsByTimestampStmt: Sqlite.Statement;
  private deleteStaleNewBlockTxsStmt: Sqlite.Statement;
  private deleteStaleNewBlocksStmt: Sqlite.Statement;
  private deleteStaleNewBlockHeightsStmt: Sqlite.Statement;
  private deleteStaleNewDataFn: Sqlite.Transaction;

  constructor(db: Sqlite.Database) {
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('page_size = 4096'); // may depend on OS and FS

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

    this.newTxTagsInsertStmt = this.db.prepare(`
      INSERT INTO new_transaction_tags (
        tag_name_hash, tag_value_hash,
        transaction_id, transaction_tag_index
      ) VALUES (
        @tag_name_hash, @tag_value_hash,
        @transaction_id, @transaction_tag_index
      ) ON CONFLICT DO NOTHING
    `);

    this.missingTxsInsertStmt = this.db.prepare(`
      INSERT INTO missing_transactions (
        block_indep_hash, transaction_id, height
      ) VALUES (
        @block_indep_hash, @transaction_id, @height
      ) ON CONFLICT DO NOTHING
    `);

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

    this.getMaxStableHeightAndTimestampStmt = this.db.prepare(`
      SELECT
        IFNULL(MAX(height), -1) AS height,
        IFNULL(MAX(block_timestamp), 0) AS block_timestamp
      FROM stable_blocks
    `);

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
        ntt.tag_name_hash, ntt.tag_name_hash, nbh.height,
        nbt.block_transaction_index, ntt.transaction_tag_index,
        ntt.transaction_id
      FROM new_transaction_tags ntt
      JOIN new_block_transactions nbt ON nbt.transaction_id = ntt.transaction_id
      JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
      WHERE nbh.height >= @start_height AND nbh.height < @end_height
      ON CONFLICT DO NOTHING
    `);

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

    this.getNewBlockHashByHeightStmt = this.db.prepare(`
      SELECT block_indep_hash
      FROM new_block_heights
      WHERE height = @height
    `);

    this.resetToHeightStmt = this.db.prepare(`
      DELETE FROM new_block_heights
      WHERE height > @height
    `);

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
          usd_to_ar_rate_dividend: block.usd_to_ar_rate_dividend,
          usd_to_ar_rate_divisor: block.usd_to_ar_rate_divisor,
          scheduled_usd_to_ar_rate_dividend:
            block.scheduled_usd_to_ar_rate_dividend,
          scheduled_usd_to_ar_rate_divisor:
            block.scheduled_usd_to_ar_rate_divisor,
          hash_list_merkle: hashListMerkle,
          wallet_list: walletList,
          tx_root: txRoot,
          tx_count: block.txs.length,
          missing_tx_count: missingTxIds.length
        });

        this.newBlockHeightsInsertStmt.run({
          height: block.height,
          block_indep_hash: indepHash
        });

        let blockTransactionIndex = 0;
        for (const txIdStr of block.txs) {
          const txId = Buffer.from(txIdStr, 'base64');

          this.newBlockTxsInsertStmt.run({
            transaction_id: txId,
            block_indep_hash: indepHash,
            block_transaction_index: blockTransactionIndex
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
              name: tagName
            });

            const tagValue = Buffer.from(tag.value, 'base64');
            const tagValueHash = crypto
              .createHash('sha1')
              .update(tagValue)
              .digest();

            this.tagValuesInsertStmt.run({
              hash: tagValueHash,
              value: tagValue
            });

            if (tagName.toString('utf8').toLowerCase() === 'content-type') {
              contentType = tagValue.toString('utf8');
            }

            this.newTxTagsInsertStmt.run({
              tag_name_hash: tagNameHash,
              tag_value_hash: tagValueHash,
              transaction_id: txId,
              transaction_tag_index: transactionTagIndex
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
            public_modulus: ownerBuffer
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
            created_at: (Date.now() / 1000).toFixed(0)
          });
        }

        for (const txIdStr of missingTxIds) {
          const txId = Buffer.from(txIdStr, 'base64');

          this.missingTxsInsertStmt.run({
            block_indep_hash: indepHash,
            transaction_id: txId,
            height: block.height
          });
        }
      }
    );

    this.saveStableBlockRangeFn = this.db.transaction(
      (startHeight: number, endHeight: number) => {
        this.saveStableBlockRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight
        });

        this.saveStableBlockTxsRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight
        });

        this.saveStableTxsRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight
        });

        this.saveStableTxTagsRangeStmt.run({
          start_height: startHeight,
          end_height: endHeight
        });
      }
    );

    this.deleteStaleNewDataFn = this.db.transaction(
      (heightThreshold: number, createdAtThreshold: number) => {
        this.deleteStaleNewTxTagsStmt.run({
          height_threshold: heightThreshold
        });

        this.deleteStaleNewTxsByHeightStmt.run({
          height_threshold: heightThreshold
        });

        this.deleteStaleNewBlockTxsStmt.run({
          height_threshold: heightThreshold,
          created_at_threshold: createdAtThreshold
        });

        this.deleteStaleNewBlocksStmt.run({
          height_threshold: heightThreshold
        });

        this.deleteStaleNewBlockHeightsStmt.run({
          height_threshold: heightThreshold
        });

        this.deleteStaleNewTxsByTimestampStmt.run({
          created_at_threshold: createdAtThreshold
        });
      }
    );
  }

  async saveBlockAndTxs(
    block: JsonBlock,
    txs: JsonTransaction[],
    missingTxIds: string[]
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
        maxStableTimestamp - NEW_TX_CLEANUP_WAIT_SECS
      );
    }
  }

  async getMaxHeight(): Promise<number> {
    return this.getMaxHeightStmt.get().height ?? -1;
  }

  async getNewBlockHashByHeight(height: number): Promise<string | undefined> {
    if (height < 0) {
      throw new Error(`Invalid height ${height}, must be >= 0.`);
    }
    const hash = this.getNewBlockHashByHeightStmt.get({
      height
    })?.block_indep_hash;
    return hash ? hash.toString('base64url') : undefined;
  }

  async resetToHeight(height: number): Promise<void> {
    this.resetToHeightStmt.run({ height });
  }

  async getDebugInfo(): Promise<DebugInfo> {
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
    const maxStableHeight = this.db
      .prepare('SELECT MAX(height) AS max_height FROM stable_blocks')
      .get().max_height as number;
    const minStableHeight = this.db
      .prepare('SELECT MIN(height) AS min_height FROM stable_blocks')
      .get().min_height as number;
    const newTxCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM new_transactions')
      .get().cnt as number;
    const newBlockCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM new_blocks')
      .get().cnt as number;

    const missingStableBlockCount =
      maxStableHeight - (minStableHeight - 1) - stableBlockCount;

    return {
      walletCount,
      tagNameCount,
      tagValueCount,
      stableTxCount,
      stableBlockCount,
      stableBlockTxCount,
      maxStableHeight,
      minStableHeight,
      missingStableBlockCount,
      newTxCount,
      newBlockCount
    };
  }
}
