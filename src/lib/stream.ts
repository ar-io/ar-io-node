/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Readable, Transform, TransformCallback } from 'node:stream';

/**
 * Attaches a stall timeout to a readable stream. If no 'data' event fires
 * within `stallTimeoutMs`, the stream is destroyed with an error. The timer
 * resets on every chunk, so active transfers are never interrupted.
 *
 * Returns a cleanup function that clears the timer and removes listeners.
 */
export function attachStallTimeout(
  stream: Readable,
  stallTimeoutMs: number,
): () => void {
  let timer: NodeJS.Timeout;
  const resetTimeout = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stream.destroy(
        new Error(
          `Stream stall timeout: no data received for ${stallTimeoutMs}ms`,
        ),
      );
    }, stallTimeoutMs);
  };
  // Start the initial timer (covers the gap before first data chunk)
  resetTimeout();
  stream.on('data', resetTimeout);
  // Re-pause the stream since adding a 'data' listener switches it to
  // flowing mode. Consumers control when the stream starts flowing via
  // pipe() or resume().
  stream.pause();

  const cleanup = () => {
    clearTimeout(timer);
    stream.off('data', resetTimeout);
  };
  stream.once('end', cleanup);
  stream.once('error', cleanup);
  stream.once('close', cleanup);
  return cleanup;
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
