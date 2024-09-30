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
import { Connection, Database } from 'duckdb-async';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';
import * as winston from 'winston';

const EXPORT_COMPLETE = 'export-complete';
const EXPORT_ERROR = 'export-error';

export class ParquetExporter {
  private log: winston.Logger;
  private worker: Worker | null = null;
  private isExporting = false;
  private duckDbPath: string;
  private bundlesDbPath: string;
  private coreDbPath: string;

  constructor({
    log,
    duckDbPath,
    bundlesDbPath,
    coreDbPath,
  }: {
    log: winston.Logger;
    duckDbPath: string;
    bundlesDbPath: string;
    coreDbPath: string;
  }) {
    this.log = log.child({ class: 'ParquetExporter' });
    this.duckDbPath = duckDbPath;
    this.bundlesDbPath = bundlesDbPath;
    this.coreDbPath = coreDbPath;
  }

  async export({
    outputDir,
    startHeight,
    endHeight,
    maxFileRows,
  }: {
    outputDir: string;
    startHeight: number;
    endHeight: number;
    maxFileRows: number;
  }): Promise<void> {
    if (this.isExporting) {
      this.log.error('An export is already in progress');
      return;
    }
    this.isExporting = true;

    return new Promise((resolve, reject) => {
      const workerUrl = new URL('./parquet-exporter.js', import.meta.url);
      this.worker = new Worker(workerUrl, {
        workerData: {
          outputDir,
          startHeight,
          endHeight,
          maxFileRows,
          duckDbPath: this.duckDbPath,
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
        });

        this.worker?.postMessage('start');
      });

      this.worker.on('message', (message: any) => {
        if (message.eventName === EXPORT_COMPLETE) {
          const endTime = Date.now();
          const duration = (endTime - startTime) / 1000; // Convert to seconds

          this.log.info(
            `Parquet export completed in ${duration.toFixed(2)} seconds`,
            { outputDir, startHeight, endHeight, maxFileRows },
          );

          this.isExporting = false;
          this.worker?.terminate();
          resolve();
        } else if (message.eventName === EXPORT_ERROR) {
          this.isExporting = false;
          this.worker?.terminate();
          this.log.error('Parquet export error', {
            error: message.error,
            stack: message.stack,
          });
          reject(new Error(message.error));
        }
      });

      this.worker.on('error', (error) => {
        this.log.error('Worker error', error);
        this.isExporting = false;
        reject(error);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          this.isExporting = false;
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const worker = this.worker;

    if (worker) {
      return new Promise((resolve) => {
        worker.on('exit', () => {
          resolve();
        });
        worker.postMessage('terminate');
      });
    }
  }
}

const importBlocks = async ({
  db,
  coreDbPath,
  startHeight,
  endHeight,
}: {
  db: Connection;
  coreDbPath: string;
  startHeight: number;
  endHeight: number;
}) => {
  const query = `
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
      FROM
        sqlite_scan('${coreDbPath}', 'stable_blocks')
      WHERE
        height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        height ASC;
    `;

  try {
    await db.exec(query);
  } catch (error: any) {
    const newError = new Error('Error importing blocks');
    newError.stack = error.stack;
    throw newError;
  }
};

const importTransactions = async ({
  db,
  coreDbPath,
  startHeight,
  endHeight,
}: {
  db: Connection;
  coreDbPath: string;
  startHeight: number;
  endHeight: number;
}) => {
  const query = `
      INSERT INTO transactions
      SELECT
        st.id,
        NULL AS indexed_at,
        st.block_transaction_index,
        0 AS is_data_item,
        st.target,
        st.quantity,
        st.reward,
        st.last_tx as anchor,
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
          WHEN octet_length(w.public_modulus) <= 64 THEN w.public_modulus
          ELSE NULL
        END AS owner,
        NULL AS signature_offset,
        NULL AS signature_size,
        NULL AS signature_type
      FROM
        sqlite_scan('${coreDbPath}', 'stable_transactions') st
      LEFT JOIN
        sqlite_scan('${coreDbPath}', 'wallets') w ON st.owner_address = w.address
      WHERE
        st.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        st.height ASC;
    `;

  try {
    await db.exec(query);
  } catch (error: any) {
    const newError = new Error('Error importing transactions');
    newError.stack = error.stack;
    throw newError;
  }
};

const importDataItems = async ({
  db,
  bundlesDbPath,
  startHeight,
  endHeight,
}: {
  db: Connection;
  bundlesDbPath: string;
  startHeight: number;
  endHeight: number;
}) => {
  const query = `
      INSERT INTO transactions
      SELECT
        sdi.id,
        sdi.indexed_at,
        NULL AS block_transaction_index,
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
          WHEN octet_length(w.public_modulus) <= 64 THEN w.public_modulus
          ELSE NULL
        END AS owner,
        sdi.signature_offset,
        sdi.signature_size,
        sdi.signature_type
      FROM
        sqlite_scan('${bundlesDbPath}', 'stable_data_items') sdi
      LEFT JOIN
        sqlite_scan('${bundlesDbPath}', 'wallets') w ON sdi.owner_address = w.address
      WHERE
        sdi.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        sdi.height ASC;
    `;

  try {
    await db.exec(query);
  } catch (error: any) {
    const newError = new Error('Error importing data items');
    newError.stack = error.stack;
    throw newError;
  }
};

const importTransactionTags = async ({
  db,
  coreDbPath,
  startHeight,
  endHeight,
}: {
  db: Connection;
  coreDbPath: string;
  startHeight: number;
  endHeight: number;
}) => {
  const query = `
      INSERT INTO tags
      SELECT
        stt.height,
        stt.transaction_id AS id,
        stt.transaction_tag_index AS tag_index,
        NULL AS indexed_at,
        tn.name AS tag_name,
        tv.value AS tag_value,
        0 AS is_data_item
      FROM
        sqlite_scan('${coreDbPath}', 'stable_transaction_tags') stt
      JOIN
        sqlite_scan('${coreDbPath}', 'tag_names') tn ON stt.tag_name_hash = tn.hash
      JOIN
        sqlite_scan('${coreDbPath}', 'tag_values') tv ON stt.tag_value_hash = tv.hash
      WHERE
        stt.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        stt.height ASC;
    `;

  try {
    await db.exec(query);
  } catch (error: any) {
    const newError = new Error('Error importing transaction tags');
    newError.stack = error.stack;
    throw newError;
  }
};

const importDataItemTags = async ({
  db,
  bundlesDbPath,
  startHeight,
  endHeight,
}: {
  db: Connection;
  bundlesDbPath: string;
  startHeight: number;
  endHeight: number;
}) => {
  const query = `
      INSERT INTO tags
      SELECT
        sdit.height,
        sdit.data_item_id AS id,
        sdit.data_item_tag_index AS tag_index,
        sdi.indexed_at,
        tn.name AS tag_name,
        tv.value AS tag_value,
        1 AS is_data_item
      FROM
        sqlite_scan('${bundlesDbPath}', 'stable_data_item_tags') sdit
      JOIN
        sqlite_scan('${bundlesDbPath}', 'tag_names') tn ON sdit.tag_name_hash = tn.hash
      JOIN
        sqlite_scan('${bundlesDbPath}', 'tag_values') tv ON sdit.tag_value_hash = tv.hash
      JOIN
        sqlite_scan('${bundlesDbPath}', 'stable_data_items') sdi ON sdit.data_item_id = sdi.id
      WHERE
        sdit.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        sdit.height ASC;
    `;

  try {
    await db.exec(query);
  } catch (error: any) {
    const newError = new Error('Error importing data item tags');
    newError.stack = error.stack;
    throw newError;
  }
};

const exportToParquet = async ({
  db,
  outputDir,
  tableName,
  startHeight,
  endHeight,
  maxFileRows,
}: {
  db: Connection;
  outputDir: string;
  tableName: string;
  startHeight: number;
  endHeight: number;
  maxFileRows: number;
}): Promise<void> => {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  let { minHeight, maxHeight } = await getHeightRange(db, tableName);
  minHeight = minHeight > BigInt(startHeight) ? minHeight : BigInt(startHeight);
  maxHeight = maxHeight < BigInt(endHeight) ? maxHeight : BigInt(endHeight);
  let rowCount = 0n;

  for (let height = minHeight; height <= maxHeight; height++) {
    const heightRowCount = await getRowCountForHeight(db, tableName, height);
    rowCount += heightRowCount;

    if (rowCount >= maxFileRows || height === maxHeight) {
      const fileName = `${tableName}-minHeight:${minHeight}-maxHeight:${height}-rowCount:${rowCount}.parquet`;
      const filePath = `${outputDir}/${fileName}`;

      try {
        await db.exec(`
            COPY (
              SELECT * FROM ${tableName}
              WHERE height >= ${minHeight} AND height <= ${height}
            ) TO '${filePath}' (FORMAT PARQUET, COMPRESSION 'zstd')
          `);

        minHeight = height + 1n;
        rowCount = 0n;
      } catch (error: any) {
        const newError = new Error(`Error exporting Parquet file ${fileName}`);
        newError.stack = error.stack;
        throw newError;
      }
    }
  }
};

const getHeightRange = async (
  db: Connection,
  tableName: string,
): Promise<{ minHeight: bigint; maxHeight: bigint }> => {
  const query = `
      SELECT MIN(height) as min_height, MAX(height) as max_height
      FROM ${tableName}
    `;

  try {
    const result = await db.all(query);

    return {
      minHeight: result[0].min_height,
      maxHeight: result[0].max_height,
    };
  } catch (error: any) {
    const newError = new Error(`Error getting height range for ${tableName}`);
    newError.stack = error.stack;
    throw newError;
  }
};

const getRowCountForHeight = async (
  db: Connection,
  tableName: string,
  height: bigint,
): Promise<bigint> => {
  const query = `
      SELECT COUNT(*) as count
      FROM ${tableName}
      WHERE height = ${height}
    `;

  try {
    const result = await db.all(query);

    return result[0].count;
  } catch (error: any) {
    const newError = new Error(
      `Error getting row count for height ${height} in ${tableName}`,
    );
    newError.stack = error.stack;
    throw newError;
  }
};

if (!isMainThread) {
  const runExport = async (data: any) => {
    const {
      outputDir,
      startHeight,
      endHeight,
      maxFileRows,
      duckDbPath,
      bundlesDbPath,
      coreDbPath,
    } = data;

    const db = await Database.create(duckDbPath);
    const connection = await db.connect();

    try {
      const duckDbSchema = readFileSync(
        './src/database/duckdb/schema.sql',
        'utf8',
      );
      await connection.exec(duckDbSchema);

      await connection.exec(`INSTALL sqlite; LOAD sqlite;`);

      // Import data into DuckDB
      await importBlocks({
        db: connection,
        coreDbPath,
        startHeight,
        endHeight,
      });
      await importTransactions({
        db: connection,
        coreDbPath,
        startHeight,
        endHeight,
      });
      await importDataItems({
        db: connection,
        bundlesDbPath,
        startHeight,
        endHeight,
      });
      await importTransactionTags({
        db: connection,
        coreDbPath,
        startHeight,
        endHeight,
      });
      await importDataItemTags({
        db: connection,
        bundlesDbPath,
        startHeight,
        endHeight,
      });

      // Export data to Parquet files
      await exportToParquet({
        db: connection,
        outputDir,
        tableName: 'blocks',
        startHeight,
        endHeight,
        maxFileRows,
      });

      await exportToParquet({
        db: connection,
        outputDir,
        tableName: 'transactions',
        startHeight,
        endHeight,
        maxFileRows,
      });

      await exportToParquet({
        db: connection,
        outputDir,
        tableName: 'tags',
        startHeight,
        endHeight,
        maxFileRows,
      });

      parentPort?.postMessage({ eventName: EXPORT_COMPLETE });
    } catch (error: any) {
      parentPort?.postMessage({
        eventName: EXPORT_ERROR,
        error: error.message,
        stack: error.stack,
      });
    } finally {
      await connection.close();
      await db.close();

      // Delete the duckdb file
      rmSync(duckDbPath, { recursive: true, force: true });
      rmSync(`${duckDbPath}.wal`, { force: true });
    }
  };

  parentPort?.on('message', (message) => {
    if (message === 'terminate') {
      process.exit(0);
    } else {
      runExport(workerData);
    }
  });
}
