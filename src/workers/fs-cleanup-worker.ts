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
import fs from 'node:fs';
import path from 'node:path';
import * as winston from 'winston';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

export class FsCleanupWorker {
  // Dependencies
  private log: winston.Logger;
  private shouldDelete: (path: string) => Promise<boolean>;
  private deleteCallback: (path: string) => Promise<void>;

  private basePath: string;
  private batchSize: number;
  private pauseDuration: number;
  private restartPauseDuration: number;

  private shouldRun = true;
  private lastPath: string | null = null;

  constructor({
    log,
    basePath,
    shouldDelete,
    deleteCallback,
    batchSize = config.FS_CLEANUP_WORKER_BATCH_SIZE,
    pauseDuration = config.FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION,
    restartPauseDuration = config.FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION,
  }: {
    log: winston.Logger;
    basePath: string;
    shouldDelete?: (path: string) => Promise<boolean>;
    deleteCallback?: (path: string) => Promise<void>;
    batchSize?: number;
    pauseDuration?: number;
    restartPauseDuration?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.shouldDelete = shouldDelete ?? (() => Promise.resolve(true));
    this.deleteCallback =
      deleteCallback ?? ((file: string) => fs.promises.unlink(file));

    this.basePath = basePath;
    this.lastPath = basePath;
    this.batchSize = batchSize;
    this.pauseDuration = pauseDuration;
    this.restartPauseDuration = restartPauseDuration;
  }

  async start(): Promise<void> {
    this.log.info('Starting worker');
    while (this.shouldRun) {
      try {
        await this.processBatch();
        await new Promise((resolve) => setTimeout(resolve, this.pauseDuration));
      } catch (error: any) {
        this.log.error('Error processing batch', {
          error: error?.message,
          stack: error?.stack,
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.log.info('Stopping worker');
    this.shouldRun = false;
  }

  async processBatch(): Promise<void> {
    const batch = await this.getBatch(this.basePath, this.lastPath);
    if (batch.length === 0) {
      this.log.info('No more files to delete, restarting from the base path');
      this.lastPath = this.basePath;
      await new Promise((resolve) =>
        setTimeout(resolve, this.restartPauseDuration),
      );
      return;
    }

    this.log.info(`Deleting ${batch.length} files in ${this.basePath}}`);

    await Promise.all(
      batch.map((file) => {
        metrics.filesCleanedTotal.inc();
        if (this.deleteCallback !== undefined) {
          return this.deleteCallback(file);
        } else {
          return fs.promises.unlink(file);
        }
      }),
    );

    this.lastPath = batch[batch.length - 1];
  }

  async getBatch(basePath: string, lastPath: string | null): Promise<string[]> {
    const batch: string[] = [];
    let totalFilesProcessed = 0;

    const walk = async (dir: string) => {
      const files = await fs.promises.readdir(dir, { withFileTypes: true });
      files.sort((a, b) => a.name.localeCompare(b.name));

      for (const file of files) {
        if (totalFilesProcessed >= this.batchSize) break;

        const fullPath = path.join(dir, file.name);

        // Skip .gitkeep files
        if (file.name === '.gitkeep') {
          continue;
        }

        if (
          lastPath !== null &&
          (lastPath.startsWith(fullPath) || fullPath >= lastPath) &&
          file.isDirectory()
        ) {
          await walk(fullPath);
        } else {
          if (lastPath === null || fullPath > lastPath) {
            if (await this.shouldDelete(fullPath)) {
              batch.push(fullPath);
              totalFilesProcessed++;
            }
          }
        }
      }
    };

    await walk(basePath);

    return batch;
  }
}
