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
import { headerNames } from '../constants.js';
import { RequestAttributes } from '../types.js';
import {
  generateRequestAttributes,
  parseRequestAttributesHeaders,
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
      };

      const result = parseRequestAttributesHeaders({ headers });
      assert.deepStrictEqual(result, expected);
    });
  });
});
