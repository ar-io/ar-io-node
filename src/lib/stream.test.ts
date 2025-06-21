/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import { ByteRangeTransform } from './stream.js';

describe('ByteRangeTransform', () => {
  it('should transform a stream within the specified range', async () => {
    const input = Buffer.from('0123456789');
    const readable = Readable.from(input);
    const transform = new ByteRangeTransform(2, 5);

    let result = '';
    for await (const chunk of readable.pipe(transform)) {
      result += chunk.toString();
    }
    assert.equal(result, '23456');
  });

  it('should handle offset larger than input', async () => {
    const input = Buffer.from('0123456789');
    const readable = Readable.from(input);
    const transform = new ByteRangeTransform(15, 5);

    let result = '';
    for await (const chunk of readable.pipe(transform)) {
      result += chunk.toString();
    }
    assert.equal(result, '');
  });

  it('should handle size larger than remaining input', async () => {
    const input = Buffer.from('0123456789');
    const readable = Readable.from(input);
    const transform = new ByteRangeTransform(8, 5);

    let result = '';
    for await (const chunk of readable.pipe(transform)) {
      result += chunk.toString();
    }
    assert.equal(result, '89');
  });

  it('should handle multiple chunks', async () => {
    const input1 = Buffer.from('01234');
    const input2 = Buffer.from('56789');
    const readable = Readable.from([input1, input2]);
    const transform = new ByteRangeTransform(3, 5);

    let result = '';
    for await (const chunk of readable.pipe(transform)) {
      result += chunk.toString();
    }
    assert.equal(result, '34567');
  });

  it('should handle zero size', async () => {
    const input = Buffer.from('0123456789');
    const readable = Readable.from(input);
    const transform = new ByteRangeTransform(3, 0);

    let result = '';
    for await (const chunk of readable.pipe(transform)) {
      result += chunk.toString();
    }
    assert.equal(result, '');
  });
});
