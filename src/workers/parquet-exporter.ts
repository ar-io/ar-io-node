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
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import * as winston from 'winston';
import { Database } from 'duckdb-async';

export class ParquetExporter {
  private log: winston.Logger;
  private db: Database;
  private isExporting = false;

  constructor({ log, db }: { log: winston.Logger; db: Database }) {
    this.log = log;
    this.db = db;
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
    });
  }

  private async importBlocks({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
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
      this.log.info('Blocks inserted into DuckDB');
    } catch (error) {
      throw `Error importing blocks: ${error}`;
    }
  }

  private async importTransactions({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const query = `
      SELECT
        id,
        block_transaction_index,
        0 AS is_data_item,
        target,
        quantity,
        reward,
        signature,
        last_tx,
        data_size,
        content_type,
        format,
        height,
        owner_address,
        data_root,
        NULL AS parent,
        "offset",
        NULL AS size,
        NULL AS data_offset,
        NULL AS owner_offset,
        NULL AS owner_size,
        NULL AS owner,
        NULL AS signature_offset,
        NULL AS signature_size,
        NULL AS signature_type
      FROM
        sqlite_core_db.stable_transactions
      WHERE
        height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO transactions ${query}`);
      this.log.info('Transactions inserted into DuckDB');
    } catch (error) {
      throw `Error importing transactions: ${error}`;
    }
  }

  private async importDataItems({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const query = `
      SELECT
        id,
        NULL AS block_transaction_index,
        1 AS is_data_item,
        target,
        NULL AS quantity,
        NULL AS reward,
        signature,
        anchor AS last_tx,
        data_size,
        content_type,
        NULL AS format,
        height,
        owner_address,
        NULL AS data_root,
        parent_id AS parent,
        "offset",
        size,
        data_offset,
        owner_offset,
        owner_size,
        NULL AS owner,
        signature_offset,
        signature_size,
        signature_type
      FROM
        sqlite_bundles_db.stable_data_items
      WHERE
        height BETWEEN ${startHeight} AND ${endHeight}
      ORDER BY
        height ASC;
    `;

    try {
      await this.db.exec(`INSERT INTO transactions ${query}`);
      this.log.info('Data items inserted into DuckDB');
    } catch (error) {
      throw `Error importing data items: ${error}`;
    }
  }

  private async importTransactionTags({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const query = `
      SELECT
        stt.height,
        stt.transaction_id AS id,
        stt.transaction_tag_index AS tag_index,
        NULL AS created_at,
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
      this.log.info('Transaction tags inserted into DuckDB');
    } catch (error) {
      throw `Error importing transaction tags: ${error}`;
    }
  }

  private async importDataItemTags({
    startHeight,
    endHeight,
  }: {
    startHeight: number;
    endHeight: number;
  }) {
    const query = `
      SELECT
        sdit.height,
        sdit.data_item_id AS id,
        sdit.data_item_tag_index AS tag_index,
        sdi.indexed_at AS created_at,
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
      this.log.info('Data item tags inserted into DuckDB');
    } catch (error) {
      throw `Error importing data item tags: ${error}`;
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
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    let { minHeight, maxHeight } = await this.getHeightRange(tableName);
    minHeight =
      minHeight > BigInt(startHeight) ? minHeight : BigInt(startHeight);
    maxHeight = maxHeight < BigInt(endHeight) ? maxHeight : BigInt(endHeight);
    let rowCount = 0n;

    this.log.info(
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

          this.log.info(`Exported Parquet file: ${fileName}`);

          minHeight = height + 1n;
          rowCount = 0n;
        } catch (error) {
          throw `Error exporting Parquet file ${fileName}: ${error}`;
        }
      }
    }

    this.log.info(`Parquet export for ${tableName} complete`);
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

    if (startHeight > endHeight) {
      this.log.error('startHeight must be less than or equal to endHeight');
      return;
    }

    if (maxFileRows <= 0) {
      this.log.error('maxFileRows must be a positive number');
      return;
    }

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    try {
      // Import data into DuckDB
      await this.importBlocks({
        startHeight,
        endHeight,
      });

      await this.importTransactions({
        startHeight,
        endHeight,
      });

      await this.importDataItems({
        startHeight,
        endHeight,
      });

      await this.importTransactionTags({
        startHeight,
        endHeight,
      });

      await this.importDataItemTags({
        startHeight,
        endHeight,
      });

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
    } catch (error) {
      this.log.error('Error exporting Parquet files:', error);
    } finally {
      // Truncate tables
      await this.truncateTable('blocks');
      await this.truncateTable('transactions');
      await this.truncateTable('tags');

      await this.db.close();
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
    } catch (error) {
      throw `Error getting height range for ${tableName}: ${error}`;
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
    } catch (error) {
      throw `Error getting row count for height ${height} in ${tableName}: ${error}`;
    }
  }

  private async truncateTable(tableName: string): Promise<void> {
    try {
      await this.db.exec(`TRUNCATE TABLE ${tableName};`);
      await this.db.exec(`CHECKPOINT ${tableName};`);
    } catch (error) {
      throw `Error truncating table ${tableName}: ${error}`;
    }
  }
}
