/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Connection, Database } from 'duckdb-async';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';
import Sqlite from 'better-sqlite3';
import * as winston from 'winston';

type EventName = 'export-complete' | 'export-error' | 'start' | 'timing-log';

const EXPORT_COMPLETE: EventName = 'export-complete';
const EXPORT_ERROR: EventName = 'export-error';
const START: EventName = 'start';
const TIMING_LOG: EventName = 'timing-log';

type Message = {
  eventName: EventName;
  error?: string;
  stack?: string;
  timingKey?: string;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
};

type ExportStatus = 'not_started' | 'running' | 'completed' | 'errored';

const NOT_STARTED: ExportStatus = 'not_started';
const RUNNING: ExportStatus = 'running';
const COMPLETED: ExportStatus = 'completed';
const ERRORED: ExportStatus = 'errored';

type ExportData = {
  status: ExportStatus;
  outputDir?: string;
  startHeight?: number;
  endHeight?: number;
  maxFileRows?: number;
  heightPartitionSize?: number;
  skipL1Transactions?: boolean;
  skipL1Tags?: boolean;
  durationInSeconds?: number;
  endTime?: string;
  endTimestamp?: number;
  error?: string;
};

export class ParquetExporter {
  private log: winston.Logger;
  private worker: Worker | null = null;
  private bundlesDbPath: string;
  private coreDbPath: string;
  private exportStatus: ExportData = {
    status: NOT_STARTED,
  };

  constructor({
    log,
    bundlesDbPath,
    coreDbPath,
  }: {
    log: winston.Logger;
    bundlesDbPath: string;
    coreDbPath: string;
  }) {
    this.log = log.child({ class: 'ParquetExporter' });
    this.bundlesDbPath = bundlesDbPath;
    this.coreDbPath = coreDbPath;
  }

