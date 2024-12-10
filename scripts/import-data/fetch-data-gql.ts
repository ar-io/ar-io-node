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
const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let GQL_ENDPOINT = 'https://arweave-search.goldsky.com/graphql';
let MIN_BLOCK_HEIGHT = 0;
let MAX_BLOCK_HEIGHT: number | undefined;
let BLOCK_RANGE_SIZE = 100;

args.forEach((arg, index) => {
  switch (arg) {
    case '--gqlEndpoint':
      if (args[index + 1]) {
        GQL_ENDPOINT = args[index + 1];
      } else {
        console.error('Missing value for --gqlEndpoint');
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
    case '--blockRangeSize':
      if (args[index + 1]) {
        BLOCK_RANGE_SIZE = parseInt(args[index + 1], 10);
      } else {
        console.error('Missing value for --blockRangeSize');
        process.exit(1);
      }
      break;
    default:
      break;
  }
});

const fetchWithRetry = async (
  url: string,
  options: RequestInit = {},
  retries = 5,
  retryInterval = 300, // interval in milliseconds
): Promise<Response> => {
  let attempt = 0;

  while (attempt < retries) {
    try {
      const response = await fetch(url, options);

      if (response.ok) {
        return response;
      }

      throw new Error(`HTTP error! status: ${response.status}`);
    } catch (error) {
      attempt++;

      if (attempt >= retries) {
        throw new Error(
          `Fetch failed after ${retries} attempts: ${(error as Error).message}`,
        );
      }

      const waitTime = retryInterval * attempt;
      console.warn(
        `Fetch attempt ${attempt} failed. Retrying in ${waitTime}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  throw new Error('Unexpected error in fetchWithRetry');
};

const fetchLatestBlockHeight = async () => {
  const response = await fetchWithRetry('https://arweave.net/info', {
    method: 'GET',
  });
  const { blocks } = await response.json();
  return blocks as number;
};

type BlockRange = { min: number; max: number };
const getBlockRanges = ({
  minBlock,
  maxBlock,
  rangeSize,
}: {
  minBlock: number;
  maxBlock: number;
  rangeSize: number;
}) => {
  if (minBlock >= maxBlock || rangeSize <= 0) {
    throw new Error(
      'Invalid input: ensure minBlock < maxBlock and rangeSize > 0',
    );
  }

  const ranges: BlockRange[] = [];
  let currentMin = minBlock;

  while (currentMin < maxBlock) {
    const currentMax = Math.min(currentMin + rangeSize - 1, maxBlock);
    ranges.push({ min: currentMin, max: currentMax });
    currentMin = currentMax + 1;
  }

  return ranges;
};

const gqlQuery = ({
  minBlock,
  maxBlock,
  cursor,
}: {
  minBlock: number;
  maxBlock: number;
  cursor?: string;
}) => `
query {
  transactions(
    block: {
      min: ${minBlock}
      max: ${maxBlock}
    }
    tags: [
      {
        name: "App-Name"
        values: [
          "ArDrive-App"
          "ArDrive-Web"
          "ArDrive-CLI"
          "ArDrive-Desktop"
          "ArDrive-Mobile"
          "ArDrive-Core"
          "ArDrive-Sync"
        ]
      }
    ]
    first: 100
    sort: HEIGHT_ASC
    after: "${cursor !== undefined ? cursor : ''}"
  ) {
    pageInfo {
      hasNextPage
    }
    edges {
      cursor
      node {
        id
        bundledIn {
          id
        }
        block {
          height
        }
      }
    }
  }
}
`;

const fetchGql = async ({
  minBlock,
  maxBlock,
  cursor,
}: {
  minBlock: number;
  maxBlock: number;
  cursor?: string;
}) => {
  const response = await fetchWithRetry(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: gqlQuery({ minBlock, maxBlock, cursor }) }),
  });
  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }
  const { data } = result;
  return data;
};

type BlockTransactions = Map<number, Set<string>>;
const getTransactionsForRange = async ({ min, max }: BlockRange) => {
  let cursor: string | undefined;
  let hasNextPage = true;
  let page = 0;
  const transactions: BlockTransactions = new Map();
  const bundles: BlockTransactions = new Map();

  while (hasNextPage) {
    console.log(
      `Fetching transactions and bundles from block ${min} to ${max}. Page ${page}`,
    );
    const {
      transactions: { edges, pageInfo },
    } = await fetchGql({
      minBlock: min,
      maxBlock: max,
      cursor,
    });

    hasNextPage = pageInfo.hasNextPage;
    cursor = hasNextPage ? edges[edges.length - 1].cursor : undefined;

    for (const edge of edges) {
      const blockHeight = edge.node.block.height;
      const bundleId = edge.node.bundledIn?.id;
      const id = edge.node.id;

      if (!transactions.has(blockHeight)) {
        transactions.set(blockHeight, new Set());
      }
      if (!bundles.has(blockHeight)) {
        bundles.set(blockHeight, new Set());
      }

      if (bundleId !== undefined) {
        bundles.get(blockHeight)?.add(bundleId);
      } else {
        transactions.get(blockHeight)?.add(id);
      }
    }

    page++;
  }

  return { transactions, bundles };
};

const writeTransactionsToFile = async ({
  outputDir,
  transactions,
}: {
  outputDir: string;
  transactions: BlockTransactions;
}) => {
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory: ${error}`);
    throw error;
  }

  for (const [height, ids] of transactions.entries()) {
    if (ids.size === 0) continue;

    const content = JSON.stringify([...ids], null, 2);
    const filePath = path.join(outputDir, `${height}.json`);

    try {
      await fs.writeFile(filePath, content);
    } catch (error) {
      console.error(`Failed to write ${filePath}: ${error}`);
      throw error;
    }
  }
};

(async () => {
  if (MAX_BLOCK_HEIGHT === undefined) {
    MAX_BLOCK_HEIGHT = await fetchLatestBlockHeight();
  }

  const blockRanges = getBlockRanges({
    minBlock: MIN_BLOCK_HEIGHT,
    maxBlock: MAX_BLOCK_HEIGHT,
    rangeSize: BLOCK_RANGE_SIZE,
  });

  console.log(
    `Starting to fetch transactions and bundles from block ${MIN_BLOCK_HEIGHT} to ${MAX_BLOCK_HEIGHT}`,
  );

  for (const range of blockRanges) {
    const { transactions, bundles } = await getTransactionsForRange(range);

    await writeTransactionsToFile({
      outputDir: path.join(__dirname, 'transactions'),
      transactions,
    });
    await writeTransactionsToFile({
      outputDir: path.join(__dirname, 'bundles'),
      transactions: bundles,
    });

    console.log(
      `Transactions and bundles from block ${range.min} to ${range.max} saved!`,
    );
  }
})();
