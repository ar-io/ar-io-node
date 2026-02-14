/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite from 'better-sqlite3';
import axios from 'axios';
import { Readable } from 'node:stream';

import { processBundleStream } from '../../../lib/bundles.js';
import { fromB64Url, sha256B64Url, toB64Url } from '../../../lib/encoding.js';
import { CanonicalDataItem, CanonicalTag, SourceAdapter } from '../types.js';

export class BundleParserSource implements SourceAdapter {
  name = 'bundle-parser';
  private bundlesDbPath: string;
  private coreDbPath: string;
  private referenceUrl: string;

  constructor(bundlesDbPath: string, coreDbPath: string, referenceUrl: string) {
    this.bundlesDbPath = bundlesDbPath;
    this.coreDbPath = coreDbPath;
    this.referenceUrl = referenceUrl;
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

        // Look up the height from core DB or bundles DB
        const heightRow = coreDb
          .prepare(
            `
            SELECT height FROM stable_transactions WHERE id = ?
            UNION
            SELECT height FROM new_transactions WHERE id = ?
            LIMIT 1
            `,
          )
          .get(
            bundleRow.root_transaction_id ?? bundleRow.id,
            bundleRow.root_transaction_id ?? bundleRow.id,
          ) as any;

        const bundleHeight = heightRow?.height;
        if (bundleHeight == null) {
          // Could be a nested bundle; try bundles DB
          const diRow = bundlesDb
            .prepare(
              `SELECT height FROM stable_data_items WHERE id = ? LIMIT 1`,
            )
            .get(bundleRow.id) as any;
          if (!diRow) continue;
        }

        try {
          const items = await this.fetchAndParseBundleItems(
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
    bundleTxId: string,
    rootTxId: string,
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    const url = `${this.referenceUrl}/raw/${bundleTxId}`;

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 120000,
    });

    const stream: Readable = response.data;
    const dataItems = await processBundleStream(stream);

    // Look up height for these data items from the bundles DB
    const bundlesDb = new Sqlite(this.bundlesDbPath, { readonly: true });
    try {
      const heightStmt = bundlesDb.prepare(
        `SELECT height FROM stable_data_items WHERE id = ? LIMIT 1`,
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

          // Extract content type from tags
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
            contentType,
            signatureType: di.signatureType,
            tags,
          });
          return acc;
        }, []);
    } finally {
      bundlesDb.close();
    }
  }
}
