/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool to download partitioned CDB64 partition files from remote sources.
 *
 * This tool reads a CDB64 manifest (from HTTP, Arweave, or local file) and
 * downloads all partition .cdb files to a local directory, producing an updated
 * manifest with file locations.
 *
 * Usage:
 *   ./tools/download-cdb64 --source <spec> --output ./index
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';

import {
  Cdb64Manifest,
  PartitionInfo,
  PartitionLocation,
  parseManifest,
  serializeManifest,
} from '../../src/lib/cdb64-manifest.js';

// Parsed manifest source types
type ManifestSource =
  | { type: 'http'; url: string }
  | { type: 'arweave-tx'; id: string }
  | { type: 'arweave-byte-range'; id: string; offset: number; size: number }
  | { type: 'file'; path: string };

interface Config {
  source: string;
  outputDir: string;
  gatewayUrl: string;
  concurrency: number;
  retries: number;
  resume: boolean;
  verify: boolean;
  verbose: boolean;
}

const DEFAULT_GATEWAY_URL = 'https://arweave.net';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRIES = 5;

function printUsage(): void {
  console.log(`
Download Partitioned CDB64

This tool downloads partitioned CDB64 partition files (.cdb) from remote
sources (HTTP, Arweave TX, Arweave byte-range) and generates a local manifest
with file location types.

Usage: ./tools/download-cdb64 [options]

Options:
  --source, -s <spec>      Manifest source specification (required)
  --output, -o <path>      Output directory (required)
  --gateway-url, -g <url>  Gateway URL for Arweave downloads (default: ${DEFAULT_GATEWAY_URL})
  --concurrency, -c <n>    Parallel downloads (default: ${DEFAULT_CONCURRENCY})
  --retries, -r <n>        Retry failed downloads per partition (default: ${DEFAULT_RETRIES})
  --resume                 Resume partial download (skip completed partitions, resume partial .tmp files)
  --verify                 Verify SHA-256 hashes after download (if present in manifest)
  --verbose                Show per-partition progress
  --help, -h               Show this help message

Source Formats:
  HTTP manifest URL:       https://cdn.example.com/index/manifest.json
  Arweave TX ID:           ABC123...90vw:manifest
  Arweave byte-range:      TxId:offset:size:manifest
  Local manifest file:     ./remote-manifest.json

Examples:
  # Download from HTTP manifest
  ./tools/download-cdb64 -s https://cdn.example.com/index/manifest.json -o ./index

  # Download from Arweave TX manifest
  ./tools/download-cdb64 -s "ABC123def456ghi789jkl012mno345pqr678stu90vw:manifest" -o ./index

  # Resume interrupted download
  ./tools/download-cdb64 -s ./remote-manifest.json -o ./index --resume

  # Download with verification
  ./tools/download-cdb64 -s ./remote-manifest.json -o ./index --verify --verbose
`);
}

function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  let source: string | undefined;
  let outputDir: string | undefined;
  let gatewayUrl = DEFAULT_GATEWAY_URL;
  let concurrency = DEFAULT_CONCURRENCY;
  let retries = DEFAULT_RETRIES;
  let resume = false;
  let verify = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--source':
      case '-s':
        if (!nextArg) throw new Error('--source requires a value');
        source = nextArg;
        i++;
        break;
      case '--output':
      case '-o':
        if (!nextArg) throw new Error('--output requires a path');
        outputDir = path.resolve(nextArg);
        i++;
        break;
      case '--gateway-url':
      case '-g':
        if (!nextArg) throw new Error('--gateway-url requires a URL');
        gatewayUrl = nextArg.replace(/\/+$/, ''); // strip trailing slashes
        i++;
        break;
      case '--concurrency':
      case '-c':
        if (!nextArg) throw new Error('--concurrency requires a number');
        concurrency = parseInt(nextArg, 10);
        if (isNaN(concurrency) || concurrency < 1) {
          throw new Error('--concurrency must be a positive integer');
        }
        i++;
        break;
      case '--retries':
      case '-r':
        if (!nextArg) throw new Error('--retries requires a number');
        retries = parseInt(nextArg, 10);
        if (isNaN(retries) || retries < 0) {
          throw new Error('--retries must be a non-negative integer');
        }
        i++;
        break;
      case '--resume':
        resume = true;
        break;
      case '--verify':
        verify = true;
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

  if (!source) {
    throw new Error('--source is required');
  }
  if (!outputDir) {
    throw new Error('--output is required');
  }

  return {
    source,
    outputDir,
    gatewayUrl,
    concurrency,
    retries,
    resume,
    verify,
    verbose,
  };
}

