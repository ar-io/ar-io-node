/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DataItemRootIndex, RootTxLookupResult } from '../types.js';
import { resolveQueuedBundleRoot } from './queue-bundle-root.js';

const index = (
  answer: RootTxLookupResult | undefined | Error,
): DataItemRootIndex => ({
  getRootTx: async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  },
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
});
