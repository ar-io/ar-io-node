/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { BufferByteRangeSource } from '../../../../test/buffer-byte-range-source.js';
import {
  malformedTagCountRoot,
  MalformedTagCountRoot,
} from '../../../../test/malformed-tag-count-item.js';
import type { ByteRangeSource } from '../../../lib/byte-range-source.js';
import { fromB64Url } from '../../../lib/encoding.js';
import {
  GatewayReads,
  ReadBudgetError,
  ReadUnavailableError,
} from './gateway-reads.js';

const ROOT = Buffer.alloc(32, 9);

describe('GatewayReads', () => {
  let fixture: MalformedTagCountRoot;

  before(async () => {
    fixture = await malformedTagCountRoot();
  });

  const reads = (maxReads = 100) =>
    new GatewayReads(() => new BufferByteRangeSource(fixture.root), {
      maxReads,
      retryDelayMs: 1,
    });

  it("takes a header with a malformed tag count as the item's, by its id and length, and counts it", async () => {
    const { item, other } = fixture;
    const gateway = reads();
    const length = item.rootDataOffset - item.rootOffset;
    assert.equal(
      await gateway.headerIs(ROOT, item.rootOffset, length, item.rawId),
      true,
    );
    assert.equal(gateway.malformedTags, 1);
    // Still not another item's, nor another length, nor somewhere else.
    assert.equal(
      await gateway.headerIs(
        ROOT,
        item.rootOffset,
        length,
        fromB64Url(other.id),
      ),
      false,
    );
    assert.equal(
      await gateway.headerIs(ROOT, item.rootOffset, length + 1, item.rawId),
      false,
    );
    assert.equal(
      await gateway.headerIs(ROOT, item.rootOffset + 1, length, item.rawId),
      false,
    );
    // Past the root: no.
    assert.equal(
      await gateway.headerIs(
        ROOT,
        fixture.root.length - 10,
        length,
        item.rawId,
      ),
      false,
    );
    assert.equal(gateway.malformedTags, 1);
    // A well-formed header is not counted.
    assert.equal(
      await gateway.headerIs(
        ROOT,
        other.rootOffset,
        other.rootDataOffset - other.rootOffset,
        fromB64Url(other.id),
      ),
      true,
    );
    assert.equal(gateway.malformedTags, 1);
  });

  it('retries a read that failed in transport, then stops; and keeps to its budget', async () => {
    let tries = 0;
    const failing = new GatewayReads(
      (): ByteRangeSource =>
        ({
          read: async () => {
            tries += 1;
            throw new Error('Request failed with status code 503');
          },
          close: async () => undefined,
        }) as unknown as ByteRangeSource,
      { maxReads: 10, retries: 2, retryDelayMs: 1 },
    );
    await assert.rejects(failing.read(ROOT, 0, 10), ReadUnavailableError);
    assert.equal(tries, 3);
    const budget = reads(1);
    await budget.read(ROOT, 0, 10);
    await assert.rejects(budget.read(ROOT, 0, 10), ReadBudgetError);
  });
});
