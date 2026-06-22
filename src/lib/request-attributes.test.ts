/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { headerNames } from '../constants.js';
import { RequestAttributes } from '../types.js';
import {
  detectLoopInViaChain,
  generateRequestAttributes,
  parseRequestAttributesHeaders,
  parseUpstreamTagHeaders,
  parseViaHeader,
  validateHopCount,
} from './request-attributes.js';

describe('Request attributes functions', () => {
  describe('generateRequestAttributes', () => {
    it('should returns undefined when input is undefined', () => {
      const result = generateRequestAttributes(undefined);
      assert.strictEqual(result, undefined);
    });

    it('should handles hops, origin, and nodeRelease correctly', () => {
      const input: RequestAttributes = {
        hops: 2,
        origin: 'test-origin',
        originNodeRelease: 'v1.0.0',
      };
      const expected = {
        headers: {
          [headerNames.hops]: '3',
          [headerNames.origin]: 'test-origin',
          [headerNames.originNodeRelease]: 'v1.0.0',
        },
        attributes: {
          hops: 3,
          origin: 'test-origin',
          originNodeRelease: 'v1.0.0',
        },
      };

      const result = generateRequestAttributes(input);
      assert.deepStrictEqual(result, expected);
    });

    it('should handles missing hops correctly', () => {
      const input = {
        origin: 'test-origin',
        originNodeRelease: 'v1.0.0',
      } as RequestAttributes;
      const expected = {
        headers: {
          [headerNames.hops]: '1',
          [headerNames.origin]: 'test-origin',
          [headerNames.originNodeRelease]: 'v1.0.0',
        },
        attributes: {
          hops: 1,
          origin: 'test-origin',
          originNodeRelease: 'v1.0.0',
        },
      };

      const result = generateRequestAttributes(input);
      assert.deepStrictEqual(result, expected);
    });

    it('should handles missing origin and nodeVersion correctly', () => {
      const input: RequestAttributes = {
        hops: 2,
      };
      const expected = {
        headers: {
          [headerNames.hops]: '3',
        },
        attributes: {
          hops: 3,
        },
      };

      const result = generateRequestAttributes(input);
      assert.deepStrictEqual(result, expected);
    });

    it('should handles ArNS headers correctly', () => {
      const input: RequestAttributes = {
        hops: 1,
        origin: 'test-origin',
        arnsName: 'test-basename_test-record',
        arnsBasename: 'test-basename',
        arnsRecord: 'test-record',
      };
      const expected = {
        headers: {
          [headerNames.hops]: '2',
          [headerNames.origin]: 'test-origin',
          [headerNames.arnsName]: 'test-basename_test-record',
          [headerNames.arnsBasename]: 'test-basename',
          [headerNames.arnsRecord]: 'test-record',
        },
        attributes: {
          hops: 2,
          origin: 'test-origin',
          arnsName: 'test-basename_test-record',
          arnsBasename: 'test-basename',
          arnsRecord: 'test-record',
        },
      };

      const result = generateRequestAttributes(input);
      assert.deepStrictEqual(result, expected);
    });
  });

  describe('parseRequestAttributesHeaders', () => {
    it('should parses headers correctly', () => {
      const headers = {
        [headerNames.hops]: '3',
        [headerNames.origin]: 'test-origin',
        [headerNames.originNodeRelease]: 'v1.0.0',
      };
      const expected: RequestAttributes = {
        hops: 3,
        origin: headers[headerNames.origin],
        originNodeRelease: headers[headerNames.originNodeRelease],
        clientIps: [],
      };

      const result = parseRequestAttributesHeaders({ headers });
      assert.deepStrictEqual(result, expected);
    });

    it('should handles missing hops and currentHops', () => {
      const headers = {
        [headerNames.origin]: 'test-origin',
        [headerNames.originNodeRelease]: 'v1.0.0',
      };
      const expected: RequestAttributes = {
        hops: 1,
        origin: headers[headerNames.origin],
        originNodeRelease: headers[headerNames.originNodeRelease],
        clientIps: [],
      };

      const result = parseRequestAttributesHeaders({ headers });
      assert.deepStrictEqual(result, expected);
    });

    it('should use currentHops when hops header is missing', () => {
      const headers = {
        [headerNames.origin]: 'test-origin',
        [headerNames.originNodeRelease]: 'v1.0.0',
      };
      const currentHops = 2;
      const expected: RequestAttributes = {
        hops: currentHops,
        origin: headers[headerNames.origin],
        originNodeRelease: headers[headerNames.originNodeRelease],
        clientIps: [],
      };

      const result = parseRequestAttributesHeaders({ headers, currentHops });
      assert.deepStrictEqual(result, expected);
    });

    it('should parses ArNS headers correctly', () => {
      const headers = {
        [headerNames.hops]: '2',
        [headerNames.origin]: 'test-origin',
        [headerNames.arnsName]: 'test-basename_test-record',
        [headerNames.arnsBasename]: 'test-basename',
        [headerNames.arnsRecord]: 'test-record',
      };
      const expected: RequestAttributes = {
        hops: 2,
        origin: 'test-origin',
        originNodeRelease: undefined,
        arnsName: 'test-basename_test-record',
        arnsBasename: 'test-basename',
        arnsRecord: 'test-record',
        clientIps: [],
      };

      const result = parseRequestAttributesHeaders({ headers });
      assert.deepStrictEqual(result, expected);
    });
  });

  describe('parseViaHeader', () => {
    it('should return empty array for undefined input', () => {
      assert.deepStrictEqual(parseViaHeader(undefined), []);
    });

    it('should return empty array for empty string', () => {
      assert.deepStrictEqual(parseViaHeader(''), []);
    });

    it('should return empty array for whitespace-only string', () => {
      assert.deepStrictEqual(parseViaHeader('   '), []);
    });

    it('should parse a single entry', () => {
      assert.deepStrictEqual(parseViaHeader('gateway-a.example.com'), [
        'gateway-a.example.com',
      ]);
    });

    it('should parse multiple entries', () => {
      assert.deepStrictEqual(
        parseViaHeader('gateway-a.example.com, gateway-b.example.com'),
        ['gateway-a.example.com', 'gateway-b.example.com'],
      );
    });

    it('should trim whitespace from entries', () => {
      assert.deepStrictEqual(
        parseViaHeader('  gateway-a.example.com ,  gateway-b.example.com  '),
        ['gateway-a.example.com', 'gateway-b.example.com'],
      );
    });

    it('should lowercase entries', () => {
      assert.deepStrictEqual(
        parseViaHeader('Gateway-A.Example.COM, GATEWAY-B.EXAMPLE.COM'),
        ['gateway-a.example.com', 'gateway-b.example.com'],
      );
    });

    it('should filter out empty entries from extra commas', () => {
      assert.deepStrictEqual(
        parseViaHeader('gateway-a.example.com,,gateway-b.example.com,'),
        ['gateway-a.example.com', 'gateway-b.example.com'],
      );
    });
  });

  describe('detectLoopInViaChain', () => {
    it('should return false for empty chain', () => {
      assert.strictEqual(
        detectLoopInViaChain([], 'gateway.example.com'),
        false,
      );
    });

    it('should return false when self is not in chain', () => {
      assert.strictEqual(
        detectLoopInViaChain(
          ['gateway-a.example.com', 'gateway-b.example.com'],
          'gateway-c.example.com',
        ),
        false,
      );
    });

    it('should return true when self is in chain', () => {
      assert.strictEqual(
        detectLoopInViaChain(
          ['gateway-a.example.com', 'gateway-b.example.com'],
          'gateway-a.example.com',
        ),
        true,
      );
    });

    it('should be case insensitive', () => {
      assert.strictEqual(
        detectLoopInViaChain(
          ['gateway-a.example.com'],
          'Gateway-A.Example.COM',
        ),
        true,
      );
    });
  });

  describe('generateRequestAttributes with via', () => {
    it('should propagate via in headers', () => {
      const input: RequestAttributes = {
        hops: 1,
        via: ['gateway-a.example.com', 'gateway-b.example.com'],
      };
      const result = generateRequestAttributes(input);
      assert.strictEqual(
        result?.headers[headerNames.via],
        'gateway-a.example.com, gateway-b.example.com',
      );
      assert.deepStrictEqual(result?.attributes.via, [
        'gateway-a.example.com',
        'gateway-b.example.com',
      ]);
    });

    it('should omit via header when via is undefined', () => {
      const input: RequestAttributes = {
        hops: 1,
      };
      const result = generateRequestAttributes(input);
      assert.strictEqual(result?.headers[headerNames.via], undefined);
      assert.strictEqual(result?.attributes.via, undefined);
    });

    it('should omit via header when via is empty array', () => {
      const input: RequestAttributes = {
        hops: 1,
        via: [],
      };
      const result = generateRequestAttributes(input);
      assert.strictEqual(result?.headers[headerNames.via], undefined);
      assert.strictEqual(result?.attributes.via, undefined);
    });
  });

  describe('parseRequestAttributesHeaders with via', () => {
    it('should parse via header', () => {
      const headers = {
        [headerNames.hops]: '2',
        [headerNames.via]: 'gateway-a.example.com, gateway-b.example.com',
      };
      const result = parseRequestAttributesHeaders({ headers });
      assert.deepStrictEqual(result.via, [
        'gateway-a.example.com',
        'gateway-b.example.com',
      ]);
    });

    it('should omit via when header is absent', () => {
      const headers = {
        [headerNames.hops]: '1',
      };
      const result = parseRequestAttributesHeaders({ headers });
      assert.strictEqual(result.via, undefined);
    });

    it('should round-trip via through generate and parse', () => {
      const input: RequestAttributes = {
        hops: 1,
        via: ['gateway-a.example.com', 'gateway-b.example.com'],
      };
      const generated = generateRequestAttributes(input);
      assert.ok(generated);
      const parsed = parseRequestAttributesHeaders({
        headers: generated.headers,
      });
      assert.deepStrictEqual(parsed.via, input.via);
    });
  });

  describe('parseUpstreamTagHeaders', () => {
    it('should parse X-Arweave-Tag-* headers into tag pairs', () => {
      const headers = {
        'X-Arweave-Tag-Content-Type': 'image/png',
        'X-Arweave-Tag-App-Name': 'ArDrive-App',
      };
      const result = parseUpstreamTagHeaders(headers);
      assert.deepStrictEqual(result, [
        { name: 'Content-Type', value: 'image/png' },
        { name: 'App-Name', value: 'ArDrive-App' },
      ]);
    });

    it('should be case-insensitive on the prefix', () => {
      const headers = {
        'x-arweave-tag-content-type': 'image/png',
        'X-ARWEAVE-TAG-App-Name': 'MyApp',
      };
      const result = parseUpstreamTagHeaders(headers);
      assert.ok(result !== undefined);
      assert.strictEqual(result!.length, 2);
    });

    it('should exclude X-Arweave-Tag-Count and X-Arweave-Tags-Truncated', () => {
      const headers = {
        'X-Arweave-Tag-Count': '5',
        'X-Arweave-Tags-Truncated': 'true',
        'X-Arweave-Tag-App-Name': 'ArDrive',
      };
      const result = parseUpstreamTagHeaders(headers);
      assert.deepStrictEqual(result, [{ name: 'App-Name', value: 'ArDrive' }]);
    });

    it('should return undefined when no tag headers are present', () => {
      const headers = {
        'Content-Type': 'text/html',
        'X-AR-IO-Hops': '2',
      };
      const result = parseUpstreamTagHeaders(headers);
      assert.strictEqual(result, undefined);
    });

    it('should return undefined for empty headers', () => {
      const result = parseUpstreamTagHeaders({});
      assert.strictEqual(result, undefined);
    });

    it('should handle array values (multiple headers with same name)', () => {
      const headers: Record<string, string | string[]> = {
        'X-Arweave-Tag-Topic': ['topic1', 'topic2'],
      };
      const result = parseUpstreamTagHeaders(headers);
      assert.deepStrictEqual(result, [
        { name: 'Topic', value: 'topic1' },
        { name: 'Topic', value: 'topic2' },
      ]);
    });

    it('should preserve original tag name casing after prefix', () => {
      const headers = {
        'X-Arweave-Tag-Content-Type': 'text/html',
      };
      const result = parseUpstreamTagHeaders(headers);
      assert.strictEqual(result![0].name, 'Content-Type');
    });
  });

  describe('retrieval-hint propagation (#A)', () => {
    const txId = 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc';
    const parentId = '8czOfZFwzg2VSsDKpEhGR7s49o1niLJFfxChEqJ58hk';

    describe('generateRequestAttributes — outbound emission', () => {
      it('emits no hint headers when no hints are populated', () => {
        const result = generateRequestAttributes({ hops: 1 });
        assert.ok(result !== undefined);
        assert.strictEqual(
          result.headers[headerNames.rootTransactionId],
          undefined,
        );
        assert.strictEqual(result.headers[headerNames.rootPath], undefined);
        assert.strictEqual(
          result.headers[headerNames.rootItemOffset],
          undefined,
        );
        assert.strictEqual(result.headers[headerNames.rootItemSize], undefined);
      });

      it('emits Root-Transaction-Id when rootTransactionIdHint is set', () => {
        const result = generateRequestAttributes({
          hops: 1,
          rootTransactionIdHint: txId,
        });
        assert.ok(result !== undefined);
        assert.strictEqual(result.headers[headerNames.rootTransactionId], txId);
        assert.strictEqual(result.attributes.rootTransactionIdHint, txId);
      });

      it('emits Root-Path comma-joined when rootPathHint is set', () => {
        const result = generateRequestAttributes({
          hops: 1,
          rootPathHint: [txId, parentId],
        });
        assert.ok(result !== undefined);
        assert.strictEqual(
          result.headers[headerNames.rootPath],
          `${txId},${parentId}`,
        );
        assert.deepStrictEqual(result.attributes.rootPathHint, [
          txId,
          parentId,
        ]);
      });

      it('omits Root-Path when rootPathHint is an empty array', () => {
        const result = generateRequestAttributes({
          hops: 1,
          rootPathHint: [],
        });
        assert.ok(result !== undefined);
        assert.strictEqual(result.headers[headerNames.rootPath], undefined);
      });

      it('emits Root-Item-Offset + Root-Item-Size as a pair when rootByteHint is set', () => {
        const result = generateRequestAttributes({
          hops: 1,
          rootByteHint: { offset: 12345, size: 6789 },
        });
        assert.ok(result !== undefined);
        assert.strictEqual(result.headers[headerNames.rootItemOffset], '12345');
        assert.strictEqual(result.headers[headerNames.rootItemSize], '6789');
        assert.deepStrictEqual(result.attributes.rootByteHint, {
          offset: 12345,
          size: 6789,
        });
      });

      it('emits all three hint kinds together', () => {
        const result = generateRequestAttributes({
          hops: 1,
          rootTransactionIdHint: txId,
          rootPathHint: [txId, parentId],
          rootByteHint: { offset: 100, size: 200 },
        });
        assert.ok(result !== undefined);
        assert.strictEqual(result.headers[headerNames.rootTransactionId], txId);
        assert.strictEqual(
          result.headers[headerNames.rootPath],
          `${txId},${parentId}`,
        );
        assert.strictEqual(result.headers[headerNames.rootItemOffset], '100');
        assert.strictEqual(result.headers[headerNames.rootItemSize], '200');
      });
    });

    describe('parseRequestAttributesHeaders — inbound parsing', () => {
      it('parses Root-Transaction-Id into rootTransactionIdHint', () => {
        const parsed = parseRequestAttributesHeaders({
          headers: { [headerNames.rootTransactionId]: txId },
        });
        assert.strictEqual(parsed.rootTransactionIdHint, txId);
      });

      it('parses comma-separated Root-Path into rootPathHint array', () => {
        const parsed = parseRequestAttributesHeaders({
          headers: { [headerNames.rootPath]: ` ${txId} , ${parentId} ` },
        });
        assert.deepStrictEqual(parsed.rootPathHint, [txId, parentId]);
      });

      it('parses Root-Item-Offset + Root-Item-Size pair into rootByteHint', () => {
        const parsed = parseRequestAttributesHeaders({
          headers: {
            [headerNames.rootItemOffset]: '12345',
            [headerNames.rootItemSize]: '6789',
          },
        });
        assert.deepStrictEqual(parsed.rootByteHint, {
          offset: 12345,
          size: 6789,
        });
      });

      it('omits rootByteHint when only one of the offset/size pair is present', () => {
        const parsed = parseRequestAttributesHeaders({
          headers: { [headerNames.rootItemOffset]: '12345' },
        });
        assert.strictEqual(parsed.rootByteHint, undefined);
      });
    });

    describe('round-trip — emit then parse', () => {
      it('preserves all three hint kinds across one emit/parse cycle', () => {
        const emitted = generateRequestAttributes({
          hops: 1,
          rootTransactionIdHint: txId,
          rootPathHint: [txId, parentId],
          rootByteHint: { offset: 100, size: 200 },
        });
        assert.ok(emitted !== undefined);

        const parsed = parseRequestAttributesHeaders({
          headers: emitted.headers,
        });
        assert.strictEqual(parsed.rootTransactionIdHint, txId);
        assert.deepStrictEqual(parsed.rootPathHint, [txId, parentId]);
        assert.deepStrictEqual(parsed.rootByteHint, {
          offset: 100,
          size: 200,
        });
      });
    });
  });

  describe('validateHopCount', () => {
    it('should throw when hops exceed maximum', () => {
      assert.throws(
        () => validateHopCount(2, 1),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('should throw when hops equal maximum', () => {
      assert.throws(
        () => validateHopCount(1, 1),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('should not throw when hops are below maximum', () => {
      assert.doesNotThrow(() => validateHopCount(0, 1));
    });

    it('should work with different maxHops values', () => {
      assert.doesNotThrow(() => validateHopCount(2, 3));
      assert.throws(
        () => validateHopCount(3, 3),
        /Maximum hops \(3\) exceeded/,
      );
      assert.throws(
        () => validateHopCount(4, 3),
        /Maximum hops \(3\) exceeded/,
      );
    });
  });
});
