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
import duckdb from 'duckdb';
// import duckdb, { RowData } from 'duckdb';

export class ParquetExporter {
  private log: winston.Logger;
  private db: duckdb.Database;

  constructor({
    log,
    duckDbPath,
    sqliteDbPath,
  }: {
    log: winston.Logger;
    duckDbPath: string;
    sqliteDbPath: string;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.db = new duckdb.Database(duckDbPath);

    const duckDbSchema = readFileSync(
      './src/database/duckdb/schema.sql',
      'utf8',
    );

    this.db.run(duckDbSchema);
    this.log.debug('DuckDB schema imported successfully');

    this.db.exec(`INSTALL sqlite; LOAD sqlite;`);
    this.db.exec(`ATTACH '${sqliteDbPath}' AS sqlite_db (TYPE sqlite);`);
    this.log.debug('SQLite database attached successfully');
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
    console.log(outputDir);

    const sqliteQuery = `
        SELECT * FROM (
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
            sdit.height BETWEEN ${startHeight} AND ${endHeight}
        UNION ALL
        SELECT
            ndit.height,
            ndit.data_item_id AS id,
            ndit.data_item_tag_index AS tag_index,
            ndi.indexed_at AS created_at,
            tn.name AS tag_name,
            tv.value AS tag_value,
            1 AS is_data_item
        FROM
            sqlite_db.new_data_item_tags ndit
        JOIN
            sqlite_db.tag_names tn ON ndit.tag_name_hash = tn.hash
        JOIN
            sqlite_db.tag_values tv ON ndit.tag_value_hash = tv.hash
        JOIN
            sqlite_db.new_data_items ndi ON ndit.data_item_id = ndi.id
        WHERE
            ndit.height BETWEEN ${startHeight} AND ${endHeight}
        ) AS combined_results
        LIMIT ${maxFileRows};
    `;

    try {
      this.db.exec('BEGIN TRANSACTION;');

      this.db.exec(`INSERT INTO tags ${sqliteQuery}`, (err: Error | null) => {
        if (err) {
          this.log.error('Error inserting data into DuckDB:', err);
          throw err;
        }
      });

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      this.log.error('Error inserting data into DuckDB, rolling back:', err);
    } finally {
      this.log.info('Data imported into DuckDB tags table successfully');
      this.exportToParquet({
        outputDir,
        tableName: 'tags',
        minHeight: startHeight,
        maxHeight: endHeight,
        rowCount: maxFileRows,
      });
      this.log.info('Data exported to Parquet file successfully');
      this.truncateTable('tags');
      this.db.close();
    }
  }

  private async exportToParquet({
    outputDir,
    tableName,
    minHeight,
    maxHeight,
    rowCount,
  }: {
    outputDir: string;
    tableName: string;
    minHeight: number;
    maxHeight: number;
    rowCount: number;
  }): Promise<void> {
    const fileName = `${tableName}-minHeight:${minHeight}-maxHeight:${maxHeight}-rowCount:${rowCount}.parquet`;
    const filePath = `${outputDir}/${fileName}`;

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.db.exec(
        `COPY tags TO '${filePath}' (FORMAT PARQUET);`,
        (err: Error | null) => {
          if (err) {
            this.log.error(`Error exporting to Parquet file ${fileName}:`, err);
            reject(err);
          } else {
            this.log.info(`Exported to Parquet file: ${fileName}`);
            resolve();
          }
        },
      );
    });
  }

  private async truncateTable(table: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(`TRUNCATE TABLE ${table};`, (err: Error | null) => {
        if (err) {
          this.log.error(`Error truncating ${table} table:`, err);
          reject(err);
        } else {
          this.log.info(`${table} table truncated`);
          resolve();
        }
      });
    });
  }
}
