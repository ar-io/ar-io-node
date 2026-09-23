/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import crypto from 'node:crypto';

import { downloadFile, partialPathFor } from './http-file-download.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

describe('downloadFile', () => {
  let tempDir: string;
  let server: http.Server;
  let baseUrl: string;
  let handler: Handler;

  /** The payload every default-serving test fetches. */
  const body = Buffer.from('the quick brown fox jumps over the lazy dog\n');
  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');

  /**
   * Serve `body`, honouring a single `bytes=<start>-<end?>` range, which is
   * what a resumed download sends.
   */
  const serveWithRanges: Handler = (req, res) => {
    const range = req.headers.range;
    if (typeof range === 'string') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match !== null) {
        const start = Number(match[1]);
        const end = match[2] === '' ? body.length - 1 : Number(match[2]);
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': String(slice.length),
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, { 'Content-Length': String(body.length) });
    res.end(body);
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-download-test-'));
    handler = serveWithRanges;
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    // closeAllConnections first: a keep-alive socket would otherwise hold the
    // server open and hang the run, since test:file has no force-exit.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const dest = (name = 'out.bin') => path.join(tempDir, name);

  it('downloads a file and verifies its digest', async () => {
    const destPath = dest();
    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });

    assert.equal(result.bytesWritten, body.length);
    assert.equal(result.resumedFrom, 0);
    assert.equal(result.sha256, bodySha256);
    assert.deepEqual(await fs.readFile(destPath), body);
    assert.equal(
      existsSync(partialPathFor(destPath)),
      false,
      'partial file should be renamed away',
    );
  });

  it('resumes from a partial file and still verifies the whole digest', async () => {
    const destPath = dest();
    const prefixLength = 10;
    await fs.writeFile(
      partialPathFor(destPath),
      body.subarray(0, prefixLength),
    );

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });

    assert.equal(result.resumedFrom, prefixLength);
    assert.equal(result.bytesWritten, body.length);
    // The digest has to cover the resumed prefix too, not just the new bytes.
    assert.equal(result.sha256, bodySha256);
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('starts over when the server ignores the range request', async () => {
    const destPath = dest();
    await fs.writeFile(partialPathFor(destPath), body.subarray(0, 10));

    // Answer 200 with the whole body despite the Range header.
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    };

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });

    assert.equal(
      result.resumedFrom,
      0,
      'ignored range must discard the prefix',
    );
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('discards the partial file on 416 and throws', async () => {
    const destPath = dest();
    const tmpPath = partialPathFor(destPath);
    await fs.writeFile(tmpPath, Buffer.alloc(5));

    handler = (_req, res) => {
      res.writeHead(416).end();
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
      }),
      /416 Range Not Satisfiable/,
    );
    assert.equal(existsSync(tmpPath), false, 'partial file should be removed');
    assert.equal(existsSync(destPath), false);
  });

  it('keeps the partial file on a short read, so the next attempt resumes', async () => {
    const destPath = dest();
    const truncated = body.subarray(0, 12);
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(truncated.length) });
      res.end(truncated);
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
      }),
      /Incomplete download: expected \d+ bytes, got 12/,
    );

    const tmpPath = partialPathFor(destPath);
    assert.equal(existsSync(tmpPath), true, 'partial should be kept');
    assert.equal((await fs.stat(tmpPath)).size, truncated.length);
    assert.equal(existsSync(destPath), false);

    // And the retry, against the real server, completes from that prefix.
    handler = serveWithRanges;
    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });
    assert.equal(result.resumedFrom, truncated.length);
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('discards the partial file when the response overruns the expected size', async () => {
    const destPath = dest();
    handler = (_req, res) => {
      res.writeHead(200).end(Buffer.concat([body, Buffer.alloc(8)]));
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
      }),
      /Size overflow/,
    );
    assert.equal(existsSync(partialPathFor(destPath)), false);
  });

  it('discards the partial file on a digest mismatch and throws', async () => {
    const destPath = dest();
    const wrongDigest = 'f'.repeat(64);

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
        expectedSha256: wrongDigest,
      }),
      (error: Error) =>
        error.message.includes('SHA-256 mismatch') &&
        error.message.includes(bodySha256),
    );

    // A file that failed verification must not be left to resume onto, or the
    // next attempt appends to known-bad bytes.
    assert.equal(existsSync(partialPathFor(destPath)), false);
    assert.equal(existsSync(destPath), false);
  });

  it('fetches a slice when the file lives inside a larger object', async () => {
    const destPath = dest();
    const container = Buffer.concat([Buffer.alloc(17, 0x41), body]);
    const containerSha = crypto.createHash('sha256').update(body).digest('hex');

    let seenRange: string | undefined;
    handler = (req, res) => {
      seenRange = req.headers.range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      assert(match !== null, 'a ranged fetch is expected');
      const slice = container.subarray(Number(match[1]), Number(match[2]) + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${match[1]}-${match[2]}/${container.length}`,
      });
      res.end(slice);
    };

    const result = await downloadFile({
      url: `${baseUrl}/container`,
      destPath,
      expectedSize: body.length,
      expectedSha256: containerSha,
      rangeOffset: 17,
    });

    assert.equal(seenRange, `bytes=17-${17 + body.length - 1}`);
    assert.equal(result.bytesWritten, body.length);
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('requires an expected size when given a range offset', async () => {
    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath: dest(),
        rangeOffset: 4,
      }),
      /rangeOffset requires expectedSize/,
    );
  });

  it('throws on a non-success status', async () => {
    handler = (_req, res) => {
      res.writeHead(503, 'Service Unavailable').end();
    };

    await assert.rejects(
      downloadFile({ url: `${baseUrl}/file`, destPath: dest() }),
      /HTTP 503/,
    );
  });

  it('aborts when the transfer exceeds its timeout', async () => {
    handler = (_req, res) => {
      // Headers, then never finish the body.
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.write(body.subarray(0, 1));
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/slow`,
        destPath: dest(),
        expectedSize: body.length,
        timeoutMs: 150,
      }),
    );
  });

  it('honours an external abort signal', async () => {
    const controller = new AbortController();
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.write(body.subarray(0, 1));
      setTimeout(() => controller.abort(), 20);
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/slow`,
        destPath: dest(),
        expectedSize: body.length,
        signal: controller.signal,
      }),
    );
  });

  it('ignores an existing partial file when resume is disabled', async () => {
    const destPath = dest();
    await fs.writeFile(partialPathFor(destPath), Buffer.from('stale'));

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
      resume: false,
    });

    assert.equal(result.resumedFrom, 0);
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('discards a partial file that is already at or past the expected size', async () => {
    const destPath = dest();
    // Stale leftovers from a previous, differently-sized artifact.
    await fs.writeFile(partialPathFor(destPath), Buffer.alloc(body.length + 5));

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });

    assert.equal(result.resumedFrom, 0);
    assert.deepEqual(await fs.readFile(destPath), body);
  });
});
