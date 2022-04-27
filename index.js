const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const R = require('ramda');
const Database = require('better-sqlite3');

const port = 3000;
const app = express();
app.use(bodyParser.json({limit: '50mb'}));

db = new Database('./chain.db');

db.pragma('journal_mode = WAL');
db.pragma('page_size = 4096'); // may depend on OS and FS

const walletInsertStmt = db.prepare(`
  INSERT INTO wallets (address, public_modulus)
  VALUES (@address, @public_modulus)
  ON CONFLICT DO NOTHING
`);

const stableTxInsertStmt = db.prepare(`
  INSERT INTO stable_transactions (
    id, height, block_transaction_index, signature, format,
    last_tx, owner_address, target, quantity, reward,
    data_size, data_root
  ) VALUES (
    @id, @height, @block_transaction_index, @signature, @format,
    @last_tx, @owner_address, @target, @quantity, @reward,
    @data_size, @data_root
  ) ON CONFLICT DO NOTHING
`);

const tagInsertStmt = db.prepare(`
  INSERT INTO tags (hash, name, value)
  VALUES (@hash, @name, @value)
  ON CONFLICT DO NOTHING
`);

const stableTxTagsInsertStmt = db.prepare(`
  INSERT INTO stable_transaction_tags (
    tag_hash, height, block_transaction_index, transaction_tag_index
  ) VALUES (
    @tag_hash, @height, @block_transaction_index, @transaction_tag_index
  ) ON CONFLICT DO NOTHING
`);

