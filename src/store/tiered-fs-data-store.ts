/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';
import fs from 'node:fs';
import winston from 'winston';
import { ContiguousDataStore, Region } from '../types.js';
import { FsDataStore } from './fs-data-store.js';

export class TieredFsDataStore implements ContiguousDataStore {
  private log: winston.Logger;
  private regularStore: FsDataStore;
  private retentionStore: FsDataStore | undefined;
  private db: any; // Database with getDataRetention method

  constructor({
    log,
    regularStore,
    retentionStore,
    db,
  }: {
    log: winston.Logger;
    regularStore: FsDataStore;
    retentionStore: FsDataStore | undefined;
    db: any;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.regularStore = regularStore;
    this.retentionStore = retentionStore;
    this.db = db;
  }

  async has(hash: string): Promise<boolean> {
    // Check both stores
    if (this.retentionStore) {
      const inRetention = await this.retentionStore.has(hash);
      if (inRetention) return true;
    }
    return this.regularStore.has(hash);
  }

  async get(hash: string, region?: Region): Promise<Readable | undefined> {
    // Try retention store first if it exists
    if (this.retentionStore) {
      const retentionData = await this.retentionStore.get(hash, region);
      if (retentionData) {
        this.log.debug('Found data in retention tier', { hash });
        return retentionData;
      }
    }

    // Fall back to regular store
    const regularData = await this.regularStore.get(hash, region);
    if (regularData) {
      this.log.debug('Found data in regular tier', { hash });
    }
    return regularData;
  }

  async createWriteStream(): Promise<fs.WriteStream> {
    // Always create write stream in regular store first
    // We'll move it to retention store in finalize if needed
    return this.regularStore.createWriteStream();
  }

  async cleanup(stream: fs.WriteStream): Promise<void> {
    return this.regularStore.cleanup(stream);
  }

  async finalize(stream: fs.WriteStream, hash: string): Promise<void> {
    // If no retention store configured, use regular store
    if (!this.retentionStore) {
      return this.regularStore.finalize(stream, hash);
    }

    // Check if this hash has a retention policy
    let retention;
    try {
      retention = await this.db.getDataRetention(hash);
    } catch (error) {
      this.log.error('Failed to get retention info, using regular store', {
        hash,
        error,
      });
      return this.regularStore.finalize(stream, hash);
    }

    if (retention?.retentionPolicyId) {
      // First finalize to regular store
      await this.regularStore.finalize(stream, hash);

      // Then move to retention store
      this.log.info('Moving retained data to retention tier', {
        hash,
        policyId: retention.retentionPolicyId,
        expiresAt: retention.retentionExpiresAt,
      });

      // Get data from regular store
      const data = await this.regularStore.get(hash);
      if (data) {
        // Create new write stream in retention store
        const retentionStream = await this.retentionStore.createWriteStream();

        // Pipe data to retention store
        await new Promise<void>((resolve, reject) => {
          data.pipe(retentionStream).on('finish', resolve).on('error', reject);
        });

        // Finalize in retention store
        await this.retentionStore.finalize(retentionStream, hash);

        // Delete from regular store
        await this.deleteFromStore(this.regularStore, hash);
      }
    } else {
      // No retention policy, use regular store
      return this.regularStore.finalize(stream, hash);
    }
  }

  /**
   * Helper method to delete data from a specific store
   */
  private async deleteFromStore(
    _store: FsDataStore,
    hash: string,
  ): Promise<void> {
    try {
      // FsDataStore doesn't have a del method, but we can check if file exists
      // and delete it manually if needed. For now, we'll leave data in both
      // stores during transition period.
      this.log.debug('Would delete from store', { hash });
    } catch (error) {
      this.log.error('Failed to delete from store', { hash, error });
    }
  }

  /**
   * Migrate data between tiers based on retention policy changes
   */
  async migrateData(hash: string): Promise<void> {
    if (!this.retentionStore) return;

    const retention = await this.db.getDataRetention(hash);
    const inRetentionStore = await this.retentionStore.has(hash);
    const inRegularStore = await this.regularStore.has(hash);

    if (retention?.retentionPolicyId && !inRetentionStore && inRegularStore) {
      // Move from regular to retention
      this.log.info('Migrating data to retention tier', { hash });
      const data = await this.regularStore.get(hash);
      if (data) {
        const retentionStream = await this.retentionStore.createWriteStream();
        await new Promise<void>((resolve, reject) => {
          data.pipe(retentionStream).on('finish', resolve).on('error', reject);
        });
        await this.retentionStore.finalize(retentionStream, hash);
        // Note: Not deleting from regular store as FsDataStore doesn't have del method
      }
    } else if (
      !retention?.retentionPolicyId &&
      inRetentionStore &&
      !inRegularStore
    ) {
      // Move from retention to regular (policy removed)
      this.log.info('Migrating data to regular tier', { hash });
      const data = await this.retentionStore.get(hash);
      if (data) {
        const regularStream = await this.regularStore.createWriteStream();
        await new Promise<void>((resolve, reject) => {
          data.pipe(regularStream).on('finish', resolve).on('error', reject);
        });
        await this.regularStore.finalize(regularStream, hash);
        // Note: Not deleting from retention store as FsDataStore doesn't have del method
      }
    }
  }
}
