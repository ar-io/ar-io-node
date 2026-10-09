/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ServerResponse } from 'node:http';
import { Readable, Transform, TransformCallback } from 'node:stream';
import * as winston from 'winston';

import * as metrics from '../metrics.js';

/**
 * Attaches a stall timeout to a readable stream. If no 'data' event fires
 * within `stallTimeoutMs`, the stream is destroyed with an error. The timer
 * resets on every chunk, so active transfers are never interrupted.
 *
 * **Side effect:** The stream is paused after attaching because adding a
 * `'data'` listener switches it to flowing mode. Callers must call
 * `stream.pipe()` or `stream.resume()` to start flowing.
 *
 * **Wall-clock cap (`maxRequestMs`, optional):** the stall timer is cleared
 * on every `'pause'` so legitimate backpressure does not look like an
 * upstream stall. That leaves an edge case where an upstream peer goes
 * silent *while* the consumer is paused for backpressure — neither
 * `'data'`, `'pause'`, nor `'resume'` fires again, the stall timer is
 * never re-armed, and the stream hangs forever. When a caller passes
 * `maxRequestMs`, a second timer is scheduled that fires unconditionally
 * after that duration regardless of pause/resume state. Mirrors the
 * connection-phase `setTimeout(controller.abort, requestTimeoutMs)` idiom
 * used in ar-io-data-source.ts for the connection phase. Use this for any
 * HTTP-response stream where a hung peer must not wedge a worker.
 *
 * Returns a cleanup function that clears the timer and removes listeners.
 */
export function attachStallTimeout(
  stream: Readable,
  stallTimeoutMs: number,
  maxRequestMs?: number,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let maxTimer: NodeJS.Timeout | undefined;
  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const clearMaxTimer = () => {
    if (maxTimer !== undefined) {
      clearTimeout(maxTimer);
      maxTimer = undefined;
    }
  };
  const armTimer = () => {
    clearTimer();
    // unref so the watchdog never keeps the process alive on its own. In a
    // live gateway the HTTP server/sockets hold the loop open, so this still
    // fires on schedule; it only stops mattering when it is the sole
    // remaining handle (e.g. test teardown after a stream is never drained),
    // preventing a 15-minute idle hang from the wall-clock cap below.
    timer = setTimeout(() => {
      stream.destroy(
        new Error(
          `Stream stall timeout: no data received for ${stallTimeoutMs}ms`,
        ),
      );
    }, stallTimeoutMs).unref();
  };
  const onResume = () => {
    if (stream.readableFlowing === true) {
      armTimer();
    }
  };
  const onPause = () => {
    // Backpressure pauses should not count as upstream stalls.
    clearTimer();
  };
  const onData = () => {
    if (stream.readableFlowing === true) {
      armTimer();
    }
  };

  stream.on('resume', onResume);
  stream.on('pause', onPause);
  stream.on('data', onData);

  // If stream is already flowing when attached, start monitoring immediately.
  if (stream.readableFlowing === true) {
    armTimer();
  }

  // Wall-clock cap: fires regardless of pause/resume state. Catches the
  // backpressure-pause-then-upstream-stall wedge that the per-data stall
  // timer cannot see.
  if (maxRequestMs !== undefined) {
    // unref for the same reason as the stall timer: in production other
    // handles keep the loop alive so this still fires, but it must not by
    // itself hold a process open (a stream that is never drained in tests
    // would otherwise wedge the runner for the full maxRequestMs).
    maxTimer = setTimeout(() => {
      stream.destroy(
        new Error(
          `Stream wall-clock timeout: not complete within ${maxRequestMs}ms`,
        ),
      );
    }, maxRequestMs).unref();
  }

  // Re-pause the stream since adding a 'data' listener switches it to
  // flowing mode. Consumers control when the stream starts flowing via
  // pipe() or resume().
  stream.pause();

  const cleanup = () => {
    clearTimer();
    clearMaxTimer();
    stream.off('resume', onResume);
    stream.off('pause', onPause);
    stream.off('data', onData);
    stream.off('end', cleanup);
    stream.off('error', cleanup);
  };
  // Intentionally NOT registered on 'close': pipeline()'s eos() helper can
  // synchronously emit 'close' on streams during chain setup or when a
  // downstream stream is destroyed (cacheStream errors, peer aborts mid-
  // stream, etc.). Registering cleanup on 'close' caused maxTimer to be
  // cleared before it could ever fire — which is the exact wedge symptom
  // we kept hitting after PR #737: source stream paused for backpressure
  // and never emits 'end'/'error', maxTimer was supposed to be the safety
  // net but had been silently nuked by an earlier pipeline-driven 'close'.
  // 'end' and 'error' alone cover the common cases; for streams that fire
  // 'close' without either, maxTimer ticks until it fires (and calls
  // destroy() on an already-closed stream, a no-op) — a harmless N-minute
  // setTimeout outliving the stream, vs. permanently wedged workers.
  stream.once('end', cleanup);
  stream.once('error', cleanup);
  return cleanup;
}

