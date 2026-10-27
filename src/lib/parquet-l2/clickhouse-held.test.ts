/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ClickHouseHeldError,
  HELD_QUERY,
  httpClickHouseForget,
  httpClickHouseHeld,
} from './clickhouse-held.js';

interface Call {
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that records each request and answers from a list. */
function fakeFetch(answers: Array<{ status?: number; body: string }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    calls.push({
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: init.body,
    });
    const answer = answers.shift() ?? { body: '' };
    return new Response(answer.body, { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ID = 'AB'.repeat(32);

describe('httpClickHouseHeld', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-held-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads the top height, and an empty table as nothing held', async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: '2029000\n' },
      { body: '0\n' },
    ]);
    const held = httpClickHouseHeld({
      url: 'http://clickhouse:8123',
      username: 'default',
      password: 'secret',
      fetchImpl,
    });
    assert.equal(await held.topHeight(), 2029000);
    assert.equal(await held.topHeight(), undefined);
    assert.equal(calls[0].url.searchParams.get('readonly'), '2');
    assert.deepEqual(calls[0].headers, {
      'X-ClickHouse-User': 'default',
      'X-ClickHouse-Key': 'secret',
    });
  });

  it('refuses a top height that is not a number', async () => {
    const { fetchImpl } = fakeFetch([{ body: 'oops' }]);
    const held = httpClickHouseHeld({
      url: 'http://ch:8123',
      username: 'u',
      password: '',
      fetchImpl,
    });
    await assert.rejects(held.topHeight(), ClickHouseHeldError);
  });

  it('sends the ids as external data, read-only, and writes the answer', async () => {
    const answer = `${ID}\t150\t1\tEE\tEE\tA1\t100\t10\t200\t110\t12\t512\t524\t512\t0\n`;
    const { calls, fetchImpl } = fakeFetch([{ body: answer }]);
    const held = httpClickHouseHeld({
      url: 'http://ch:8123',
      username: 'u',
      password: 'p',
      fetchImpl,
    });
    const idsFile = path.join(dir, 'ids.tsv');
    const outFile = path.join(dir, 'held.tsv');
    await fs.writeFile(idsFile, `${ID}\n`);
    await held.heldIn({ from: 90, to: 10009, idsFile, outFile });
    assert.equal(await fs.readFile(outFile, 'utf8'), answer);
    const { url, body } = calls[0];
    assert.equal(url.searchParams.get('query'), HELD_QUERY);
    assert.equal(url.searchParams.get('param_from'), '90');
    assert.equal(url.searchParams.get('param_to'), '10009');
    assert.equal(url.searchParams.get('ids_structure'), 'id_hex String');
    assert.equal(url.searchParams.get('ids_format'), 'TSV');
    assert.equal(url.searchParams.get('readonly'), '2');
    assert.ok(body instanceof FormData);
    const part = body.get('ids') as Blob;
    assert.equal(await part.text(), `${ID}\n`);
    assert.match(HELD_QUERY, /id IN \(SELECT unhex\(id_hex\) FROM ids\)/);
  });

  it('fails on an error ClickHouse sends after the answer began', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: `${ID}\t150\nCode: 241. DB::Exception: Memory limit (total) exceeded. (MEMORY_LIMIT_EXCEEDED)\n`,
      },
    ]);
    const held = httpClickHouseHeld({
      url: 'http://ch:8123',
      username: 'u',
      password: '',
      fetchImpl,
    });
    const idsFile = path.join(dir, 'ids.tsv');
    await fs.writeFile(idsFile, `${ID}\n`);
    await assert.rejects(
      held.heldIn({
        from: 0,
        to: 1,
        idsFile,
        outFile: path.join(dir, 'out.tsv'),
      }),
      /failed mid-answer/,
    );
  });

  it('fails on an error status', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 500, body: 'Code: 60. DB::Exception: no table' },
    ]);
    const held = httpClickHouseHeld({
      url: 'http://ch:8123',
      username: 'u',
      password: '',
      fetchImpl,
    });
    const idsFile = path.join(dir, 'ids.tsv');
    await fs.writeFile(idsFile, `${ID}\n`);
    await assert.rejects(
      held.heldIn({
        from: 0,
        to: 1,
        idsFile,
        outFile: path.join(dir, 'out.tsv'),
      }),
      /answered 500/,
    );
  });
});

describe('httpClickHouseForget', () => {
  it('fills a helper table, counts, deletes in one waited mutation, and drops the helper', async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: '' },
      { body: '' },
      { body: '2\n' },
      { body: '' },
      { body: '' },
    ]);
    const forget = httpClickHouseForget({
      url: 'http://ch:8123',
      username: 'u',
      password: 'p',
      fetchImpl,
      now: () => 42,
    });
    const other = 'CD'.repeat(32);
    const result = await forget.forget({
      from: 100,
      to: 199,
      indexedAt: 1_790_000_000,
      ids: [ID, other],
    });
    assert.deepEqual(result, { matched: 2 });
    const queries = calls.map(
      (c) => c.url.searchParams.get('query') ?? String(c.body),
    );
    assert.match(
      queries[0],
      /^CREATE TABLE l2_import_forget_42_\d+ \(id_hex String\)/,
    );
    assert.match(
      queries[1],
      /^INSERT INTO l2_import_forget_42_\d+ \(id_hex\) FORMAT TSV$/,
    );
    assert.equal(calls[1].body, `${ID}\n${other}\n`);
    assert.match(
      queries[2],
      /^SELECT count\(\) FROM transactions WHERE height >= 100 AND height <= 199 AND is_data_item\s+AND indexed_at = 1790000000\s+AND id IN \(SELECT unhex\(id_hex\) FROM l2_import_forget_42_\d+\) FORMAT TSV$/,
    );
    assert.equal(calls[2].url.searchParams.get('readonly'), null);
    assert.match(
      queries[3],
      /^ALTER TABLE transactions DELETE WHERE height >= 100 AND height <= 199/,
    );
    assert.equal(calls[3].url.searchParams.get('mutations_sync'), '2');
    assert.match(queries[4], /^DROP TABLE IF EXISTS l2_import_forget_42_\d+$/);
  });

  it('drops the helper table when the delete fails', async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: '' },
      { body: '' },
      { body: '1\n' },
      { status: 500, body: 'Code: 341. DB::Exception: mutation failed' },
      { body: '' },
    ]);
    const forget = httpClickHouseForget({
      url: 'http://ch:8123',
      username: 'u',
      password: '',
      fetchImpl,
    });
    await assert.rejects(
      forget.forget({ from: 1, to: 2, indexedAt: 3, ids: [ID] }),
      /answered 500/,
    );
    assert.match(
      String(calls.at(-1)?.body),
      /^DROP TABLE IF EXISTS l2_import_forget_/,
    );
  });

  it('refuses anything but upper-case hex ids, before touching ClickHouse', async () => {
    const { calls, fetchImpl } = fakeFetch([]);
    const forget = httpClickHouseForget({
      url: 'http://ch:8123',
      username: 'u',
      password: '',
      fetchImpl,
    });
    for (const bad of [
      "ab'; DROP TABLE transactions; --",
      'ab'.repeat(32),
      'AB',
    ]) {
      await assert.rejects(
        forget.forget({ from: 1, to: 2, indexedAt: 3, ids: [bad] }),
        ClickHouseHeldError,
      );
    }
    await assert.rejects(
      forget.forget({ from: -1, to: 2, indexedAt: 3, ids: [ID] }),
      ClickHouseHeldError,
    );
    assert.equal(calls.length, 0);
  });
});
