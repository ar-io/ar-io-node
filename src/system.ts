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
import { default as Arweave } from 'arweave';
import EventEmitter from 'node:events';
import { Server } from 'node:http';
import fs from 'node:fs';
import { AOProcess, IO } from '@ar.io/sdk';
import awsLite from '@aws-lite/client';
import awsLiteS3 from '@aws-lite/s3';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import * as config from './config.js';
import { GatewayDataSource } from './data/gateway-data-source.js';
import { ReadThroughChunkDataCache } from './data/read-through-chunk-data-cache.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { BundleDataImporter } from './workers/bundle-data-importer.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import * as events from './events.js';
import { MatchTags } from './filters.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import { makeBlockStore, makeTxStore } from './init/header-stores.js';
import { currentUnixTimestamp } from './lib/time.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { MemoryCacheArNSResolver } from './resolution/memory-cache-arns-resolver.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsDataStore } from './store/fs-data-store.js';
import {
  BlockListValidator,
  BundleIndex,
  ChainIndex,
  ChainOffsetIndex,
  ContiguousDataSource,
  ContiguousDataIndex,
  DataItemIndexWriter,
  MatchableItem,
  NestedDataIndexWriter,
  NormalizedDataItem,
  PartialJsonTransaction,
} from './types.js';
import { Ans104DataIndexer } from './workers/ans104-data-indexer.js';
import { Ans104Unbundler } from './workers/ans104-unbundler.js';
import { BlockImporter } from './workers/block-importer.js';
import { BundleRepairWorker } from './workers/bundle-repair-worker.js';
import { DataItemIndexer } from './workers/data-item-indexer.js';
import { FsCleanupWorker } from './workers/fs-cleanup-worker.js';
import { TransactionFetcher } from './workers/transaction-fetcher.js';
import { TransactionImporter } from './workers/transaction-importer.js';
import { TransactionRepairWorker } from './workers/transaction-repair-worker.js';
import { TransactionOffsetImporter } from './workers/transaction-offset-importer.js';
import { TransactionOffsetRepairWorker } from './workers/transaction-offset-repair-worker.js';
import { WebhookEmitter } from './workers/webhook-emitter.js';
import { createArNSResolver } from './init/resolvers.js';
import { MempoolWatcher } from './workers/mempool-watcher.js';
import { ArIODataSource } from './data/ar-io-data-source.js';
import { S3DataSource } from './data/s3-data-source.js';
import { connect } from '@permaweb/aoconnect';
import { DataContentAttributeImporter } from './workers/data-content-attribute-importer.js';
import { SignatureFetcher } from './data/signature-fetcher.js';

