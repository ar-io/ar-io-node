/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';
import { ContiguousDataByteRangeSource } from './contiguous-data-byte-range-source.js';
import { ContiguousDataSource } from '../types.js';

// PE-9081: tests for the bounded streamToBuffer rewrite. Replaces the
// previous Buffer.concat-per-chunk pattern with Buffer.alloc(size) + offset
// writes; aborts the stream and throws on overage.
describe('ContiguousDataByteRangeSource', () => {
  const makeDataSource = (
    streamFactory: () => Readable,
    extras: { size?: number } = {},
  ): ContiguousDataSource => ({
    getData: mock.fn(async () => ({
      stream: streamFactory(),
      size: extras.size ?? 0,
      verified: false,
      trusted: false,
      cached: false,
      requestAttributes: {} as any,
    })),
  });

  describe('read', () => {
    it('should return exactly size bytes when upstream emits exactly size bytes', async () => {
      const payload = Buffer.from('hello world!'); // 12 bytes
      const source = new ContiguousDataByteRangeSource({
        dataSource: makeDataSource(() => Readable.from([payload])),
        id: 'tx',
      });

      const result = await source.read(0, 12);
      assert.equal(result.length, 12);
      assert.equal(result.toString(), 'hello world!');
    });

    it('should accept a stream split across multiple chunks summing to size', async () => {
      const source = new ContiguousDataByteRangeSource({
        dataSource: makeDataSource(() =>
          Readable.from([
            Buffer.from('aa'),
            Buffer.from('bb'),
            Buffer.from('cc'),
          ]),
        ),
        id: 'tx',
      });

      const result = await source.read(0, 6);
      assert.equal(result.toString(), 'aabbcc');
    });

    it('should throw on size <= 0', async () => {
      const source = new ContiguousDataByteRangeSource({
        dataSource: makeDataSource(() => Readable.from([Buffer.alloc(0)])),
        id: 'tx',
      });

      await assert.rejects(source.read(0, 0), /invalid size/);
      await assert.rejects(source.read(0, -1), /invalid size/);
    });

    it('should throw and destroy stream when upstream emits more bytes than requested', async () => {
      const oversized = Buffer.alloc(100, 0x41);
      let destroyed = false;
      const stream = Readable.from([oversized]);
      const origDestroy = stream.destroy.bind(stream);
      stream.destroy = (...args: any[]) => {
        destroyed = true;
        return origDestroy(...args);
      };

      const source = new ContiguousDataByteRangeSource({
        dataSource: makeDataSource(() => stream),
        id: 'tx',
      });

      await assert.rejects(
        source.read(0, 10),
        /more bytes than requested/,
      );
      assert.equal(destroyed, true);
    });

    it('should throw on short read', async () => {
      const source = new ContiguousDataByteRangeSource({
        dataSource: makeDataSource(() => Readable.from([Buffer.from('hi')])),
        id: 'tx',
      });

      await assert.rejects(source.read(0, 100), /short read/);
    });
  });
});