  async export({
    outputDir,
    startHeight,
    endHeight,
    maxFileRows,
    heightPartitionSize = 1000,
    skipL1Transactions = true,
    skipL1Tags = true,
  }: {
    outputDir: string;
    startHeight: number;
    endHeight: number;
    maxFileRows?: number;
    heightPartitionSize?: number;
    skipL1Transactions?: boolean;
    skipL1Tags?: boolean;
  }): Promise<void> {
    if (this.exportStatus.status === RUNNING) {
      const error = new Error('An export is already in progress');
      this.log.error(error.message);
      throw error;
    }

    this.exportStatus.status = RUNNING;

    return new Promise((resolve, reject) => {
      const workerUrl = new URL('./parquet-exporter.js', import.meta.url);
      this.worker = new Worker(workerUrl, {
        workerData: {
          outputDir,
          startHeight,
          endHeight,
          maxFileRows,
          heightPartitionSize,
          skipL1Transactions,
          skipL1Tags,
          bundlesDbPath: this.bundlesDbPath,
          coreDbPath: this.coreDbPath,
        },
      });

      let startTime: number;

      this.worker.on('online', () => {
        startTime = Date.now();

        this.log.info('Started Parquet export', {
          outputDir,
          startHeight,
          endHeight,
          maxFileRows,
          heightPartitionSize,
          skipL1Transactions,
          skipL1Tags,
        });

        this.worker?.postMessage({ eventName: START });
      });

      this.worker.on('message', (message: Message) => {
        if (message.eventName === EXPORT_COMPLETE) {
          const endTime = new Date();
          const durationInSeconds = (endTime.getTime() - startTime) / 1000;

          this.log.info('Parquet export completed', {
            outputDir,
            startHeight,
            endHeight,
            maxFileRows,
            heightPartitionSize,
            skipL1Transactions,
            skipL1Tags,
            durationInSeconds,
          });

          this.exportStatus = {
            status: COMPLETED,
            outputDir,
            startHeight,
            endHeight,
            maxFileRows,
            heightPartitionSize,
            skipL1Transactions,
            skipL1Tags,
            endTime: endTime.toISOString(),
            endTimestamp: endTime.getTime(),
            durationInSeconds,
          };

          resolve();
        } else if (message.eventName === EXPORT_ERROR) {
          const endTime = new Date();
          const durationInSeconds = (endTime.getTime() - startTime) / 1000;

          this.exportStatus = {
            status: ERRORED,
            error: message.error,
            endTime: endTime.toISOString(),
            endTimestamp: endTime.getTime(),
            durationInSeconds,
          };

          this.log.error('Parquet export error', {
            error: message.error,
            stack: message.stack,
            durationInSeconds,
          });

          reject(new Error(message.error));
        } else if (message.eventName === TIMING_LOG) {
          this.log.debug(`Parquet export timing: ${message.timingKey}`, {
            exportStep: message.timingKey,
            startTime:
              message.startTime != null
                ? new Date(message.startTime).toISOString()
                : undefined,
            endTime:
              message.endTime != null
                ? new Date(message.endTime).toISOString()
                : undefined,
            durationMs: message.durationMs,
            durationSeconds:
              message.durationMs != null
                ? message.durationMs / 1000
                : undefined,
          });
        }
      });

      this.worker.on('error', (error) => {
        this.exportStatus = {
          status: ERRORED,
          error: error.message,
        };

        this.log.error('Worker error', error);

        reject(error);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          this.exportStatus = {
            status: ERRORED,
            error: `Worker stopped with exit code ${code}`,
          };

          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
  }

  status(): ExportData {
    return this.exportStatus;
  }

  async stop(): Promise<void> {
    const worker = this.worker;

    if (worker) {
      return new Promise((resolve) => {
        worker.on('exit', () => {
          resolve();
        });

        worker.terminate();
      });
    }

    this.log.debug('Stopped successfully.');
  }
}

if (!isMainThread) {
  const TEMP_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  indep_hash BLOB,
  height INTEGER NOT NULL,
  previous_block BLOB,
  nonce BLOB NOT NULL,
  hash BLOB NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_count INTEGER NOT NULL,
  block_size INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id BLOB NOT NULL,
  indexed_at INTEGER,
  block_transaction_index INTEGER,
  is_data_item INTEGER,
  target BLOB,
  quantity TEXT,
  reward TEXT,
  anchor BLOB NOT NULL,
  data_size INTEGER,
  content_type TEXT,
  format INTEGER,
  height INTEGER NOT NULL,
  owner_address BLOB,
  data_root BLOB,
  parent BLOB,
  "offset" INTEGER,
  size INTEGER,
  data_offset INTEGER,
  owner_offset INTEGER,
  owner_size INTEGER,
  owner BLOB,
  signature_offset INTEGER,
  signature_size INTEGER,
  signature_type INTEGER,
  root_transaction_id BLOB,
  root_parent_offset INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
  height INTEGER NOT NULL,
  id BLOB NOT NULL,
  tag_index INTEGER NOT NULL,
  indexed_at INTEGER,
  tag_name BLOB NOT NULL,
  tag_value BLOB NOT NULL,
  is_data_item INTEGER NOT NULL
);
`;
  function escapeSqlString(s: string): string {
    return s.replace(/'/g, "''");
  }

  async function logTiming<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    try {
      return await fn();
    } finally {
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      parentPort?.postMessage({
        eventName: TIMING_LOG,
        timingKey: operation,
        startTime,
        endTime,
        durationMs,
      });
    }
  }

  function populateTempDb({
    tempDb,
    coreDbPath,
    bundlesDbPath,
    startHeight,
    endHeight,
    skipL1Transactions,
    skipL1Tags,
  }: {
    tempDb: InstanceType<typeof Sqlite>;
    coreDbPath: string;
    bundlesDbPath: string;
    startHeight: number;
    endHeight: number;
    skipL1Transactions: boolean;
    skipL1Tags: boolean;
  }): void {
    // Attach core database and import blocks + L1 data
    tempDb.exec(`ATTACH DATABASE '${escapeSqlString(coreDbPath)}' AS core`);

    tempDb.exec(`
      INSERT INTO blocks
      SELECT
        indep_hash,
        height,
        previous_block,
        nonce,
        hash,
        block_timestamp,
        tx_count,
        block_size
      FROM core.stable_blocks
      WHERE height BETWEEN ${startHeight} AND ${endHeight}
    `);

    if (!skipL1Transactions) {
      tempDb.exec(`
        INSERT INTO transactions
        SELECT
          st.id,
          NULL AS indexed_at,
          st.block_transaction_index,
          0 AS is_data_item,
          st.target,
          st.quantity,
          st.reward,
          st.last_tx AS anchor,
          st.data_size,
          st.content_type,
          st.format,
          st.height,
          st.owner_address,
          st.data_root,
          NULL AS parent,
          st."offset",
          NULL AS size,
          NULL AS data_offset,
          NULL AS owner_offset,
          NULL AS owner_size,
          CASE
            WHEN length(w.public_modulus) <= 64 THEN w.public_modulus
            ELSE NULL
          END AS owner,
          NULL AS signature_offset,
          NULL AS signature_size,
          NULL AS signature_type,
          st.id AS root_transaction_id,
          NULL AS root_parent_offset
        FROM core.stable_transactions st
        LEFT JOIN core.wallets w ON st.owner_address = w.address
        WHERE st.height BETWEEN ${startHeight} AND ${endHeight}
      `);
    }

    if (!skipL1Tags) {
      tempDb.exec(`
        INSERT INTO tags
        SELECT
          st.height,
          st.id,
          stt.transaction_tag_index AS tag_index,
          NULL AS indexed_at,
          tn.name AS tag_name,
          tv.value AS tag_value,
          0 AS is_data_item
        FROM core.stable_transactions st
        JOIN core.stable_transaction_tags stt ON st.id = stt.transaction_id
        JOIN core.tag_names tn ON stt.tag_name_hash = tn.hash
        JOIN core.tag_values tv ON stt.tag_value_hash = tv.hash
        WHERE st.height BETWEEN ${startHeight} AND ${endHeight}
      `);
    }

    tempDb.exec('DETACH core');

    // Attach bundles database and import L2 data
    tempDb.exec(
      `ATTACH DATABASE '${escapeSqlString(bundlesDbPath)}' AS bundles`,
    );

    tempDb.exec(`
      INSERT INTO transactions
      SELECT
        sdi.id,
        sdi.indexed_at,
        sdi.block_transaction_index,
        1 AS is_data_item,
        sdi.target,
        NULL AS quantity,
        NULL AS reward,
        sdi.anchor,
        sdi.data_size,
        sdi.content_type,
        NULL AS format,
        sdi.height,
        sdi.owner_address,
        NULL AS data_root,
        sdi.parent_id AS parent,
        sdi."offset",
        sdi.size,
        sdi.data_offset,
        sdi.owner_offset,
        sdi.owner_size,
        CASE
          WHEN length(w.public_modulus) <= 64 THEN w.public_modulus
          ELSE NULL
        END AS owner,
        sdi.signature_offset,
        sdi.signature_size,
        sdi.signature_type,
        sdi.root_transaction_id,
        sdi.root_parent_offset
      FROM bundles.stable_data_items sdi
      LEFT JOIN bundles.wallets w ON sdi.owner_address = w.address
      WHERE sdi.height BETWEEN ${startHeight} AND ${endHeight}
    `);

    tempDb.exec(`
      INSERT INTO tags
      SELECT
        sdi.height,
        sdi.id,
        sdit.data_item_tag_index AS tag_index,
        sdi.indexed_at,
        tn.name AS tag_name,
        tv.value AS tag_value,
        1 AS is_data_item
      FROM bundles.stable_data_items sdi
      JOIN bundles.stable_data_item_tags sdit ON sdi.id = sdit.data_item_id
      JOIN bundles.tag_names tn ON sdit.tag_name_hash = tn.hash
      JOIN bundles.tag_values tv ON sdit.tag_value_hash = tv.hash
      WHERE sdi.height BETWEEN ${startHeight} AND ${endHeight}
    `);

    tempDb.exec('DETACH bundles');
  }

  // Typed SELECT expressions that cast SQLite types to Parquet-appropriate types
  const TYPED_SELECTS: Record<string, string> = {
    blocks: `
      SELECT indep_hash, height::UBIGINT AS height, previous_block, nonce, hash,
             block_timestamp, tx_count, block_size::UBIGINT AS block_size
      FROM staging.blocks`,
    transactions: `
      SELECT id, indexed_at::UBIGINT AS indexed_at,
             block_transaction_index::USMALLINT AS block_transaction_index,
             is_data_item::BOOLEAN AS is_data_item, target,
             quantity::DECIMAL(20,0) AS quantity, reward::DECIMAL(20,0) AS reward,
             anchor, data_size::UBIGINT AS data_size, content_type,
             format::UTINYINT AS format, height::UBIGINT AS height, owner_address,
             data_root, parent, "offset"::UBIGINT AS "offset",
             size::UBIGINT AS size, data_offset::UBIGINT AS data_offset,
             owner_offset::UBIGINT AS owner_offset,
             owner_size::UINTEGER AS owner_size, owner,
             signature_offset::UBIGINT AS signature_offset,
             signature_size::UINTEGER AS signature_size,
             signature_type::UINTEGER AS signature_type, root_transaction_id,
             root_parent_offset::UINTEGER AS root_parent_offset
      FROM staging.transactions`,
    tags: `
      SELECT height::UBIGINT AS height, id,
             tag_index::USMALLINT AS tag_index,
             indexed_at::UBIGINT AS indexed_at, tag_name, tag_value,
             is_data_item::BOOLEAN AS is_data_item
      FROM staging.tags`,
  };

  const ORDER_BY: Record<string, string> = {
    blocks: 'ORDER BY height, indep_hash',
    transactions: 'ORDER BY height, id',
    tags: 'ORDER BY height, id, tag_index',
  };

  async function exportTableToParquet({
    connection,
    tableName,
    outputDir,
    partitionStart,
    partitionEnd,
    runId,
    maxFileRows,
  }: {
    connection: Connection;
    tableName: string;
    outputDir: string;
    partitionStart: number;
    partitionEnd: number;
    runId: string;
    maxFileRows?: number;
  }): Promise<void> {
    const partitionDir = `height=${partitionStart}-${partitionEnd}`;
    const tableOutputDir = join(outputDir, tableName, 'data', partitionDir);
    mkdirSync(tableOutputDir, { recursive: true });

    const countResult = await connection.all(
      `SELECT COUNT(*) AS cnt FROM staging.${tableName}`,
    );
    const rowCount = Number(countResult[0].cnt);

    if (rowCount === 0) return;

    const typedSelect = TYPED_SELECTS[tableName];
    const orderBy = ORDER_BY[tableName];

    if (maxFileRows === undefined || rowCount <= maxFileRows) {
      const fileName = `${tableName}_${partitionStart}_${partitionEnd}_${runId}.parquet`;
      await connection.exec(`
        COPY (${typedSelect} ${orderBy})
        TO '${escapeSqlString(join(tableOutputDir, fileName))}'
        (FORMAT PARQUET, COMPRESSION 'zstd')
      `);
    } else {
      let offset = 0;
      let fileNum = 0;
      while (offset < rowCount) {
        const fileName = `${tableName}_${partitionStart}_${partitionEnd}_${fileNum}_${runId}.parquet`;
        await connection.exec(`
          COPY (
            ${typedSelect} ${orderBy}
            LIMIT ${maxFileRows} OFFSET ${offset}
          )
          TO '${escapeSqlString(join(tableOutputDir, fileName))}'
          (FORMAT PARQUET, COMPRESSION 'zstd')
        `);
        offset += maxFileRows;
        fileNum++;
      }
    }
  }

  async function runExport(data: any): Promise<void> {
    const totalStartTime = Date.now();

    const {
      outputDir,
      startHeight,
      endHeight,
      maxFileRows,
      heightPartitionSize,
      skipL1Transactions,
      skipL1Tags,
      bundlesDbPath,
      coreDbPath,
    } = data;

    // e.g. "20260214T120000_12345"
    const runId = `${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}_${process.pid}`;

    // Create temp directory for intermediate files
    let tempDir: string | null = null;
    let connection: Connection | null = null;
    let tempDb: InstanceType<typeof Sqlite> | null = null;
    let exitCode = 1;

    try {
      tempDir = mkdtempSync(join(tmpdir(), 'parquet-export-'));
      const tempDbPath = join(tempDir, 'temp.db');

      // Initialize in-memory DuckDB with SQLite extension
      const db = await Database.create(':memory:');
      connection = await db.connect();

      await logTiming('init-duckdb', async () => {
        await connection!.exec('INSTALL sqlite; LOAD sqlite;');
      });

      // Create temp SQLite database
      tempDb = new Sqlite(tempDbPath);
      tempDb.pragma('busy_timeout = 30000');
      tempDb.exec(TEMP_SQLITE_SCHEMA);

      // Create output directory structure
      mkdirSync(outputDir, { recursive: true });

      // Process partitions
      for (
        let partStart = startHeight;
        partStart <= endHeight;
        partStart += heightPartitionSize
      ) {
        const partEnd = Math.min(
          partStart + heightPartitionSize - 1,
          endHeight,
        );

        await logTiming(`partition-${partStart}-${partEnd}`, async () => {
          // Step 1: Populate temp SQLite from source DBs (uses SQLite indexes)
          await logTiming(`populate-temp-${partStart}-${partEnd}`, async () => {
            populateTempDb({
              tempDb: tempDb!,
              coreDbPath,
              bundlesDbPath,
              startHeight: partStart,
              endHeight: partEnd,
              skipL1Transactions,
              skipL1Tags,
            });
          });

          // Step 2: Attach temp SQLite and export directly to Parquet
          await connection!.exec(
            `ATTACH '${escapeSqlString(tempDbPath)}' AS staging (TYPE SQLITE, READONLY)`,
          );

          await logTiming(
            `export-parquet-${partStart}-${partEnd}`,
            async () => {
              await exportTableToParquet({
                connection: connection!,
                tableName: 'blocks',
                outputDir,
                partitionStart: partStart,
                partitionEnd: partEnd,
                runId,
              });

              await exportTableToParquet({
                connection: connection!,
                tableName: 'transactions',
                outputDir,
                partitionStart: partStart,
                partitionEnd: partEnd,
                runId,
                maxFileRows,
              });

              await exportTableToParquet({
                connection: connection!,
                tableName: 'tags',
                outputDir,
                partitionStart: partStart,
                partitionEnd: partEnd,
                runId,
                maxFileRows,
              });
            },
          );

          await connection!.exec('DETACH staging');

          // Step 3: Clear temp SQLite tables for next partition
          tempDb!.exec(
            'DELETE FROM blocks; DELETE FROM transactions; DELETE FROM tags;',
          );
        });
      }

      const totalEndTime = Date.now();
      const totalDurationMs = totalEndTime - totalStartTime;

      parentPort?.postMessage({
        eventName: TIMING_LOG,
        timingKey: 'total-export-process',
        startTime: totalStartTime,
        endTime: totalEndTime,
        durationMs: totalDurationMs,
      });

      parentPort?.postMessage({ eventName: EXPORT_COMPLETE });
      exitCode = 0;
    } catch (error: any) {
      parentPort?.postMessage({
        eventName: EXPORT_ERROR,
        error: error.message,
        stack: error.stack,
      });
    } finally {
      try {
        tempDb?.close();
      } catch {
        // ignore cleanup errors
      }
      try {
        await connection?.close();
      } catch {
        // ignore cleanup errors
      }
      if (tempDir !== null) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      process.exit(exitCode);
    }
  }

  parentPort?.on('message', (message: Message) => {
    if (message.eventName === START) {
      runExport(workerData);
    }
  });
}
