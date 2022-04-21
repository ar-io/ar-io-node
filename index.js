const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const R = require('ramda');
const Database = require('better-sqlite3');

const port = 3000;
const app = express();
app.use(bodyParser.json({limit: '50mb'}));

//const knex = require('knex')({
//  client: 'better-sqlite3',
//  useNullAsDefault: true,
//  connection: {
//    filename: "./chain.db"
//  }
//});

db = new Database('./chain.db');

db.pragma('journal_mode = WAL');

const walletInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO wallets (address, public_modulus)
  VALUES (@address, @public_modulus)
`);

const stableTxInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO stable_transactions (
    id, height, block_transaction_index, signature, format,
    last_tx, owner_address, target, quantity, reward,
    data_size, data_root
  ) VALUES (
    @id, @height, @block_transaction_index, @signature, @format,
    @last_tx, @owner_address, @target, @quantity, @reward,
    @data_size, @data_root
  )
`);

const tagInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO tags (hash, name, value)
  VALUES (@hash, @name, @value)
`);

const stableTxTagInsertsStmt = db.prepare(`
  INSERT OR IGNORE INTO stable_transaction_tags (tag_hash, height, block_transaction_index, transaction_tag_index)
  VALUES (@tag_hash, @height, @block_transaction_index, @transaction_tag_index)
`);

const insertStableBlockTransactions = db.transaction((txs) => {
  let blockTransactionIndex = 0;
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

      stableTxTagInsertsStmt.run({
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

    // TODO add content type
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

let totalTxCount = 0;

app.post('/add-stable-block-transactions', async (req, res) => {
  txCount = req.body.length;
  totalTxCount += txCount;
  console.log(`Received ${txCount} transactions, total: ${totalTxCount}`);
  const startTs = Date.now();
  insertStableBlockTransactions(req.body);
  console.log(`Saved ${txCount} transactions in ${Date.now() - startTs}ms`);
  res.send({ endpoint: 'add-stable-block-transactions' });
});

app.post('/add-stable-blocks', (_req, res) => {
  res.send({ endpoint: 'add-stable-blocks' });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
