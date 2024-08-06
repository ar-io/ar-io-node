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
import { describe, it, beforeEach, mock } from 'node:test';
import * as winston from 'winston';
import { SignatureFetcher } from './signature-fetcher.js';
import { ContiguousDataSource, ContiguousDataIndex } from '../types.js';

describe('SignatureFetcher', () => {
  let log: winston.Logger;
  let dataSource: ContiguousDataSource;
  let dataIndex: ContiguousDataIndex;
  let signatureFetcher: SignatureFetcher;

  beforeEach(() => {
    log = winston.createLogger({ silent: true });
    dataSource = {
      getData: mock.fn(),
    } as unknown as ContiguousDataSource;
    dataIndex = {
      getDataItemAttributes: mock.fn(),
    } as unknown as ContiguousDataIndex;

    signatureFetcher = new SignatureFetcher({ log, dataSource, dataIndex });
  });

  describe('getDataItemSignature', () => {
    it('should return undefined if no attributes found', async () => {
      mock.method(dataIndex, 'getDataItemAttributes', async () => undefined);

      const result = await signatureFetcher.getDataItemSignature('testId');

      assert.strictEqual(result, undefined);
    });

    it('should return signature if it exists in attributes', async () => {
      const testSignature = 'testSignature';
      mock.method(dataIndex, 'getDataItemAttributes', async () => ({
        signature: testSignature,
      }));

      const result = await signatureFetcher.getDataItemSignature('testId');

      assert.strictEqual(result, testSignature);
    });

    it('should fetch and return signature if not in attributes', async () => {
      const testParentId = 'testParentId';
      const testSignatureOffset = 100;
      const testSignatureSize = 512;
      const testSignatureBuffer = Buffer.from('testSignature');

      mock.method(dataIndex, 'getDataItemAttributes', async () => ({
        parentId: testParentId,
        signatureOffset: testSignatureOffset,
        signatureSize: testSignatureSize,
      }));

      mock.method(dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testSignatureBuffer;
          },
        },
      }));

      const result = await signatureFetcher.getDataItemSignature('testId');

      assert.strictEqual(result, testSignatureBuffer.toString('base64url'));
    });

    it('should handle errors and return undefined', async () => {
      mock.method(dataIndex, 'getDataItemAttributes', async () => {
        throw new Error('Test error');
      });

      const result = await signatureFetcher.getDataItemSignature('testId');

      assert.strictEqual(result, undefined);
    });
  });
});
