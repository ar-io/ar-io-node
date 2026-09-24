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
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import crypto from 'node:crypto';
import * as zlib from 'node:zlib';

import {
  completedFileHashes,
  downloadFile,
  DownloadHttpError,
  DownloadIntegrityError,
  partialPathFor,
} from './http-file-download.js';

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

  it('does not fetch a file that is already complete and verified', async () => {
    const destPath = dest();
    await fs.writeFile(destPath, body);
    let requests = 0;
    handler = (req, res) => {
      requests += 1;
      serveWithRanges(req, res);
    };

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });

    assert.equal(requests, 0, 'nothing was fetched');
    assert.equal(result.bytesWritten, body.length);
    assert.equal(result.resumedFrom, body.length);
    assert.equal(result.sha256, bodySha256);
  });

  it('replaces a file in place whose digest does not match', async () => {
    const destPath = dest();
    const wrong = Buffer.from(body);
    wrong[0] ^= 0xff;
    await fs.writeFile(destPath, wrong);
    let requests = 0;
    handler = (req, res) => {
      requests += 1;
      serveWithRanges(req, res);
    };

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
    });

    assert.equal(requests, 1);
    assert.equal(result.resumedFrom, 0);
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('fetches again when resume is disabled, even if the file is complete', async () => {
    const destPath = dest();
    await fs.writeFile(destPath, body);
    let requests = 0;
    handler = (req, res) => {
      requests += 1;
      serveWithRanges(req, res);
    };

    await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
      resume: false,
    });

    assert.equal(requests, 1);
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
    // No Content-Length: a declared length short of the expected size is
    // refused up front, so the short read has to be one nobody announced.
    handler = (_req, res) => {
      res.writeHead(200);
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

  it('gives up on a stalled transfer and keeps its partial file for a resume', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.write(body.subarray(0, 5)); // then nothing more
    };
    const destPath = dest();
    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/stall`,
        destPath,
        expectedSize: body.length,
        idleTimeoutMs: 150,
      }),
      /Download stalled: no bytes for 150 ms/,
    );
    assert.ok(existsSync(partialPathFor(destPath)), 'the partial file stays');
  });

  it('lets a slow transfer that keeps moving run past the stall timeout', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      let sent = 0;
      // A byte every 20 ms: the whole body takes several times the timeout,
      // but no gap between bytes comes near it.
      const tick = setInterval(() => {
        res.write(body.subarray(sent, sent + 1));
        sent++;
        if (sent >= body.length) {
          clearInterval(tick);
          res.end();
        }
      }, 20);
    };
    const destPath = dest();
    const result = await downloadFile({
      url: `${baseUrl}/trickle`,
      destPath,
      expectedSize: body.length,
      idleTimeoutMs: 150,
    });
    assert.equal(result.bytesWritten, body.length);
    assert.deepEqual(await fs.readFile(destPath), body);
  });

  it('holds a multi-chunk transfer to the rate cap', async () => {
    // Many chunks, sent as fast as the server can: the cap, not the server,
    // must set the pace. (A single-chunk body cannot tell the difference.)
    const chunk = Buffer.alloc(1024, 7);
    const count = 20;
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(chunk.length * count) });
      let sent = 0;
      const next = () => {
        if (sent === count) return void res.end();
        sent++;
        res.write(chunk, next);
      };
      next();
    };
    const startedAt = Date.now();
    const result = await downloadFile({
      url: `${baseUrl}/paced`,
      destPath: dest(),
      expectedSize: chunk.length * count,
      maxBytesPerSecond: 20_000,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.bytesWritten, chunk.length * count);
    // 20 KiB at 20,000 bytes/s is about 1 s; allow for timer slack.
    assert.ok(elapsed >= 800, `took ${elapsed} ms, the cap did not hold`);
  });

  it('does not count pacing for a rate cap as a stall', async () => {
    handler = serveWithRanges;
    const destPath = dest();
    // 44 bytes at 100 bytes/s means sleeping about 440 ms after the first
    // chunk, well past the 100 ms stall timeout.
    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      idleTimeoutMs: 100,
      maxBytesPerSecond: 100,
    });
    assert.equal(result.bytesWritten, body.length);
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

  /** Resolves once the server-side response closes, or rejects after `ms`. */
  const closedWithin = (res: http.ServerResponse, ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (res.closed) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`response still open after ${ms} ms`)),
        ms,
      );
      res.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  it('cuts off a body that runs past the expected size while it streams', async () => {
    const destPath = dest();
    const expectedSize = 1000;
    const chunk = Buffer.alloc(64 * 1024, 1);
    // Endless, with no declared length, so only the stream itself can tell.
    handler = (_req, res) => {
      res.writeHead(200);
      const next = () => {
        if (!res.destroyed) res.write(chunk, next);
      };
      next();
    };

    let maxPartial = 0;
    const poll = setInterval(() => {
      try {
        const size = statSync(partialPathFor(destPath)).size;
        if (size > maxPartial) maxPartial = size;
      } catch {
        // Not created yet, or already removed.
      }
    }, 2);

    const startedAt = Date.now();
    try {
      await assert.rejects(
        downloadFile({
          url: `${baseUrl}/endless`,
          destPath,
          expectedSize,
          // Only so the old behaviour (never finishing) fails rather than hangs.
          signal: AbortSignal.timeout(3000),
        }),
        (error: Error) =>
          error instanceof DownloadIntegrityError &&
          /Size overflow/.test(error.message),
      );
    } finally {
      clearInterval(poll);
    }
    assert.ok(Date.now() - startedAt < 2000, 'rejected promptly');
    assert.ok(
      maxPartial <= expectedSize + chunk.length,
      `partial reached ${maxPartial} bytes`,
    );
    assert.equal(existsSync(partialPathFor(destPath)), false);
    assert.equal(existsSync(destPath), false);
  });

  it('refuses a Content-Length that contradicts the expected size before reading the body', async () => {
    let serverRes: http.ServerResponse | undefined;
    handler = (_req, res) => {
      serverRes = res;
      res.writeHead(200, { 'Content-Length': String(body.length * 1000) });
      res.write(body); // then hold the rest back
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/big`,
        destPath: dest(),
        expectedSize: body.length,
        signal: AbortSignal.timeout(3000),
      }),
      (error: Error) =>
        error instanceof DownloadIntegrityError &&
        /Content-Length/.test(error.message),
    );
    assert(serverRes !== undefined);
    await closedWithin(serverRes, 1000);
  });

  it('refuses a 206 whose Content-Range does not start where the partial ends, and keeps the partial', async () => {
    const destPath = dest();
    const tmpPath = partialPathFor(destPath);
    const prefix = body.subarray(0, 10);
    await fs.writeFile(tmpPath, prefix);
    // Ignores the requested start and sends the whole file as a 206.
    handler = (_req, res) => {
      res.writeHead(206, {
        'Content-Range': `bytes 0-${body.length - 1}/${body.length}`,
        'Content-Length': String(body.length),
      });
      res.end(body);
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
        expectedSha256: bodySha256,
      }),
      (error: Error) =>
        error instanceof DownloadIntegrityError &&
        /Content-Range/.test(error.message),
    );
    assert.deepEqual(await fs.readFile(tmpPath), prefix, 'partial untouched');
  });

  it('refuses a 206 whose Content-Range total contradicts the expected size', async () => {
    const destPath = dest();
    await fs.writeFile(partialPathFor(destPath), body.subarray(0, 10));
    handler = (_req, res) => {
      res.writeHead(206, {
        'Content-Range': `bytes 10-${body.length - 1}/${body.length + 1}`,
      });
      res.end(body.subarray(10));
    };

    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
      }),
      (error: Error) =>
        error instanceof DownloadIntegrityError &&
        /expected a total of/.test(error.message),
    );
  });

  it('asks for no compression and refuses a compressed response', async () => {
    const destPath = dest();
    const gzipped = zlib.gzipSync(body);
    let acceptEncoding: string | undefined;
    handler = (req, res) => {
      acceptEncoding = req.headers['accept-encoding'];
      res.writeHead(200, {
        'Content-Encoding': 'gzip',
        'Content-Length': String(gzipped.length),
      });
      res.end(gzipped);
    };

    // Decompressed, these are exactly the expected bytes: it must be refused
    // for the encoding alone, since a bomb would look the same until expanded.
    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
        expectedSha256: bodySha256,
        headers: { 'accept-encoding': 'gzip' },
      }),
      /Content-Encoding: gzip/,
    );
    assert.equal(acceptEncoding, 'identity');
    assert.equal(existsSync(destPath), false);
  });

  it('does not follow a redirect', async () => {
    let targetRequests = 0;
    const target = http.createServer((_req, res) => {
      targetRequests++;
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      target.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = target.address();
      assert(address !== null && typeof address === 'object');
      handler = (_req, res) => {
        res.writeHead(302, {
          Location: `http://127.0.0.1:${address.port}/internal`,
        });
        res.end();
      };

      await assert.rejects(
        downloadFile({
          url: `${baseUrl}/file`,
          destPath: dest(),
          expectedSize: body.length,
          expectedSha256: bodySha256,
        }),
        (error: Error) =>
          error instanceof DownloadHttpError && error.status === 302,
      );
      assert.equal(targetRequests, 0, 'the redirect target saw no request');
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it('releases the connection of a non-success response', async () => {
    let serverRes: http.ServerResponse | undefined;
    handler = (_req, res) => {
      serverRes = res;
      res.writeHead(503, 'Service Unavailable');
      res.write('x'.repeat(1024)); // and never finish
    };

    await assert.rejects(
      downloadFile({ url: `${baseUrl}/file`, destPath: dest() }),
      /HTTP 503/,
    );
    assert(serverRes !== undefined);
    await closedWithin(serverRes, 1000);
  });

  it('keeps the partial where partialPath says, so another digest does not resume onto it', async () => {
    const destPath = dest();
    const oldPartial = path.join(tempDir, 'out.bin.old.tmp');
    const newPartial = path.join(tempDir, 'out.bin.new.tmp');

    // An earlier version of the file, interrupted part way.
    const oldBody = Buffer.from(
      'an older build of this file, since replaced\n',
    );
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(oldBody.length) });
      res.write(oldBody.subarray(0, 10)); // then stall
    };
    await assert.rejects(
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: oldBody.length,
        expectedSha256: crypto
          .createHash('sha256')
          .update(oldBody)
          .digest('hex'),
        idleTimeoutMs: 100,
        partialPath: oldPartial,
      }),
      /stalled/,
    );
    assert.equal(existsSync(oldPartial), true);
    assert.equal(existsSync(partialPathFor(destPath)), false);

    // The rebuilt file, with its own digest and its own partial path.
    const ranges: (string | undefined)[] = [];
    handler = (req, res) => {
      ranges.push(req.headers.range);
      serveWithRanges(req, res);
    };
    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
      partialPath: newPartial,
    });
    assert.deepEqual(ranges, [undefined], 'nothing was resumed');
    assert.equal(result.resumedFrom, 0);
    assert.deepEqual(await fs.readFile(destPath), body);
    assert.equal(existsSync(newPartial), false);
  });

  it('resumes from the partial at partialPath', async () => {
    const destPath = dest();
    const partialPath = path.join(tempDir, 'elsewhere.tmp');
    await fs.writeFile(partialPath, body.subarray(0, 10));

    const result = await downloadFile({
      url: `${baseUrl}/file`,
      destPath,
      expectedSize: body.length,
      expectedSha256: bodySha256,
      partialPath,
    });
    assert.equal(result.resumedFrom, 10);
    assert.deepEqual(await fs.readFile(destPath), body);
    assert.equal(existsSync(partialPath), false);
  });

  it('does not re-hash a completed file that has not changed, but does once it has', async () => {
    const destPath = dest();
    await fs.writeFile(destPath, body);
    let requests = 0;
    handler = (req, res) => {
      requests++;
      serveWithRanges(req, res);
    };
    const check = () =>
      downloadFile({
        url: `${baseUrl}/file`,
        destPath,
        expectedSize: body.length,
        expectedSha256: bodySha256,
      });

    const before = completedFileHashes();
    await check();
    assert.equal(completedFileHashes(), before + 1, 'first check hashes');
    await check();
    await check();
    assert.equal(completedFileHashes(), before + 1, 'unchanged: memo answers');

    // Same size, different content and mtime: must be read again, found
    // wrong, and fetched.
    const wrong = Buffer.from(body);
    wrong[0] ^= 0xff;
    await fs.writeFile(destPath, wrong);
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(destPath, later, later);
    await check();
    assert.equal(completedFileHashes(), before + 2, 'changed: hashed again');
    assert.equal(requests, 1);
    assert.deepEqual(await fs.readFile(destPath), body);

    // And the file just downloaded and verified is remembered as such.
    await check();
    assert.equal(completedFileHashes(), before + 2);
    assert.equal(requests, 1);
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
