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
    timer = setTimeout(() => {
      stream.destroy(
        new Error(
          `Stream stall timeout: no data received for ${stallTimeoutMs}ms`,
        ),
      );
    }, stallTimeoutMs);
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
    maxTimer = setTimeout(() => {
      stream.destroy(
        new Error(
          `Stream wall-clock timeout: not complete within ${maxRequestMs}ms`,
        ),
      );
    }, maxRequestMs);
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
    stream.off('close', cleanup);
  };
  stream.once('end', cleanup);
  stream.once('error', cleanup);
  stream.once('close', cleanup);
  return cleanup;
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
