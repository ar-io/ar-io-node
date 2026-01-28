/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool to upload partitioned CDB64 partition files to Arweave via Turbo SDK.
 *
 * This tool:
 * 1. Phase 1 (Upload): Uploads partition .cdb files to Turbo, saving data item IDs
 * 2. Phase 2 (Resolve): Polls Turbo offsets API to get root bundle IDs and offsets
 * 3. Phase 3 (Manifest Upload): Optionally uploads the final manifest to Arweave
 *
 * The output manifest contains arweave-bundle-item location types with offsets
 * suitable for byte-range reads from Arweave gateways.
 *
 * Usage:
 *   ./tools/upload-cdb64-to-arweave --input ./index --wallet ./wallet.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import Arweave from 'arweave';
import axios, { AxiosInstance } from 'axios';

// Use createRequire to load turbo-sdk via CJS to avoid ESM/ethers compatibility issues
const require = createRequire(import.meta.url);
const { TurboFactory, ArweaveSigner } = require('@ardrive/turbo-sdk');
type TurboAuthenticatedClient = ReturnType<typeof TurboFactory.authenticated>;

import {
  Cdb64Manifest,
  PartitionInfo,
  parseManifest,
  serializeManifest,
} from '../../src/lib/cdb64-manifest.js';

// Internal-only pending location type (not exported from cdb64-manifest)
interface PartitionArweavePendingLocation {
  type: 'arweave-pending';
  dataItemId: string;
}

type ExtendedPartitionLocation =
  | PartitionInfo['location']
  | PartitionArweavePendingLocation;

interface ExtendedPartitionInfo extends Omit<PartitionInfo, 'location'> {
  location: ExtendedPartitionLocation;
}

interface ExtendedCdb64Manifest extends Omit<Cdb64Manifest, 'partitions'> {
  partitions: ExtendedPartitionInfo[];
}

interface Config {
  inputDir: string;
  walletPath: string;
  outputPath: string;
  name?: string;
  dryRun: boolean;
  resume: boolean;
  uploadOnly: boolean;
  resolveOnly: boolean;
  uploadManifest: boolean;
  uploadManifestL1: boolean;
  concurrency: number;
  appName: string;
  verbose: boolean;
}

interface TurboOffsetsResponse {
  rootBundleId?: string;
  startOffsetInRootBundle?: number;
  payloadDataStart: number;
  payloadContentLength: number;
}

const TURBO_ENDPOINT = 'https://upload.ardrive.io';
const DEFAULT_APP_NAME = 'AR.IO-CDB64';
const OFFSET_POLL_INITIAL_DELAY_MS = 5000;
const OFFSET_POLL_MAX_DELAY_MS = 60000;
const OFFSET_POLL_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

function printUsage(): void {
  console.log(`
Upload Partitioned CDB64 to Arweave

This tool uploads partitioned CDB64 partition files (.cdb) to Arweave using
the Turbo SDK and generates a new local manifest with arweave-bundle-item
location types (includes offsets for byte-range reads).

Usage: ./tools/upload-cdb64-to-arweave [options]

Options:
  --input, -i <path>     Input directory with partitioned CDB64 (required)
  --wallet, -w <path>    Path to Arweave JWK wallet file (required)
  --output, -o <path>    Output manifest path (default: <input>/manifest-arweave.json)
  --name, -n <name>      Descriptive name for this CDB index (added to tags)
  --dry-run              Show cost estimate and exit without uploading
  --resume               Resume from previous partial upload/resolution
  --upload-only          Upload partitions but skip offset resolution phase
  --resolve-only         Skip upload, only resolve offsets for pending partitions
  --upload-manifest      Upload final manifest via Turbo after all partitions resolved
  --upload-manifest-l1   Upload final manifest directly to Arweave L1 (not bundled)
  --concurrency <n>      Parallel uploads (default: 1)
  --app-name <name>      App-Name tag (default: "${DEFAULT_APP_NAME}")
  --verbose              Show detailed per-partition progress
  --help, -h             Show this help message

Phases:
  Phase 1 (Upload):
    - Uploads each partition .cdb file to Turbo
    - Saves data item ID with 'arweave-pending' location type
    - Atomic save after each upload for resumability

  Phase 2 (Resolve):
    - Polls Turbo /tx/:id/offsets API for each pending partition
    - Updates to 'arweave-bundle-item' location type with offset info
    - Atomic save after each resolved partition

  Phase 3 (Manifest Upload, optional):
    - Uploads the final manifest JSON to Arweave
    - Via Turbo (--upload-manifest) or L1 (--upload-manifest-l1)

Examples:
  # Dry run to see cost estimate
  ./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --dry-run

  # Upload only (Phase 1)
  ./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --upload-only

  # Resolve offsets only (Phase 2)
  ./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --resolve-only

  # Full upload with manifest via Turbo
  ./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json -n "root-tx-index" --upload-manifest

  # Resume interrupted upload
  ./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --resume
`);
}

