/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite from 'better-sqlite3';

import { toB64Url } from '../../../lib/encoding.js';
import {
  CanonicalBlock,
  CanonicalDataItem,
  CanonicalTag,
  CanonicalTransaction,
  CanonicalUnstableDataItem,
  CanonicalUnstableTransaction,
  SourceAdapter,
} from '../types.js';

function mapTagRows(tagRows: any[]): CanonicalTag[] {
  return tagRows.map((t) => ({
    name: Buffer.from(t.tag_name).toString('utf8'),
    value: Buffer.from(t.tag_value).toString('utf8'),
    index: t.tag_index,
  }));
}

export class SqliteSource implements SourceAdapter {
  name = 'sqlite';
  private bundlesDbPath: string;
  private coreDbPath: string;

  constructor(bundlesDbPath: string, coreDbPath: string) {
    this.bundlesDbPath = bundlesDbPath;
    this.coreDbPath = coreDbPath;
  }

  async getBlocks(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalBlock[]> {
    const db = new Sqlite(this.coreDbPath, { readonly: true });

    try {
      const rows = db
        .prepare(
          `
          SELECT
            sb.indep_hash,
            sb.height,
            sb.previous_block,
            sb.nonce,
            sb.hash,
            sb.block_timestamp,
            sb.tx_count,
            sb.block_size
          FROM stable_blocks sb
          WHERE sb.height BETWEEN ? AND ?
          ORDER BY sb.height
          `,
        )
        .all(startHeight, endHeight) as any[];

      return rows.map((row) => ({
        indepHash: toB64Url(row.indep_hash),
        height: row.height,
        previousBlock: row.previous_block ? toB64Url(row.previous_block) : '',
        nonce: toB64Url(row.nonce),
        hash: toB64Url(row.hash),
        blockTimestamp: row.block_timestamp,
        txCount: row.tx_count,
        blockSize: row.block_size ?? null,
      }));
    } finally {
      db.close();
    }
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
            sdi."offset",
            sdi.size,
            sdi.owner_offset,
            sdi.owner_size,
            sdi.signature_offset,
            sdi.signature_size,
            sdi.root_parent_offset,
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
        const tags = mapTagRows(tagStmt.all(row.id) as any[]);

        return {
          id: toB64Url(row.id),
          parentId: toB64Url(row.parent_id),
          rootTransactionId: toB64Url(row.root_transaction_id),
          height: row.height,
          ownerAddress: toB64Url(row.owner_address),
          target: row.target ? toB64Url(row.target) : '',
          anchor: toB64Url(row.anchor),
          dataSize: row.data_size,
          dataOffset: row.data_offset ?? null,
          offset: row.offset ?? null,
          size: row.size ?? null,
          ownerOffset: row.owner_offset ?? null,
          ownerSize: row.owner_size ?? null,
          signatureOffset: row.signature_offset ?? null,
          signatureSize: row.signature_size ?? null,
          rootParentOffset: row.root_parent_offset ?? null,
          contentType: row.content_type ?? null,
          signatureType: row.signature_type ?? null,
          tags,
        };
      });
    } finally {
      db.close();
    }
  }

  async getTransactions(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalTransaction[]> {
    const db = new Sqlite(this.coreDbPath, { readonly: true });

    try {
      const rows = db
        .prepare(
          `
          SELECT
            st.id,
            st.height,
            st.block_transaction_index,
            st.target,
            st.quantity,
            st.reward,
            st.last_tx,
            st.data_size,
            st.content_type,
            st.format,
            st.owner_address,
            st.data_root,
            st."offset"
          FROM stable_transactions st
          WHERE st.height BETWEEN ? AND ?
          ORDER BY st.height, st.id
          `,
        )
        .all(startHeight, endHeight) as any[];

      const tagStmt = db.prepare(
        `
        SELECT
          stt.transaction_tag_index AS tag_index,
          tn.name AS tag_name,
          tv.value AS tag_value
        FROM stable_transaction_tags stt
        JOIN tag_names tn ON stt.tag_name_hash = tn.hash
        JOIN tag_values tv ON stt.tag_value_hash = tv.hash
        WHERE stt.transaction_id = ?
        ORDER BY stt.transaction_tag_index
        `,
      );

      return rows.map((row) => {
        const tags = mapTagRows(tagStmt.all(row.id) as any[]);

        return {
          id: toB64Url(row.id),
          height: row.height,
          blockTransactionIndex: row.block_transaction_index,
          target: row.target ? toB64Url(row.target) : '',
          quantity: String(row.quantity ?? '0'),
          reward: String(row.reward ?? '0'),
          anchor: toB64Url(row.last_tx),
          dataSize: row.data_size,
          contentType: row.content_type ?? null,
          format: row.format,
          ownerAddress: toB64Url(row.owner_address),
          dataRoot: row.data_root ? toB64Url(row.data_root) : '',
          offset: row.offset ?? null,
          tags,
        };
      });
    } finally {
      db.close();
    }
  }

  async getUnstableDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalUnstableDataItem[]> {
    const bundlesDb = new Sqlite(this.bundlesDbPath, { readonly: true });
    const coreDb = new Sqlite(this.coreDbPath, { readonly: true });

    try {
      const dataItemRows = bundlesDb
        .prepare(
          `
          SELECT
            ndi.id,
            ndi.parent_id,
            ndi.root_transaction_id,
            ndi.height,
            ndi.owner_address,
            ndi.target,
            ndi.anchor,
            ndi.data_size,
            ndi.content_type,
            ndi.signature_type,
            ndi.signature
          FROM new_data_items ndi
          WHERE ndi.height BETWEEN ? AND ?
          ORDER BY ndi.height, ndi.id
          `,
        )
        .all(startHeight, endHeight) as any[];

      if (dataItemRows.length === 0) return [];

      const tagStmt = bundlesDb.prepare(
        `
        SELECT
          ndit.data_item_tag_index AS tag_index,
          tn.name AS tag_name,
          tv.value AS tag_value
        FROM new_data_item_tags ndit
        JOIN tag_names tn ON ndit.tag_name_hash = tn.hash
        JOIN tag_values tv ON ndit.tag_value_hash = tv.hash
        WHERE ndit.data_item_id = ?
        ORDER BY ndit.data_item_tag_index
        `,
      );

      // Block context for unstable data items isn't denormalized on
      // new_data_items the way it is on the ClickHouse sibling — derive it
      // from new_block_transactions joined to new_blocks via the bundle's
      // root_transaction_id. The wallets table provides the inline RSA
      // modulus keyed on owner_address.
      const blockCtxStmt = coreDb.prepare(
        `
        SELECT
          nbt.block_transaction_index,
          nb.indep_hash AS block_indep_hash,
          nb.block_timestamp,
          nb.previous_block AS block_previous_block
        FROM new_block_transactions nbt
        JOIN new_blocks nb ON nbt.block_indep_hash = nb.indep_hash
        WHERE nbt.transaction_id = ?
          AND nbt.height = ?
        LIMIT 1
        `,
      );

      const ownerStmt = coreDb.prepare(
        `SELECT public_modulus FROM wallets WHERE address = ?`,
      );

      return dataItemRows.map((row) => {
        const tags = mapTagRows(tagStmt.all(row.id) as any[]);
        const blockCtx = blockCtxStmt.get(
          row.root_transaction_id,
          row.height,
        ) as any;
        const ownerRow = ownerStmt.get(row.owner_address) as any;

        return {
          id: toB64Url(row.id),
          parentId: toB64Url(row.parent_id),
          rootTransactionId: toB64Url(row.root_transaction_id),
          height: row.height,
          blockTransactionIndex: blockCtx?.block_transaction_index ?? 0,
          ownerAddress: toB64Url(row.owner_address),
          target: row.target ? toB64Url(row.target) : '',
          anchor: toB64Url(row.anchor),
          dataSize: row.data_size,
          contentType: row.content_type ?? null,
          signatureType: row.signature_type ?? null,
          signature: row.signature ? toB64Url(row.signature) : null,
          owner: ownerRow?.public_modulus
            ? toB64Url(ownerRow.public_modulus)
            : '',
          blockIndepHash: blockCtx?.block_indep_hash
            ? toB64Url(blockCtx.block_indep_hash)
            : '',
          blockTimestamp: blockCtx?.block_timestamp ?? 0,
          blockPreviousBlock: blockCtx?.block_previous_block
            ? toB64Url(blockCtx.block_previous_block)
            : '',
          tags,
        };
      });
    } finally {
      bundlesDb.close();
      coreDb.close();
    }
  }

  async getUnstableTransactions(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalUnstableTransaction[]> {
    const db = new Sqlite(this.coreDbPath, { readonly: true });

    try {
      // new_transactions has no block context columns; join through
      // new_block_transactions to new_blocks to recover them, and through
      // wallets to recover the inline RSA modulus from owner_address.
      const rows = db
        .prepare(
          `
          SELECT
            nt.id,
            nt.height,
            nbt.block_transaction_index,
            nt.target,
            nt.quantity,
            nt.reward,
            nt.last_tx,
            nt.data_size,
            nt.content_type,
            nt.format,
            nt.owner_address,
            nt.data_root,
            nt.signature,
            w.public_modulus AS owner,
            nb.indep_hash AS block_indep_hash,
            nb.block_timestamp,
            nb.previous_block AS block_previous_block
          FROM new_transactions nt
          JOIN new_block_transactions nbt
            ON nt.id = nbt.transaction_id AND nt.height = nbt.height
          JOIN new_blocks nb ON nbt.block_indep_hash = nb.indep_hash
          LEFT JOIN wallets w ON nt.owner_address = w.address
          WHERE nt.height BETWEEN ? AND ?
          ORDER BY nt.height, nt.id
          `,
        )
        .all(startHeight, endHeight) as any[];

      if (rows.length === 0) return [];

      const tagStmt = db.prepare(
        `
        SELECT
          ntt.transaction_tag_index AS tag_index,
          tn.name AS tag_name,
          tv.value AS tag_value
        FROM new_transaction_tags ntt
        JOIN tag_names tn ON ntt.tag_name_hash = tn.hash
        JOIN tag_values tv ON ntt.tag_value_hash = tv.hash
        WHERE ntt.transaction_id = ?
        ORDER BY ntt.transaction_tag_index
        `,
      );

      return rows.map((row) => {
        const tags = mapTagRows(tagStmt.all(row.id) as any[]);

        return {
          id: toB64Url(row.id),
          height: row.height,
          blockTransactionIndex: row.block_transaction_index,
          target: row.target ? toB64Url(row.target) : '',
          quantity: String(row.quantity ?? '0'),
          reward: String(row.reward ?? '0'),
          anchor: toB64Url(row.last_tx),
          dataSize: row.data_size,
          contentType: row.content_type ?? null,
          format: row.format,
          ownerAddress: toB64Url(row.owner_address),
          dataRoot: row.data_root ? toB64Url(row.data_root) : '',
          signature: row.signature ? toB64Url(row.signature) : null,
          owner: row.owner ? toB64Url(row.owner) : '',
          blockIndepHash: toB64Url(row.block_indep_hash),
          blockTimestamp: row.block_timestamp,
          blockPreviousBlock: row.block_previous_block
            ? toB64Url(row.block_previous_block)
            : '',
          tags,
        };
      });
    } finally {
      db.close();
    }
  }
}