process.on('uncaughtException', (error) => {
  metrics.uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

// IPFS via Helia
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { car } from '@helia/car';
import { FsBlockstore } from 'blockstore-fs';
import { CarReader } from '@ipld/car';
import { b64UrlToUtf8 } from './lib/encoding.js';
import { CID } from 'multiformats/cid';
import { base58btc } from 'multiformats/bases/base58';
const blockstore = new FsBlockstore(`data/helia-ipfs`);

export const helia = await createHelia({
  blockstore,
});

export const heliaFs = unixfs(helia);

// IPFS txid and cid index storage
// Load existing mappings (if any) from the file
const txIdToCidFilePath = 'data/ipfs/txIdToCidMap.json';
let txIdToCidMap: Record<string, string> = {};
if (fs.existsSync(txIdToCidFilePath)) {
  const data = fs.readFileSync(txIdToCidFilePath, 'utf-8');
  txIdToCidMap = JSON.parse(data);
}
const cidToTxIdMapFilePath = 'data/ipfs/cidToTxIdMap.json';
let cidToTxIdMap: Record<string, string[]> = {};
if (fs.existsSync(cidToTxIdMapFilePath)) {
  const data = fs.readFileSync(cidToTxIdMapFilePath, 'utf-8');
  cidToTxIdMap = JSON.parse(data);
}

// IPFS Utility Functions
// Add IPFS mappings to indexes
export function storeIpfsMappings(txId: string, cid: string): void {
  // Store TX ID -> CID mapping
  txIdToCidMap[txId] = cid;

  // Initialize CID -> TX ID mapping array if not already present
  if (!Array.isArray(cidToTxIdMap[cid])) {
    cidToTxIdMap[cid] = [];
  }

  // Add the TX ID to the array for the given CID
  cidToTxIdMap[cid].push(txId);

  // Persist mappings to disk
  fs.writeFileSync(txIdToCidFilePath, JSON.stringify(txIdToCidMap, null, 2));
  fs.writeFileSync(cidToTxIdMapFilePath, JSON.stringify(cidToTxIdMap, null, 2));
}

// Function to retrieve a CID by TX ID
export function getCidByTxId(txId: string): string | undefined {
  return txIdToCidMap[txId];
}

// Function to retrieve the last TX ID by CID
export function getTxIdByCid(cid: string): string | undefined {
  const txIds = cidToTxIdMap[cid];
  if (Array.isArray(txIds) && txIds.length > 0) {
    return txIds[txIds.length - 1]; // Return the last item without removing it
  }
  return undefined;
}

export function isBase58CID(cidStr: string): boolean {
  try {
    // Try to parse the string as a CID
    const cid = CID.parse(cidStr, base58btc);

    // Check if the CID is using base58btc encoding and is version 0
    return cid.toString(base58btc) === cidStr && cid.version === 0;
  } catch (err) {
    // If parsing fails, it's not a valid Base58 CID
    return false;
  }
}

// Helper function to load a car file as contiguous data, and import into Helia IPFS
export async function handleIpfsCarFile(
  txId: string,
  ipfsTagValue?: string,
): Promise<string> {
  try {
    const data = await contiguousDataSource.getData({ id: txId });

    return new Promise(async (resolve, reject) => {
      try {
        const reader = await CarReader.fromIterable(data.stream);

        // Import the CAR file into Helia
        const c = car(helia); // Create the car instance using Helia
        await c.import(reader);

        // Get the root CIDs from the reader
        const roots = await reader.getRoots();

        // Assuming you want to return the first root CID
        if (roots.length > 0) {
          let rootCid = roots[0].toString();

          // Convert to Base58 if necessary
          if (
            CID.parse(rootCid).version === 1 ||
            (ipfsTagValue !== undefined && isBase58CID(ipfsTagValue))
          ) {
            rootCid = CID.parse(rootCid).toV0().toString(base58btc);
          }

          resolve(rootCid);
          return;
        } else {
          reject(new Error('No roots found in CAR file.'));
        }
      } catch (error) {
        log.error('Error importing CAR file to IPFS:', error);
        reject(error);
      }
    });
  } catch (error) {
    log.error(`Error handling CAR file for transaction ID ${txId}:`, error);
    throw error;
  }
}

// Helper function to load contiguous data, generate CID, and import into Helia IPFS
export async function loadDataAndGenerateCid(
  txId: string,
  ipfsTagValue?: string,
): Promise<string> {
  try {
    const data = await contiguousDataSource.getData({ id: txId });

    return new Promise(async (resolve, reject) => {
      try {
        const source = (async function* () {
          for await (const chunk of data.stream) {
            yield chunk; // Stream the data chunk by chunk
          }
        })();

        // Use `addAll` to stream the data to IPFS
        for await (const entry of heliaFs.addAll([
          {
            path: `${txId}`,
            content: source,
          },
        ])) {
          let cid = entry.cid.toString();

          // Convert to Base58 if necessary
          if (
            CID.parse(cid).version === 1 ||
            (ipfsTagValue !== undefined && isBase58CID(ipfsTagValue))
          ) {
            cid = CID.parse(cid).toV0().toString(base58btc);
          }

          resolve(cid);
          return;
        }
      } catch (error) {
        log.error('Error adding data to IPFS:', error);
        reject(error);
      }
    });
  } catch (error) {
    log.error(`Error generating CID for transaction ID ${txId}:`, error);
    throw error;
  }
}

// IO/AO SDK

const arIO = IO.init({
  process: new AOProcess({
    processId: config.IO_PROCESS_ID,
    ao: connect({
      // @permaweb/aoconnect defaults will be used if these are not provided
      MU_URL: config.AO_MU_URL,
      CU_URL: config.AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
  }),
});

export const awsClient =
  config.AWS_ACCESS_KEY_ID !== undefined &&
  config.AWS_SECRET_ACCESS_KEY !== undefined &&
  config.AWS_REGION !== undefined
    ? await awsLite({
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        endpoint: config.AWS_ENDPOINT,
        region: config.AWS_REGION,
        plugins: [awsLiteS3],
      })
    : undefined;

export const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  chunkPostUrls: config.CHUNK_POST_URLS,
  skipCache: config.SKIP_CACHE,
  blockStore: makeBlockStore({
    log,
    type: config.CHAIN_CACHE_TYPE,
  }),
  txStore: makeTxStore({
    log,
    type: config.CHAIN_CACHE_TYPE,
  }),
  failureSimulator: new UniformFailureSimulator({
    failureRate: config.SIMULATED_REQUEST_FAILURE_RATE,
  }),
});

export const db = new StandaloneSqliteDatabase({
  log,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
  moderationDbPath: 'data/sqlite/moderation.db',
  bundlesDbPath: 'data/sqlite/bundles.db',
});

export const chainIndex: ChainIndex = db;
export const chainOffsetIndex: ChainOffsetIndex = db;
export const bundleIndex: BundleIndex = db;
export const contiguousDataIndex: ContiguousDataIndex = db;
export const blockListValidator: BlockListValidator = db;
export const nestedDataIndexWriter: NestedDataIndexWriter = db;
export const dataItemIndexWriter: DataItemIndexWriter = db;

// Workers
export const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(100);

export const blockImporter = new BlockImporter({
  log,
  chainSource: arweaveClient,
  chainIndex,
  eventEmitter,
  startHeight: config.START_HEIGHT,
  stopHeight: config.STOP_HEIGHT,
});

eventEmitter.on(events.BLOCK_TX_INDEXED, (tx) => {
  eventEmitter.emit(events.TX_INDEXED, tx);
});

export const headerFsCacheCleanupWorker = config.ENABLE_FS_HEADER_CACHE_CLEANUP
  ? new FsCleanupWorker({
      log,
      basePath: 'data/headers',
    })
  : undefined;

const contiguousDataCacheCleanupThresholdInSeconds = parseInt(
  config.CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD,
);

export const contiguousDataFsCacheCleanupWorker = !isNaN(
  contiguousDataCacheCleanupThresholdInSeconds,
)
  ? new FsCleanupWorker({
      log,
      basePath: 'data/contiguous',
      shouldDelete: async (path) => {
        try {
          const stats = await fs.promises.stat(path);
          const mostRecentTime =
            stats.atime > stats.mtime ? stats.atime : stats.mtime;

          const currentTimestamp = Date.now();

          const thresholdDate = new Date(
            currentTimestamp -
              contiguousDataCacheCleanupThresholdInSeconds * 1000,
          );

          return mostRecentTime <= thresholdDate;
        } catch (err) {
          log.error(`Error getting file stats for ${path}`, err);
          return false;
        }
      },
    })
  : undefined;

const ans104TxMatcher = new MatchTags([
  { name: 'Bundle-Format', value: 'binary' },
  { name: 'Bundle-Version', valueStartsWith: '2.' },
]);

const ipfsItemFilter = config.IPFS_ADD_FILTER;

export const prioritizedTxIds = new Set<string>();

eventEmitter.on(events.TX_INDEXED, async (tx: MatchableItem) => {
  if (await ipfsItemFilter.match(tx)) {
    try {
      // Extract the IPFS-Add or IPFS-CID tag value if it exists
      let ipfsTagValue: string | undefined;
      for (const tag of tx.tags) {
        const tagName = b64UrlToUtf8(tag.name);
        if (tagName === 'IPFS-Add' || tagName === 'IPFS-CID') {
          ipfsTagValue = b64UrlToUtf8(tag.value);
          break;
        }
      }
      // get the data then hash it
      if (tx.id !== undefined) {
        // check if its already an IPFS CAR content type
        const isIpfsCar = tx.tags.some(
          (tag) =>
            b64UrlToUtf8(tag.name) === 'Content-Type' &&
            b64UrlToUtf8(tag.value) === 'application/vnd.ipld.car',
        );
        if (isIpfsCar) {
          // Handle storing IPFS car file
          const cid = await handleIpfsCarFile(tx.id, ipfsTagValue);
          if (cid !== undefined) {
            storeIpfsMappings(tx.id, cid);
            log.info(
              `TX ${tx.id} added to IPFS as CAR and mapped with CID: ${cid}`,
            );
          } else {
            log.error(
              'TX CID is undefined. Cannot add CAR to IPFS/TXID Mapping.',
            );
          }
        } else {
          // If not, load the data, generate a CID and store it
          const cid = await loadDataAndGenerateCid(tx.id);
          if (cid !== undefined) {
            storeIpfsMappings(tx.id, cid);
            log.info(`TX ${tx.id} added to IPFS and mapped with CID: ${cid}`);
          } else {
            log.error('TX CID is undefined. Cannot add to IPFS/TXID  Mapping.');
          }
        }
      } else {
        log.error('TX ID is undefined. Cannot map and add to IPFS.');
      }
    } catch (error) {
      log.error(`Error adding data for TX ${tx.id} to IPFS: `, error);
    }
  }

  if (await ans104TxMatcher.match(tx)) {
    metrics.bundlesCounter.inc({
      bundle_format: 'ans-104',
      parent_type: 'transaction',
    });
    eventEmitter.emit(events.ANS104_TX_INDEXED, tx);
    eventEmitter.emit(events.ANS104_BUNDLE_INDEXED, tx);
  }
});

eventEmitter.on(
  events.ANS104_DATA_ITEM_DATA_INDEXED,
  async (item: MatchableItem) => {
    if (await ipfsItemFilter.match(item)) {
      try {
        // Extract the IPFS-Add or IPFS-CID tag value if it exists
        let ipfsTagValue: string | undefined;
        for (const tag of item.tags) {
          const tagName = b64UrlToUtf8(tag.name);
          if (tagName === 'IPFS-Add' || tagName === 'IPFS-CID') {
            ipfsTagValue = b64UrlToUtf8(tag.value);
            break;
          }
        }
        // get the data then hash it
        if (item.id !== undefined) {
          // check if its already an IPFS CAR content type
          const isIpfsCar = item.tags.some(
            (tag) =>
              b64UrlToUtf8(tag.name) === 'Content-Type' &&
              b64UrlToUtf8(tag.value) === 'application/vnd.ipld.car',
          );
          if (isIpfsCar) {
            // Handle storing IPFS car file
            const cid = await handleIpfsCarFile(item.id);
            if (cid !== undefined) {
              storeIpfsMappings(item.id, cid);
              log.info(
                `Data Item ${item.id} added to IPFS as CAR and mapped with CID: ${cid}`,
              );
            } else {
              log.error(
                'Data Item CID is undefined. Cannot add CAR to IPFS/TXID Mapping.',
              );
            }
          } else {
            // If not, load the data, generate a CID and store it
            const cid = await loadDataAndGenerateCid(item.id);
            if (cid !== undefined) {
              storeIpfsMappings(item.id, cid);
              log.info(
                `ANS104 Data Item ${item.id} added to IPFS and mapped with CID: ${cid}`,
              );
            } else {
              log.error(
                'ANS104 Data Item CID is undefined. Cannot add to IPFS/TXID  Mapping.',
              );
            }
          }
        } else {
          log.error('ANS104 Data Item ID is undefined. Cannot add to IPFS.');
        }
      } catch (error) {
        log.error(
          `Error adding data for ANS104 Data Item ${item.id} to IPFS: `,
          error,
        );
      }
    }

    if (await ans104TxMatcher.match(item)) {
      metrics.bundlesCounter.inc({
        bundle_format: 'ans-104',
        parent_type: 'data_item',
      });
      eventEmitter.emit(events.ANS104_NESTED_BUNDLE_INDEXED, item);
      eventEmitter.emit(events.ANS104_BUNDLE_INDEXED, item);
    }
  },
);

export const txFetcher = new TransactionFetcher({
  log,
  chainSource: arweaveClient,
  eventEmitter,
});

// Async fetch block TXs that failed sync fetch
eventEmitter.on(events.BLOCK_TX_FETCH_FAILED, ({ id: txId }) => {
  txFetcher.queueTxId({ txId });
});

const txImporter = new TransactionImporter({
  log,
  chainIndex,
  eventEmitter,
});

// Queue fetched TXs to
eventEmitter.addListener(events.TX_FETCHED, (tx: PartialJsonTransaction) => {
  txImporter.queueTx(tx);
});

export const txRepairWorker = new TransactionRepairWorker({
  log,
  chainIndex,
  txFetcher,
});

const txOffsetImporter = new TransactionOffsetImporter({
  log,
  chainSource: arweaveClient,
  chainOffsetIndex,
});

export const txOffsetRepairWorker = new TransactionOffsetRepairWorker({
  log,
  chainOffsetIndex,
  txOffsetIndexer: txOffsetImporter,
});

export const bundleRepairWorker = new BundleRepairWorker({
  log,
  bundleIndex,
  txFetcher,
  unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
  indexFilter: config.ANS104_INDEX_FILTER_STRING,
  shouldBackfillBundles: config.BACKFILL_BUNDLE_RECORDS,
  filtersChanged: config.FILTER_CHANGE_REPROCESS,
});

// Configure contiguous data source
const chunkDataSource = new ReadThroughChunkDataCache({
  log,
  chunkSource: arweaveClient,
  chunkDataStore: new FsChunkDataStore({ log, baseDir: 'data/chunks' }),
});

const txChunksDataSource = new TxChunksDataSource({
  log,
  chainSource: arweaveClient,
  chunkSource: chunkDataSource,
});

const gatewayDataSource = new GatewayDataSource({
  log,
  trustedGatewayUrl: config.TRUSTED_GATEWAY_URL,
});

const arIODataSource = new ArIODataSource({
  log,
  arIO,
  nodeWallet: config.AR_IO_WALLET,
});

const s3DataSource =
  awsClient !== undefined && config.AWS_S3_BUCKET !== undefined
    ? new S3DataSource({
        log,
        s3Client: awsClient.S3,
        s3Bucket: config.AWS_S3_BUCKET,
        s3Prefix: config.AWS_S3_PREFIX,
        awsClient,
      })
    : undefined;

const dataSources: ContiguousDataSource[] = [];
for (const sourceName of config.ON_DEMAND_RETRIEVAL_ORDER) {
  switch (sourceName) {
    case 's3':
      if (s3DataSource !== undefined) {
        dataSources.push(s3DataSource);
      }
      break;
    case 'ario-peer':
      dataSources.push(arIODataSource);
      break;
    case 'trusted-gateway':
      dataSources.push(gatewayDataSource);
      break;
    case 'chunks':
      dataSources.push(txChunksDataSource);
      break;
    case 'tx-data':
      dataSources.push(arweaveClient);
      break;
    default:
      throw new Error(`Unknown data source: ${sourceName}`);
  }
}

const dataContentAttributeImporter = new DataContentAttributeImporter({
  log,
  contiguousDataIndex: contiguousDataIndex,
});

export const contiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources,
  }),
  dataStore: new FsDataStore({ log, baseDir: 'data/contiguous' }),
  contiguousDataIndex,
  dataContentAttributeImporter,
});

