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
import { fetchLatestBlockHeight, fetchWithRetry } from './utils.js';
const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let GQL_ENDPOINT = 'https://arweave-search.goldsky.com/graphql';
let MIN_BLOCK_HEIGHT = 0;
let MAX_BLOCK_HEIGHT: number | undefined;
let BLOCK_RANGE_SIZE = 100;
let BUNDLES_FETCH_ROOT_TX = true;
let GQL_TAGS = `[
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
]`;

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
    case '--fetchOnlyRootTx':
      if (args[index + 1]) {
        BUNDLES_FETCH_ROOT_TX = args[index + 1] === 'true';
      } else {
        console.error('Missing value for --fetchOnlyRootTx');
        process.exit(1);
      }
      break;
    case '--gqlTags':
      if (args[index + 1]) {
        GQL_TAGS = args[index + 1];
      } else {
        console.error('Missing value for --gqlTags');
        process.exit(1);
      }
      break;
    default:
      break;
  }
});

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

const txsGqlQuery = ({
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
    tags:  ${GQL_TAGS}
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

const rootTxGqlQuery = (txId: string) => `
query {
  transaction(
    id: "${txId}"
  ) {
    bundledIn {
      id
    }
  }
}
`;

const getRootTxId = async (txId: string) => {
  let rootTxId: string | undefined;
  let currentId = txId;

  while (rootTxId === undefined) {
    const response = await fetchWithRetry(GQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: rootTxGqlQuery(currentId),
      }),
    });

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
    }

    const { data } = result;

    if (data.transaction === null) {
      console.warn("Can't get any results while fetching rootTxId for", txId);
      return;
    }

    const bundleId = data.transaction.bundledIn?.id;

    if (bundleId === undefined) {
      rootTxId = currentId;
    } else {
      currentId = bundleId;
    }
  }

  return rootTxId;
};

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
    body: JSON.stringify({
      query: txsGqlQuery({ minBlock, maxBlock, cursor }),
    }),
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
  const transactions: BlockTransactions = new Map();
  const bundles: BlockTransactions = new Map();
  const rootTxIdsForBundles: Map<string, string> = new Map();
  const txsMissingRootTx = new Set<string>();

  while (hasNextPage) {
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
        if (BUNDLES_FETCH_ROOT_TX) {
          const cachedRootTxId = rootTxIdsForBundles.get(bundleId);
          const rootTxId = cachedRootTxId ?? (await getRootTxId(bundleId));

          if (rootTxId === undefined) {
            txsMissingRootTx.add(bundleId);
          } else {
            rootTxIdsForBundles.set(bundleId, rootTxId);
            bundles.get(blockHeight)?.add(rootTxId);
          }
        } else {
          bundles.get(blockHeight)?.add(bundleId);
        }
      } else {
        transactions.get(blockHeight)?.add(id);
      }
    }
  }

  return { transactions, bundles, txsMissingRootTx };
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

    const content = JSON.stringify([...ids]);
    const filePath = path.join(outputDir, `${height}.json`);

    try {
      await fs.writeFile(filePath, content);
    } catch (error) {
      console.error(`Failed to write ${filePath}: ${error}`);
      throw error;
    }
  }
};

const writeTxMissingRootTxIds = async ({
  ids,
  minHeight,
  maxHeight,
  outputDir,
}: {
  ids: Set<string>;
  minHeight: number;
  maxHeight: number;
  outputDir: string;
}) => {
  if (ids.size === 0) return;
  try {
    const missingRootTxDir = path.join(outputDir, 'missing-root-tx-ids');
    await fs.mkdir(missingRootTxDir, { recursive: true });

    const filePath = path.join(
      missingRootTxDir,
      `tx-missing-root-tx-ids-${minHeight}-${maxHeight}.json`,
    );

    const content = JSON.stringify([...ids]);

    await fs.writeFile(filePath, content, 'utf8');

    console.warn(
      `Failed to fetch rootTxId for ${ids.size} transactions.\ntx-missing-root-tx-ids-${minHeight}-${maxHeight}.json was written.`,
    );
  } catch (error) {
    console.error(
      `Failed to write tx-missing-root-tx-ids-${minHeight}-${maxHeight}.json: ${error}`,
    );
    throw error;
  }
};

const countTransactions = (map: BlockTransactions) => {
  let total = 0;
  map.forEach((set) => {
    total += set.size;
  });
  return total;
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

  let txCount = 0;
  let bundleCount = 0;

  for (const range of blockRanges) {
    const { transactions, bundles, txsMissingRootTx } =
      await getTransactionsForRange(range);

    await writeTransactionsToFile({
      outputDir: path.join(__dirname, 'transactions'),
      transactions,
    });
    await writeTransactionsToFile({
      outputDir: path.join(__dirname, 'bundles'),
      transactions: bundles,
    });
    await writeTxMissingRootTxIds({
      ids: txsMissingRootTx,
      minHeight: range.min,
      maxHeight: range.max,
      outputDir: __dirname,
    });

    txCount += countTransactions(transactions);
    bundleCount += countTransactions(bundles);

    if (transactions.size > 0 || bundles.size > 0) {
      console.log(
        `Transactions and bundles from block ${range.min} to ${range.max} saved!`,
      );
      console.log(
        `Saved transactions: ${txCount}, Saved bundles: ${bundleCount}`,
      );
    }
  }
})();