function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  let inputDir: string | undefined;
  let walletPath: string | undefined;
  let outputPath: string | undefined;
  let name: string | undefined;
  let dryRun = false;
  let resume = false;
  let uploadOnly = false;
  let resolveOnly = false;
  let uploadManifest = false;
  let uploadManifestL1 = false;
  let concurrency = 1;
  let appName = DEFAULT_APP_NAME;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--input':
      case '-i':
        if (!nextArg) throw new Error('--input requires a path');
        inputDir = path.resolve(nextArg);
        i++;
        break;
      case '--wallet':
      case '-w':
        if (!nextArg) throw new Error('--wallet requires a path');
        walletPath = path.resolve(nextArg);
        i++;
        break;
      case '--output':
      case '-o':
        if (!nextArg) throw new Error('--output requires a path');
        outputPath = path.resolve(nextArg);
        i++;
        break;
      case '--name':
      case '-n':
        if (!nextArg) throw new Error('--name requires a value');
        name = nextArg;
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--resume':
        resume = true;
        break;
      case '--upload-only':
        uploadOnly = true;
        break;
      case '--resolve-only':
        resolveOnly = true;
        break;
      case '--upload-manifest':
        uploadManifest = true;
        break;
      case '--upload-manifest-l1':
        uploadManifestL1 = true;
        break;
      case '--concurrency':
        if (!nextArg) throw new Error('--concurrency requires a number');
        concurrency = parseInt(nextArg, 10);
        if (isNaN(concurrency) || concurrency < 1) {
          throw new Error('--concurrency must be a positive integer');
        }
        i++;
        break;
      case '--app-name':
        if (!nextArg) throw new Error('--app-name requires a value');
        appName = nextArg;
        i++;
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        return null;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!inputDir) {
    throw new Error('--input is required');
  }
  if (!walletPath) {
    throw new Error('--wallet is required');
  }

  // Default output path
  if (!outputPath) {
    outputPath = path.join(inputDir, 'manifest-arweave.json');
  }

  // Validate mutually exclusive options
  if (uploadOnly && resolveOnly) {
    throw new Error('--upload-only and --resolve-only are mutually exclusive');
  }
  if (uploadManifest && uploadManifestL1) {
    throw new Error(
      '--upload-manifest and --upload-manifest-l1 are mutually exclusive',
    );
  }

  return {
    inputDir,
    walletPath,
    outputPath,
    name,
    dryRun,
    resume,
    uploadOnly,
    resolveOnly,
    uploadManifest,
    uploadManifestL1,
    concurrency,
    appName,
    verbose,
  };
}

function loadWallet(walletPath: string): any {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }
  const walletJson = fs.readFileSync(walletPath, 'utf-8');
  try {
    return JSON.parse(walletJson);
  } catch {
    throw new Error(`Invalid wallet JSON: ${walletPath}`);
  }
}

