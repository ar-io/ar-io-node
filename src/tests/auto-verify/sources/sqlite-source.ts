/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite from 'better-sqlite3';

import { toB64Url, b64UrlToUtf8 } from '../../../lib/encoding.js';
import { CanonicalDataItem, CanonicalTag, SourceAdapter } from '../types.js';

export class SqliteSource implements SourceAdapter {
  name = 'sqlite';
  private bundlesDbPath: string;

  constructor(bundlesDbPath: string) {
    this.bundlesDbPath = bundlesDbPath;
  }

  async getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    const db = new Sqlite(this.bundlesDbPath, { readonly: true });

    try {
      const rows = db
        .prepare(
          `
          SELECT
            sdi.id,
            sdi.parent_id,
            sdi.root_transaction_id,
            sdi.height,
            sdi.owner_address,
            sdi.target,
            sdi.anchor,
            sdi.data_size,
            sdi.data_offset,
            sdi.content_type,
            sdi.signature_type
          FROM stable_data_items sdi
          WHERE sdi.height BETWEEN ? AND ?
          ORDER BY sdi.height, sdi.id
          `,
        )
        .all(startHeight, endHeight) as any[];

      const tagStmt = db.prepare(
        `
        SELECT
          sdit.data_item_tag_index AS tag_index,
          tn.name AS tag_name,
          tv.value AS tag_value
        FROM stable_data_item_tags sdit
        JOIN tag_names tn ON sdit.tag_name_hash = tn.hash
        JOIN tag_values tv ON sdit.tag_value_hash = tv.hash
        WHERE sdit.data_item_id = ?
        ORDER BY sdit.data_item_tag_index
        `,
      );

      return rows.map((row) => {
        const tagRows = tagStmt.all(row.id) as any[];

        const tags: CanonicalTag[] = tagRows.map((t) => ({
          name: Buffer.from(t.tag_name).toString('utf8'),
          value: Buffer.from(t.tag_value).toString('utf8'),
          index: t.tag_index,
        }));

        return {
          id: toB64Url(row.id),
          parentId: toB64Url(row.parent_id),
          rootTransactionId: toB64Url(row.root_transaction_id),
          height: row.height,
          ownerAddress: toB64Url(row.owner_address),
          target: row.target ? toB64Url(row.target) : '',
          anchor: toB64Url(row.anchor),
          dataSize: row.data_size,
          dataOffset: row.data_offset,
          contentType: row.content_type ?? null,
          signatureType: row.signature_type ?? null,
          tags,
        };
      });
    } finally {
      db.close();
    }
  }
}
