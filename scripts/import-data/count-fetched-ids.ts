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
import { getFilesInRange } from './utils.js';
const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let TRANSACTIONS_DIR = path.join(__dirname, 'transactions');
let BUNDLES_DIR = path.join(__dirname, 'bundles');
let MIN_BLOCK_HEIGHT = 0;
let MAX_BLOCK_HEIGHT = Infinity;

args.forEach((arg, index) => {
  switch (arg) {
    case '--transactionsDir':
      if (args[index + 1]) {
        TRANSACTIONS_DIR = args[index + 1];
      } else {
        console.error('Missing value for --transactionsDir');
        process.exit(1);
      }
      break;
    case '--bundlesDir':
      if (args[index + 1]) {
        BUNDLES_DIR = args[index + 1];
      } else {
        console.error('Missing value for --bundlesDir');
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
    default:
      break;
  }
});

const countIds = async ({
  folder,
  files,
}: {
  folder: string;
  files: string[];
}) => {
  let counter = 0;
  for (const file of files) {
    const filePath = path.join(folder, file);
    const ids = JSON.parse(await fs.readFile(filePath, 'utf-8')) as string[];
    counter += ids.length;
  }
  return counter;
};

// const importFromFiles = async ({
//   files,
//   type,
// }: {
//   files: string[];
//   type: 'transactions' | 'bundles';
// }) => {
//   let counter = 0;
//   let folder: string;
//   let endpoint: string;
//   switch (type) {
//     case 'transactions':
//       folder = TRANSACTIONS_DIR;
//       endpoint = `${ARIO_ENDPOINT}/ar-io/admin/queue-tx`;
//       break;
//     case 'bundles':
//       folder = BUNDLES_DIR;
//       endpoint = `${ARIO_ENDPOINT}/ar-io/admin/queue-bundle`;
//       break;
//     default:
//       throw new Error('Invalid type');
//   }

//   for (const file of files) {
//     const filePath = path.join(folder, file);
//     const ids = JSON.parse(await fs.readFile(filePath, 'utf-8')) as string[];
//     console.log(
//       `Importing ${ids.length} ${type} from block ${file.split('.')[0]}`,
//     );

//     for (const id of ids) {
//       counter++;
//       await fetchWithRetry(endpoint, {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           Authorization: `Bearer ${ADMIN_KEY}`,
//         },
//         body: JSON.stringify({ id }),
//       });
//     }
//   }

//   return { queued: counter };
// };

(async () => {
  const transactionFiles = await getFilesInRange({
    folder: TRANSACTIONS_DIR,
    min: MIN_BLOCK_HEIGHT,
    max: MAX_BLOCK_HEIGHT,
  });
  const bundleFiles = await getFilesInRange({
    folder: BUNDLES_DIR,
    min: MIN_BLOCK_HEIGHT,
    max: MAX_BLOCK_HEIGHT,
  });

  const firstTransactionHeight = parseInt(
    transactionFiles[0].split('.')[0],
    10,
  );
  const lastTransactionHeight = parseInt(
    transactionFiles[transactionFiles.length - 1].split('.')[0],
    10,
  );
  const transactionCount = await countIds({
    folder: TRANSACTIONS_DIR,
    files: transactionFiles,
  });

  const firstBundleHeight = parseInt(bundleFiles[0].split('.')[0], 10);
  const lastBundleHeight = parseInt(
    bundleFiles[bundleFiles.length - 1].split('.')[0],
    10,
  );
  const bundleCount = await countIds({
    folder: BUNDLES_DIR,
    files: bundleFiles,
  });

  console.log(
    `Total transactions from ${firstTransactionHeight} to ${lastTransactionHeight}: ${transactionCount}`,
  );

  console.log(
    `Total bundles from ${firstBundleHeight} to ${lastBundleHeight}: ${bundleCount}`,
  );
})();
