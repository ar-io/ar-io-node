/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ClickHouseClient, createClient } from '@clickhouse/client';

import { hexToB64Url } from '../../../lib/encoding.js';
import {
  CanonicalDataItem,
  CanonicalTag,
  CanonicalTransaction,
  SourceAdapter,
} from '../types.js';

function mapTags(tags: any[], tagsCount: number): CanonicalTag[] {
  if (tagsCount === 0) return [];
  return tags.map((tag: any, i: number) => ({
    name: Buffer.from(tag[0], 'hex').toString('utf8'),
    value: Buffer.from(tag[1], 'hex').toString('utf8'),
    index: i,
  }));
}

export class ClickHouseSource implements SourceAdapter {
  name = 'clickhouse';
  private client: ClickHouseClient;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]> {
    const result = await this.client.query({
      query: `
        SELECT
          hex(id) AS id,
          hex(parent_id) AS parent_id,
          hex(root_transaction_id) AS root_transaction_id,
          height,
          hex(owner_address) AS owner_address,
          hex(target) AS target,
          hex(anchor) AS anchor,
          data_size,
          data_offset,
          "offset",
          "size",
          owner_offset,
          owner_size,
          signature_offset,
          signature_size,
          root_parent_offset,
          content_type,
          signature_type,
          tags_count,
          arrayMap(x -> (hex(x.1), hex(x.2)), tags) AS tags
        FROM transactions FINAL
        WHERE is_data_item = true
          AND height >= {start: UInt32}
          AND height <= {end: UInt32}
        ORDER BY height, id
      `,
      query_params: { start: startHeight, end: endHeight },
    });

    const rows = (await result.json()).data as any[];

    return rows.map((row) => ({
      id: hexToB64Url(row.id),
      parentId: row.parent_id ? hexToB64Url(row.parent_id) : '',
      rootTransactionId: row.root_transaction_id
        ? hexToB64Url(row.root_transaction_id)
        : '',
      height: Number(row.height),
      ownerAddress: row.owner_address ? hexToB64Url(row.owner_address) : '',
      target: row.target ? hexToB64Url(row.target) : '',
      anchor: row.anchor ? hexToB64Url(row.anchor) : '',
      dataSize: Number(row.data_size),
      dataOffset: row.data_offset != null ? Number(row.data_offset) : null,
      offset: row.offset != null ? Number(row.offset) : null,
      size: row.size != null ? Number(row.size) : null,
      ownerOffset: row.owner_offset != null ? Number(row.owner_offset) : null,
      ownerSize: row.owner_size != null ? Number(row.owner_size) : null,
      signatureOffset:
        row.signature_offset != null ? Number(row.signature_offset) : null,
      signatureSize:
        row.signature_size != null ? Number(row.signature_size) : null,
      rootParentOffset:
        row.root_parent_offset != null ? Number(row.root_parent_offset) : null,
      contentType: row.content_type || null,
      signatureType:
        row.signature_type != null ? Number(row.signature_type) : null,
      tags: mapTags(row.tags, row.tags_count),
    }));
  }

  async getTransactions(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalTransaction[]> {
    const result = await this.client.query({
      query: `
        SELECT
          hex(id) AS id,
          height,
          block_transaction_index,
          hex(target) AS target,
          toString(quantity) AS quantity,
          toString(reward) AS reward,
          hex(anchor) AS anchor,
          data_size,
          content_type,
          format,
          hex(owner_address) AS owner_address,
          hex(data_root) AS data_root,
          "offset",
          tags_count,
          arrayMap(x -> (hex(x.1), hex(x.2)), tags) AS tags
        FROM transactions FINAL
        WHERE is_data_item = false
          AND height >= {start: UInt32}
          AND height <= {end: UInt32}
        ORDER BY height, id
      `,
      query_params: { start: startHeight, end: endHeight },
    });

    const rows = (await result.json()).data as any[];

    return rows.map((row) => ({
      id: hexToB64Url(row.id),
      height: Number(row.height),
      blockTransactionIndex: Number(row.block_transaction_index),
      target: row.target ? hexToB64Url(row.target) : '',
      quantity: String(row.quantity ?? '0'),
      reward: String(row.reward ?? '0'),
      anchor: row.anchor ? hexToB64Url(row.anchor) : '',
      dataSize: Number(row.data_size),
      contentType: row.content_type || null,
      format: Number(row.format),
      ownerAddress: row.owner_address ? hexToB64Url(row.owner_address) : '',
      dataRoot: row.data_root ? hexToB64Url(row.data_root) : '',
      offset: row.offset != null ? Number(row.offset) : null,
      tags: mapTags(row.tags, row.tags_count),
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