/**
 * Parse the manifest source specification string into a typed union.
 */
function parseManifestSource(spec: string): ManifestSource {
  // HTTP URL
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    try {
      new URL(spec);
      return { type: 'http', url: spec };
    } catch {
      throw new Error(`Invalid HTTP URL: ${spec}`);
    }
  }

  const colonParts = spec.split(':');

  // rootTxId:offset:size:manifest format (byte-range manifest)
  if (colonParts.length === 4 && colonParts[3] === 'manifest') {
    const [id, offsetStr, sizeStr] = colonParts;
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeStr, 10);
      if (
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(size) &&
        offset >= 0 &&
        size > 0
      ) {
        return { type: 'arweave-byte-range', id, offset, size };
      }
    }
  }

  // txId:manifest format (Arweave TX manifest)
  if (colonParts.length === 2 && colonParts[1] === 'manifest') {
    const id = colonParts[0];
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      return { type: 'arweave-tx', id };
    }
  }

  // Default to local file path
  return { type: 'file', path: path.resolve(spec) };
}

/**
 * Fetch the manifest JSON from the given source.
 * For HTTP sources with file locations, transforms them to HTTP URLs
 * relative to the manifest's base URL.
 */
async function fetchManifest(
  source: ManifestSource,
  gatewayUrl: string,
): Promise<Cdb64Manifest> {
  let manifestJson: string;
  let httpBaseUrl: string | undefined;

  switch (source.type) {
    case 'http': {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch manifest from ${source.url}: ${response.status} ${response.statusText}`,
        );
      }
      manifestJson = await response.text();
      // Derive base URL for relative file locations
      httpBaseUrl = source.url.substring(
        0,
        source.url.lastIndexOf('/') + 1,
      );
      break;
    }
    case 'arweave-tx': {
      const url = `${gatewayUrl}/raw/${source.id}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch manifest from Arweave TX ${source.id}: ${response.status}`,
        );
      }
      manifestJson = await response.text();
      break;
    }
    case 'arweave-byte-range': {
      const url = `${gatewayUrl}/raw/${source.id}`;
      const rangeEnd = source.offset + source.size - 1;
      const response = await fetch(url, {
        headers: { Range: `bytes=${source.offset}-${rangeEnd}` },
      });
      if (!response.ok && response.status !== 206) {
        throw new Error(
          `Failed to fetch manifest from Arweave byte-range: ${response.status}`,
        );
      }
      manifestJson = await response.text();
      break;
    }
    case 'file': {
      if (!fs.existsSync(source.path)) {
        throw new Error(`Manifest file not found: ${source.path}`);
      }
      manifestJson = fs.readFileSync(source.path, 'utf-8');
      break;
    }
  }

  const manifest = parseManifest(manifestJson);

  // Transform file locations to HTTP URLs if we have a base URL
  if (httpBaseUrl) {
    return transformFileLocationsToHttp(manifest, httpBaseUrl);
  }

  return manifest;
}

/**
 * Transforms file locations in a manifest to HTTP locations using a base URL.
 */
function transformFileLocationsToHttp(
  manifest: Cdb64Manifest,
  baseUrl: string,
): Cdb64Manifest {
  return {
    ...manifest,
    partitions: manifest.partitions.map((p) => {
      if (p.location.type === 'file') {
        return {
          ...p,
          location: {
            type: 'http' as const,
            url: new URL(p.location.filename, baseUrl).toString(),
          },
        };
      }
      return p;
    }),
  };
}

/**
 * Resolve a partition location to a download URL.
 * Returns null for file locations (already local).
 */
function resolvePartitionUrl(
  location: PartitionLocation,
  gatewayUrl: string,
): string | null {
  switch (location.type) {
    case 'http':
      return location.url;
    case 'arweave-id':
      return `${gatewayUrl}/raw/${location.id}`;
    case 'arweave-byte-range':
      // Prefer dataItemId for direct fetch if available
      if (location.dataItemId) {
        return `${gatewayUrl}/raw/${location.dataItemId}`;
      }
      // Fallback to byte-range from root TX (handled separately in download)
      return `${gatewayUrl}/raw/${location.rootTxId}`;
    case 'file':
      return null;
  }
}

/**
 * Check if a partition has already been downloaded with the correct size.
 */
function isPartitionDownloaded(
  partition: PartitionInfo,
  outputDir: string,
): boolean {
  const destPath = path.join(outputDir, `${partition.prefix}.cdb`);
  if (!fs.existsSync(destPath)) {
    return false;
  }
  const stat = fs.statSync(destPath);
  return stat.size === partition.size;
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Download a single partition file with optional SHA-256 verification.
 * Uses atomic write (write to .tmp, rename on success).
 * Supports resuming from partial .tmp files via HTTP Range requests.
 */
async function downloadPartition(
  url: string,
  destPath: string,
  location: PartitionLocation,
  expectedSize: number,
  expectedSha256: string | undefined,
  verify: boolean,
): Promise<void> {
  const tmpPath = `${destPath}.tmp`;

  // Detect existing partial .tmp file for resume
  let existingSize = 0;
  if (fs.existsSync(tmpPath)) {
    const tmpStat = fs.statSync(tmpPath);
    if (tmpStat.size >= expectedSize) {
      // Corrupt or stale — delete and start fresh
      safeUnlink(tmpPath);
    } else {
      existingSize = tmpStat.size;
    }
  }

  // Build fetch options with Range header
  const fetchOptions: RequestInit = {};
  if (
    location.type === 'arweave-byte-range' &&
    !location.dataItemId
  ) {
    // Byte-range from root TX: compose partition offset + resume offset
    const rangeStart = location.dataOffsetInRootTx + existingSize;
    const rangeEnd = location.dataOffsetInRootTx + expectedSize - 1;
    fetchOptions.headers = {
      Range: `bytes=${rangeStart}-${rangeEnd}`,
    };
  } else if (existingSize > 0) {
    // Standard Range request for resume
    fetchOptions.headers = {
      Range: `bytes=${existingSize}-`,
    };
  }

  const response = await fetch(url, fetchOptions);

  // Handle Range request responses
  if (response.status === 416) {
    // Range Not Satisfiable — partial file is invalid
    safeUnlink(tmpPath);
    throw new Error('416 Range Not Satisfiable (invalid partial file)');
  }

  let resuming = false;
  if (response.status === 206) {
    resuming = true;
  } else if (response.status >= 200 && response.status < 300) {
    if (existingSize > 0) {
      // Server ignored Range header — restart from scratch
      existingSize = 0;
    }
  } else {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Response body is null');
  }

  const hash = verify && expectedSha256 ? crypto.createHash('sha256') : null;

  // Hash existing data on resume for verification
  if (resuming && existingSize > 0 && hash) {
    const hashWritable = new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    });
    await pipeline(
      fs.createReadStream(tmpPath, { end: existingSize - 1 }),
      hashWritable,
    );
  }

  // Open write stream in appropriate mode
  const writeStream = resuming
    ? fs.createWriteStream(tmpPath, { flags: 'a' })
    : fs.createWriteStream(tmpPath);

  let bytesWritten = existingSize;

  // Stream the response body to file
  const reader = response.body.getReader();
  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        bytesWritten += value.length;
        if (hash) {
          hash.update(value);
        }
        this.push(value);
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });

  await pipeline(nodeStream, writeStream);

  // Verify size
  if (bytesWritten > expectedSize) {
    safeUnlink(tmpPath);
    throw new Error(
      `Size overflow: expected ${expectedSize} bytes, got ${bytesWritten}`,
    );
  }
  if (bytesWritten !== expectedSize) {
    // Partial download — keep .tmp for resume on next retry
    throw new Error(
      `Incomplete download: expected ${expectedSize} bytes, got ${bytesWritten}`,
    );
  }

  // Verify SHA-256 if requested
  if (verify && expectedSha256 && hash) {
    const actualHash = hash.digest('hex');
    if (actualHash !== expectedSha256) {
      safeUnlink(tmpPath);
      throw new Error(
        `SHA-256 mismatch: expected ${expectedSha256}, got ${actualHash}`,
      );
    }
  }

  // Atomic rename
  fs.renameSync(tmpPath, destPath);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array(Math.min(concurrency, queue.length))
    .fill(null)
    .map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          await fn(item);
        }
      }
    });
  await Promise.all(workers);
}

function saveManifestAtomic(manifest: Cdb64Manifest, outputPath: string): void {
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, serializeManifest(manifest));
  fs.renameSync(tmpPath, outputPath);
}

async function runDownload(config: Config): Promise<void> {
  console.log('=== Download Partitioned CDB64 ===\n');
  console.log(`Source: ${config.source}`);
  console.log(`Output: ${config.outputDir}`);
  console.log(`Gateway: ${config.gatewayUrl}`);
  console.log(`Concurrency: ${config.concurrency}`);
  console.log(`Retries: ${config.retries}`);
  if (config.resume) console.log('Resume: enabled');
  if (config.verify) console.log('Verify: enabled');
  console.log('');

  // Create output directory
  fs.mkdirSync(config.outputDir, { recursive: true });

  // Parse source and fetch manifest
  const source = parseManifestSource(config.source);
  console.log(`Source type: ${source.type}`);

  console.log('Fetching manifest...');
  const sourceManifest = await fetchManifest(source, config.gatewayUrl);
  console.log(`Partitions: ${sourceManifest.partitions.length}`);
  console.log(`Total records: ${sourceManifest.totalRecords.toLocaleString()}`);
  const totalBytes = sourceManifest.partitions.reduce(
    (sum, p) => sum + p.size,
    0,
  );
  console.log(`Total size: ${formatBytes(totalBytes)}`);
  console.log('');

  // Initialize output manifest (load existing if resuming)
  const outputManifestPath = path.join(config.outputDir, 'manifest.json');
  let outputManifest: Cdb64Manifest;

  if (config.resume && fs.existsSync(outputManifestPath)) {
    const existingJson = fs.readFileSync(outputManifestPath, 'utf-8');
    outputManifest = parseManifest(existingJson);
    if (outputManifest.partitions.length !== sourceManifest.partitions.length) {
      throw new Error(
        `Partition count mismatch: existing manifest has ${outputManifest.partitions.length} ` +
          `but source has ${sourceManifest.partitions.length}. ` +
          'Delete output directory and restart if source changed.',
      );
    }
    console.log('Resuming from existing manifest...');
  } else {
    outputManifest = {
      version: 1,
      createdAt: sourceManifest.createdAt,
      totalRecords: sourceManifest.totalRecords,
      partitions: sourceManifest.partitions.map((p) => ({ ...p })),
      metadata: {
        ...sourceManifest.metadata,
        downloadedAt: new Date().toISOString(),
      },
    };
  }

  // Categorize partitions
  const toDownload: number[] = [];
  let alreadyLocal = 0;
  let alreadyDownloaded = 0;

  for (let i = 0; i < sourceManifest.partitions.length; i++) {
    const partition = sourceManifest.partitions[i];

    // Check if already downloaded (resume mode)
    if (config.resume && isPartitionDownloaded(partition, config.outputDir)) {
      alreadyDownloaded++;
      // Ensure output manifest reflects file location
      outputManifest.partitions[i] = {
        ...partition,
        location: { type: 'file', filename: `${partition.prefix}.cdb` },
      };
      continue;
    }

    // Check if source is already a local file
    if (partition.location.type === 'file') {
      alreadyLocal++;
      continue;
    }

    toDownload.push(i);
  }

  console.log(`Partitions to download: ${toDownload.length}`);
  if (alreadyDownloaded > 0)
    console.log(`Already downloaded (resume): ${alreadyDownloaded}`);
  if (alreadyLocal > 0) console.log(`Already local: ${alreadyLocal}`);
  console.log('');

  if (toDownload.length === 0) {
    console.log('All partitions are already available locally.');
    saveManifestAtomic(outputManifest, outputManifestPath);
    console.log(`Manifest saved: ${outputManifestPath}`);
    return;
  }

  // Download partitions
  const startTime = Date.now();
  let downloadedCount = 0;
  let failedCount = 0;
  let downloadedBytes = 0;

  if (config.concurrency > 1) {
    console.log(`Downloading with concurrency: ${config.concurrency}`);
  }
  console.log('');

  await runWithConcurrency(toDownload, config.concurrency, async (idx) => {
    const partition = sourceManifest.partitions[idx];
    const destPath = path.join(config.outputDir, `${partition.prefix}.cdb`);
    const url = resolvePartitionUrl(partition.location, config.gatewayUrl);

    if (url === null) {
      // Should not happen since we filtered file locations
      return;
    }

    if (config.verbose) {
      console.log(
        `  Downloading ${partition.prefix}.cdb (${formatBytes(partition.size)})...`,
      );
    }

    let succeeded = false;
    for (let attempt = 1; attempt <= config.retries + 1; attempt++) {
      try {
        // Log resume info if partial .tmp exists
        if (config.verbose) {
          const tmpPath = `${destPath}.tmp`;
          if (fs.existsSync(tmpPath)) {
            const tmpStat = fs.statSync(tmpPath);
            if (tmpStat.size > 0 && tmpStat.size < partition.size) {
              console.log(
                `  Resuming ${partition.prefix}.cdb from ${formatBytes(tmpStat.size)} / ${formatBytes(partition.size)}...`,
              );
            }
          }
        }

        await downloadPartition(
          url,
          destPath,
          partition.location,
          partition.size,
          partition.sha256,
          config.verify,
        );
        succeeded = true;
        break;
      } catch (error: any) {
        if (attempt <= config.retries) {
          console.warn(
            `  Retry ${attempt}/${config.retries} for ${partition.prefix}.cdb - ${error.message}`,
          );
        } else {
          console.error(
            `  Failed: ${partition.prefix}.cdb - ${error.message}`,
          );
        }
      }
    }

    if (succeeded) {
      // Update manifest to file location
      outputManifest.partitions[idx] = {
        ...partition,
        location: { type: 'file', filename: `${partition.prefix}.cdb` },
      };

      // Atomic save for resumability
      saveManifestAtomic(outputManifest, outputManifestPath);

      downloadedCount++;
      downloadedBytes += partition.size;

      if (config.verbose) {
        console.log(`    Done: ${partition.prefix}.cdb`);
      } else if (downloadedCount % 10 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(
          `  Downloaded ${downloadedCount}/${toDownload.length} partitions ` +
            `(${formatBytes(downloadedBytes)}, ${elapsed.toFixed(1)}s)`,
        );
      }
    } else {
      failedCount++;
    }
  });

  const totalElapsed = (Date.now() - startTime) / 1000;
  console.log('');
  console.log('=== Download Complete ===');
  console.log(`Downloaded: ${downloadedCount} partitions`);
  console.log(`Total downloaded: ${formatBytes(downloadedBytes)}`);
  console.log(`Time: ${totalElapsed.toFixed(1)}s`);
  if (failedCount > 0) {
    console.log(`Failed: ${failedCount} partitions`);
  }
  console.log(`Manifest: ${outputManifestPath}`);

  if (failedCount > 0) {
    console.error(
      `\n${failedCount} partition(s) failed. Re-run with --resume to retry.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    const config = parseArgs();
    if (config === null) {
      process.exit(0);
    }

    await runDownload(config);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
