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
