/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Readable, Transform, TransformCallback } from 'node:stream';

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
