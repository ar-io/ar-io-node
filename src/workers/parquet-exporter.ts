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

  constructor({
    log,
    db,
  }: {
    log: winston.Logger;
    db: Database;
    duckDbPath: string;
    sqliteDbPath: string;
  }) {
    this.log = log;
    this.db = db;
  }

  static async create({
    log,
    duckDbPath,
    sqliteDbPath,
  }: {
    log: winston.Logger;
    duckDbPath: string;
    sqliteDbPath: string;
  }) {
    const logger = log.child({ class: this.constructor.name });
    const db = await Database.create(duckDbPath);

    const duckDbSchema = readFileSync(
      './src/database/duckdb/schema.sql',
      'utf8',
    );
    await db.exec(duckDbSchema);
    logger.debug('DuckDB schema created');

    await db.exec(`INSTALL sqlite; LOAD sqlite;`);
    await db.exec(`ATTACH '${sqliteDbPath}' AS sqlite_db (TYPE sqlite);`);
    logger.debug('SQLite loaded');
    return new ParquetExporter({ log: logger, db, duckDbPath, sqliteDbPath });
  }

  async exportDataItemTagsParquet({
    startHeight,
    endHeight,
    maxFileRows,
    outputDir,
  }: {
    startHeight: number;
    endHeight: number;
    maxFileRows: number;
    outputDir: string;
  }) {
    const sqliteQuery = `
        SELECT
            sdit.height,
            sdit.data_item_id AS id,
            sdit.data_item_tag_index AS tag_index,
            sdi.indexed_at AS created_at,
            tn.name AS tag_name,
            tv.value AS tag_value,
            1 AS is_data_item
        FROM
            sqlite_db.stable_data_item_tags sdit
        JOIN
            sqlite_db.tag_names tn ON sdit.tag_name_hash = tn.hash
        JOIN
            sqlite_db.tag_values tv ON sdit.tag_value_hash = tv.hash
        JOIN
            sqlite_db.stable_data_items sdi ON sdit.data_item_id = sdi.id
        WHERE
            sdit.height BETWEEN ${startHeight} AND ${endHeight};
    `;

    await this.db.exec(`INSERT INTO tags ${sqliteQuery}`);

    this.log.debug('Data inserted into DuckDB');

    await this.exportToParquet({
      outputDir,
      tableName: 'tags',
      startHeight,
      endHeight,
      maxFileRows,
    });

    await this.truncateTable('tags');

    await this.db.close();
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
    minHeight = Math.max(startHeight, minHeight);
    maxHeight = Math.min(endHeight, maxHeight);
    let rowCount = 0;

    this.log.info(
      `Exporting Parquet file(s) for ${tableName} from height ${minHeight} to ${maxHeight}`,
    );

    for (let height = minHeight; height <= maxHeight; height++) {
      const heightRowCount = await this.getRowCountForHeight(tableName, height);
      rowCount += heightRowCount;

      if (rowCount >= maxFileRows || height === maxHeight) {
        const fileName = `${tableName}-minHeight:${minHeight}-maxHeight:${height}-rowCount:${rowCount}.parquet`;
        const filePath = `${outputDir}/${fileName}`;

        await this.db.exec(`
        COPY (
          SELECT * FROM ${tableName}
          WHERE height >= ${minHeight} AND height <= ${height}
        ) TO '${filePath}' (FORMAT PARQUET, COMPRESSION 'zstd')
      `);

        this.log.info(`Exported Parquet file: ${fileName}`);

        minHeight = height + 1;
        rowCount = 0;
      }
    }

    this.log.info('Parquet export complete');
  }

  private async getHeightRange(
    tableName: string,
  ): Promise<{ minHeight: number; maxHeight: number }> {
    const query = `
      SELECT MIN(height) as min_height, MAX(height) as max_height
      FROM ${tableName}
    `;
    const result = await this.db.all(query);

    return {
      minHeight: result[0].min_height,
      maxHeight: result[0].max_height,
    };
  }

  private async getRowCountForHeight(
    tableName: string,
    height: number,
  ): Promise<number> {
    const query = `
      SELECT COUNT(*) as count
      FROM ${tableName}
      WHERE height = ${height}
    `;
    const result = await this.db.all(query);

    return Number(result[0].count);
  }

  private async truncateTable(tableName: string): Promise<void> {
    await this.db.exec(`TRUNCATE TABLE ${tableName};`);
    await this.db.exec(`CHECKPOINT ${tableName};`);
  }
}
