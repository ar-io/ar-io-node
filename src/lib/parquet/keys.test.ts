/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import { prefix64, prefix64Sql, sha256_64, sha256_64Sql } from './keys.js';

/**
 * The published test vectors: a client in any language must reproduce them.
 * They are also in docs/index-swarm.md, for readers who write their own.
 */
const ID = 'O048e9pT5nX1CPrMjGC1y1dWdtd3AChFX27hoRsVIdA';
const VECTORS = {
  prefix64: [
    {
      input: Buffer.from(ID, 'base64url'),
      output: 4273419599062754933n, // 0x3b4e3c7bda53e675
    },
    // Shorter than 8 bytes, as a few early `target`s are: zero-padded right.
    { input: Buffer.from([0xab]), output: 0xab00000000000000n },
  ],
  sha256_64: [
    { input: Buffer.from('App-Name'), output: 13793613791578176130n }, // 0xbf6cc2a967f23a82
    { input: Buffer.from('ArDrive-App'), output: 11728218962302099301n }, // 0xa2c30101e8045f65
  ],
};

describe('lookup keys', () => {
  let duck: Database;
  before(async () => {
    duck = await Database.create(':memory:');
  });
  after(async () => {
    await duck.close();
  });

  const sql = async (expression: string, input: Buffer): Promise<bigint> => {
    const [row] = (await duck.all(
      `SELECT ${expression} AS k FROM (SELECT from_hex('${input.toString('hex')}') AS b)`,
    )) as Array<{ k: bigint }>;
    return BigInt(row.k);
  };

  it('prefix64 gives the vectors in code and in SQL', async () => {
    for (const { input, output } of VECTORS.prefix64) {
      assert.equal(prefix64(input), output);
      assert.equal(await sql(prefix64Sql('b'), input), output);
    }
  });

  it('sha256_64 gives the vectors in code and in SQL', async () => {
    for (const { input, output } of VECTORS.sha256_64) {
      assert.equal(sha256_64(input), output);
      assert.equal(await sql(sha256_64Sql('b'), input), output);
    }
  });

  it('orders keys as the bytes they come from', () => {
    const low = Buffer.alloc(32, 0x01);
    const high = Buffer.alloc(32, 0x02);
    assert.ok(prefix64(low) < prefix64(high));
  });
});
