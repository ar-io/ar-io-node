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
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
//@ts-ignore
import { isMainThread, parentPort } from 'node:worker_threads';

import log from '../log.js';
import { PostgressDatabaseWorker } from './postgress/PostgressDatabaseWorker.js';
import { WorkerMessage } from './postgress/PostgressDatabaseTypes.js';

const MAX_WORKER_ERRORS = 100;

if (!isMainThread) {
  const worker: PostgressDatabaseWorker = new PostgressDatabaseWorker({ log });
  let errorCount = 0;

  parentPort?.on('message', async ({ method, args }: WorkerMessage): Promise<void> => {
    try {
      switch (method) {
        case 'getMaxHeight': {
          const height = await worker.getMaxHeight();
          parentPort?.postMessage(height);
          break;
        }
        case 'getBlockHashByHeight': {
          const height = await worker.getBlockHashByHeight(args[0]);
          parentPort?.postMessage(height);
          break;
        }
        case 'getMissingTxIds': {
          const missingTxIds = await worker.getMissingTxIds(args[0]);
          parentPort?.postMessage(missingTxIds);
          break;
        }
        case 'getFailedBundleIds': {
          const failedBundleIds = worker.getFailedBundleIds(args[0]);
          parentPort?.postMessage(failedBundleIds);
          break;
        }
        case 'backfillBundles': {
          await worker.backfillBundles();
          parentPort?.postMessage(null);
          break;
        }
        case 'updateBundlesFullyIndexedAt': {
          await worker.updateBundlesFullyIndexedAt();
          parentPort?.postMessage(null);
          break;
        }
        case 'updateBundlesForFilterChange': {
          const [unbundleFilter, indexFilter] = args;
          await worker.updateBundlesForFilterChange(unbundleFilter, indexFilter);
          parentPort?.postMessage(null);
          break;
        }
        case 'resetToHeight': {
          await worker.resetToHeight(args[0]);
          parentPort?.postMessage(undefined);
          break;
        }
        case 'saveTx': {
          await worker.saveTx(args[0]);
          parentPort?.postMessage(null);
          break;
        }
        case 'getTxIdsMissingOffsets': {
          const txIdsMissingOffsets = await worker.getTxIdsMissingOffsets(args[0]);
          parentPort?.postMessage(txIdsMissingOffsets);
          break;
        }
        case 'saveTxOffset': {
          await worker.saveTxOffset(args[0], args[1]);
          parentPort?.postMessage(null);
          break;
        }
        case 'saveDataItem': {
          await worker.saveDataItem(args[0]);
          parentPort?.postMessage(null);
        }
          break;
        case 'saveBundle': {
          await worker.saveBundle(args[0]);
          parentPort?.postMessage(null);
          break;
        }
        case 'saveBlockAndTxs': {
          const [block, txs, missingTxIds] = args;
          await worker.saveBlockAndTxs(block, txs, missingTxIds);
          parentPort?.postMessage(null);
          break;
        }
        case 'getDataAttributes': {
          const dataAttributes = await worker.getDataAttributes(args[0]);
          parentPort?.postMessage(dataAttributes);
          break;
        }
        case 'getDataParent': {
          const dataParent = await worker.getDataParent(args[0]);
          parentPort?.postMessage(dataParent);
          break;
        }
        case 'getDebugInfo': {
          const debugInfo = await worker.getDebugInfo();
          parentPort?.postMessage(debugInfo);
          break;
        }
        case 'saveDataContentAttributes': {
          await worker.saveDataContentAttributes(args[0]);
          parentPort?.postMessage(null);
          break;
        }
        case 'getGqlTransactions': {
          const gqlTransactions = await worker.getGqlTransactions(args[0]);
          parentPort?.postMessage(gqlTransactions);
          break;
        }
        case 'getGqlTransaction': {
          const gqlTransaction = await worker.getGqlTransaction(args[0]);
          parentPort?.postMessage(gqlTransaction);
          break;
        }
        case 'getGqlBlocks': {
          const gqlBlocks = await worker.getGqlBlocks(args[0]);
          parentPort?.postMessage(gqlBlocks);
          break;
        }
        case 'getGqlBlock': {
          const gqlBlock = await worker.getGqlBlock(args[0]);
          parentPort?.postMessage(gqlBlock);
          break;
        }
        case 'isIdBlocked': {
          const isIdBlocked = await worker.isIdBlocked(args[0]);
          parentPort?.postMessage(isIdBlocked);
          break;
        }
        case 'isHashBlocked': {
          const isHashBlocked = await worker.isHashBlocked(args[0]);
          parentPort?.postMessage(isHashBlocked);
          break;
        }
        case 'blockData': {
          await worker.blockData(args[0]);
          parentPort?.postMessage(null);
          break;
        }
        case 'saveNestedDataId': {
          await worker.saveNestedDataId(args[0]);
          parentPort?.postMessage(null);
          break;
        }
        case 'saveNestedDataHash': {
          await worker.saveNestedDataHash(args[0]);
          parentPort?.postMessage(null);
          break;
        }
        case 'terminate': {
          parentPort?.postMessage(null);
          process.exit(0);
        }
      }
    } catch (error) {
      if (errorCount > MAX_WORKER_ERRORS) {
        log.error('Too many errors in Postgres worker, exiting.');
        process.exit(1);
      }
      log.error('Error in Postgres worker:', error);
      errorCount++;
      parentPort?.postMessage('__ERROR__');
    }
  });
}
