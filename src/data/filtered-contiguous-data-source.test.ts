/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';
import * as winston from 'winston';

import { FilteredContiguousDataSource } from './filtered-contiguous-data-source.js';
import { ContiguousDataSource, RequestAttributes } from '../types.js';

let log: winston.Logger;
let mockDataSource: ContiguousDataSource;
let filteredDataSource: FilteredContiguousDataSource;

const mockContiguousData = {
  stream: Readable.from(['test data']),
  size: 9,
  verified: false,
  trusted: true,
  sourceContentType: 'text/plain',
  cached: false,
  requestAttributes: {
    hops: 1,
    origin: 'test-origin',
  },
};

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockDataSource = {
    getData: mock.fn(() => Promise.resolve(mockContiguousData)),
  };

  filteredDataSource = new FilteredContiguousDataSource({
    log,
    dataSource: mockDataSource,
    blockedOrigins: ['blocked-origin.com', 'evil.gateway.net'],
    blockedIpAddresses: ['192.168.1.100', '10.0.0.0/8'],
  });
});

afterEach(async () => {
  mock.restoreAll();
});

describe('FilteredContiguousDataSource', () => {
  describe('Allowed requests', () => {
    it('should pass through requests with no request attributes', async () => {
      const data = await filteredDataSource.getData({ id: 'test-id' });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should pass through requests with allowed origin', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.10',
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should pass through requests with no origin', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        clientIp: '192.168.1.10',
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should pass through requests with allowed IP', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.2.100',
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should pass through requests with no client IP', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });
  });

  describe('Blocked requests', () => {
    it('should block requests from blocked origin', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'blocked-origin.com',
        clientIp: '192.168.1.10',
      };

      await assert.rejects(
        filteredDataSource.getData({
          id: 'test-id',
          requestAttributes,
        }),
        /Request blocked: origin 'blocked-origin\.com' is blocked/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should block requests from exact IP match', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.100',
      };

      await assert.rejects(
        filteredDataSource.getData({
          id: 'test-id',
          requestAttributes,
        }),
        /Request blocked: IP '192\.168\.1\.100' is blocked/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should block requests from IP in CIDR range', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '10.0.5.100',
      };

      await assert.rejects(
        filteredDataSource.getData({
          id: 'test-id',
          requestAttributes,
        }),
        /Request blocked: IP '10\.0\.5\.100' is blocked/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should block requests from another blocked origin', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'evil.gateway.net',
        clientIp: '1.2.3.4',
      };

      await assert.rejects(
        filteredDataSource.getData({
          id: 'test-id',
          requestAttributes,
        }),
        /Request blocked: origin 'evil\.gateway\.net' is blocked/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });
  });

  describe('CIDR matching', () => {
    it('should not block IPs outside CIDR range', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '11.0.0.1', // Outside 10.0.0.0/8
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should handle invalid CIDR gracefully', async () => {
      const filteredDataSourceWithInvalidCidr =
        new FilteredContiguousDataSource({
          log,
          dataSource: mockDataSource,
          blockedOrigins: [],
          blockedIpAddresses: ['invalid-cidr/abc'],
        });

      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.1',
      };

      // Should not block due to invalid CIDR
      const data = await filteredDataSourceWithInvalidCidr.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });
  });

  describe('Configuration', () => {
    it('should work with empty blocking lists', async () => {
      const unrestrictedDataSource = new FilteredContiguousDataSource({
        log,
        dataSource: mockDataSource,
        blockedOrigins: [],
        blockedIpAddresses: [],
      });

      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'any-origin.com',
        clientIp: '192.168.1.100',
      };

      const data = await unrestrictedDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should pass through all parameters to inner data source', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 2,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.10',
        arnsName: 'test-name',
        arnsBasename: 'test-basename',
      };

      const region = { offset: 100, size: 200 };

      await filteredDataSource.getData({
        id: 'test-id-123',
        requestAttributes,
        region,
      });

      const mockCall = (mockDataSource.getData as any).mock.calls[0];
      assert.equal(mockCall.arguments[0].id, 'test-id-123');
      assert.deepEqual(
        mockCall.arguments[0].requestAttributes,
        requestAttributes,
      );
      assert.deepEqual(mockCall.arguments[0].region, region);
    });
  });
});
