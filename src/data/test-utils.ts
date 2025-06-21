/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';

export class TestDestroyedReadable extends Readable {
  private counter: number;

  constructor() {
    super();
    this.counter = 0;
  }

  _read() {
    this.counter += 1;

    // Simulate reading data
    const chunk = Buffer.from(`Chunk ${this.counter}\n`);
    this.push(chunk);

    // Destroy the stream after reading 5 chunks
    if (this.counter === 5) {
      this.destroy(new Error('Stream destroyed intentionally'));
    }
  }
}

export const axiosStreamData = Readable.from(['mocked stream']);
