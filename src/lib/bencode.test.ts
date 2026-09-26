/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { bdecode, bdecodeWithSpans, bencode, BencodeValue } from './bencode.js';

describe('bencode', () => {
  it('encodes the BEP 3 examples', () => {
    assert.equal(bencode('spam').toString(), '4:spam');
    assert.equal(bencode(3).toString(), 'i3e');
    assert.equal(bencode(-3).toString(), 'i-3e');
    assert.equal(bencode(['spam', 'eggs']).toString(), 'l4:spam4:eggse');
    assert.equal(
      bencode({ spam: ['a', 'b'], cow: 'moo' }).toString(),
      'd3:cow3:moo4:spaml1:a1:bee',
    );
  });

  it('sorts keys by raw bytes, including non-text keys', () => {
    const high = Buffer.from([0xff]).toString('latin1');
    const low = Buffer.from([0x01]).toString('latin1');
    const encoded = bencode({ [high]: 1, [low]: 2 });
    assert.deepEqual(
      encoded,
      Buffer.concat([
        Buffer.from('d1:'),
        Buffer.from([0x01]),
        Buffer.from('i2e1:'),
        Buffer.from([0xff]),
        Buffer.from('i1ee'),
      ]),
    );
  });

  it('refuses a number that is not a safe integer', () => {
    assert.throws(() => bencode(1.5));
    assert.throws(() => bencode(2 ** 60));
  });

  it('round-trips arbitrary values', () => {
    const value: fc.Arbitrary<BencodeValue> = fc.letrec((tie) => ({
      v: fc.oneof(
        { depthSize: 'small' },
        fc.integer(),
        fc.uint8Array({ maxLength: 40 }).map((b) => Buffer.from(b)),
        fc.array(tie('v'), { maxLength: 4 }),
        fc.dictionary(
          fc
            .uint8Array({ maxLength: 8 })
            .map((b) => Buffer.from(b).toString('latin1')),
          tie('v'),
          { maxKeys: 4 },
        ),
      ),
    })).v as fc.Arbitrary<BencodeValue>;
    fc.assert(
      fc.property(value, (v) => {
        const once = bencode(v);
        assert.deepEqual(bencode(bdecode(once)), once);
      }),
    );
  });

  it('rejects encodings that would hash differently from the canonical one', () => {
    for (const bad of [
      'i03e',
      'i-0e',
      'ie',
      '02:ab',
      'd1:b1:x1:a1:ye',
      'd1:a1:x1:a1:ye',
      'i1ei2e',
      'l',
      '5:abc',
    ]) {
      assert.throws(() => bdecode(Buffer.from(bad)), Error, bad);
    }
  });

  it('reports where each top-level value sits', () => {
    const input = Buffer.from('d4:infod1:ai1ee4:name3:fooe');
    const { spans } = bdecodeWithSpans(input);
    const [start, end] = spans.get('info')!;
    assert.equal(input.subarray(start, end).toString(), 'd1:ai1ee');
  });

  it('decodes a __proto__ key as an ordinary key', () => {
    const decoded = bdecode(
      Buffer.from('d9:__proto__d12:meta versioni2eee'),
    ) as Record<string, unknown>;
    assert.equal(decoded['meta version'], undefined, 'nothing inherited');
    assert.ok(Object.prototype.hasOwnProperty.call(decoded, '__proto__'));
  });
});
