/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Transform, TransformCallback } from 'node:stream';

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
