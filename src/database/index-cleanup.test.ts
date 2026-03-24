/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it } from 'node:test';
import crypto from 'node:crypto';

import { StandaloneSqliteDatabaseWorker } from '../../src/database/standalone-sqlite.js';
import { fromB64Url, toB64Url } from '../../src/lib/encoding.js';
import {
  bundlesDb,
  bundlesDbPath,
  coreDbPath,
  dataDb,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import log from '../log.js';

let dbWorker: StandaloneSqliteDatabaseWorker;

function insertStableDataItem(
  id: string,
  ownerAddress: Buffer,
  height: number,
  indexedAt: number,
  tags: { name: string; value: string }[] = [],
) {
  const idBuf = fromB64Url(id);
  const parentId = crypto.randomBytes(32);
  const rootTxId = crypto.randomBytes(32);

  bundlesDb
    .prepare(
      `INSERT INTO stable_data_items (
      id, parent_id, root_transaction_id, height, block_transaction_index,
      signature, anchor, owner_address, target, data_offset, data_size,
      content_type, tag_count, indexed_at, signature_offset, signature_size,
      signature_type, owner_offset, owner_size
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 100,
      'application/octet-stream', ?, ?, 0, 64, 1, 0, 32)`,
    )
    .run(
      idBuf,
      parentId,
      rootTxId,
      height,
      Buffer.alloc(64),
      Buffer.alloc(32),
      ownerAddress,
      Buffer.alloc(0),
      tags.length,
      indexedAt,
    );

  tags.forEach((tag, index) => {
    const nameHash = crypto
      .createHash('sha1')
      .update(Buffer.from(tag.name, 'utf8'))
      .digest();
    const valueHash = crypto
      .createHash('sha1')
      .update(Buffer.from(tag.value, 'utf8'))
      .digest();

    bundlesDb
      .prepare(
        `INSERT INTO tag_names (hash, name) VALUES (?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(nameHash, Buffer.from(tag.name, 'utf8'));
    bundlesDb
      .prepare(
        `INSERT INTO tag_values (hash, value) VALUES (?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(valueHash, Buffer.from(tag.value, 'utf8'));
    bundlesDb
      .prepare(
        `INSERT INTO stable_data_item_tags (
        tag_name_hash, tag_value_hash, height, block_transaction_index,
        data_item_tag_index, data_item_id, parent_id, root_transaction_id
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(nameHash, valueHash, height, index, idBuf, parentId, rootTxId);
  });
}

function insertContiguousDataId(id: string) {
  const idBuf = fromB64Url(id);
  const hash = crypto.randomBytes(32);
  const parentId = crypto.randomBytes(32);

  dataDb
    .prepare(
      `INSERT INTO contiguous_data_ids (id, contiguous_data_hash, verified, indexed_at)
       VALUES (?, ?, 0, ?)`,
    )
    .run(idBuf, hash, 1000);
  dataDb
    .prepare(
      `INSERT INTO contiguous_data_id_parents (id, parent_id, data_offset, data_size, indexed_at)
       VALUES (?, ?, 0, 100, ?)`,
    )
    .run(idBuf, parentId, 1000);
}

function countRows(db: any, table: string): number {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

// Generate IDs that sort in a predictable order
const ID1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID2 = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID3 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID4 = 'DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID5 = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID6 = 'FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

before(() => {
  dbWorker = new StandaloneSqliteDatabaseWorker({
    log,
    coreDbPath,
    dataDbPath,
    moderationDbPath,
    bundlesDbPath,
    tagSelectivity: {},
  });
});

describe('Index cleanup', () => {
  describe('getIndexCleanupCandidateIds', () => {
    it('should find data items by owner address', () => {
      const owner1 = crypto.randomBytes(32);
      const owner2 = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner1, 100, 1000);
      insertStableDataItem(ID2, owner2, 100, 1000);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: { owners: [toB64Url(owner1)] },
        limit: 100,
      });
      assert.equal(result.ids.length, 1);
      assert.deepEqual(result.ids[0], fromB64Url(ID1));
    });

    it('should find data items by multiple owner addresses', () => {
      const owner1 = crypto.randomBytes(32);
      const owner2 = crypto.randomBytes(32);
      const owner3 = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner1, 100, 1000);
      insertStableDataItem(ID2, owner2, 100, 1000);
      insertStableDataItem(ID3, owner3, 100, 1000);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: { owners: [toB64Url(owner1), toB64Url(owner2)] },
        limit: 100,
      });
      assert.equal(result.ids.length, 2);
    });

    it('should find data items by tag', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000, [
        { name: 'App-Name', value: 'ArDrive' },
      ]);
      insertStableDataItem(ID2, owner, 100, 1000, [
        { name: 'App-Name', value: 'Other' },
      ]);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: { tags: [{ name: 'App-Name', values: ['ArDrive'] }] },
        limit: 100,
      });
      assert.equal(result.ids.length, 1);
      assert.deepEqual(result.ids[0], fromB64Url(ID1));
    });

    it('should find data items by multiple tags (AND logic)', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000, [
        { name: 'App-Name', value: 'ArDrive' },
        { name: 'Content-Type', value: 'text/plain' },
      ]);
      insertStableDataItem(ID2, owner, 100, 1000, [
        { name: 'App-Name', value: 'ArDrive' },
        { name: 'Content-Type', value: 'image/png' },
      ]);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: {
          tags: [
            { name: 'App-Name', values: ['ArDrive'] },
            { name: 'Content-Type', values: ['text/plain'] },
          ],
        },
        limit: 100,
      });
      assert.equal(result.ids.length, 1);
      assert.deepEqual(result.ids[0], fromB64Url(ID1));
    });

    it('should find data items by tag with multiple values (OR within tag)', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000, [
        { name: 'App-Name', value: 'ArDrive' },
      ]);
      insertStableDataItem(ID2, owner, 100, 1000, [
        { name: 'App-Name', value: 'Turbo' },
      ]);
      insertStableDataItem(ID3, owner, 100, 1000, [
        { name: 'App-Name', value: 'Other' },
      ]);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: {
          tags: [{ name: 'App-Name', values: ['ArDrive', 'Turbo'] }],
        },
        limit: 100,
      });
      assert.equal(result.ids.length, 2);
    });

    it('should find data items by indexed_at threshold', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 500);
      insertStableDataItem(ID2, owner, 100, 2000);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: { maxIndexedAt: 1000 },
        limit: 100,
      });
      assert.equal(result.ids.length, 1);
      assert.deepEqual(result.ids[0], fromB64Url(ID1));
    });

    it('should find data items by height range', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 50, 1000);
      insertStableDataItem(ID2, owner, 150, 1000);
      insertStableDataItem(ID3, owner, 250, 1000);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: { minHeight: 100, maxHeight: 200 },
        limit: 100,
      });
      assert.equal(result.ids.length, 1);
      assert.deepEqual(result.ids[0], fromB64Url(ID2));
    });

    it('should support combined filters', () => {
      const owner1 = crypto.randomBytes(32);
      const owner2 = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner1, 100, 500, [
        { name: 'App-Name', value: 'ArDrive' },
      ]);
      insertStableDataItem(ID2, owner2, 100, 500, [
        { name: 'App-Name', value: 'ArDrive' },
      ]);
      insertStableDataItem(ID3, owner1, 100, 2000, [
        { name: 'App-Name', value: 'ArDrive' },
      ]);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: {
          owners: [toB64Url(owner1)],
          tags: [{ name: 'App-Name', values: ['ArDrive'] }],
          maxIndexedAt: 1000,
        },
        limit: 100,
      });
      assert.equal(result.ids.length, 1);
      assert.deepEqual(result.ids[0], fromB64Url(ID1));
    });

    it('should paginate with cursor', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000);
      insertStableDataItem(ID2, owner, 100, 1000);
      insertStableDataItem(ID3, owner, 100, 1000);

      const page1 = dbWorker.getIndexCleanupCandidateIds({
        filter: { owners: [toB64Url(owner)] },
        limit: 2,
      });
      assert.equal(page1.ids.length, 2);
      assert.equal(page1.hasMore, true);

      const page2 = dbWorker.getIndexCleanupCandidateIds({
        filter: { owners: [toB64Url(owner)] },
        limit: 2,
        afterId: page1.ids[page1.ids.length - 1],
      });
      assert.equal(page2.ids.length, 1);
      assert.equal(page2.hasMore, false);
    });

    it('should return empty when no matches', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000);

      const result = dbWorker.getIndexCleanupCandidateIds({
        filter: { owners: [toB64Url(crypto.randomBytes(32))] },
        limit: 100,
      });
      assert.equal(result.ids.length, 0);
      assert.equal(result.hasMore, false);
    });

    it('should throw when filter is empty', () => {
      assert.throws(
        () => {
          dbWorker.getIndexCleanupCandidateIds({
            filter: {},
            limit: 100,
          });
        },
        {
          message: /at least one criterion/i,
        },
      );
    });
  });

  describe('countIndexCleanupCandidates', () => {
    it('should return correct count', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000);
      insertStableDataItem(ID2, owner, 100, 1000);
      insertStableDataItem(ID3, crypto.randomBytes(32), 100, 1000);

      const count = dbWorker.countIndexCleanupCandidates({
        owners: [toB64Url(owner)],
      });
      assert.equal(count, 2);
    });

    it('should not delete anything', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000);

      dbWorker.countIndexCleanupCandidates({
        owners: [toB64Url(owner)],
      });

      assert.equal(countRows(bundlesDb, 'stable_data_items'), 1);
    });

    it('should throw when filter is empty', () => {
      assert.throws(
        () => {
          dbWorker.countIndexCleanupCandidates({});
        },
        {
          message: /at least one criterion/i,
        },
      );
    });
  });

  describe('deleteIndexCleanupBundlesBatch', () => {
    it('should delete stable_data_items and tags', () => {
      const owner = crypto.randomBytes(32);
      insertStableDataItem(ID1, owner, 100, 1000, [
        { name: 'App-Name', value: 'ArDrive' },
      ]);

      const result = dbWorker.deleteIndexCleanupBundlesBatch([fromB64Url(ID1)]);
      assert.equal(result.stableDataItemsDeleted, 1);
      assert.equal(result.stableDataItemTagsDeleted, 1);
      assert.equal(countRows(bundlesDb, 'stable_data_items'), 0);
      assert.equal(countRows(bundlesDb, 'stable_data_item_tags'), 0);
    });

    it('should not delete from bundles or bundle_data_items tables', () => {
      const owner = crypto.randomBytes(32);
      const id = fromB64Url(ID1);
      insertStableDataItem(ID1, owner, 100, 1000);

      // Insert a bundle record
      bundlesDb
        .prepare(
          `INSERT INTO bundles (id, root_transaction_id, format_id)
           VALUES (?, ?, 1)`,
        )
        .run(id, crypto.randomBytes(32));

      // Insert a bundle_data_items record
      bundlesDb
        .prepare(
          `INSERT INTO bundle_data_items (id, parent_id, parent_index, filter_id, root_transaction_id, first_indexed_at, last_indexed_at)
           VALUES (?, ?, 0, 1, ?, ?, ?)`,
        )
        .run(id, crypto.randomBytes(32), crypto.randomBytes(32), 1000, 1000);

      dbWorker.deleteIndexCleanupBundlesBatch([id]);

      assert.equal(countRows(bundlesDb, 'stable_data_items'), 0);
      assert.equal(countRows(bundlesDb, 'bundles'), 1);
      assert.equal(countRows(bundlesDb, 'bundle_data_items'), 1);
    });

    it('should also delete new_data_items and new_data_item_tags', () => {
      const owner = crypto.randomBytes(32);
      const idBuf = fromB64Url(ID1);
      const parentId = crypto.randomBytes(32);
      const rootTxId = crypto.randomBytes(32);
      const nameHash = crypto
        .createHash('sha1')
        .update(Buffer.from('App-Name', 'utf8'))
        .digest();
      const valueHash = crypto
        .createHash('sha1')
        .update(Buffer.from('ArDrive', 'utf8'))
        .digest();

      bundlesDb
        .prepare(
          `INSERT INTO new_data_items (
          id, parent_id, root_transaction_id, height, signature, anchor,
          owner_address, target, data_offset, data_size, content_type,
          tag_count, indexed_at, signature_offset, signature_size,
          signature_type, owner_offset, owner_size
        ) VALUES (?, ?, ?, 100, ?, ?, ?, ?, 0, 100,
          'application/octet-stream', 1, 1000, 0, 64, 1, 0, 32)`,
        )
        .run(
          idBuf,
          parentId,
          rootTxId,
          Buffer.alloc(64),
          Buffer.alloc(32),
          owner,
          Buffer.alloc(0),
        );
      bundlesDb
        .prepare(
          `INSERT INTO tag_names (hash, name) VALUES (?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(nameHash, Buffer.from('App-Name', 'utf8'));
      bundlesDb
        .prepare(
          `INSERT INTO tag_values (hash, value) VALUES (?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(valueHash, Buffer.from('ArDrive', 'utf8'));
      bundlesDb
        .prepare(
          `INSERT INTO new_data_item_tags (
          tag_name_hash, tag_value_hash, height, indexed_at,
          data_item_tag_index, data_item_id, root_transaction_id
        ) VALUES (?, ?, 100, 1000, 0, ?, ?)`,
        )
        .run(nameHash, valueHash, idBuf, rootTxId);

      assert.equal(countRows(bundlesDb, 'new_data_items'), 1);
      assert.equal(countRows(bundlesDb, 'new_data_item_tags'), 1);

      const result = dbWorker.deleteIndexCleanupBundlesBatch([idBuf]);
      assert.equal(result.newDataItemsDeleted, 1);
      assert.equal(result.newDataItemTagsDeleted, 1);
      assert.equal(countRows(bundlesDb, 'new_data_items'), 0);
      assert.equal(countRows(bundlesDb, 'new_data_item_tags'), 0);
    });

    it('should handle empty ID list', () => {
      const result = dbWorker.deleteIndexCleanupBundlesBatch([]);
      assert.equal(result.stableDataItemsDeleted, 0);
      assert.equal(result.stableDataItemTagsDeleted, 0);
    });
  });

  describe('deleteIndexCleanupDataBatch', () => {
    it('should delete contiguous_data_ids and parents', () => {
      insertContiguousDataId(ID1);

      const result = dbWorker.deleteIndexCleanupDataBatch([fromB64Url(ID1)]);
      assert.equal(result.contiguousDataIdsDeleted, 1);
      assert.equal(result.contiguousDataIdParentsDeleted, 1);
      assert.equal(countRows(dataDb, 'contiguous_data_ids'), 0);
      assert.equal(countRows(dataDb, 'contiguous_data_id_parents'), 0);
    });

    it('should not delete from contiguous_data table', () => {
      const hash = crypto.randomBytes(32);
      dataDb
        .prepare(
          `INSERT INTO contiguous_data (hash, data_size, indexed_at) VALUES (?, 100, ?)`,
        )
        .run(hash, 1000);

      const id = fromB64Url(ID1);
      dataDb
        .prepare(
          `INSERT INTO contiguous_data_ids (id, contiguous_data_hash, verified, indexed_at)
           VALUES (?, ?, 0, ?)`,
        )
        .run(id, hash, 1000);

      dbWorker.deleteIndexCleanupDataBatch([id]);

      assert.equal(countRows(dataDb, 'contiguous_data'), 1);
      assert.equal(countRows(dataDb, 'contiguous_data_ids'), 0);
    });

    it('should handle IDs not present in data DB', () => {
      const result = dbWorker.deleteIndexCleanupDataBatch([fromB64Url(ID1)]);
      assert.equal(result.contiguousDataIdsDeleted, 0);
      assert.equal(result.contiguousDataIdParentsDeleted, 0);
    });

    it('should handle empty ID list', () => {
      const result = dbWorker.deleteIndexCleanupDataBatch([]);
      assert.equal(result.contiguousDataIdsDeleted, 0);
      assert.equal(result.contiguousDataIdParentsDeleted, 0);
    });
  });
});
