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
