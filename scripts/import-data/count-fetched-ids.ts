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
let ANS104_DIR = path.join(__dirname, 'ans104');
let ANS102_DIR = path.join(__dirname, 'ans102');
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
    case '--ans104Dir':
      if (args[index + 1]) {
        ANS104_DIR = args[index + 1];
      } else {
        console.error('Missing value for --ans104Dir');
        process.exit(1);
      }
      break;
    case '--ans102Dir':
      if (args[index + 1]) {
        ANS102_DIR = args[index + 1];
      } else {
        console.error('Missing value for --ans102Dir');
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

(async () => {
  const transactionFiles = await getFilesInRange({
    folder: TRANSACTIONS_DIR,
    min: MIN_BLOCK_HEIGHT,
    max: MAX_BLOCK_HEIGHT,
  });
  const ans104Files = await getFilesInRange({
    folder: ANS104_DIR,
    min: MIN_BLOCK_HEIGHT,
    max: MAX_BLOCK_HEIGHT,
  });
  const ans102Files = await getFilesInRange({
    folder: ANS102_DIR,
    min: MIN_BLOCK_HEIGHT,
    max: MAX_BLOCK_HEIGHT,
  });

  if (transactionFiles.length > 0) {
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

    console.log(
      `Total transactions from ${firstTransactionHeight} to ${lastTransactionHeight}: ${transactionCount}`,
    );
  }

  if (ans104Files.length > 0) {
    const firstBundleHeight = parseInt(ans104Files[0].split('.')[0], 10);
    const lastBundleHeight = parseInt(
      ans104Files[ans104Files.length - 1].split('.')[0],
      10,
    );
    const bundleCount = await countIds({
      folder: ANS104_DIR,
      files: ans104Files,
    });

    console.log(
      `Total ans-104 bundles from ${firstBundleHeight} to ${lastBundleHeight}: ${bundleCount}`,
    );
  }

  if (ans102Files.length > 0) {
    const firstBundleHeight = parseInt(ans102Files[0].split('.')[0], 10);
    const lastBundleHeight = parseInt(
      ans102Files[ans102Files.length - 1].split('.')[0],
      10,
    );
    const bundleCount = await countIds({
      folder: ANS102_DIR,
      files: ans102Files,
    });

    console.log(
      `Total ans-102 bundles from ${firstBundleHeight} to ${lastBundleHeight}: ${bundleCount}`,
    );
  }
})();