const newTxInsertStmt = db.prepare(`
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

const newTxTagsInsertStmt = db.prepare(`
  INSERT INTO new_transaction_tags (
    tag_hash, transaction_id, transaction_tag_index
  ) VALUES (
    @tag_hash, @transaction_id, @transaction_tag_index
  ) ON CONFLICT DO NOTHING
`);

const newBlocksInsertStmt = db.prepare(`
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

const newBlockHeightsInsertStmt = db.prepare(`
  INSERT INTO new_block_heights (
    height, block_indep_hash
  ) VALUES (
    @height, @block_indep_hash
  ) ON CONFLICT DO NOTHING
`);

const newBlockTxsInsertStmt = db.prepare(`
  INSERT INTO new_block_transactions (
    block_indep_hash, transaction_id, block_transaction_index
  ) VALUES (
    @block_indep_hash, @transaction_id, @block_transaction_index
  ) ON CONFLICT DO NOTHING
`);

const saveStableTxsRangeStmt = db.prepare(`
  INSERT INTO stable_transactions (
    id, height, block_transaction_index, signature,
    format, last_tx, owner_address, target, quantity,
    reward, data_size, data_root
  ) SELECT
    nt.id, nbh.height, nbt.block_transaction_index, nt.signature, 
    nt.format, nt.last_tx, nt.owner_address, nt.target, nt.quantity,
    nt.reward, nt.data_size, nt.data_root
  FROM new_transactions nt
  JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
  JOIN new_block_heights nbh ON nbh.block_indep_hash = nbt.block_indep_hash
  WHERE nbh.height >= @start_height AND nbh.height < @end_height
  ON CONFLICT DO NOTHING
`);

const saveStableBlockRangeStmt = db.prepare(`
  INSERT INTO stable_blocks (
    height, indep_hash, previous_block, nonce, hash,
    block_timestamp, diff, cumulative_diff, last_retarget,
    reward_addr, reward_pool, block_size, weave_size,
    usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
    scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
    hash_list_merkle, wallet_list, tx_root
  ) SELECT
    nbh.height, nb.indep_hash, nb.previous_block, nb.nonce, nb.hash,
    nb.block_timestamp, nb.diff, nb.cumulative_diff, nb.last_retarget,
    nb.reward_addr, nb.reward_pool, nb.block_size, nb.weave_size,
    nb.usd_to_ar_rate_dividend, nb.usd_to_ar_rate_divisor,
    nb.scheduled_usd_to_ar_rate_dividend, nb.scheduled_usd_to_ar_rate_divisor,
    nb.hash_list_merkle, nb.wallet_list, nb.tx_root
  FROM new_blocks nb
  JOIN new_block_heights nbh ON nbh.block_indep_hash = nb.indep_hash
  WHERE nbh.height >= @start_height AND nbh.height < @end_height
  ON CONFLICT DO NOTHING
`);

const insertStableBlockTransactions = db.transaction((txs) => {
  let blockTransactionIndex = 0;
  for (tx of txs) {
    const txId = Buffer.from(tx.id, 'base64');

    let transactionTagIndex = 0;
    for (tag of tx.tags) {
      const tagHashContent = `${tag.name}|${tag.value}`;
      const tagHash = crypto.createHash('sha-1').update(tagHashContent).digest();

      tagInsertStmt.run({
        hash: tagHash,
        name: Buffer.from(tag.name, 'base64'),
        value: Buffer.from(tag.value, 'base64'),
      });

      stableTxTagsInsertStmt.run({
        tag_hash: tagHash,
        height: tx.BlockHeight,
        block_transaction_index: blockTransactionIndex,
        transaction_tag_index: transactionTagIndex,
      });

      transactionTagIndex++;
    }

    const ownerBuffer = Buffer.from(tx.owner, 'base64');
    const ownerAddressBuffer = crypto.createHash('sha256').update(ownerBuffer).digest();

    walletInsertStmt.run({
      address: ownerAddressBuffer,
      public_modulus: ownerBuffer
    });

    // TODO add content_type
    stableTxInsertStmt.run({
      id: txId,
      height: tx.BlockHeight,
      block_transaction_index: blockTransactionIndex,
      signature: Buffer(tx.signature, 'base64'),
      format: tx.format,
      last_tx: Buffer(tx.last_tx, 'base64'),
      owner_address: ownerAddressBuffer,
      target: Buffer(tx.target, 'base64'),
      quantity: tx.quantity,
      reward: tx.reward,
      data_size: tx.data_size,
      data_root: Buffer(tx.data_root, 'base64')
    });

    blockTransactionIndex++;
  }
});

const insertNewTransactions = db.transaction((txs) => {
  for (tx of txs) {
    const txId = Buffer.from(tx.id, 'base64');

    let transactionTagIndex = 0;
    for (tag of tx.tags) {
      const tagHashContent = `${tag.name}|${tag.value}`;
      const tagHash = crypto.createHash('md5').update(tagHashContent).digest();

      tagInsertStmt.run({
        hash: tagHash,
        name: Buffer.from(tag.name, 'base64'),
        value: Buffer.from(tag.value, 'base64'),
      });

      newTxTagsInsertStmt.run({
        tag_hash: tagHash,
        transaction_id: txId,
        transaction_tag_index: transactionTagIndex,
      });

      transactionTagIndex++;
    }

    const ownerBuffer = Buffer.from(tx.owner, 'base64');
    const ownerAddressBuffer = crypto.createHash('sha256').update(ownerBuffer).digest();

    walletInsertStmt.run({
      address: ownerAddressBuffer,
      public_modulus: ownerBuffer
    });

    // TODO add content_type
    newTxInsertStmt.run({
      id: txId,
      signature: Buffer(tx.signature, 'base64'),
      format: tx.format,
      last_tx: Buffer(tx.last_tx, 'base64'),
      owner_address: ownerAddressBuffer,
      target: Buffer(tx.target, 'base64'),
      quantity: tx.quantity,
      reward: tx.reward,
      data_size: tx.data_size,
      data_root: Buffer(tx.data_root, 'base64'),
      created_at: (Date.now()/1000).toFixed(0)
    });
  }
});

const insertNewBlocks = db.transaction((blocks) => {
  for (block of blocks) {
    if (block.indep_hash) {
      const indepHash = Buffer.from(block.indep_hash, 'base64');
      const previousBlock = Buffer.from(block.previous_block, 'base64');
      const nonce = Buffer.from(block.nonce , 'base64');
      const hash = Buffer.from(block.hash, 'base64');
      const rewardAddr = Buffer.from(block.reward_addr, 'base64');
      const hashListMerkle = block.hash_list_merkle && Buffer.from(block.hash_list_merkle, 'base64');
      const walletList = Buffer.from(block.wallet_list, 'base64');
      const txRoot = block.tx_root && Buffer.from(block.tx_root, 'base64');

      newBlocksInsertStmt.run({
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

      newBlockHeightsInsertStmt.run({
        height: block.height,
        block_indep_hash: indepHash
      });

      let blockTransactionIndex = 0;
      for (txIdStr of block.txs) {
        const txId = Buffer.from(txIdStr, 'base64');

        newBlockTxsInsertStmt.run({
          transaction_id: txId,
          block_indep_hash: indepHash,
          block_transaction_index: blockTransactionIndex
        });

        blockTransactionIndex++;
      }

    } else {
      console.log('Skipping block with no indep_hash');
    }
  }
});

const saveStableBlockRange = db.transaction((startHeight, endHeight) => {
  saveStableBlockRangeStmt.run({
    start_height: startHeight,
    end_height: endHeight
  });

  saveStableTxsRangeStmt.run({
    start_height: startHeight,
    end_height: endHeight
  });
});

let totalTxCount = 0;
let totalBlockCount = 0;

app.post('/add-stable-block-transactions', async (req, res) => {
  txCount = req.body.length;
  totalTxCount += txCount;
  console.log(`Received ${txCount} transactions, total: ${totalTxCount}`);
  const startTs = Date.now();
  try {
    insertStableBlockTransactions(req.body);
  } catch (error) {
    console.log(error);
  }
  console.log(`Saved ${txCount} transactions in ${Date.now() - startTs}ms`);
  res.send({ endpoint: 'add-stable-block-transactions' });
});

app.post('/add-new-transactions', async (req, res) => {
  txCount = req.body.length;
  totalTxCount += txCount;
  console.log(`Received ${txCount} transactions, total: ${totalTxCount}`);
  const startTs = Date.now();
  try {
    insertNewTransactions(req.body);
  } catch (error) {
    console.log(error);
  }
  console.log(`Saved ${txCount} transactions in ${Date.now() - startTs}ms`);
  res.send({ endpoint: 'add-new-transactions' });
});

app.post('/add-new-blocks', async (req, res) => {
  blockCount = req.body.length;
  totalBlockCount += blockCount;
  console.log(`Received ${blockCount} blocks, total: ${totalBlockCount}`);
  const startTs = Date.now();
  try {
    insertNewBlocks(req.body);
  } catch (error) {
    console.log(error);
    //System.exit(1);
  }
  console.log(`Saved ${blockCount} blocks in ${Date.now() - startTs}ms`);
  res.send({ endpoint: 'add-new-blocks' });
});

app.post('/save-stable-block/:blockHeight', async (req, res) => {
  console.log(req.params);
  const blockHeight = parseInt(req.params.blockHeight);
  saveStableBlockRange(blockHeight, blockHeight+1);
  res.send({ endpoint: 'save-stable-block' });
});

app.listen(port, () => {
  console.log(`AR.IO gateway POC listening on port ${port}`);
});
