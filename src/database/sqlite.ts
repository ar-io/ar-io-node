import { ChainDatabaseInterface, JsonBlock, JsonTransaction } from '../types';
import Sqlite = require('better-sqlite3');
import * as crypto from 'crypto';

export class ChainDatabase implements ChainDatabaseInterface {
  private db: Sqlite.Database;
  private walletInsertStmt: Sqlite.Statement;
  private tagInsertStmt: Sqlite.Statement;
  private newTxInsertStmt: Sqlite.Statement;
  private newTxTagsInsertStmt: Sqlite.Statement;
  private newBlocksInsertStmt: Sqlite.Statement;
  private newBlockHeightsInsertStmt: Sqlite.Statement;
  private newBlockTxsInsertStmt: Sqlite.Statement;
  private insertBlockAndTxsFn: Sqlite.Transaction;

  constructor(dbPath: string) {
    this.db = new Sqlite(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('page_size = 4096'); // may depend on OS and FS

    this.walletInsertStmt = this.db.prepare(`
      INSERT INTO wallets (address, public_modulus)
      VALUES (@address, @public_modulus)
      ON CONFLICT DO NOTHING
    `);

    this.tagInsertStmt = this.db.prepare(`
      INSERT INTO tags (hash, name, value)
      VALUES (@hash, @name, @value)
      ON CONFLICT DO NOTHING
    `);

    this.newTxInsertStmt = this.db.prepare(`
      INSERT INTO new_transactions (
        id, signature, format, last_tx, owner_address,
        target, quantity, reward, data_size, data_root,
        created_at
      ) VALUES (
        @id, @signature, @format, @last_tx, @owner_address,
        @target, @quantity, @reward, @data_size, @data_root,
        @created_at
      ) ON CONFLICT DO NOTHING
    `);

    this.newTxTagsInsertStmt = this.db.prepare(`
      INSERT INTO new_transaction_tags (
        tag_hash, transaction_id, transaction_tag_index
      ) VALUES (
        @tag_hash, @transaction_id, @transaction_tag_index
      ) ON CONFLICT DO NOTHING
    `);

    // TODO are the CASTs necessary
    this.newBlocksInsertStmt = this.db.prepare(`
      INSERT INTO new_blocks (
        indep_hash, previous_block, nonce, hash,
        block_timestamp, diff,
        cumulative_diff, last_retarget,
        reward_addr, reward_pool, 
        block_size, weave_size,
        usd_to_ar_rate_dividend,
        usd_to_ar_rate_divisor,
        scheduled_usd_to_ar_rate_dividend,
        scheduled_usd_to_ar_rate_divisor,
        hash_list_merkle, wallet_list, tx_root
      ) VALUES (
        @indep_hash, @previous_block, @nonce, @hash,
        CAST(@block_timestamp AS INTEGER), @diff,
        @cumulative_diff, CAST(@last_retarget AS INTEGER),
        @reward_addr, CAST(@reward_pool AS INTEGER),
        CAST(@block_size AS INTEGER), CAST(@weave_size AS INTEGER), 
        CAST(@usd_to_ar_rate_dividend AS INTEGER),
        CAST(@usd_to_ar_rate_divisor AS INTEGER),
        CAST(@scheduled_usd_to_ar_rate_dividend AS INTEGER),
        CAST(@scheduled_usd_to_ar_rate_divisor AS INTEGER),
        @hash_list_merkle, @wallet_list, @tx_root
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

    this.insertBlockAndTxsFn = this.db.transaction((
      block : JsonBlock, txs: JsonTransaction[]
    ) => {
      const indepHash = Buffer.from(block.indep_hash, 'base64');
      const previousBlock = Buffer.from(block.previous_block ?? "", 'base64');
      const nonce = Buffer.from(block.nonce , 'base64');
      const hash = Buffer.from(block.hash, 'base64');
      const rewardAddr = Buffer.from(block.reward_addr ?? "", 'base64');
      const hashListMerkle = block.hash_list_merkle && Buffer.from(block.hash_list_merkle, 'base64');
      const walletList = Buffer.from(block.wallet_list, 'base64');
      const txRoot = block.tx_root && Buffer.from(block.tx_root, 'base64');

      this.newBlocksInsertStmt.run({
        indep_hash: indepHash,
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
        scheduled_usd_to_ar_rate_dividend: block.scheduled_usd_to_ar_rate_dividend,
        scheduled_usd_to_ar_rate_divisor: block.scheduled_usd_to_ar_rate_divisor,
        hash_list_merkle: hashListMerkle,
        wallet_list: walletList,
        tx_root: txRoot
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
        const txId = Buffer.from(tx.id, 'base64');

        let transactionTagIndex = 0;
        for (const tag of tx.tags) {
          const tagHashContent = `${tag.name}|${tag.value}`;
          const tagHash = crypto.createHash('md5').update(tagHashContent).digest();

          this.tagInsertStmt.run({
            hash: tagHash,
            name: Buffer.from(tag.name, 'base64'),
            value: Buffer.from(tag.value, 'base64'),
          });

          this.newTxTagsInsertStmt.run({
            tag_hash: tagHash,
            transaction_id: txId,
            transaction_tag_index: transactionTagIndex,
          });

          transactionTagIndex++;
        }

        const ownerBuffer = Buffer.from(tx.owner, 'base64');
        const ownerAddressBuffer = crypto.createHash('sha256').update(ownerBuffer).digest();

        this.walletInsertStmt.run({
          address: ownerAddressBuffer,
          public_modulus: ownerBuffer
        });

        // TODO add content_type
        this.newTxInsertStmt.run({
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
          created_at: (Date.now()/1000).toFixed(0)
        });
      }
    });
  }

  async insertBlockAndTxs(block: JsonBlock, transactions: JsonTransaction[]): Promise<void> {
    this.insertBlockAndTxsFn(block, transactions);

    // TODO flush to stable every N blocks
  }
}