function loadSourceManifest(inputDir: string): Cdb64Manifest {
  const manifestPath = path.join(inputDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Source manifest not found: ${manifestPath}`);
  }
  const manifestJson = fs.readFileSync(manifestPath, 'utf-8');
  return parseManifest(manifestJson);
}

function loadOutputManifest(outputPath: string): ExtendedCdb64Manifest | null {
  if (!fs.existsSync(outputPath)) {
    return null;
  }
  const manifestJson = fs.readFileSync(outputPath, 'utf-8');
  // Parse as extended manifest (allows arweave-pending locations)
  const data = JSON.parse(manifestJson);
  return data as ExtendedCdb64Manifest;
}

function saveManifestAtomic(
  manifest: ExtendedCdb64Manifest,
  outputPath: string,
): void {
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpPath, outputPath);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatWinc(winc: string): string {
  // 1 AR = 10^12 winston
  const winstonBigInt = BigInt(winc);
  const arValue = Number(winstonBigInt) / 1e12;
  return `${arValue.toFixed(6)} AR`;
}

async function getWalletAddress(jwk: any): Promise<string> {
  const arweave = Arweave.init({});
  return arweave.wallets.jwkToAddress(jwk);
}

async function estimateCost(
  turbo: TurboAuthenticatedClient,
  totalBytes: number,
): Promise<{ winc: string; balance: string; sufficient: boolean }> {
  const [uploadCost] = await turbo.getUploadCosts({ bytes: [totalBytes] });
  const { winc: balance } = await turbo.getBalance();

  const costBigInt = BigInt(uploadCost.winc);
  const balanceBigInt = BigInt(balance);

  return {
    winc: uploadCost.winc,
    balance,
    sufficient: balanceBigInt >= costBigInt,
  };
}

async function uploadPartition(
  turbo: TurboAuthenticatedClient,
  partitionPath: string,
  partition: PartitionInfo,
  config: Config,
): Promise<string> {
  const fileSize = fs.statSync(partitionPath).size;

  const tags = [
    { name: 'Content-Type', value: 'application/octet-stream' },
    { name: 'App-Name', value: config.appName },
    { name: 'CDB64-Partition', value: partition.prefix },
    { name: 'CDB64-Records', value: String(partition.recordCount) },
  ];

  if (config.name) {
    tags.push({ name: 'CDB64-Name', value: config.name });
  }

  const result = await turbo.uploadFile({
    fileStreamFactory: () => fs.createReadStream(partitionPath),
    fileSizeFactory: () => fileSize,
    dataItemOpts: { tags },
  });

  return result.id;
}

async function pollForOffsets(
  axiosInstance: AxiosInstance,
  dataItemId: string,
  verbose: boolean,
): Promise<TurboOffsetsResponse | null> {
  const startTime = Date.now();
  let delay = OFFSET_POLL_INITIAL_DELAY_MS;

  while (Date.now() - startTime < OFFSET_POLL_MAX_DURATION_MS) {
    try {
      const url = `${TURBO_ENDPOINT}/v1/tx/${dataItemId}/offsets`;
      const response = await axiosInstance.get<TurboOffsetsResponse>(url);

      if (
        response.status === 200 &&
        response.data?.rootBundleId != null &&
        response.data?.startOffsetInRootBundle != null
      ) {
        return response.data;
      }

      // Response received but offsets not ready yet
      if (verbose) {
        console.log(`  Offsets not ready for ${dataItemId}, waiting...`);
      }
    } catch (error: any) {
      if (error.response?.status === 404) {
        if (verbose) {
          console.log(`  Data item ${dataItemId} not found yet, waiting...`);
        }
      } else {
        // Other errors - log and continue polling
        if (verbose) {
          console.log(`  Error polling ${dataItemId}: ${error.message}`);
        }
      }
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, OFFSET_POLL_MAX_DELAY_MS);
  }

  return null; // Timeout
}

async function uploadManifestToTurbo(
  turbo: TurboAuthenticatedClient,
  manifest: Cdb64Manifest,
  config: Config,
): Promise<string> {
  const manifestJson = serializeManifest(manifest);
  const manifestBuffer = Buffer.from(manifestJson, 'utf-8');

  const tags = [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: config.appName },
    { name: 'CDB64-Manifest', value: 'true' },
    { name: 'CDB64-Partitions', value: String(manifest.partitions.length) },
    { name: 'CDB64-TotalRecords', value: String(manifest.totalRecords) },
  ];

  if (config.name) {
    tags.push({ name: 'CDB64-Name', value: config.name });
  }

  const result = await turbo.uploadFile({
    fileStreamFactory: () => {
      const { Readable } = require('node:stream');
      return Readable.from(manifestBuffer);
    },
    fileSizeFactory: () => manifestBuffer.length,
    dataItemOpts: { tags },
  });

  return result.id;
}

async function uploadManifestToL1(
  jwk: any,
  manifest: Cdb64Manifest,
  config: Config,
): Promise<string> {
  const arweave = Arweave.init({
    host: 'arweave.net',
    port: 443,
    protocol: 'https',
  });

  const manifestJson = serializeManifest(manifest);

  const tx = await arweave.createTransaction({ data: manifestJson }, jwk);

  tx.addTag('Content-Type', 'application/json');
  tx.addTag('App-Name', config.appName);
  tx.addTag('CDB64-Manifest', 'true');
  tx.addTag('CDB64-Partitions', String(manifest.partitions.length));
  tx.addTag('CDB64-TotalRecords', String(manifest.totalRecords));

  if (config.name) {
    tx.addTag('CDB64-Name', config.name);
  }

  await arweave.transactions.sign(tx, jwk);
  const response = await arweave.transactions.post(tx);

  if (response.status !== 200) {
    throw new Error(`Failed to post L1 transaction: ${response.status}`);
  }

  return tx.id;
}

async function runUpload(config: Config): Promise<void> {
  console.log('=== Upload Partitioned CDB64 to Arweave ===\n');
  console.log(`Input directory: ${config.inputDir}`);
  console.log(`Output manifest: ${config.outputPath}`);
  console.log(`Wallet: ${config.walletPath}`);
  if (config.name) {
    console.log(`Index name: ${config.name}`);
  }
  console.log('');

  // Load wallet
  const jwk = loadWallet(config.walletPath);
  const walletAddress = await getWalletAddress(jwk);
  console.log(`Wallet address: ${walletAddress}`);

  // Load source manifest
  const sourceManifest = loadSourceManifest(config.inputDir);
  console.log(`Source manifest: ${sourceManifest.partitions.length} partitions`);
  console.log(`Total records: ${sourceManifest.totalRecords.toLocaleString()}`);

  // Calculate total bytes
  const totalBytes = sourceManifest.partitions.reduce((sum, p) => sum + p.size, 0);
  console.log(`Total size: ${formatBytes(totalBytes)}`);
  console.log('');

  // Create Turbo client
  const signer = new ArweaveSigner(jwk);
  const turbo = TurboFactory.authenticated({ signer });

  // Create axios instance for offset polling
  const axiosInstance = axios.create({ timeout: 30000 });

  // Check for existing output manifest (resume logic)
  let outputManifest: ExtendedCdb64Manifest;
  const existingManifest = loadOutputManifest(config.outputPath);

  if (existingManifest) {
    if (!config.resume) {
      throw new Error(
        `Output manifest already exists: ${config.outputPath}\n` +
          'Use --resume to continue from previous state, or delete the file to start fresh.',
      );
    }
    console.log('Resuming from existing manifest...');
    outputManifest = existingManifest;
  } else {
    // Initialize output manifest from source
    outputManifest = {
      version: 1,
      createdAt: sourceManifest.createdAt,
      totalRecords: sourceManifest.totalRecords,
      partitions: sourceManifest.partitions.map((p) => ({
        ...p,
        location: p.location, // Keep original location initially
      })),
      metadata: {
        ...sourceManifest.metadata,
        uploadedAt: new Date().toISOString(),
        walletAddress,
        sourceManifestPath: path.join(config.inputDir, 'manifest.json'),
      },
    };
  }

  // Determine which partitions need uploading vs resolving
  const partitionsToUpload: number[] = [];
  const partitionsToResolve: number[] = [];

  for (let i = 0; i < outputManifest.partitions.length; i++) {
    const partition = outputManifest.partitions[i];
    if (partition.location.type === 'arweave-bundle-item') {
      // Already complete
      continue;
    } else if (partition.location.type === 'arweave-pending') {
      partitionsToResolve.push(i);
    } else {
      // file location - needs uploading
      partitionsToUpload.push(i);
    }
  }

  console.log(`Partitions to upload: ${partitionsToUpload.length}`);
  console.log(`Partitions to resolve: ${partitionsToResolve.length}`);
  console.log(
    `Partitions complete: ${outputManifest.partitions.length - partitionsToUpload.length - partitionsToResolve.length}`,
  );
  console.log('');

  // Cost estimation
  const bytesToUpload = partitionsToUpload.reduce(
    (sum, i) => sum + outputManifest.partitions[i].size,
    0,
  );

  if (bytesToUpload > 0) {
    console.log('=== Cost Estimate ===');
    const estimate = await estimateCost(turbo, bytesToUpload);
    console.log(`Bytes to upload: ${formatBytes(bytesToUpload)}`);
    console.log(`Estimated cost: ${formatWinc(estimate.winc)}`);
    console.log(`Wallet balance: ${formatWinc(estimate.balance)}`);

    if (!estimate.sufficient) {
      console.error('\nInsufficient balance for upload.');
      console.error(
        `Need: ${formatWinc(estimate.winc)}, Have: ${formatWinc(estimate.balance)}`,
      );
      process.exit(1);
    }
    console.log('');
  }

  if (config.dryRun) {
    console.log('Dry run complete. No uploads performed.');
    return;
  }

  // Phase 1: Upload partitions
  if (!config.resolveOnly && partitionsToUpload.length > 0) {
    console.log('=== Phase 1: Upload Partitions ===');
    const startTime = Date.now();
    let uploadedCount = 0;

    for (const idx of partitionsToUpload) {
      const partition = outputManifest.partitions[idx];
      const sourcePartition = sourceManifest.partitions[idx];

      if (sourcePartition.location.type !== 'file') {
        console.error(`  Partition ${partition.prefix}: not a file location, skipping`);
        continue;
      }

      const partitionPath = path.join(
        config.inputDir,
        sourcePartition.location.filename,
      );

      if (!fs.existsSync(partitionPath)) {
        throw new Error(`Partition file not found: ${partitionPath}`);
      }

      if (config.verbose) {
        console.log(
          `  Uploading ${partition.prefix} (${formatBytes(partition.size)})...`,
        );
      }

      try {
        const dataItemId = await uploadPartition(
          turbo,
          partitionPath,
          sourcePartition,
          config,
        );

        // Update manifest with pending location
        outputManifest.partitions[idx] = {
          ...partition,
          location: {
            type: 'arweave-pending',
            dataItemId,
          },
        };

        // Atomic save
        saveManifestAtomic(outputManifest, config.outputPath);
        partitionsToResolve.push(idx);
        uploadedCount++;

        if (config.verbose) {
          console.log(`    Data item ID: ${dataItemId}`);
        } else if (uploadedCount % 10 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          console.log(
            `  Uploaded ${uploadedCount}/${partitionsToUpload.length} partitions (${elapsed.toFixed(1)}s)`,
          );
        }
      } catch (error: any) {
        console.error(`  Failed to upload ${partition.prefix}: ${error.message}`);
        throw error;
      }
    }

    const totalElapsed = (Date.now() - startTime) / 1000;
    console.log(
      `\nPhase 1 complete: ${uploadedCount} partitions uploaded in ${totalElapsed.toFixed(1)}s`,
    );
    console.log('');
  }

  if (config.uploadOnly) {
    console.log('Upload-only mode. Skipping offset resolution phase.');
    console.log(`Output manifest: ${config.outputPath}`);
    return;
  }

  // Phase 2: Resolve offsets
  if (partitionsToResolve.length > 0) {
    console.log('=== Phase 2: Resolve Offsets ===');
    const startTime = Date.now();
    let resolvedCount = 0;
    let failedCount = 0;

    for (const idx of partitionsToResolve) {
      const partition = outputManifest.partitions[idx];

      if (partition.location.type !== 'arweave-pending') {
        continue;
      }

      const { dataItemId } = partition.location;

      if (config.verbose) {
        console.log(`  Resolving ${partition.prefix} (${dataItemId})...`);
      }

      const offsets = await pollForOffsets(axiosInstance, dataItemId, config.verbose);

      if (offsets && offsets.rootBundleId && offsets.startOffsetInRootBundle != null) {
        // Calculate payload offset: data item start + header size
        // startOffsetInRootBundle points to data item header, payloadDataStart is the header size
        const payloadOffset = offsets.startOffsetInRootBundle + offsets.payloadDataStart;

        // Update to bundle-item location
        outputManifest.partitions[idx] = {
          ...partition,
          location: {
            type: 'arweave-bundle-item',
            txId: offsets.rootBundleId,
            offset: payloadOffset,
            size: offsets.payloadContentLength,
          },
        };

        saveManifestAtomic(outputManifest, config.outputPath);
        resolvedCount++;

        if (config.verbose) {
          console.log(
            `    Resolved: txId=${offsets.rootBundleId}, offset=${payloadOffset} (dataItem=${offsets.startOffsetInRootBundle}, headerSize=${offsets.payloadDataStart})`,
          );
        } else if (resolvedCount % 10 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          console.log(
            `  Resolved ${resolvedCount}/${partitionsToResolve.length} partitions (${elapsed.toFixed(1)}s)`,
          );
        }
      } else {
        console.error(`  Failed to resolve offsets for ${partition.prefix} (timeout)`);
        failedCount++;
      }
    }

    const totalElapsed = (Date.now() - startTime) / 1000;
    console.log(
      `\nPhase 2 complete: ${resolvedCount} resolved, ${failedCount} failed in ${totalElapsed.toFixed(1)}s`,
    );
    console.log('');

    if (failedCount > 0) {
      console.log(
        'Some partitions failed to resolve. Run with --resume --resolve-only to retry.',
      );
    }
  }

  // Check if all partitions are resolved
  const pendingCount = outputManifest.partitions.filter(
    (p) => p.location.type === 'arweave-pending',
  ).length;

  if (pendingCount > 0) {
    console.log(
      `${pendingCount} partitions still pending. Cannot upload manifest until all are resolved.`,
    );
    console.log(`Output manifest: ${config.outputPath}`);
    return;
  }

  // Phase 3: Upload manifest (optional)
  if (config.uploadManifest || config.uploadManifestL1) {
    console.log('=== Phase 3: Upload Manifest ===');

    // Convert to final manifest (all locations should be arweave-bundle-item now)
    const finalManifest: Cdb64Manifest = {
      version: 1,
      createdAt: outputManifest.createdAt,
      totalRecords: outputManifest.totalRecords,
      partitions: outputManifest.partitions.map((p) => ({
        prefix: p.prefix,
        location: p.location as PartitionInfo['location'],
        recordCount: p.recordCount,
        size: p.size,
        sha256: p.sha256,
      })),
      metadata: outputManifest.metadata,
    };

    let manifestTxId: string;

    if (config.uploadManifest) {
      console.log('Uploading manifest via Turbo...');
      manifestTxId = await uploadManifestToTurbo(turbo, finalManifest, config);
    } else {
      console.log('Uploading manifest to Arweave L1...');
      manifestTxId = await uploadManifestToL1(jwk, finalManifest, config);
    }

    console.log(`Manifest transaction ID: ${manifestTxId}`);

    // Update metadata with manifest txId
    outputManifest.metadata = {
      ...outputManifest.metadata,
      manifestTxId,
    };
    saveManifestAtomic(outputManifest, config.outputPath);

    console.log('');
  }

  // Final summary
  console.log('=== Upload Complete ===');
  console.log(`Partitions: ${outputManifest.partitions.length}`);
  console.log(`Total records: ${outputManifest.totalRecords.toLocaleString()}`);
  console.log(`Output manifest: ${config.outputPath}`);

  if (outputManifest.metadata?.manifestTxId) {
    console.log(`Manifest txId: ${outputManifest.metadata.manifestTxId}`);
  }
}

async function main(): Promise<void> {
  try {
    const config = parseArgs();
    if (config === null) {
      process.exit(0);
    }

    await runUpload(config);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
