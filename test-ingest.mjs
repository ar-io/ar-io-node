import fs from 'fs';
import fetch from 'node-fetch';
import { strict as assert } from 'assert';

const chainDir = process.env.CHAIN_DIR;
const txsPostURL = process.env.TXS_POST_URL ?? 
  'http://localhost:3000/add-new-transactions';
const blocksPostURL = process.env.BLOCKS_POST_URL ?? 
  'http://localhost:3000/add-new-blocks';

async function main() {
  let totalTxs = 0;
  //let erroredTxFiles = 0;

  const chainDirs = fs.readdirSync(chainDir)
    .filter(dir => dir.match(/^\d+$/))
    .map(dir => parseInt(dir))
    .sort()
    .map(dir => `${chainDir}${dir}`);

  const startMs = Date.now();
  for (const chainDir of chainDirs) {
    const block = JSON.parse(fs.readFileSync(`${chainDir}/block.json`))[0];
    //console.log(`block = ${JSON.stringify(block)}`);
    try {
        await fetch(blocksPostURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([block])
        });
    } catch (e) {
      console.error(`Error processing block ${block.indep_hash}`, e);
    }
    if(block.txs.length > 0) {
      try {
        const txs = JSON.parse(fs.readFileSync(`${chainDir}/txs.json`));
        assert.equal(txs.length, block.txs.length);
        await fetch(txsPostURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(txs)
        });
        totalTxs += txs.length;
        console.log(`${(totalTxs * 1000)/(Date.now() - startMs)} txs/sec`);
      } catch (e) {
        //erroredTxFiles++;
        console.log(`Error processing TXs in ${chainDir}/txs.json`, e);
      }
    }
  }
  // Log total TXs
  console.log(`${totalTxs} total TXs`);
}

main();
