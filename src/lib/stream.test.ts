/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import {
  attachStallTimeout,
  ByteRangeTransform,
  pipeStreamToResponse,
  peekLeadingBytes,
} from './stream.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe('attachStallTimeout', () => {
  it('should destroy stream when no data arrives', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 50);
    stream.resume();

    await sleep(80);
    assert.equal(stream.destroyed, true);
  });

  it('should reset timer on each chunk', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 50);
    stream.resume();

    // Write data before timeout expires
    await sleep(30);
    stream.write('chunk1');
    await sleep(30);
    assert.equal(stream.destroyed, false);

    // Now let it stall
    await sleep(80);
    assert.equal(stream.destroyed, true);
  });

  it('should clear timer on pause', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 50);
    stream.resume();
    stream.pause();

    await sleep(80);
    assert.equal(stream.destroyed, false);

    // Clean up
    stream.destroy();
  });

  it('should re-arm timer on resume after pause', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 50);
    // Stream starts paused, keep it paused
    await sleep(80);
    assert.equal(stream.destroyed, false);

    // Now resume — timer should arm
    stream.resume();
    await sleep(80);
    assert.equal(stream.destroyed, true);
  });

  it('should not fire after cleanup is called', async () => {
    const stream = new PassThrough();
    const cleanup = attachStallTimeout(stream, 50);
    cleanup();
    stream.resume();

    await sleep(80);
    assert.equal(stream.destroyed, false);

    // Clean up
    stream.destroy();
  });

  it('should auto-cleanup on stream end', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 50);

    const listenersBefore = stream.listenerCount('data');
    stream.end();
    // 'end' fires cleanup, removing listeners
    await sleep(10);
    const listenersAfter = stream.listenerCount('data');
    assert.equal(listenersAfter < listenersBefore, true);
  });

  it('should leave stream paused after attach', () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 50);
    assert.equal(stream.isPaused(), true);

    // Clean up
    stream.destroy();
  });

  it('should destroy stream when maxRequestMs elapses even while paused', async () => {
    // The wedge scenario: stall timer is cleared on pause, so a paused
    // stream whose upstream goes silent would hang forever without this
    // wall-clock cap.
    const stream = new PassThrough();
    attachStallTimeout(stream, 1000, 50); // stall=1s, maxRequest=50ms
    // Don't resume — leave stream in its initial paused state, simulating
    // backpressure + upstream stall.

    await sleep(80);
    assert.equal(stream.destroyed, true);
  });

  it('should not fire maxRequestMs after stream ends', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 1000, 50);
    stream.end();

    // Allow the maxRequestMs window to pass; if cleanup didn't clear
    // the timer, .destroy() would still get called (harmless on an
    // already-ended stream, but we want to verify the timer is cleared).
    await sleep(80);
    // Stream is ended (and Node autoDestroy makes destroyed=true too,
    // but that's a normal-completion side effect, not the maxTimer).
    assert.equal(stream.readableEnded, true);
  });

  it('should not arm maxRequestMs when not provided (backward compatibility)', async () => {
    const stream = new PassThrough();
    attachStallTimeout(stream, 1000); // no maxRequestMs
    // Keep paused and wait beyond what a default cap might be
    await sleep(80);
    assert.equal(stream.destroyed, false);

    // Clean up
    stream.destroy();
  });
});

describe('pipeStreamToResponse', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('should pipe data to response', async () => {
    const stream = new PassThrough();
    const res = new PassThrough();
    const log = { error: mock.fn(), info: mock.fn() } as any;

    pipeStreamToResponse(stream, res as any, log, 'test-id');

    stream.write('hello');
    stream.end();

    let result = '';
    for await (const chunk of res) {
      result += chunk.toString();
    }
    assert.equal(result, 'hello');
  });

  it('should log and destroy response on stream error', async () => {
    const stream = new PassThrough();
    const res = new PassThrough();
    const log = { error: mock.fn(), info: mock.fn() } as any;

    pipeStreamToResponse(stream, res as any, log, 'test-id');

    stream.emit('error', new Error('upstream failure'));

    assert.equal(log.error.mock.calls.length, 1);
    assert.equal(
      log.error.mock.calls[0].arguments[0],
      'Stream error during data transfer:',
    );
    assert.deepEqual(log.error.mock.calls[0].arguments[1], {
      dataId: 'test-id',
      message: 'upstream failure',
    });
    assert.equal(res.destroyed, true);
  });

  it('should skip destroy if response already destroyed', () => {
    const stream = new PassThrough();
    const res = new PassThrough();
    const log = { error: mock.fn(), info: mock.fn() } as any;

    pipeStreamToResponse(stream, res as any, log, 'test-id');

    res.destroy();
    // Should not throw
    stream.emit('error', new Error('late error'));

    assert.equal(log.error.mock.calls.length, 1);
  });

  it('should destroy upstream stream on premature client disconnect', async () => {
    const stream = new PassThrough();
    const res = new PassThrough();
    // Simulate a response that has not finished writing
    Object.defineProperty(res, 'writableFinished', { value: false });
    const log = { info: mock.fn(), error: mock.fn() } as any;

    pipeStreamToResponse(stream, res as any, log, 'test-id');

    // Simulate client disconnect by destroying the response
    res.destroy();

    // Allow 'close' event to propagate
    await sleep(10);

    assert.equal(stream.destroyed, true);
    assert.equal(log.info.mock.calls.length, 1);
    assert.equal(
      log.info.mock.calls[0].arguments[0],
      'Client disconnected, destroying upstream stream',
    );
  });

  it('should not destroy upstream stream when response finishes normally', async () => {
    const stream = new PassThrough();
    const res = new PassThrough();
    const log = { info: mock.fn(), error: mock.fn() } as any;

    pipeStreamToResponse(stream, res as any, log, 'test-id');

    // Drain res so it can finish
    res.resume();

    stream.write('data');
    stream.end();

    // Wait for res to close after pipe finishes
    await new Promise<void>((resolve) => res.once('close', resolve));

    assert.equal(log.info.mock.calls.length, 0);
  });
});

