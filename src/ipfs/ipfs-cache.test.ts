/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { createTestLogger } from '../../test/test-logger.js';
import { IpfsFsCache } from './ipfs-cache.js';

const log = createTestLogger({ suite: 'IpfsFsCache' });

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('IpfsFsCache', () => {
  let baseDir: string;
  let cache: IpfsFsCache;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-cache-test-'));
    cache = new IpfsFsCache({
      log,
      basePath: baseDir,
      maxSizeBytes: 10 * 1024 * 1024,
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('round-trips bytes and the content digest through putFromFile/get', async () => {
    const cid = 'bafkreiefysqevlhofnppvnhaptsjt7cqi6wcjsllgpn7ml5i4256v2rbwu';
    const content = Buffer.from('hello digest test');
    const digest = crypto
      .createHash('sha256')
      .update(content)
      .digest('base64url');

    // The streaming writer hands putFromFile an already-written temp file under
    // the cache's tmp dir; emulate that here.
    const tempPath = path.join(
      baseDir,
      'tmp',
      crypto.randomBytes(8).toString('hex'),
    );
    fs.writeFileSync(tempPath, content);

    await cache.putFromFile(
      cid,
      tempPath,
      content.length,
      'text/plain',
      undefined,
      digest,
    );

    const got = await cache.get(cid);
    assert.ok(got, 'expected a cache hit');
    assert.equal(got.digest, digest, 'digest should round-trip');
    assert.equal(got.size, content.length);
    assert.equal(got.contentType, 'text/plain');
    assert.deepEqual(await streamToBuffer(got.stream), content);
  });

  it('returns undefined for an uncached CID', async () => {
    const got = await cache.get(
      'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    );
    assert.equal(got, undefined);
  });

  it('rebuilds a digest-less entry (older cache) without a digest', async () => {
    const cid = 'bafkreiefysqevlhofnppvnhaptsjt7cqi6wcjsllgpn7ml5i4256v2rbwu';
    const content = Buffer.from('legacy entry, no digest');
    const tempPath = path.join(
      baseDir,
      'tmp',
      crypto.randomBytes(8).toString('hex'),
    );
    fs.writeFileSync(tempPath, content);

    // No digest argument — emulates an entry written before Content-Digest support.
    await cache.putFromFile(
      cid,
      tempPath,
      content.length,
      'application/octet-stream',
    );

    const got = await cache.get(cid);
    assert.ok(got);
    assert.equal(got.digest, undefined, 'legacy entry should have no digest');
    assert.deepEqual(await streamToBuffer(got.stream), content);
  });
});