/**
 * Reads at least `minBytes` from the start of a stream that nothing is reading
 * yet, collecting as many chunks as that takes, and resolves with those bytes
 * (`head`) and the stream to read the body from (`stream`).
 *
 * The collected chunks are put back in their original order, so `stream` is
 * the stream passed in and no bytes are consumed. When the stream ends before
 * `minBytes`, its bytes can no longer be put back, so `stream` is then a new
 * stream of exactly the bytes collected (possibly none), and `head` is shorter
 * than `minBytes`. Callers must read the body from the returned `stream`.
 *
 * A prefix split across chunks is the reason this collects: a first chunk of
 * one byte would otherwise be compared as if it were the whole prefix.
 *
 * Leaves the stream paused, as {@link attachStallTimeout} does, so consumers
 * start it with `pipe()` or `resume()`. Call it before attaching any `'data'`
 * listener: a stream that already has one can flow while the peek runs, and
 * those bytes would be lost.
 *
 * If `minBytes` have not arrived within `timeoutMs`, the stream is destroyed
 * and the promise rejects. If `signal` aborts first, the stream is destroyed
 * and the promise rejects with an `AbortError`.
 */
export function peekLeadingBytes(
  stream: Readable,
  minBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ head: Buffer; stream: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    // The caller has stopped wanting the bytes (client disconnect, or a hedged
    // request that lost): release the connection now, not at the timeout.
    const onAbort = () => {
      cleanup();
      stream.destroy();
      const error = new Error('Peek aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      collected += chunk.length;
      if (collected < minBytes) {
        return;
      }
      stream.pause();
      cleanup();
      // unshift() puts each chunk in front of the last, so restore them in
      // reverse to keep their order.
      for (let i = chunks.length - 1; i >= 0; i--) {
        stream.unshift(chunks[i]);
      }
      resolve({ head: Buffer.concat(chunks), stream });
    };
    // The whole body arrived before minBytes. An ended stream takes no
    // unshift, so hand back a fresh one carrying exactly those bytes.
    const onEnd = () => {
      cleanup();
      resolve({
        head: Buffer.concat(chunks),
        stream: Readable.from(chunks, { objectMode: false }),
      });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      // Destroy without an error: the 'error' listener is gone, and an
      // unhandled 'error' event would be an uncaught exception.
      stream.destroy();
      reject(
        new Error(
          `Received ${collected} of ${minBytes} leading bytes within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs).unref();

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    // A stream paused earlier does not start flowing on a new 'data' listener.
    stream.resume();
  });
}

/**
 * Pipes a readable stream to an HTTP response, logging and destroying
 * the response on stream error.
 */
export function pipeStreamToResponse(
  stream: Readable,
  res: ServerResponse,
  log: winston.Logger,
  dataId: string,
): void {
  stream.pipe(res);
  stream.once('error', (error) => {
    log.error('Stream error during data transfer:', {
      dataId,
      message: error.message,
    });
    if (!res.destroyed) {
      res.destroy();
    }
  });
  res.once('close', () => {
    if (!res.writableFinished && !stream.destroyed) {
      log.info('Client disconnected, destroying upstream stream', { dataId });
      metrics.clientDisconnectsTotal.inc();
      stream.destroy();
    }
  });
}

export class ByteRangeTransform extends Transform {
  private offset: number;
  private size: number;
  private bytesRead: number;
  private bytesWritten: number;

  constructor(offset: number, size: number) {
    super();
    this.offset = offset;
    this.size = size;
    this.bytesRead = 0;
    this.bytesWritten = 0;
  }

  _transform(
    chunk: Buffer,
    _: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.bytesWritten >= this.size) {
      this.push(null);
      return callback();
    }

    const chunkStart = Math.max(0, this.offset - this.bytesRead);
    const chunkEnd = Math.min(
      chunk.length,
      this.offset + this.size - this.bytesRead,
    );

    if (chunkStart < chunkEnd) {
      const slicedChunk = chunk.slice(chunkStart, chunkEnd);
      this.bytesWritten += slicedChunk.length;
      this.push(slicedChunk);
    }

    this.bytesRead += chunk.length;

    if (this.bytesWritten >= this.size) {
      this.push(null);
    }

    callback();
  }
}

export const bufferToStream = (buffer: Buffer) => {
  return new Readable({
    objectMode: false,
    read() {
      this.push(buffer);
      this.push(null);
    },
  });
};
