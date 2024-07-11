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

import { B64uTag } from '../../types';

const MAX_TAG_BYTES = 4096;
const CONTINUE_BIT = 0x80;
const DATA_BITS = 0x7f;

export class AVSCTap {
  protected buf: Buffer;
  protected pos: number;

  constructor(buf = Buffer.alloc(MAX_TAG_BYTES), pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  public writeTags(tags: B64uTag[]): void {
    if (!Array.isArray(tags)) {
      throw new Error('input must be array');
    }

    this.writeLong(tags.length);
    for (const tag of tags) {
      if (typeof tag?.name !== 'string' || typeof tag?.value !== 'string') {
        throw new Error(
          `Invalid tag format for ${tag}, expected {name:string, value: string}`,
        );
      }
      this.writeString(tag.name);
      this.writeString(tag.value);
    }
    this.writeLong(0);
  }

  public toBuffer(): Buffer {
    return this.buf.subarray(0, this.pos);
  }

  protected writeLong(n: number): void {
    let value = n >= 0 ? n << 1 : (~n << 1) | 1;
    do {
      let byte = value & DATA_BITS;
      value >>>= 7;
      if (value !== 0) {
        byte |= CONTINUE_BIT;
      }
      this.buf[this.pos++] = byte;
    } while (value !== 0);
  }

  protected writeString(s: string): void {
    const len = Buffer.byteLength(s);
    this.writeLong(len);
    this.buf.write(s, this.pos, len, 'utf8');
    this.pos += len;
  }

  protected readLong(): number {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.buf[this.pos++];
      result |= (byte & DATA_BITS) << shift;
      shift += 7;
    } while ((byte & CONTINUE_BIT) !== 0);
    return (result >>> 1) ^ -(result & 1);
  }

  protected skipLong(): void {
    while ((this.buf[this.pos++] & CONTINUE_BIT) !== 0) {
      if (this.pos >= this.buf.length) {
        throw new Error('Unexpected end of buffer');
      }
    }
  }

  public readTags(): B64uTag[] {
    const val: B64uTag[] = [];
    let n = this.readLong();
    while (n !== 0) {
      if (n < 0) {
        n = -n;
        this.skipLong();
      }
      for (let i = 0; i < n; i++) {
        const name = this.readString();
        const value = this.readString();
        val.push({ name, value });
      }
      n = this.readLong();
    }
    return val;
  }

  protected readString(): string {
    const len = this.readLong();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.buf.length) {
      throw new Error('TAP Position out of range');
    }
    return this.buf.toString('utf8', start, this.pos);
  }
}

export function deserializeTags(tagsBuffer: Buffer): B64uTag[] {
  const tap = new AVSCTap(tagsBuffer);
  return tap.readTags();
}
