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
