const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const R = require('ramda');

const port = 3000;
const app = express();
app.use(bodyParser.json({limit: '50mb'}));

const knex = require('knex')({
  client: 'better-sqlite3',
  useNullAsDefault: true,
  connection: {
    filename: "./chain.db"
  }
});

async function saveTransactions(txs) {
  const txInserts = [];
  const tagInserts = [];
  const transactionTagInserts = [];

  for (tx of txs) {
    txInserts.push({
      id: tx.id,
      height: tx.BlockHeight,
    });

    for (tag of tx.tags) {
      const tagHashContent = `${tag.name}|${tag.value}`;
      const tagHash = crypto.createHash('md5').update(tagHashContent).digest('hex');
      tagInserts.push({
        hash: tagHash,
        name: tag.name,
        value: tag.value,
      });

      transactionTagInserts.push({
        tag_hash: tagHash,
        height: tx.BlockHeight,
        transaction_id: tx.id
      });
    }
  }

  await knex.transaction(async (trx) => {
    for (txInsertsChunk of R.splitEvery(100, txInserts)) {
      await knex('stable_transactions')
        .transacting(trx)
        .insert(txInsertsChunk)
        .onConflict('id').ignore();
    }

    if (tagInserts.length > 0) {
      for (tagInsertsChunk of R.splitEvery(100, tagInserts)) {
        await knex('tags')
          .transacting(trx)
          .insert(tagInsertsChunk)
          .onConflict('hash')
          .ignore();
      }
    }

    if (transactionTagInserts.length > 0) {
      for (transactionTagInsertsChunk of R.splitEvery(100, transactionTagInserts)) {
        await knex('stable_transaction_tags')
          .transacting(trx)
          .insert(transactionTagInsertsChunk)
          .onConflict(['tag_hash', 'height', 'transaction_id'])
          .ignore();
      }
    }
  });
}

let totalTxCount = 0;

app.post('/add-transactions', async (req, res) => {
  txCount = req.body.length;
  totalTxCount += txCount;
  console.log(`Received ${txCount} transactions, total: ${totalTxCount}`);
  const startTs = Date.now();
  await saveTransactions(req.body);
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
