/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';

import Sqlite from 'better-sqlite3';
import axios from 'axios';

import { processBundleStream } from '../../../lib/bundles.js';
import { fromB64Url, sha256B64Url, toB64Url } from '../../../lib/encoding.js';
import { CanonicalDataItem, CanonicalTag, SourceAdapter } from '../types.js';

export class BundleParserSource implements SourceAdapter {
  name = 'bundle-parser';
  private bundlesDbPath: string;
  private coreDbPath: string;
  private referenceUrl: string;
  private prefetchedData: Map<string, Buffer> = new Map();

  constructor(bundlesDbPath: string, coreDbPath: string, referenceUrl: string) {
    this.bundlesDbPath = bundlesDbPath;
    this.coreDbPath = coreDbPath;
    this.referenceUrl = referenceUrl;
  }

  async prefetchBundles(
    startHeight: number,
    endHeight: number,
    gatewayUrl: string,
  ): Promise<void> {
    const bundlesDb = new Sqlite(this.bundlesDbPath, { readonly: true });

    try {
      // Query new_data_items since this runs before flush to stable
      const bundleRows = bundlesDb
        .prepare(
          `
          SELECT DISTINCT b.id
          FROM bundles b
          JOIN new_data_items ndi ON b.id = ndi.parent_id OR b.id = ndi.root_transaction_id
          WHERE ndi.height BETWEEN ? AND ?
            AND b.last_fully_indexed_at IS NOT NULL
          `,
        )
        .all(startHeight, endHeight) as any[];

      console.log(
        `Prefetching ${bundleRows.length} bundle(s) from local gateway...`,
      );

      for (const row of bundleRows) {
        const bundleTxId = toB64Url(row.id);
        const url = `${gatewayUrl}/raw/${bundleTxId}`;

        try {
          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 120000,
          });
          this.prefetchedData.set(bundleTxId, Buffer.from(response.data));
          console.log(`  Prefetched bundle ${bundleTxId}`);
        } catch (err: any) {
          console.error(
            `  Failed to prefetch bundle ${bundleTxId}: ${err.message}`,
          );
        }
      }

      console.log(
        `Prefetched ${this.prefetchedData.size}/${bundleRows.length} bundle(s)`,
      );
    } finally {
      bundlesDb.close();
    }
  }

  async getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    // Find bundle transaction IDs from the bundles database
    const bundlesDb = new Sqlite(this.bundlesDbPath, { readonly: true });
    const coreDb = new Sqlite(this.coreDbPath, { readonly: true });

    try {
      // Get bundles that were fully indexed in this height range
      // We need L1 transaction IDs that are bundles
      const bundleRows = bundlesDb
        .prepare(
          `
          SELECT DISTINCT b.id, b.root_transaction_id
          FROM bundles b
          JOIN stable_data_items sdi ON b.id = sdi.parent_id OR b.id = sdi.root_transaction_id
          WHERE sdi.height BETWEEN ? AND ?
            AND b.last_fully_indexed_at IS NOT NULL
          `,
        )
        .all(startHeight, endHeight) as any[];

      const allItems: CanonicalDataItem[] = [];

      for (const bundleRow of bundleRows) {
        const bundleTxId = toB64Url(bundleRow.id);
        const rootTxId = bundleRow.root_transaction_id
          ? toB64Url(bundleRow.root_transaction_id)
          : bundleTxId;

        // Skip bundles we can't find in either DB
        const inCore = coreDb
          .prepare('SELECT 1 FROM stable_transactions WHERE id = ? LIMIT 1')
          .get(bundleRow.root_transaction_id ?? bundleRow.id);
        if (!inCore) {
          const inBundles = bundlesDb
            .prepare('SELECT 1 FROM stable_data_items WHERE id = ? LIMIT 1')
            .get(bundleRow.id);
          if (!inBundles) continue;
        }

        try {
          const items = await this.fetchAndParseBundleItems(
            bundlesDb,
            bundleTxId,
            rootTxId,
            startHeight,
            endHeight,
          );
          allItems.push(...items);
        } catch (err: any) {
          console.error(
            `Failed to fetch/parse bundle ${bundleTxId}: ${err.message}`,
          );
        }
      }

      // Sort and deduplicate
      const seen = new Set<string>();
      const deduped = allItems.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });

      deduped.sort((a, b) => {
        if (a.height !== b.height) return a.height - b.height;
        return a.id.localeCompare(b.id);
      });

      return deduped;
    } finally {
      bundlesDb.close();
      coreDb.close();
    }
  }

  private async fetchAndParseBundleItems(
    bundlesDb: Sqlite.Database,
    bundleTxId: string,
    rootTxId: string,
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    let stream: Readable;

    const prefetched = this.prefetchedData.get(bundleTxId);
    if (prefetched) {
      stream = Readable.from(prefetched);
    } else {
      const url = `${this.referenceUrl}/raw/${bundleTxId}`;
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 120000,
      });
      stream = response.data;
    }

    const dataItems = await processBundleStream(stream);

    const heightStmt = bundlesDb.prepare(
      'SELECT height FROM stable_data_items WHERE id = ? LIMIT 1',
    );

    return dataItems.reduce<CanonicalDataItem[]>((acc, di) => {
      const heightRow = heightStmt.get(fromB64Url(di.id)) as any;
      const height = heightRow?.height;

      // Skip items outside our height range
      if (height == null || height < startHeight || height > endHeight) {
        return acc;
      }

      const ownerAddress = sha256B64Url(fromB64Url(di.owner));

      // Parse tags from the raw bundle
      const tags: CanonicalTag[] = di.tags.map((t, i) => ({
        name: t.name,
        value: t.value,
        index: i,
      }));

      // Extract content type from tags (first match wins)
      let contentType: string | null = null;
      for (const tag of di.tags) {
        if (tag.name.toLowerCase() === 'content-type') {
          contentType = tag.value;
          break;
        }
      }

      acc.push({
        id: di.id,
        parentId: bundleTxId,
        rootTransactionId: rootTxId,
        height,
        ownerAddress,
        target: di.target,
        anchor: di.anchor,
        dataSize: di.dataSize,
        dataOffset: di.dataOffset,
        offset: di.offset,
        size: di.size,
        ownerOffset: di.ownerOffset,
        ownerSize: di.ownerSize,
        signatureOffset: di.signatureOffset,
        signatureSize: di.signatureSize,
        rootParentOffset: null, // not available from raw parsing
        contentType,
        signatureType: di.signatureType,
        tags,
      });
      return acc;
    }, []);
  }
}
