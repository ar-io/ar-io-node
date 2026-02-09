/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Sqlite from 'better-sqlite3';

import { AutoVerifyConfig } from './config.js';

const POLL_INTERVAL_MS = 5000;
const INDEXING_TIMEOUT_MS = 600000; // 10 minutes

export async function cleanGatewayState(
  config: AutoVerifyConfig,
): Promise<void> {
  console.log('Cleaning gateway state...');

  // Remove SQLite DBs
  const dbFiles = ['core.db', 'bundles.db', 'data.db', 'moderation.db'];
  for (const f of dbFiles) {
    const dbPath = path.join(config.sqliteDir, f);
    for (const suffix of ['', '-wal', '-shm']) {
      const fullPath = dbPath + suffix;
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  // Remove contiguous data cache
  const contiguousDir = path.join(process.cwd(), 'data', 'contiguous');
  if (fs.existsSync(contiguousDir)) {
    fs.rmSync(contiguousDir, { recursive: true, force: true });
  }

  // Remove LMDB data
  const lmdbDir = path.join(process.cwd(), 'data', 'lmdb');
  if (fs.existsSync(lmdbDir)) {
    fs.rmSync(lmdbDir, { recursive: true, force: true });
  }

  console.log('Gateway state cleaned.');
}

export function startGateway(startHeight: number, endHeight: number): void {
  console.log(`Starting gateway for blocks ${startHeight}-${endHeight}...`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    START_HEIGHT: String(startHeight),
    STOP_HEIGHT: String(endHeight),
    ANS104_UNBUNDLE_FILTER: '{"always":true}',
    ANS104_INDEX_FILTER: '{"always":true}',
    ADMIN_API_KEY: 'auto-verify-secret',
  };

  execSync('yarn service:start', {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });

  console.log('Gateway started.');
}

export function stopGateway(): void {
  console.log('Stopping gateway...');
  try {
    execSync('yarn service:stop', {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } catch {
    // Ignore errors if service wasn't running
  }
  console.log('Gateway stopped.');
}

export async function waitForIndexingComplete(
  config: AutoVerifyConfig,
  stopHeight: number,
): Promise<void> {
  console.log(
    `Waiting for indexing to complete (target height: ${stopHeight})...`,
  );

  const startTime = Date.now();

  // Wait for the core DB to exist
  while (!fs.existsSync(config.coreDbPath)) {
    if (Date.now() - startTime > INDEXING_TIMEOUT_MS) {
      throw new Error('Timeout waiting for core database to be created');
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Wait for blocks to be indexed
  while (true) {
    if (Date.now() - startTime > INDEXING_TIMEOUT_MS) {
      throw new Error(
        `Timeout waiting for blocks to reach height ${stopHeight}`,
      );
    }

    try {
      const coreDb = new Sqlite(config.coreDbPath, { readonly: true });
      try {
        const row = coreDb
          .prepare('SELECT MAX(height) as max_height FROM stable_blocks')
          .get() as any;
        const maxHeight = row?.max_height;

        if (maxHeight != null && maxHeight >= stopHeight) {
          console.log(`Blocks indexed to height ${maxHeight}.`);
          break;
        }
        console.log(
          `  Blocks at height ${maxHeight ?? 'N/A'}, waiting for ${stopHeight}...`,
        );
      } finally {
        coreDb.close();
      }
    } catch {
      // DB might not be ready yet
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Wait for bundles to be fully indexed
  if (!fs.existsSync(config.bundlesDbPath)) {
    console.log('No bundles database found, skipping bundle indexing wait.');
    return;
  }

  console.log('Waiting for all bundles to be fully indexed...');
  while (true) {
    if (Date.now() - startTime > INDEXING_TIMEOUT_MS) {
      throw new Error('Timeout waiting for bundles to be fully indexed');
    }

    try {
      const bundlesDb = new Sqlite(config.bundlesDbPath, { readonly: true });
      try {
        const row = bundlesDb
          .prepare(
            `
            SELECT COUNT(*) as pending
            FROM bundles
            WHERE last_fully_indexed_at IS NULL
              AND last_queued_at IS NOT NULL
            `,
          )
          .get() as any;

        if (row.pending === 0) {
          console.log('All bundles fully indexed.');
          break;
        }
        console.log(`  ${row.pending} bundles still pending...`);
      } finally {
        bundlesDb.close();
      }
    } catch {
      // DB might not be ready yet
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

export async function exportParquet(
  config: AutoVerifyConfig,
  startHeight: number,
  endHeight: number,
): Promise<string> {
  const stagingDir = path.join(config.resultsDir, 'parquet-staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  console.log(
    `Exporting Parquet data for blocks ${startHeight}-${endHeight}...`,
  );

  execSync(
    [
      'scripts/parquet-export',
      `--start-height ${startHeight}`,
      `--end-height ${endHeight}`,
      `--staging-job-dir ${stagingDir}`,
      '--skip-dataset-move',
    ].join(' '),
    {
      cwd: process.cwd(),
      stdio: 'inherit',
    },
  );

  console.log('Parquet export complete.');
  return stagingDir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
