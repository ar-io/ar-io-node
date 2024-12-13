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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLatestBlockHeight, fetchWithRetry } from './utils.js';
const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ARIO_ENDPOINT = 'http://localhost:4000';
let ADMIN_KEY: string | undefined;
let OUTPUT_DIR = path.join(__dirname, 'parquet');
let MAX_FILE_ROWS = 1_000_000;
let MIN_BLOCK_HEIGHT = 0;
let MAX_BLOCK_HEIGHT: number | undefined;

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
    case '--outputDir':
      if (args[index + 1]) {
        OUTPUT_DIR = args[index + 1];
      } else {
        console.error('Missing value for --outputDir');
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

    case '--maxFileRows':
      if (args[index + 1]) {
        MAX_FILE_ROWS = parseInt(args[index + 1], 10);
      } else {
        console.error('Missing value for --maxFileRows');
        process.exit(1);
      }
      break;
    default:
      break;
  }
});

(async () => {
  if (ADMIN_KEY === undefined) {
    throw new Error('Missing admin key');
  }

  if (MAX_BLOCK_HEIGHT === undefined) {
    MAX_BLOCK_HEIGHT = await fetchLatestBlockHeight();
  }

  await fetchWithRetry(`${ARIO_ENDPOINT}/ar-io/admin/export-parquet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_KEY}`,
    },
    body: JSON.stringify({
      outputDir: OUTPUT_DIR,
      startHeight: MIN_BLOCK_HEIGHT,
      endHeight: MAX_BLOCK_HEIGHT,
      maxFileRows: MAX_FILE_ROWS,
    }),
  });

  console.log(
    `Parquet export started from block ${MIN_BLOCK_HEIGHT} to ${MAX_BLOCK_HEIGHT}`,
  );

  let isComplete = false;

  while (!isComplete) {
    const response = await fetchWithRetry(
      `${ARIO_ENDPOINT}/ar-io/admin/export-parquet/status`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
        },
      },
    );

    const data = await response.json();
    isComplete = data.status === 'completed';

    if (isComplete) {
      console.log('Parque export finished!');
      console.log(data);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
})();
