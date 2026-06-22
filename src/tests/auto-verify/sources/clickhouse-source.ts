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
  CanonicalUnstableDataItem,
  CanonicalUnstableTransaction,
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

  async getUnstableDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalUnstableDataItem[]> {
    const result = await this.client.query({
      query: `
        SELECT
          hex(t.id) AS id,
          hex(t.parent_id) AS parent_id,
          hex(t.root_transaction_id) AS root_transaction_id,
          t.height AS height,
          t.block_transaction_index AS block_transaction_index,
          hex(t.owner_address) AS owner_address,
          hex(t.target) AS target,
          hex(t.anchor) AS anchor,
          t.data_size AS data_size,
          t.content_type AS content_type,
          t.signature_type AS signature_type,
          hex(t.signature) AS signature,
          hex(t.owner) AS owner,
          hex(t.block_indep_hash) AS block_indep_hash,
          t.block_timestamp AS block_timestamp,
          hex(t.block_previous_block) AS block_previous_block,
          t.tags_count AS tags_count,
          arrayMap(x -> (hex(x.1), hex(x.2)), t.tags) AS tags
        FROM new_transactions FINAL t
        WHERE t.is_data_item = true
          AND (t.height, t.block_indep_hash) IN
            (SELECT height, indep_hash FROM new_blocks FINAL)
          AND t.height BETWEEN {start: UInt32} AND {end: UInt32}
        ORDER BY t.height, t.id
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
      blockTransactionIndex: Number(row.block_transaction_index),
      ownerAddress: row.owner_address ? hexToB64Url(row.owner_address) : '',
      target: row.target ? hexToB64Url(row.target) : '',
      anchor: row.anchor ? hexToB64Url(row.anchor) : '',
      dataSize: Number(row.data_size),
      contentType: row.content_type || null,
      signatureType:
        row.signature_type != null ? Number(row.signature_type) : null,
      signature: row.signature ? hexToB64Url(row.signature) : null,
      owner: row.owner ? hexToB64Url(row.owner) : '',
      blockIndepHash: row.block_indep_hash
        ? hexToB64Url(row.block_indep_hash)
        : '',
      blockTimestamp: Number(row.block_timestamp),
      blockPreviousBlock: row.block_previous_block
        ? hexToB64Url(row.block_previous_block)
        : '',
      tags: mapTags(row.tags, row.tags_count),
    }));
  }

  async getUnstableTransactions(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalUnstableTransaction[]> {
    const result = await this.client.query({
      query: `
        SELECT
          hex(t.id) AS id,
          t.height AS height,
          t.block_transaction_index AS block_transaction_index,
          hex(t.target) AS target,
          toString(t.quantity) AS quantity,
          toString(t.reward) AS reward,
          hex(t.anchor) AS anchor,
          t.data_size AS data_size,
          t.content_type AS content_type,
          t.format AS format,
          hex(t.owner_address) AS owner_address,
          hex(t.data_root) AS data_root,
          hex(t.signature) AS signature,
          hex(t.owner) AS owner,
          hex(t.block_indep_hash) AS block_indep_hash,
          t.block_timestamp AS block_timestamp,
          hex(t.block_previous_block) AS block_previous_block,
          t.tags_count AS tags_count,
          arrayMap(x -> (hex(x.1), hex(x.2)), t.tags) AS tags
        FROM new_transactions FINAL t
        WHERE t.is_data_item = false
          AND (t.height, t.block_indep_hash) IN
            (SELECT height, indep_hash FROM new_blocks FINAL)
          AND t.height BETWEEN {start: UInt32} AND {end: UInt32}
        ORDER BY t.height, t.id
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
      signature: row.signature ? hexToB64Url(row.signature) : null,
      owner: row.owner ? hexToB64Url(row.owner) : '',
      blockIndepHash: row.block_indep_hash
        ? hexToB64Url(row.block_indep_hash)
        : '',
      blockTimestamp: Number(row.block_timestamp),
      blockPreviousBlock: row.block_previous_block
        ? hexToB64Url(row.block_previous_block)
        : '',
      tags: mapTags(row.tags, row.tags_count),
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