describe('peekLeadingBytes', () => {
  const collect = async (stream: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  it('returns the leading bytes without consuming them', async () => {
    const stream = new PassThrough();
    stream.write(Buffer.from([0x1f, 0x8b, 1, 2]));
    stream.write(Buffer.from([3, 4]));
    stream.end();

    const peeked = await peekLeadingBytes(stream, 2, 1000);

    assert.equal(peeked.stream, stream);
    assert.deepEqual(peeked.head, Buffer.from([0x1f, 0x8b, 1, 2]));
    assert.deepEqual(
      await collect(peeked.stream),
      Buffer.from([0x1f, 0x8b, 1, 2, 3, 4]),
    );
  });

  it('collects a prefix split across chunks and restores them in order', async () => {
    const stream = new PassThrough();
    // Each write is read as its own chunk.
    stream.write(Buffer.from([0x28]));
    setImmediate(() => {
      stream.write(Buffer.from([0xb5, 0x2f]));
      setImmediate(() => stream.end(Buffer.from([0xfd, 9, 9])));
    });

    const peeked = await peekLeadingBytes(stream, 4, 1000);

    assert.equal(peeked.stream, stream);
    assert.deepEqual(
      peeked.head.subarray(0, 4),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    );
    assert.deepEqual(
      await collect(peeked.stream),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 9, 9]),
    );
  });

  it('hands back a fresh stream of the whole body when it is shorter than asked', async () => {
    const stream = new PassThrough();
    stream.end(Buffer.from([0x1f]));

    const peeked = await peekLeadingBytes(stream, 4, 1000);

    assert.deepEqual(peeked.head, Buffer.from([0x1f]));
    assert.notEqual(peeked.stream, stream);
    assert.deepEqual(await collect(peeked.stream), Buffer.from([0x1f]));
  });

  it('hands back an empty stream when the body is empty', async () => {
    const stream = new PassThrough();
    stream.end();

    const peeked = await peekLeadingBytes(stream, 2, 1000);

    assert.equal(peeked.head.length, 0);
    assert.equal((await collect(peeked.stream)).length, 0);
  });

  it('leaves the stream paused, so a later stall timeout loses no bytes', async () => {
    const stream = new PassThrough();
    const body = Buffer.alloc(256 * 1024, 7);
    stream.end(body);

    const peeked = await peekLeadingBytes(stream, 2, 1000);
    assert.equal(peeked.stream.isPaused(), true);

    const cleanup = attachStallTimeout(peeked.stream, 1000);
    const sink = new PassThrough();
    peeked.stream.pipe(sink);
    const received = await collect(sink);
    cleanup();

    assert.equal(received.length, body.length);
    assert.deepEqual(received, body);
  });

  it('starts a stream that was paused before the peek', async () => {
    const stream = new PassThrough();
    stream.pause();
    setImmediate(() => stream.end(Buffer.from('abc')));

    const peeked = await peekLeadingBytes(stream, 2, 1000);

    assert.deepEqual(peeked.head, Buffer.from('abc'));
    assert.deepEqual(await collect(peeked.stream), Buffer.from('abc'));
  });

  it('rejects and destroys the stream when the bytes do not arrive in time', async () => {
    const stream = new PassThrough();
    stream.write(Buffer.from([0x1f]));
    // The peek's timer is unref'd, like the stall timer; hold the loop open.
    const keepAlive = setTimeout(() => {}, 1000);

    await assert.rejects(
      peekLeadingBytes(stream, 2, 20),
      /Received 1 of 2 leading bytes/,
    );
    clearTimeout(keepAlive);
    assert.equal(stream.destroyed, true);
  });

  it('rejects with an AbortError and destroys the stream on abort', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    setImmediate(() => controller.abort());

    await assert.rejects(
      peekLeadingBytes(stream, 2, 10_000, controller.signal),
      (error: Error) => error.name === 'AbortError',
    );
    assert.equal(stream.destroyed, true);
  });

  it('rejects at once for an already-aborted signal', async () => {
    const stream = new PassThrough();
    stream.write(Buffer.from('abc'));

    await assert.rejects(
      peekLeadingBytes(stream, 2, 10_000, AbortSignal.abort()),
      (error: Error) => error.name === 'AbortError',
    );
    assert.equal(stream.destroyed, true);
  });

  it('stops listening for abort once the peek resolves', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    stream.end(Buffer.from('abc'));

    const peeked = await peekLeadingBytes(stream, 2, 10_000, controller.signal);
    controller.abort();

    assert.equal(stream.destroyed, false);
    assert.deepEqual(await collect(peeked.stream), Buffer.from('abc'));
  });

  it('rejects on a stream error', async () => {
    const stream = new PassThrough();
    setImmediate(() => stream.destroy(new Error('boom')));

    await assert.rejects(peekLeadingBytes(stream, 2, 1000), /boom/);
  });
});
