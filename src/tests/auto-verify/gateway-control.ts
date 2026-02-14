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
const BUNDLE_INDEXING_TIMEOUT_MS = 300000; // 5 minutes

export async function cleanGatewayState(
  config: AutoVerifyConfig,
): Promise<void> {
  console.log(
    `Cleaning gateway state (preserve cache: ${config.preserveCache})...`,
  );

  // Always remove indexing DBs — these need fresh state per iteration
  const indexingDbs = ['core.db', 'bundles.db', 'moderation.db'];
  // Only remove data.db when not preserving cache
  const dbFiles = config.preserveCache
    ? indexingDbs
    : [...indexingDbs, 'data.db'];

  for (const f of dbFiles) {
    const dbPath = path.join(config.sqliteDir, f);
    for (const suffix of ['', '-wal', '-shm']) {
      const fullPath = dbPath + suffix;
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  if (!config.preserveCache) {
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
  }

  console.log('Gateway state cleaned.');
}

export function runMigrations(config: AutoVerifyConfig): void {
  console.log('Running database migrations...');

  // When preserving cache, data.db survives but core.db (which tracks migration
  // history) is deleted. Pre-populate the migrations table with data.db
  // migration names so Umzug skips them — several use ALTER TABLE which fails
  // if re-run against an existing schema.
  const dataDbPath = path.join(config.sqliteDir, 'data.db');
  if (config.preserveCache && fs.existsSync(dataDbPath)) {
    const migrationsDir = path.join(process.cwd(), 'migrations');
    const dataFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => /\.\bdata\b\./.test(f) && f.endsWith('.sql'));

    if (dataFiles.length > 0) {
      fs.mkdirSync(config.sqliteDir, { recursive: true });
      const coreDb = new Sqlite(config.coreDbPath);
      try {
        coreDb.exec(`
          CREATE TABLE IF NOT EXISTS migrations (
            name TEXT PRIMARY KEY,
            executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        const insert = coreDb.prepare(
          'INSERT OR IGNORE INTO migrations (name) VALUES (?)',
        );
        for (const f of dataFiles) {
          insert.run(f);
        }
        console.log(
          `Pre-registered ${dataFiles.length} data.db migrations (preserve cache).`,
        );
      } finally {
        coreDb.close();
      }
    }
  }

  execSync('yarn db:migrate up', {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  console.log('Migrations complete.');
}

export function startGateway(
  config: AutoVerifyConfig,
  startHeight: number,
  endHeight: number,
): void {
  console.log(`Starting gateway for blocks ${startHeight}-${endHeight}...`);

  runMigrations(config);

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
          .prepare(
            `SELECT MAX(height) as max_height FROM (
              SELECT height FROM stable_blocks
              UNION ALL
              SELECT height FROM new_blocks
            )`,
          )
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
  const bundleWaitStart = Date.now();
  while (true) {
    if (Date.now() - bundleWaitStart > BUNDLE_INDEXING_TIMEOUT_MS) {
      console.log(
        'Bundle indexing timed out — proceeding with partially indexed bundles.',
      );
      break;
    }

    try {
      const bundlesDb = new Sqlite(config.bundlesDbPath, { readonly: true });
      try {
        const row = bundlesDb
          .prepare(
            `
            SELECT
              COUNT(*) as total_queued,
              SUM(CASE WHEN matched_data_item_count IS NULL THEN 1 ELSE 0 END) as awaiting_unbundle,
              IFNULL(SUM(matched_data_item_count), 0) as expected_data_items,
              IFNULL(SUM(
                (SELECT COUNT(*) FROM bundle_data_items bdi
                 WHERE bdi.parent_id = b.id
                   AND bdi.filter_id = b.index_filter_id)
              ), 0) as indexed_data_items
            FROM bundles b
            WHERE last_queued_at IS NOT NULL
            `,
          )
          .get() as any;

        const done =
          row.total_queued > 0 &&
          row.awaiting_unbundle === 0 &&
          row.indexed_data_items >= row.expected_data_items;

        if (done) {
          console.log(
            `All bundles fully indexed (${row.indexed_data_items} data items across ${row.total_queued} bundles).`,
          );
          break;
        }
        console.log(
          `  ${row.total_queued} bundles queued, ${row.awaiting_unbundle} awaiting unbundle, ${row.indexed_data_items}/${row.expected_data_items} data items indexed...`,
        );
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
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
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

/**
 * Flush all new_* data to stable_* tables. This must be run after the gateway
 * is stopped so there's no contention. The core flush must happen before the
 * bundles flush because the bundles flush joins against
 * core.stable_block_transactions.
 */
export function flushToStable(config: AutoVerifyConfig, endHeight: number): void {
  console.log(`Flushing new data to stable tables (end_height=${endHeight + 1})...`);

  const coreDb = new Sqlite(config.coreDbPath);
  try {
    coreDb.exec('BEGIN');

    coreDb.prepare(`
      INSERT INTO stable_blocks (
        height, indep_hash, previous_block, nonce, hash,
        block_timestamp, diff, cumulative_diff, last_retarget,
        reward_addr, reward_pool, block_size, weave_size,
        usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
        scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
        hash_list_merkle, wallet_list, tx_root,
        tx_count, missing_tx_count
      ) SELECT
        nb.height, nb.indep_hash, nb.previous_block, nb.nonce, nb.hash,
        nb.block_timestamp, nb.diff, nb.cumulative_diff, nb.last_retarget,
        nb.reward_addr, nb.reward_pool, nb.block_size, nb.weave_size,
        nb.usd_to_ar_rate_dividend, nb.usd_to_ar_rate_divisor,
        nb.scheduled_usd_to_ar_rate_dividend, nb.scheduled_usd_to_ar_rate_divisor,
        nb.hash_list_merkle, nb.wallet_list, nb.tx_root,
        nb.tx_count, nb.missing_tx_count
      FROM new_blocks nb
      WHERE nb.height < @end_height
      ON CONFLICT DO NOTHING
    `).run({ end_height: endHeight + 1 });

    coreDb.prepare(`
      INSERT INTO stable_block_transactions (
        block_indep_hash, transaction_id, block_transaction_index
      ) SELECT
        nbt.block_indep_hash, nbt.transaction_id, nbt.block_transaction_index
      FROM new_block_transactions nbt
      WHERE nbt.height < @end_height
      ON CONFLICT DO NOTHING
    `).run({ end_height: endHeight + 1 });

    coreDb.prepare(`
      INSERT INTO stable_transactions (
        id, height, block_transaction_index, signature,
        format, last_tx, owner_address, target, quantity,
        reward, data_size, data_root, content_type, tag_count,
        content_encoding, indexed_at
      ) SELECT
        nt.id, nbt.height, nbt.block_transaction_index, nt.signature,
        nt.format, nt.last_tx, nt.owner_address, nt.target, nt.quantity,
        nt.reward, nt.data_size, nt.data_root, nt.content_type, nt.tag_count,
        nt.content_encoding, nt.indexed_at
      FROM new_transactions nt
      JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
      WHERE nbt.height < @end_height
      ON CONFLICT DO NOTHING
    `).run({ end_height: endHeight + 1 });

    coreDb.prepare(`
      INSERT INTO stable_transaction_tags (
        tag_name_hash, tag_value_hash, height,
        block_transaction_index, transaction_tag_index,
        transaction_id
      ) SELECT
        ntt.tag_name_hash, ntt.tag_value_hash, nbt.height,
        nbt.block_transaction_index, ntt.transaction_tag_index,
        ntt.transaction_id
      FROM new_transaction_tags ntt
      JOIN new_block_transactions nbt ON nbt.transaction_id = ntt.transaction_id
      WHERE nbt.height < @end_height
      ON CONFLICT DO NOTHING
    `).run({ end_height: endHeight + 1 });

    coreDb.exec('COMMIT');
  } catch (err) {
    coreDb.exec('ROLLBACK');
    throw err;
  } finally {
    coreDb.close();
  }

  console.log('Core flush complete. Flushing bundles...');

  const bundlesDb = new Sqlite(config.bundlesDbPath);
  try {
    bundlesDb.exec(`ATTACH DATABASE '${config.coreDbPath}' AS core`);
    bundlesDb.exec('BEGIN');

    bundlesDb.prepare(`
      INSERT INTO stable_data_items (
        id, parent_id, root_transaction_id,
        height, block_transaction_index,
        signature, anchor, owner_address, target,
        data_offset, data_size, content_type,
        tag_count, indexed_at, signature_type,
        offset, size, owner_offset, owner_size,
        signature_offset, signature_size, content_encoding,
        root_parent_offset
      ) SELECT
        ndi.id, ndi.parent_id, ndi.root_transaction_id,
        ndi.height, sbt.block_transaction_index,
        ndi.signature, ndi.anchor, ndi.owner_address, ndi.target,
        ndi.data_offset, ndi.data_size, ndi.content_type,
        ndi.tag_count, ndi.indexed_at, ndi.signature_type,
        ndi.offset, ndi.size, ndi.owner_offset, ndi.owner_size,
        ndi.signature_offset, ndi.signature_size, ndi.content_encoding,
        ndi.root_parent_offset
      FROM new_data_items ndi
      JOIN core.stable_block_transactions sbt
        ON ndi.root_transaction_id = sbt.transaction_id
      WHERE ndi.height < @end_height
      ON CONFLICT DO NOTHING
    `).run({ end_height: endHeight + 1 });

    bundlesDb.prepare(`
      INSERT INTO stable_data_item_tags (
        tag_name_hash, tag_value_hash,
        height, block_transaction_index,
        data_item_tag_index, data_item_id,
        parent_id, root_transaction_id
      ) SELECT
        ndit.tag_name_hash, ndit.tag_value_hash,
        ndit.height, sbt.block_transaction_index,
        ndit.data_item_tag_index, ndit.data_item_id,
        ndi.parent_id, ndit.root_transaction_id
      FROM new_data_item_tags ndit
      JOIN new_data_items ndi
        ON ndit.data_item_id = ndi.id
      JOIN core.stable_block_transactions sbt
        ON ndit.root_transaction_id = sbt.transaction_id
      WHERE ndit.height < @end_height
      ON CONFLICT DO NOTHING
    `).run({ end_height: endHeight + 1 });

    // Mark bundles as fully indexed where all matched data items are present
    bundlesDb.prepare(`
      UPDATE bundles
      SET
        first_fully_indexed_at = IFNULL(first_fully_indexed_at, @fully_indexed_at),
        last_fully_indexed_at = @fully_indexed_at
      WHERE matched_data_item_count IS NOT NULL
        AND matched_data_item_count > 0
        AND (
          SELECT COUNT(*)
          FROM bundle_data_items bdi
          WHERE bdi.parent_id = bundles.id
            AND bdi.filter_id = bundles.index_filter_id
        ) = bundles.matched_data_item_count
        AND last_fully_indexed_at IS NULL
    `).run({ fully_indexed_at: Math.floor(Date.now() / 1000) });

    bundlesDb.exec('COMMIT');
  } catch (err) {
    bundlesDb.exec('ROLLBACK');
    throw err;
  } finally {
    bundlesDb.close();
  }

  console.log('Flush to stable complete.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
