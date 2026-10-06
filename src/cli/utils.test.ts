/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { writeAndFlush } from './utils.js';

describe('writeAndFlush', () => {
  it('waits for the write to be acknowledged, not just queued', async () => {
    // `process.exit` discards whatever is still buffered, and a write to
    // a pipe is asynchronous, so a result over the 64 KiB pipe buffer was
    // being cut mid-token and stdout held JSON that would not parse.
    // Anything that exits after writing has to wait for the callback.
    let acknowledged = false;
    let release: (() => void) | undefined;
    const stream = {
      write: (_text: string, cb: (e?: Error | null) => void) => {
        release = () => {
          acknowledged = true;
          cb(null);
        };
        return false;
      },
    } as unknown as NodeJS.WriteStream;

    const flushed = writeAndFlush(stream, 'x'.repeat(100_000));
    let done = false;
    void flushed.then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, 'it must not resolve while the write is pending');

    release?.();
    await flushed;
    assert.equal(acknowledged, true);
  });

  it('passes a write failure on rather than swallowing it', async () => {
    const stream = {
      write: (_text: string, cb: (e?: Error | null) => void) => {
        cb(new Error('EPIPE'));
        return false;
      },
    } as unknown as NodeJS.WriteStream;
    await assert.rejects(writeAndFlush(stream, 'x'), /EPIPE/);
  });

  it('resolves for a write the stream takes immediately', async () => {
    const written: string[] = [];
    const stream = {
      write: (text: string, cb: (e?: Error | null) => void) => {
        written.push(text);
        cb();
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    await writeAndFlush(stream, 'hello');
    assert.deepEqual(written, ['hello']);
  });
});
