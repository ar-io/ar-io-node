/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  contentTypeSourceOutranks,
  resolveContentType,
} from './content-type.js';

const MANIFEST = 'application/x.arweave-manifest+json';

describe('resolveContentType', () => {
  it("prefers the item's indexed tag", () => {
    assert.deepStrictEqual(
      resolveContentType({
        indexed: MANIFEST,
        item: 'text/plain',
        itemSource: 'item',
        hash: 'text/html',
      }),
      { contentType: MANIFEST, contentTypeSource: 'indexed' },
    );
  });

  it('prefers the type recorded for the item over the per-hash type', () => {
    for (const itemSource of ['item', 'upstream'] as const) {
      assert.deepStrictEqual(
        resolveContentType({ item: MANIFEST, itemSource, hash: 'text/html' }),
        { contentType: MANIFEST, contentTypeSource: itemSource },
      );
    }
  });

  it('falls back to the per-hash type', () => {
    assert.deepStrictEqual(
      resolveContentType({ item: null, itemSource: null, hash: 'text/html' }),
      { contentType: 'text/html', contentTypeSource: 'hash' },
    );
  });

  it('ignores a recorded type without a known source', () => {
    assert.deepStrictEqual(
      resolveContentType({
        item: MANIFEST,
        itemSource: 'bogus',
        hash: 'text/html',
      }),
      { contentType: 'text/html', contentTypeSource: 'hash' },
    );
  });

  it('reports nothing when nothing is known', () => {
    assert.deepStrictEqual(resolveContentType({}), {
      contentType: undefined,
      contentTypeSource: undefined,
    });
  });
});

describe('contentTypeSourceOutranks', () => {
  it('orders indexed > item > upstream > hash', () => {
    const order = ['hash', 'upstream', 'item', 'indexed'] as const;
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        assert.strictEqual(
          contentTypeSourceOutranks(order[i], order[j]),
          i > j,
          `${order[i]} vs ${order[j]}`,
        );
      }
    }
  });

  it('treats an unranked value as the per-hash fallback', () => {
    assert.strictEqual(contentTypeSourceOutranks('upstream', undefined), true);
    assert.strictEqual(contentTypeSourceOutranks(undefined, 'hash'), false);
    assert.strictEqual(contentTypeSourceOutranks(undefined, undefined), false);
  });
});
