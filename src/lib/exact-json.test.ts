/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { parseJsonExact, quoteLongIntegers } from './exact-json.js';
import { hasRoundedInteger, sanityCheckBlock } from './validation.js';

// Block 600,570 as the chain serves it: reward_pool is a bare number past
// 2^53, which JSON.parse rounds to ...668.
const HEADER_600570 =
  '{"nonce":"x","previous_block":"4vy5NMo9QjuxNG1bE95DZmSHMS1w_wrCpBrpakYaYfsiU8EJV8nIuHtsZq_Aq_KE",' +
  '"timestamp":1609102030,"height":600570,"reward_pool":12774234261122667,' +
  '"indep_hash":"lJHaGZxBgTWPp4KLJzQFXK3qKoAGOFWfcn0pyygNNuftoc9fhPNY6TnSHWIj6faJ","txs":[]}';

describe('parseJsonExact', () => {
  it('keeps a pre-2.4 reward_pool past 2^53 exact, where JSON.parse rounds it', () => {
    assert.equal(
      (JSON.parse(HEADER_600570) as { reward_pool: number }).reward_pool,
      12774234261122668,
    );
    const block = parseJsonExact(HEADER_600570) as Record<string, unknown>;
    assert.equal(block.reward_pool, '12774234261122667');
    assert.equal(block.height, 600570);
    assert.equal(block.timestamp, 1609102030);
  });

  it('quotes only integer literals of 16 or more digits in value position', () => {
    assert.equal(
      quoteLongIntegers(
        '{"a":1234567890123456,"b":[-12345678901234567, 1],"c":123456789012345}',
      ),
      '{"a":"1234567890123456","b":["-12345678901234567", 1],"c":123456789012345}',
    );
  });

  it('never touches digits inside a string, escaped quotes included', () => {
    for (const text of [
      '{"s":"x:1234567890123456,","t":"1234567890123456"}',
      '{"s":"a\\":1234567890123456,"}',
      '{"s":"\\\\","n":1}',
      '["1234567890123456789", ",12345678901234567]"]',
    ]) {
      assert.equal(quoteLongIntegers(text), text, text);
      assert.deepEqual(parseJsonExact(text), JSON.parse(text), text);
    }
  });

  it('leaves fractions and exponents alone', () => {
    const text =
      '{"a":12345678901234567.5,"b":1234567890123456789e2,"c":-1.5E3}';
    assert.equal(quoteLongIntegers(text), text);
  });

  it('parses JSON without long integers exactly as JSON.parse does', () => {
    fc.assert(
      fc.property(
        fc
          .jsonValue({ maxDepth: 4 })
          .filter(
            (v) =>
              !/\d{16}/.test(
                JSON.stringify(v).replace(/"(?:[^"\\]|\\.)*"/g, ''),
              ),
          ),
        (value) => {
          const text = JSON.stringify(value);
          assert.deepEqual(parseJsonExact(text), JSON.parse(text));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keeps every integer of 16 to 30 digits exact, at any depth', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10n ** 15n, max: 10n ** 30n }),
        fc.boolean(),
        (n, negative) => {
          const literal = `${negative ? '-' : ''}${n}`;
          const parsed = parseJsonExact(
            `{"k":[{"v":${literal}}],"s":"${literal}"}`,
          ) as { k: Array<{ v: string }>; s: string };
          assert.equal(parsed.k[0].v, literal);
          assert.equal(parsed.s, literal);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('sanityCheckBlock and rounded integers', () => {
  const block = (rewardPool: unknown) =>
    ({
      ...(JSON.parse(HEADER_600570) as object),
      reward_pool: rewardPool,
    }) as never;

  it('refuses a block whose reward_pool was parsed into a rounded number', () => {
    assert.equal(hasRoundedInteger(block(12774234261122668)), true);
    assert.throws(() => sanityCheckBlock(block(12774234261122668)), /rounded/);
  });

  it('accepts reward_pool as an exact string or a safe integer', () => {
    assert.equal(hasRoundedInteger(block('12774234261122667')), false);
    assert.equal(hasRoundedInteger(block(64812685069)), false);
    sanityCheckBlock(block('12774234261122667'));
    sanityCheckBlock(block(64812685069));
  });
});
