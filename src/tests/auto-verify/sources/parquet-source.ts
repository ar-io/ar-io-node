/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Database } from 'duckdb-async';
import path from 'node:path';

import { toB64Url } from '../../../lib/encoding.js';
import { CanonicalDataItem, CanonicalTag, SourceAdapter } from '../types.js';

export class ParquetSource implements SourceAdapter {
  name = 'parquet';
  private stagingDir: string;

  constructor(stagingDir: string) {
    this.stagingDir = stagingDir;
  }

  async getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    const db = await Database.create(':memory:');

    try {
      const txGlob = path.join(
        this.stagingDir,
        'transactions',
        '**',
        '*.parquet',
      );
      const tagsGlob = path.join(this.stagingDir, 'tags', '**', '*.parquet');

      const rows = await db.all(
        `
        SELECT
          id,
          parent AS parent_id,
          root_transaction_id,
          height,
          owner_address,
          target,
          anchor,
          data_size,
          data_offset,
          "offset",
          size,
          owner_offset,
          owner_size,
          signature_offset,
          signature_size,
          root_parent_offset,
          content_type,
          signature_type
        FROM read_parquet('${txGlob}', hive_partitioning=false)
        WHERE is_data_item = true
          AND height >= ${startHeight}
          AND height <= ${endHeight}
        ORDER BY height, id
        `,
      );

      const tagRows = await db.all(
        `
        SELECT
          id,
          tag_index,
          tag_name,
          tag_value
        FROM read_parquet('${tagsGlob}', hive_partitioning=false)
        WHERE is_data_item = true
          AND height >= ${startHeight}
          AND height <= ${endHeight}
        ORDER BY id, tag_index
        `,
      );

      // Group tags by data item id
      const tagsByItemId = new Map<string, CanonicalTag[]>();
      for (const t of tagRows) {
        const itemId = toB64Url(Buffer.from(t.id));
        if (!tagsByItemId.has(itemId)) {
          tagsByItemId.set(itemId, []);
        }
        tagsByItemId.get(itemId)!.push({
          name: Buffer.from(t.tag_name).toString('utf8'),
          value: Buffer.from(t.tag_value).toString('utf8'),
          index: t.tag_index,
        });
      }

      return rows.map((row) => {
        const id = toB64Url(Buffer.from(row.id));
        return {
          id,
          parentId: row.parent_id ? toB64Url(Buffer.from(row.parent_id)) : '',
          rootTransactionId: row.root_transaction_id
            ? toB64Url(Buffer.from(row.root_transaction_id))
            : '',
          height: Number(row.height),
          ownerAddress: row.owner_address
            ? toB64Url(Buffer.from(row.owner_address))
            : '',
          target: row.target ? toB64Url(Buffer.from(row.target)) : '',
          anchor: row.anchor ? toB64Url(Buffer.from(row.anchor)) : '',
          dataSize: Number(row.data_size),
          dataOffset: row.data_offset != null ? Number(row.data_offset) : null,
          offset: row.offset != null ? Number(row.offset) : null,
          size: row.size != null ? Number(row.size) : null,
          ownerOffset: row.owner_offset != null ? Number(row.owner_offset) : null,
          ownerSize: row.owner_size != null ? Number(row.owner_size) : null,
          signatureOffset: row.signature_offset != null ? Number(row.signature_offset) : null,
          signatureSize: row.signature_size != null ? Number(row.signature_size) : null,
          rootParentOffset: row.root_parent_offset != null ? Number(row.root_parent_offset) : null,
          contentType: row.content_type ?? null,
          signatureType:
            row.signature_type != null ? Number(row.signature_type) : null,
          tags: tagsByItemId.get(id) ?? [],
        };
      });
    } finally {
      await db.close();
    }
  }
}