const ans104Unbundler = new Ans104Unbundler({
  log,
  eventEmitter,
  filter: config.ANS104_UNBUNDLE_FILTER,
  contiguousDataSource,
  dataItemIndexFilterString: config.ANS104_INDEX_FILTER_STRING,
  workerCount: config.ANS104_UNBUNDLE_WORKERS,
});

const bundleDataImporter = new BundleDataImporter({
  log,
  contiguousDataSource,
  ans104Unbundler,
  workerCount: config.ANS104_DOWNLOAD_WORKERS,
});

async function queueBundle(item: NormalizedDataItem | PartialJsonTransaction) {
  try {
    if ('root_tx_id' in item && item.root_tx_id === null) {
      log.debug('Skipping download of optimistically indexed data item', {
        id: item.id,
        rootTxId: item.root_tx_id,
        parentId: item.parent_id,
      });
      return;
    }

    await db.saveBundle({
      id: item.id,
      rootTransactionId: 'root_tx_id' in item ? item.root_tx_id : item.id,
      format: 'ans-104',
    });

    const isPrioritized = prioritizedTxIds.has(item.id);
    prioritizedTxIds.delete(item.id);

    if (await config.ANS104_UNBUNDLE_FILTER.match(item)) {
      metrics.bundlesMatchedCounter.inc({ bundle_format: 'ans-104' });
      await db.saveBundle({
        id: item.id,
        format: 'ans-104',
        unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
        indexFilter: config.ANS104_INDEX_FILTER_STRING,
        queuedAt: currentUnixTimestamp(),
      });
      bundleDataImporter.queueItem(
        {
          ...item,
          index:
            'parent_index' in item && item.parent_index !== undefined
              ? item.parent_index
              : -1, // parent indexes are not needed for L1
        },
        isPrioritized,
      );
      metrics.bundlesQueuedCounter.inc({ bundle_format: 'ans-104' });
    } else {
      await db.saveBundle({
        id: item.id,
        format: 'ans-104',
        unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
        skippedAt: currentUnixTimestamp(),
      });
    }
  } catch (error: any) {
    log.error('Error saving or queueing bundle', {
      message: error.message,
      stack: error.stack,
    });
  }
}

