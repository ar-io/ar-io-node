/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../../test/test-logger.js';
import { DEFAULT_ARWEAVE_NODE_URLS } from '../../lib/onchain/arweave-nodes.js';
import { L2BandsRefused } from '../../lib/parquet-l2/verify-bands.js';
import {
  concurrencyFor,
  indexL2VerifyCLICommand,
  L2VerifyRefused,
  MAX_CONCURRENCY,
  threadpoolSize,
  urlList,
} from './indexL2VerifyCommands.js';

const log = createTestLogger({ suite: 'index-l2-verify' });

describe('index-l2-verify', () => {
  it('requires --bands-dir', async () => {
    await assert.rejects(indexL2VerifyCLICommand({}, { log }), /bands-dir/);
  });

  it('refuses --gateway-url with --arweave-nodes', async () => {
    await assert.rejects(
      indexL2VerifyCLICommand(
        {
          bandsDir: '/nowhere',
          gatewayUrl: 'http://core:4000',
          arweaveNodes: 'default',
        },
        { log },
      ),
      L2VerifyRefused,
    );
  });

  it('refuses a height or count that is not a whole number', async () => {
    for (const bad of [
      { from: '-1' },
      { to: 'x' },
      { onchain: '2.5' },
      { seed: 'y' },
    ]) {
      await assert.rejects(
        indexL2VerifyCLICommand({ bandsDir: '/nowhere', ...bad }, { log }),
        L2VerifyRefused,
      );
    }
  });

  it('refuses --band-deadline 0, which would leave every item unchecked (CodeRabbit, #1071)', async () => {
    await assert.rejects(
      indexL2VerifyCLICommand(
        { bandsDir: '/nowhere', bandDeadline: '0' },
        { log },
      ),
      /--band-deadline must be 1 or above/,
    );
  });

  it("reads libuv's threadpool size as libuv does", () => {
    assert.equal(threadpoolSize({}), 4);
    assert.equal(threadpoolSize({ UV_THREADPOOL_SIZE: '16' }), 16);
    assert.equal(threadpoolSize({ UV_THREADPOOL_SIZE: '12abc' }), 12);
    // atoi: nothing it reads, or 0, is one thread; at most 1024.
    assert.equal(threadpoolSize({ UV_THREADPOOL_SIZE: 'x' }), 1);
    assert.equal(threadpoolSize({ UV_THREADPOOL_SIZE: '0' }), 1);
    assert.equal(threadpoolSize({ UV_THREADPOOL_SIZE: '5000' }), 1024);
  });

  it('runs no more databases than the threadpool leaves two threads beside (review: starved DNS and fs)', () => {
    // Each database's query holds a libuv thread for as long as it runs;
    // the on-chain reads' DNS lookups and the file reads need the rest.
    assert.equal(concurrencyFor({ cpus: 24, threadpool: 4 }), 2);
    assert.equal(concurrencyFor({ cpus: 24, threadpool: 16 }), 4);
    assert.equal(concurrencyFor({ cpus: 8, threadpool: 16 }), 2);
    assert.equal(concurrencyFor({ cpus: 2, threadpool: 16 }), 1);
    assert.equal(concurrencyFor({ cpus: 24, threadpool: 1 }), 1);
    assert.equal(concurrencyFor({ asked: 1, cpus: 24, threadpool: 1 }), 1);
    assert.equal(concurrencyFor({ asked: 6, cpus: 2, threadpool: 16 }), 6);
    assert.throws(
      () => concurrencyFor({ asked: 3, cpus: 24, threadpool: 4 }),
      (error: Error) =>
        error instanceof L2VerifyRefused &&
        /UV_THREADPOOL_SIZE/.test(error.message) &&
        /at most 2/.test(error.message),
    );
    assert.throws(
      () =>
        concurrencyFor({
          asked: MAX_CONCURRENCY + 1,
          cpus: 256,
          threadpool: 1024,
        }),
      /--concurrency must be at most/,
    );
  });

  it('refuses --concurrency the threadpool cannot serve, before it reads a band', async () => {
    const was = process.env.UV_THREADPOOL_SIZE;
    delete process.env.UV_THREADPOOL_SIZE;
    try {
      await assert.rejects(
        indexL2VerifyCLICommand(
          { bandsDir: '/nowhere', concurrency: '4' },
          { log },
        ),
        (error: Error) =>
          error instanceof L2VerifyRefused &&
          /UV_THREADPOOL_SIZE/.test(error.message),
      );
      await assert.rejects(
        indexL2VerifyCLICommand(
          { bandsDir: '/nowhere', concurrency: '0' },
          { log },
        ),
        /--concurrency must be 1 or above/,
      );
    } finally {
      if (was !== undefined) process.env.UV_THREADPOOL_SIZE = was;
    }
  });

  it('refuses publication options without --publication, and --publication without exactly one key source', async () => {
    for (const bad of [
      { publisherKey: 'x' },
      { registryUrl: 'http://core:4000' },
      { index: 'ardrive-l2' },
      { publication: '/nowhere/publication.json' },
      {
        publication: '/nowhere/publication.json',
        publisherKey: 'x',
        registryUrl: 'http://core:4000',
      },
    ]) {
      await assert.rejects(
        indexL2VerifyCLICommand({ bandsDir: '/nowhere', ...bad }, { log }),
        L2VerifyRefused,
        JSON.stringify(bad),
      );
    }
  });

  it('refuses a share that is not a fraction, and an L1 directory that is not one', async () => {
    for (const bad of [
      { maxUnchecked: '1.5' },
      { maxUnchecked: '20', onchain: '20' },
      { maxUnchecked: '30', onchain: '20' },
      { maxUnchecked: '-1' },
      { maxUnlocatedShare: '' },
      { bandDeadline: '-3' },
      { l1BandsDir: '/nowhere/parquet-l1' },
    ]) {
      await assert.rejects(
        indexL2VerifyCLICommand(
          { bandsDir: '/nowhere', onchain: '0', ...bad },
          { log },
        ),
        L2VerifyRefused,
        JSON.stringify(bad),
      );
    }
  });

  it('refuses a directory that holds no l2 band', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-verify-cli-'));
    try {
      await assert.rejects(
        indexL2VerifyCLICommand({ bandsDir: dir, onchain: '0' }, { log }),
        L2BandsRefused,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tells a registry it could not read from one without the publisher (review 14)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-verify-cli-'));
    const wallet = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';
    const publication = path.join(dir, 'publication.json');
    await fs.writeFile(
      publication,
      JSON.stringify({
        version: 1,
        publisher: wallet,
        sequence: 1,
        previousManifestSha256: null,
        issuedAt: '2026-09-22T12:00:00Z',
        expiresAt: '2026-09-23T12:00:00Z',
        indexes: [],
      }),
    );
    let failing = true;
    const server = http.createServer((_req, res) => {
      if (failing) {
        res.writeHead(502).end();
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ gateways: {} }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as { port: number };
    const run = () =>
      indexL2VerifyCLICommand(
        {
          bandsDir: dir,
          onchain: '0',
          publication,
          registryUrl: `http://127.0.0.1:${port}`,
        },
        { log },
      );
    try {
      await assert.rejects(run(), (error: Error) => {
        assert.ok(error instanceof L2VerifyRefused, error.message);
        assert.match(error.message, /could not read the registry/);
        assert.match(error.message, /502/);
        assert.doesNotMatch(error.message, /has no gateway/);
        return true;
      });
      failing = false;
      await assert.rejects(run(), (error: Error) => {
        assert.ok(error instanceof L2VerifyRefused, error.message);
        assert.match(error.message, /has no gateway/);
        return true;
      });
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads --arweave-nodes as a list, or the default pool', () => {
    assert.deepEqual(urlList('http://a:1984/, http://b:1984,http://a:1984'), [
      'http://a:1984',
      'http://b:1984',
    ]);
    assert.equal(urlList('default'), DEFAULT_ARWEAVE_NODE_URLS);
    assert.equal(urlList(undefined), undefined);
    assert.throws(() => urlList(' , '), L2VerifyRefused);
  });

  it('refuses before it starts when the spill can not hold what will run, lookups skipped or not (review 13)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-verify-nospill-'));
    try {
      const band = path.join(dir, 'l2-h100-199-aaaaaaaa-000000000000');
      await fs.mkdir(band);
      await fs.writeFile(
        path.join(band, 'data_items.parquet'),
        Buffer.alloc(1000),
      );
      await fs.writeFile(path.join(band, 'tags.parquet'), Buffer.alloc(1000));
      // 50 GB free: under the 100 GB reserve, so the spill is capped at 0.
      const tight = { log, freeBytes: async () => 50e9 };
      // With --skip-lookups the consistency checks still group the tables,
      // and spill: refused, and skipping lookups is not offered.
      await assert.rejects(
        indexL2VerifyCLICommand(
          { bandsDir: dir, onchain: '0', skipLookups: true },
          tight,
        ),
        (e: unknown) =>
          e instanceof L2VerifyRefused &&
          /TMPDIR/.test(e.message) &&
          !/--skip-lookups/.test(e.message),
      );
      await assert.rejects(
        indexL2VerifyCLICommand({ bandsDir: dir, onchain: '0' }, tight),
        (e: unknown) =>
          e instanceof L2VerifyRefused &&
          /TMPDIR/.test(e.message) &&
          !/--skip-lookups/.test(e.message),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
