/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 5TB in bytes - provides good granularity without excessive file size
const INTERVAL_BYTES = 5497558138880;
const DEFAULT_GATEWAY_URL = 'https://arweave.net';
const DEFAULT_OUTPUT_PATH = path.join(__dirname, '../../src/data/offset-block-mapping.json');
const REQUEST_TIMEOUT_MS = 30000;

interface MappingInterval {
  offset: number;
  blockHeight: number;
}

interface OffsetBlockMapping {
  version: string;
  generatedAt: string;
  currentHeight: number;
  currentWeaveSize: number;
  intervalBytes: number;
  intervals: MappingInterval[];
}

interface Config {
  gatewayUrl: string;
  outputPath: string;
}

function printUsage(): void {
  console.log(`
Generate Offset-to-Block Mapping

This tool generates a static mapping file that maps byte offsets to block heights.
The mapping is used to optimize binary search when looking up transactions by offset.

Usage: ./tools/generate-offset-mapping [options]

Options:
  --gateway <url>   Gateway URL to fetch block data (default: ${DEFAULT_GATEWAY_URL})
  --output <path>   Output file path (default: src/data/offset-block-mapping.json)
  --help            Show this help message

Example:
  ./tools/generate-offset-mapping
  ./tools/generate-offset-mapping --gateway https://arweave.net --output ./mapping.json
`);
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  let gatewayUrl = DEFAULT_GATEWAY_URL;
  let outputPath = DEFAULT_OUTPUT_PATH;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--gateway':
        if (!nextArg) throw new Error('--gateway requires a URL');
        gatewayUrl = nextArg.replace(/\/$/, '');
        i++;
        break;
      case '--output':
        if (!nextArg) throw new Error('--output requires a path');
        outputPath = path.resolve(nextArg);
        i++;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { gatewayUrl, outputPath };
}

async function getBlockByHeight(gatewayUrl: string, height: number): Promise<any> {
  const response = await axios.get(`${gatewayUrl}/block/height/${height}`, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': 'ar-io-node-offset-mapping-generator/1.0' },
  });
  return response.data;
}

async function getCurrentHeight(gatewayUrl: string): Promise<number> {
  const response = await axios.get(`${gatewayUrl}/height`, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': 'ar-io-node-offset-mapping-generator/1.0' },
  });
  return response.data;
}

/**
 * Binary search to find the block whose weave_size is >= targetOffset.
 * Returns the block height.
 */
async function binarySearchBlockForOffset(
  gatewayUrl: string,
  targetOffset: number,
  maxHeight: number,
): Promise<number> {
  let left = 0;
  let right = maxHeight;
  let result = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const block = await getBlockByHeight(gatewayUrl, mid);
    const blockOffset = parseInt(block.weave_size, 10);

    if (blockOffset >= targetOffset) {
      result = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return result;
}

async function generateMapping(config: Config): Promise<OffsetBlockMapping> {
  console.log(`Fetching current chain state from ${config.gatewayUrl}...`);

  const currentHeight = await getCurrentHeight(config.gatewayUrl);
  const currentBlock = await getBlockByHeight(config.gatewayUrl, currentHeight);
  const currentWeaveSize = parseInt(currentBlock.weave_size, 10);

  const weaveSizeTiB = currentWeaveSize / 1099511627776;
  console.log(`Current height: ${currentHeight.toLocaleString()}`);
  console.log(`Current weave size: ${currentWeaveSize.toLocaleString()} bytes (${weaveSizeTiB.toFixed(2)} TiB)`);

  const expectedIntervals = Math.ceil(currentWeaveSize / INTERVAL_BYTES) + 1;
  console.log(`\nGenerating ${expectedIntervals} intervals at 5TB increments...\n`);

  const intervals: MappingInterval[] = [];

  // Always include genesis
  intervals.push({ offset: 0, blockHeight: 0 });
  console.log(`[1/${expectedIntervals}] Genesis: offset=0, blockHeight=0`);

  // Generate intervals every 5TB
  let intervalNum = 2;
  for (let offset = INTERVAL_BYTES; offset <= currentWeaveSize; offset += INTERVAL_BYTES) {
    const offsetTiB = (offset / 1099511627776).toFixed(0);
    process.stdout.write(`[${intervalNum}/${expectedIntervals}] Finding block for ~${offsetTiB} TiB...`);

    const blockHeight = await binarySearchBlockForOffset(config.gatewayUrl, offset, currentHeight);
    intervals.push({ offset, blockHeight });

    console.log(` blockHeight=${blockHeight.toLocaleString()}`);
    intervalNum++;
  }

  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    currentHeight,
    currentWeaveSize,
    intervalBytes: INTERVAL_BYTES,
    intervals,
  };
}

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('=== Offset-to-Block Mapping Generator ===\n');

  const mapping = await generateMapping(config);

  // Ensure output directory exists
  const outputDir = path.dirname(config.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(config.outputPath, JSON.stringify(mapping, null, 2) + '\n');

  console.log(`\n=== Generation Complete ===`);
  console.log(`Total intervals: ${mapping.intervals.length}`);
  console.log(`Output written to: ${config.outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