eventEmitter.on(
  events.ANS104_BUNDLE_QUEUED,
  async (item: NormalizedDataItem | PartialJsonTransaction) => {
    await queueBundle(item);
  },
);

eventEmitter.on(
  events.ANS104_BUNDLE_INDEXED,
  async (item: NormalizedDataItem | PartialJsonTransaction) => {
    await queueBundle(item);
  },
);

eventEmitter.on(events.ANS104_UNBUNDLE_COMPLETE, async (bundleEvent: any) => {
  try {
    metrics.bundlesUnbundledCounter.inc({ bundle_format: 'ans-104' });
    db.saveBundle({
      id: bundleEvent.parentId,
      format: 'ans-104',
      dataItemCount: bundleEvent.itemCount,
      matchedDataItemCount: bundleEvent.matchedItemCount,
      unbundledAt: currentUnixTimestamp(),
    });
  } catch (error: any) {
    log.error('Error saving unbundle completion', {
      parentId: bundleEvent.parentId,
      message: error.message,
      stack: error.stack,
    });
  }
});

export const dataItemIndexer = new DataItemIndexer({
  log,
  eventEmitter,
  indexWriter: dataItemIndexWriter,
});

const ans104DataIndexer = new Ans104DataIndexer({
  log,
  eventEmitter,
  indexWriter: nestedDataIndexWriter,
  contiguousDataIndex,
});

