/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildRootTxOffsets } from './ar-io-offsets-builder.js';
import { ContiguousDataAttributes } from '../types.js';

const ROOT_TX_ID = 'MOXw-sA3FeiSRCfXlohVkwKKoUioYYIFmSawV3UzgSg';
const PARENT_ID = 'LPMc8z6reldKo_KitgnV6i3RgHnFLAKnn5jDK7ar4qo';

function attributes(
  overrides: Partial<ContiguousDataAttributes> = {},
): ContiguousDataAttributes {
  return {
    size: 17,
    offset: 0,
    verified: false,
    rootTransactionId: ROOT_TX_ID,
    rootDataItemOffset: 19512,
    rootDataOffset: 20788,
    itemSize: 1293,
    contentType: 'application/json',
    ...overrides,
  } as ContiguousDataAttributes;
}

describe('buildRootTxOffsets', () => {
  it('projects indexed attributes into the offsets response', () => {
    const result = buildRootTxOffsets(attributes({ parentId: PARENT_ID }));

    assert.deepEqual(result, {
      rootTxId: ROOT_TX_ID,
      path: undefined,
      rootOffset: 19512,
      rootDataOffset: 20788,
      contentType: 'application/json',
      size: 1293,
      dataSize: 17,
    });
  });

  it('returns undefined when the ID is unknown to this node', () => {
    assert.equal(buildRootTxOffsets(undefined), undefined);
  });

  it('returns undefined when no root transaction is indexed', () => {
    assert.equal(
      buildRootTxOffsets(attributes({ rootTransactionId: undefined })),
      undefined,
    );
  });

  it('derives a traversal path when the parent is the root bundle', () => {
    const result = buildRootTxOffsets(attributes({ parentId: ROOT_TX_ID }));

    assert.deepEqual(result?.path, [ROOT_TX_ID]);
  });

  it('omits the path for multi-level nesting it cannot walk', () => {
    const result = buildRootTxOffsets(attributes({ parentId: PARENT_ID }));

    assert.equal(result?.path, undefined);
  });

  it('omits the path when no parent is recorded', () => {
    const result = buildRootTxOffsets(attributes({ parentId: undefined }));

    assert.equal(result?.path, undefined);
  });

  // The whole point of the endpoint: an item that has been unbundled and
  // indexed resolves even when none of its bytes are cached locally, so no
  // field here may depend on cache-side state.
  it('resolves offsets without any cached data present', () => {
    const result = buildRootTxOffsets(
      attributes({ hash: undefined, parentId: PARENT_ID }),
    );

    assert.equal(result?.rootTxId, ROOT_TX_ID);
    assert.equal(result?.rootOffset, 19512);
    assert.equal(result?.rootDataOffset, 20788);
  });

  it('passes through partial offsets rather than dropping the result', () => {
    const result = buildRootTxOffsets(
      attributes({ rootDataItemOffset: undefined, rootDataOffset: undefined }),
    );

    assert.equal(result?.rootTxId, ROOT_TX_ID);
    assert.equal(result?.rootOffset, undefined);
    assert.equal(result?.rootDataOffset, undefined);
  });
});
