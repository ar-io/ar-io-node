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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { generateTransactionChunks } from 'arweave/node/lib/merkle.js';
import { toB64Url } from './encoding.js';
import { computeDataRootFromReadable } from './data-root-streaming.js';

describe('computeDataRootFromReadable', () => {
  it('computes the data root of a readable stream', async () => {
    const data = new Uint8Array(1024);
    const readStream = new Readable({
      read() {
        this.push(data);
        this.push(null);
      },
    });

    const dataRoot = await computeDataRootFromReadable(readStream);
    assert.strictEqual(dataRoot, 'gW9UehZlGpdJlUewW61TTIHXbRhjj7RbAxmFXt1GO_I');
  });

  it('matches the data root computed by Arweave-Js own function', async () => {
    const bundleTestFileUint8Array = fs.readFileSync(
      './test/mock_files/ans104_bundle',
    );
    const bundleTestFileReadable = fs.createReadStream(
      './test/mock_files/ans104_bundle',
    );

    const arweaveJsResult = toB64Url(
      Buffer.from(
        (await generateTransactionChunks(bundleTestFileUint8Array)).data_root,
      ),
    );
    const arioReadableResult = await computeDataRootFromReadable(
      bundleTestFileReadable,
    );

    const expectedDataRoot = 'BJkjrb7FyBkgNF6KvLNQpXgWSjMB75UaoioxIOKpcJA';

    assert.strictEqual(arweaveJsResult, expectedDataRoot);
    assert.strictEqual(arweaveJsResult, arioReadableResult);
  });
});