eventEmitter.on(events.ANS104_DATA_ITEM_MATCHED, async (dataItem: any) => {
  metrics.dataItemsQueuedCounter.inc({ bundle_format: 'ans-104' });
  dataItemIndexer.queueDataItem(dataItem);
  ans104DataIndexer.queueDataItem(dataItem);
});

export const manifestPathResolver = new StreamingManifestPathResolver({
  log,
});

export const nameResolver = new MemoryCacheArNSResolver({
  log,
  resolver: createArNSResolver({
    log,
    type: config.TRUSTED_ARNS_RESOLVER_TYPE,
    url: config.TRUSTED_ARNS_RESOLVER_URL,
  }),
});

const webhookEmitter = new WebhookEmitter({
  eventEmitter,
  targetServersUrls: config.WEBHOOK_TARGET_SERVERS,
  indexFilter: config.WEBHOOK_INDEX_FILTER,
  blockFilter: config.WEBHOOK_BLOCK_FILTER,
  log,
});

export const mempoolWatcher = config.ENABLE_MEMPOOL_WATCHER
  ? new MempoolWatcher({
      log,
      chainSource: arweaveClient,
      txFetcher,
      mempoolPollingIntervalMs: config.MEMPOOL_POLLING_INTERVAL_MS,
    })
  : undefined;

export const signatureFetcher = new SignatureFetcher({
  log,
  dataSource: contiguousDataSource,
  dataIndex: contiguousDataIndex,
});

let isShuttingDown = false;

export const shutdown = async (express: Server) => {
  if (isShuttingDown) {
    log.info('Shutdown already in progress');
  } else {
    isShuttingDown = true;
    log.info('Shutting down...');
    express.close(async () => {
      log.debug('Web server stopped successfully');
      eventEmitter.removeAllListeners();
      arIODataSource.stopUpdatingPeers();
      await mempoolWatcher?.stop();
      await blockImporter.stop();
      await dataItemIndexer.stop();
      await txRepairWorker.stop();
      await txImporter.stop();
      await txFetcher.stop();
      await txOffsetImporter.stop();
      await txOffsetRepairWorker.stop();
      await bundleDataImporter.stop();
      await bundleRepairWorker.stop();
      await ans104DataIndexer.stop();
      await ans104Unbundler.stop();
      await webhookEmitter.stop();
      await db.stop();
      await headerFsCacheCleanupWorker?.stop();
      await contiguousDataFsCacheCleanupWorker?.stop();

      process.exit(0);
    });
  }
};
