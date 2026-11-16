/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DataItemRootIndex, RootTxLookupResult } from '../types.js';
import {
  queuedBundleItem,
  resolveQueuedBundleRoot,
} from './queue-bundle-root.js';

const index = (
  answer: RootTxLookupResult | undefined | Error,
): DataItemRootIndex => ({
  getRootTx: async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

/**
 * A composite-like index over sources in order: the first result the
 * caller's accept predicate takes wins, else the first result as fallback.
 */
const sources = (...answers: RootTxLookupResult[]): DataItemRootIndex => ({
  getRootTx: async (_id, opts) =>
    answers.find((a) => opts?.accept?.(a) ?? true) ?? answers[0],
});

describe('resolveQueuedBundleRoot', () => {
  const id = 'bundle-id';

  it('places a nested bundle at its root, from its payload offset', async () => {
    assert.deepEqual(
      await resolveQueuedBundleRoot(
        id,
        index({ rootTxId: 'l1-root', rootOffset: 1000, rootDataOffset: 1260 }),
      ),
      { kind: 'nested', rootTxId: 'l1-root', rootParentOffset: 1260 },
    );
  });

  it('treats an ID that is its own root as L1', async () => {
    assert.deepEqual(
      await resolveQueuedBundleRoot(id, index({ rootTxId: id })),
      { kind: 'l1' },
    );
  });

  it('treats an ID no source can place as L1, as before', async () => {
    assert.deepEqual(await resolveQueuedBundleRoot(id, index(undefined)), {
      kind: 'l1',
    });
    assert.deepEqual(
      await resolveQueuedBundleRoot(id, index(new Error('lookup failed'))),
      { kind: 'l1' },
    );
  });

  it('refuses to guess offsets for a nested bundle whose offset is unknown', async () => {
    assert.deepEqual(
      await resolveQueuedBundleRoot(id, index({ rootTxId: 'l1-root' })),
      { kind: 'unresolved', rootTxId: 'l1-root' },
    );
  });

  it('keeps looking past a root without an offset (GraphQL, deeply nested)', async () => {
    assert.deepEqual(
      await resolveQueuedBundleRoot(
        id,
        sources(
          { rootTxId: 'l1-root', path: ['l1-root', 'outer', id] },
          { rootTxId: 'l1-root', rootOffset: 900, rootDataOffset: 1100 },
        ),
      ),
      { kind: 'nested', rootTxId: 'l1-root', rootParentOffset: 1100 },
    );
  });

  describe('queuedBundleItem', () => {
    it('queues a nested bundle at its L1 root and payload offset', () => {
      assert.deepEqual(
        queuedBundleItem(id, {
          kind: 'nested',
          rootTxId: 'l1-root',
          rootParentOffset: 1260,
        }),
        {
          id,
          root_tx_id: 'l1-root',
          root_parent_offset: 1260,
          data_offset: 0,
        },
      );
    });

    it('queues an L1 bundle as its own root', () => {
      assert.deepEqual(queuedBundleItem(id, { kind: 'l1' }), {
        id,
        root_tx_id: id,
      });
    });
  });
});
