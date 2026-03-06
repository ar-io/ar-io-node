/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from 'axios';
import fs from 'node:fs';

const GRAPHQL_BUNDLE_QUERY = `
  query getBundleParent($id: ID!) {
    transaction(id: $id) {
      id
      bundledIn {
        id
      }
    }
  }
`;

const MAX_DEPTH = 20;

function usage() {
  console.error(`Usage: fetch-with-hint <data-item-id> [options]

Fetches a data item from the gateway using client-supplied root TX ID
and nesting path hints resolved via GraphQL.

Options:
  --gateway <url>   Gateway URL (default: http://localhost:4000)
  --graphql <url>   GraphQL endpoint (default: https://arweave.net/graphql)
  --output <file>   Output file (default: stdout)
  --verbose         Show resolution details
  --help            Show this help`);
  process.exit(1);
}

async function resolveRootPath(
  graphqlUrl: string,
  dataItemId: string,
  verbose: boolean,
): Promise<{ rootTxId: string; path: string[] }> {
  const chain: string[] = [];
  let currentId = dataItemId;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const response = await axios.post(graphqlUrl, {
      query: GRAPHQL_BUNDLE_QUERY,
      variables: { id: currentId },
    });

    const transaction = response.data?.data?.transaction;
    if (!transaction) {
      throw new Error(`Transaction ${currentId} not found in GraphQL`);
    }

    const bundleId = transaction.bundledIn?.id;
    if (!bundleId) {
      // currentId is the root L1 transaction
      if (verbose) {
        console.error(`Root TX: ${currentId}`);
        console.error(`Nesting depth: ${chain.length}`);
      }
      // Path is [rootTxId, ...intermediate bundles] (root first)
      const path = [currentId, ...chain.reverse()];
      return { rootTxId: currentId, path };
    }

    chain.push(currentId);
    if (verbose) {
      console.error(`  ${currentId} bundled in ${bundleId}`);
    }
    currentId = bundleId;
  }

  throw new Error(`Exceeded max nesting depth (${MAX_DEPTH})`);
}

async function main() {
  const args = process.argv.slice(2);

  let dataItemId: string | undefined;
  let gateway = 'http://localhost:4000';
  let graphqlUrl = 'https://arweave.net/graphql';
  let outputFile: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--gateway':
        gateway = args[++i];
        break;
      case '--graphql':
        graphqlUrl = args[++i];
        break;
      case '--output':
        outputFile = args[++i];
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--help':
        usage();
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          usage();
        }
        dataItemId = arg;
    }
  }

  if (!dataItemId) {
    console.error('Error: data-item-id is required');
    usage();
    return;
  }

  if (verbose) {
    console.error(`Resolving root path for ${dataItemId}...`);
  }

  const { rootTxId, path } = await resolveRootPath(
    graphqlUrl,
    dataItemId,
    verbose,
  );

  if (verbose) {
    console.error(`Path: ${path.join(' -> ')}`);
    console.error(
      `Fetching ${gateway}/raw/${dataItemId} with hint headers...`,
    );
  }

  const headers: Record<string, string> = {
    'X-AR-IO-Root-Transaction-Id': rootTxId,
  };
  if (path.length > 0) {
    headers['X-AR-IO-Root-Path'] = path.join(',');
  }

  const response = await axios.get(`${gateway}/raw/${dataItemId}`, {
    headers,
    responseType: 'stream',
  });

  if (verbose) {
    console.error(`Response status: ${response.status}`);
    console.error(
      `Content-Type: ${response.headers['content-type'] ?? 'unknown'}`,
    );
    console.error(
      `Content-Length: ${response.headers['content-length'] ?? 'unknown'}`,
    );
  }

  if (outputFile) {
    const writeStream = fs.createWriteStream(outputFile);
    response.data.pipe(writeStream);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    if (verbose) {
      console.error(`Written to ${outputFile}`);
    }
  } else {
    response.data.pipe(process.stdout);
    await new Promise<void>((resolve) => {
      response.data.on('end', resolve);
    });
  }
}

main().catch((error) => {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
