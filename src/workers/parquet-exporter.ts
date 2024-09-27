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
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import * as winston from 'winston';
import { Database } from 'duckdb-async';

export class ParquetExporter {
  private log: winston.Logger;
  private db: Database;
  private duckDbPath: string;
  private isExporting = false;

  constructor({
    log,
    db,
    duckDbPath,
  }: {
    log: winston.Logger;
    db: Database;
    duckDbPath: string;
  }) {
    this.log = log;
    this.db = db;
    this.duckDbPath = duckDbPath;
  }

  static async create({
    log,
    duckDbPath,
    sqliteBundlesDbPath,
    sqliteCoreDbPath,
  }: {
    log: winston.Logger;
    duckDbPath: string;
    sqliteBundlesDbPath: string;
    sqliteCoreDbPath: string;
  }) {
    const logger = log.child({ class: 'ParquetExporter' });
    let db: Database;

    try {
      db = await Database.create(duckDbPath);

      const duckDbSchema = readFileSync(
        './src/database/duckdb/schema.sql',
        'utf8',
      );
      await db.exec(duckDbSchema);

      logger.debug('DuckDB schema created');
    } catch (error) {
      logger.error('Error creating DuckDB database', error);
      throw error;
    }

    try {
      await db.exec(`INSTALL sqlite; LOAD sqlite;`);
      await db.exec(
        `ATTACH '${sqliteBundlesDbPath}' AS sqlite_bundles_db (TYPE sqlite);`,
      );
      await db.exec(
        `ATTACH '${sqliteCoreDbPath}' AS sqlite_core_db (TYPE sqlite);`,
      );

      logger.debug('SQLite databases loaded');
    } catch (error) {
      logger.error('Error loading SQLite databases', error);
      throw error;
    }

    logger.info('DuckDB database created!');

    return new ParquetExporter({
      log: logger,
      db,
      duckDbPath,
    });
  }

