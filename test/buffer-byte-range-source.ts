/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ByteRangeSource } from '../src/lib/byte-range-source.js';

/**
 * An in-memory root transaction for tests. A read outside the bytes fails as
 * a gateway answers a range the root doesn't have: an error carrying a 416.
 */
export class BufferByteRangeSource implements ByteRangeSource {
  constructor(private readonly bytes: Buffer) {}

  async read(offset: number, size: number): Promise<Buffer> {
    if (offset < 0 || offset + size > this.bytes.length) {
      throw Object.assign(
        new Error(`Read ${offset}+${size} is outside the root`),
        { response: { status: 416 } },
      );
    }
    return this.bytes.subarray(offset, offset + size);
  }

  async close(): Promise<void> {}

  isOpen(): boolean {
    return true;
  }
}
