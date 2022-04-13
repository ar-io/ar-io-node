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

const txInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO stable_transactions (id, height)
  VALUES (@id, @height)
`);

const tagInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO tags (hash, name, value)
  VALUES (@hash, @name, @value)
`);

const transactionTagInsertsStmt = db.prepare(`
  INSERT OR IGNORE INTO stable_transaction_tags (tag_hash, height, transaction_id)
  VALUES (@tag_hash, @height, @transaction_id)
`);

const insertBlockTransactions = db.transaction((txs) => {
  for (tx of txs) {
    const txId = Buffer.from(tx.id, 'base64');

    txInsertStmt.run({
      id: txId,
      height: tx.BlockHeight,
    });

    for (tag of tx.tags) {
      const tagHashContent = `${tag.name}|${tag.value}`;
      const tagHash = crypto.createHash('md5').update(tagHashContent).digest();

      tagInsertStmt.run({
        hash: tagHash,
        name: Buffer.from(tag.name, 'base64'),
        value: Buffer.from(tag.value, 'base64'),
      });

      transactionTagInsertsStmt.run({
        tag_hash: tagHash,
        height: tx.BlockHeight,
        transaction_id: txId
      });
    }
  }
});

let totalTxCount = 0;

app.post('/add-block-transactions', async (req, res) => {
  txCount = req.body.length;
  totalTxCount += txCount;
  console.log(`Received ${txCount} transactions, total: ${totalTxCount}`);
  const startTs = Date.now();
  insertBlockTransactions(req.body);
  console.log(`Saved ${txCount} transactions in ${Date.now() - startTs}ms`);
  res.send({ endpoint: 'add-transactions' });
});

app.post('/add-blocks', (_req, res) => {
  //console.log(req.body);
  res.send({ endpoint: 'add-blocks' });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