  private async importBlocks({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const log = this.log.child({ method: 'importBlocks' });
    const query = `
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
        sqlite_core_db.stable_blocks
      WHERE
        height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO blocks ${query}`);
      log.info('Blocks inserted into DuckDB');
    } catch (error: any) {
      const newError = new Error('Error importing blocks');
      newError.stack = error.stack;
      throw newError;
    }
  }

  private async importTransactions({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const log = this.log.child({ method: 'importTransactions' });
    const query = `
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
        sqlite_core_db.stable_transactions st
      LEFT JOIN
        sqlite_core_db.wallets w ON st.owner_address = w.address
      WHERE
        st.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        st.height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO transactions ${query}`);
      log.info('Transactions inserted into DuckDB');
    } catch (error: any) {
      const newError = new Error('Error importing transactions');
      newError.stack = error.stack;
      throw newError;
    }
  }

  private async importDataItems({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const log = this.log.child({ method: 'importDataItems' });
    const query = `
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
        sqlite_bundles_db.stable_data_items sdi
      LEFT JOIN
        sqlite_bundles_db.wallets w ON sdi.owner_address = w.address
      WHERE
        sdi.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        sdi.height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO transactions ${query}`);
      log.info('Data items inserted into DuckDB');
    } catch (error: any) {
      const newError = new Error('Error importing data items');
      newError.stack = error.stack;
      throw newError;
    }
  }

  private async importTransactionTags({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const log = this.log.child({ method: 'importTransactionTags' });
    const query = `
      SELECT
        stt.height,
        stt.transaction_id AS id,
        stt.transaction_tag_index AS tag_index,
        NULL AS indexed_at,
        tn.name AS tag_name,
        tv.value AS tag_value,
        0 AS is_data_item
      FROM
        sqlite_core_db.stable_transaction_tags stt
      JOIN
        sqlite_core_db.tag_names tn ON stt.tag_name_hash = tn.hash
      JOIN
        sqlite_core_db.tag_values tv ON stt.tag_value_hash = tv.hash
      WHERE
        stt.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        stt.height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO tags ${query}`);
      log.info('Transaction tags inserted into DuckDB');
    } catch (error: any) {
      const newError = new Error('Error importing transaction tags');
      newError.stack = error.stack;
      throw newError;
    }
  }

  private async importDataItemTags({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const log = this.log.child({ method: 'importDataItemTags' });
    const query = `
      SELECT
        sdit.height,
        sdit.data_item_id AS id,
        sdit.data_item_tag_index AS tag_index,
        sdi.indexed_at,
        tn.name AS tag_name,
        tv.value AS tag_value,
        1 AS is_data_item
      FROM
        sqlite_bundles_db.stable_data_item_tags sdit
      JOIN
        sqlite_bundles_db.tag_names tn ON sdit.tag_name_hash = tn.hash
      JOIN
        sqlite_bundles_db.tag_values tv ON sdit.tag_value_hash = tv.hash
      JOIN
        sqlite_bundles_db.stable_data_items sdi ON sdit.data_item_id = sdi.id
      WHERE
        sdit.height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        sdit.height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO tags ${query}`);
      log.info('Data item tags inserted into DuckDB');
    } catch (error: any) {
      const newError = new Error('Error importing data item tags');
      newError.stack = error.stack;
      throw newError;
    }
  }

  private async exportToParquet({
    outputDir,
    tableName,
    startHeight,
    endHeight,
    maxFileRows,
  }: {
    outputDir: string;
    tableName: string;
    startHeight: number;
    endHeight: number;
    maxFileRows: number;
  }): Promise<void> {
    const log = this.log.child({ method: 'exportToParquet' });

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    let { minHeight, maxHeight } = await this.getHeightRange(tableName);
    minHeight =
      minHeight > BigInt(startHeight) ? minHeight : BigInt(startHeight);
    maxHeight = maxHeight < BigInt(endHeight) ? maxHeight : BigInt(endHeight);
    let rowCount = 0n;

    log.info(
      `Exporting Parquet file(s) for ${tableName} from height ${minHeight} to ${maxHeight}`,
    );

    for (let height = minHeight; height <= maxHeight; height++) {
      const heightRowCount = await this.getRowCountForHeight(tableName, height);
      rowCount += heightRowCount;

      if (rowCount >= maxFileRows || height === maxHeight) {
        const fileName = `${tableName}-minHeight:${minHeight}-maxHeight:${height}-rowCount:${rowCount}.parquet`;
        const filePath = `${outputDir}/${fileName}`;

        try {
          await this.db.exec(`
            COPY (
              SELECT * FROM ${tableName}
              WHERE height >= ${minHeight} AND height <= ${height}
            ) TO '${filePath}' (FORMAT PARQUET, COMPRESSION 'zstd')
          `);

          log.info(`Exported Parquet file: ${fileName}`);

          minHeight = height + 1n;
          rowCount = 0n;
        } catch (error: any) {
          const newError = new Error(
            `Error exporting Parquet file ${fileName}`,
          );
          newError.stack = error.stack;
          throw newError;
        }
      }
    }

    log.info(`Parquet export for ${tableName} complete`);
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
    const log = this.log.child({ method: 'export' });

    if (this.isExporting) {
      log.error('An export is already in progress');
      return;
    }
    this.isExporting = true;

    if (startHeight > endHeight) {
      log.error('startHeight must be less than or equal to endHeight');
      return;
    }

    if (maxFileRows <= 0) {
      log.error('maxFileRows must be a positive number');
      return;
    }

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    try {
      // Import data into DuckDB
      await this.importBlocks({ startHeight, endHeight });
      await this.importTransactions({ startHeight, endHeight });
      await this.importDataItems({ startHeight, endHeight });
      await this.importTransactionTags({ startHeight, endHeight });
      await this.importDataItemTags({ startHeight, endHeight });

      // Export data to Parquet files
      await this.exportToParquet({
        outputDir,
        tableName: 'blocks',
        startHeight,
        endHeight,
        maxFileRows,
      });

      await this.exportToParquet({
        outputDir,
        tableName: 'transactions',
        startHeight,
        endHeight,
        maxFileRows,
      });

      await this.exportToParquet({
        outputDir,
        tableName: 'tags',
        startHeight,
        endHeight,
        maxFileRows,
      });

      log.info('Parquet export complete');
    } catch (error) {
      log.error('Error exporting Parquet files', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      await this.db.close();

      // Delete the duckdb file
      try {
        rmSync(this.duckDbPath, { recursive: true, force: true });
        rmSync(`${this.duckDbPath}.wal`, { force: true });
      } catch (error) {
        log.error(`Error deleting duckdb file ${this.duckDbPath}:`, error);
      }
      this.isExporting = false;
    }
  }

  private async getHeightRange(
    tableName: string,
  ): Promise<{ minHeight: bigint; maxHeight: bigint }> {
    const query = `
      SELECT MIN(height) as min_height, MAX(height) as max_height
      FROM ${tableName}
    `;

    try {
      const result = await this.db.all(query);

      return {
        minHeight: result[0].min_height,
        maxHeight: result[0].max_height,
      };
    } catch (error: any) {
      const newError = new Error(`Error getting height range for ${tableName}`);
      newError.stack = error.stack;
      throw newError;
    }
  }

  private async getRowCountForHeight(
    tableName: string,
    height: bigint,
  ): Promise<bigint> {
    const query = `
      SELECT COUNT(*) as count
      FROM ${tableName}
      WHERE height = ${height}
    `;

    try {
      const result = await this.db.all(query);

      return result[0].count;
    } catch (error: any) {
      const newError = new Error(
        `Error getting row count for height ${height} in ${tableName}`,
      );
      newError.stack = error.stack;
      throw newError;
    }
  }
}
