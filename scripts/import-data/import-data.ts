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
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchLatestBlockHeight,
  fetchWithRetry,
  getFilesInRange,
} from './utils.js';
const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ARIO_ENDPOINT = 'http://localhost:4000';
let ADMIN_KEY: string | undefined;
let MIN_BLOCK_HEIGHT = 0;
let MAX_BLOCK_HEIGHT: number | undefined;
let TRANSACTIONS_DIR = path.join(__dirname, 'transactions');
let ANS104_DIR = path.join(__dirname, 'ans104');

type ImportType = 'transaction' | 'ans104' | 'all';
let IMPORT_TYPE: ImportType | undefined;

args.forEach((arg, index) => {
  switch (arg) {
    case '--adminKey':
      if (args[index + 1]) {
        ADMIN_KEY = args[index + 1];
      } else {
        console.error('Missing value for --adminKey');
        process.exit(1);
      }
      break;
    case '--arioNode':
      if (args[index + 1]) {
        ARIO_ENDPOINT = args[index + 1];
      } else {
        console.error('Missing value for --arioNode');
        process.exit(1);
      }
      break;
    case '--minHeight':
      if (args[index + 1]) {
        MIN_BLOCK_HEIGHT = parseInt(args[index + 1], 10);
      } else {
        console.error('Missing value for --minHeight');
        process.exit(1);
      }
      break;
    case '--maxHeight':
      if (args[index + 1]) {
        MAX_BLOCK_HEIGHT = parseInt(args[index + 1], 10);
      } else {
        console.error('Missing value for --maxHeight');
        process.exit(1);
      }
      break;
    case '--transactionsDir':
      if (args[index + 1]) {
        TRANSACTIONS_DIR = args[index + 1];
      } else {
        console.error('Missing value for --transactionsDir');
        process.exit(1);
      }
      break;
    case '--ans104Dir':
      if (args[index + 1]) {
        ANS104_DIR = args[index + 1];
      } else {
        console.error('Missing value for --ans104Dir');
        process.exit(1);
      }
      break;
    case '--importType': {
      const importType = args[index + 1];
      if (
        importType === 'transaction' ||
        importType === 'ans104' ||
        importType === 'all'
      ) {
        IMPORT_TYPE = importType;
      } else {
        console.error('Missing value for --importType');
        process.exit(1);
      }
      break;
    }
    default:
      break;
  }
});

const importFromFiles = async ({
  files,
  type,
}: {
  files: string[];
  type: 'transactions' | 'ans104';
}) => {
  let counter = 0;
  let folder: string;
  let endpoint: string;
  switch (type) {
    case 'transactions':
      folder = TRANSACTIONS_DIR;
      endpoint = `${ARIO_ENDPOINT}/ar-io/admin/queue-tx`;
      break;
    case 'ans104':
      folder = ANS104_DIR;
      endpoint = `${ARIO_ENDPOINT}/ar-io/admin/queue-bundle`;
      break;
    default:
      throw new Error('Invalid type');
  }

  for (const file of files) {
    const filePath = path.join(folder, file);
    const ids = JSON.parse(await fs.readFile(filePath, 'utf-8')) as string[];
    console.log(
      `Importing ${ids.length} ${type} from block ${file.split('.')[0]}`,
    );

    for (const id of ids) {
      counter++;
      await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({ id }),
      });
    }
  }

  return { queued: counter };
};

(async () => {
  if (ADMIN_KEY === undefined) {
    throw new Error('Missing admin key');
  }

  if (MAX_BLOCK_HEIGHT === undefined) {
    MAX_BLOCK_HEIGHT = await fetchLatestBlockHeight();
  }

  let transactionFiles: string[] = [];
  let bundleFiles: string[] = [];

  switch (IMPORT_TYPE ?? 'all') {
    case 'transaction':
      transactionFiles = await getFilesInRange({
        folder: TRANSACTIONS_DIR,
        min: MIN_BLOCK_HEIGHT,
        max: MAX_BLOCK_HEIGHT,
      });
      break;
    case 'ans104':
      bundleFiles = await getFilesInRange({
        folder: ANS104_DIR,
        min: MIN_BLOCK_HEIGHT,
        max: MAX_BLOCK_HEIGHT,
      });
      break;
    case 'all':
      transactionFiles = await getFilesInRange({
        folder: TRANSACTIONS_DIR,
        min: MIN_BLOCK_HEIGHT,
        max: MAX_BLOCK_HEIGHT,
      });
      bundleFiles = await getFilesInRange({
        folder: ANS104_DIR,
        min: MIN_BLOCK_HEIGHT,
        max: MAX_BLOCK_HEIGHT,
      });
      break;
  }

  console.log(
    `Starting to import transactions and bundles from block ${MIN_BLOCK_HEIGHT} to ${MAX_BLOCK_HEIGHT}`,
  );

  const queuedTransactions = await importFromFiles({
    files: transactionFiles,
    type: 'transactions',
  });

  if (queuedTransactions.queued > 0) {
    console.log(`Finished queueing ${queuedTransactions.queued} transactions`);
  }

  const queuedBundles = await importFromFiles({
    files: bundleFiles,
    type: 'ans104',
  });

  if (queuedBundles.queued > 0) {
    console.log(`Finished queueing ${queuedBundles.queued} bundles`);
  }
})();
