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
    blockedCidrs: ['192.168.1.100/32', '10.0.0.0/8'],
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
        clientIps: ['192.168.1.10'],
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
        clientIps: ['192.168.1.10'],
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
        clientIps: ['192.168.2.100'],
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
        clientIps: ['192.168.1.10'],
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
        clientIps: ['192.168.1.100'],
      };

      await assert.rejects(
        filteredDataSource.getData({
          id: 'test-id',
          requestAttributes,
        }),
        /Request blocked.*192\.168\.1\.100.*blocked/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should block requests from IP in CIDR range', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '10.0.5.100',
        clientIps: ['10.0.5.100'],
      };

      await assert.rejects(
        filteredDataSource.getData({
          id: 'test-id',
          requestAttributes,
        }),
        /Request blocked.*10\.0\.5\.100.*blocked/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should block requests from another blocked origin', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'evil.gateway.net',
        clientIp: '1.2.3.4',
        clientIps: ['1.2.3.4'],
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
        clientIps: ['11.0.0.1'],
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
        clientIps: ['192.168.1.1'],
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
        clientIps: ['192.168.1.100'],
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
        clientIps: ['192.168.1.10'],
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

  describe('Multiple Client IPs', () => {
    beforeEach(() => {
      filteredDataSource = new FilteredContiguousDataSource({
        log,
        dataSource: mockDataSource,
        blockedOrigins: [],
        blockedCidrs: ['192.168.1.0/24', '10.0.0.0/8'],
      });
    });

    it('should block when first IP in clientIps matches blocked CIDR', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.100', // First IP, should be blocked
        clientIps: ['192.168.1.100', '203.0.113.1'], // First blocked, second allowed
      };

      await assert.rejects(
        () =>
          filteredDataSource.getData({
            id: 'test-id',
            requestAttributes,
          }),
        {
          message: /Request blocked.*192.168.1.100.*203.0.113.1.*blocked/,
        },
      );
    });

    it('should block when second IP in clientIps matches blocked CIDR', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '203.0.113.1', // First IP, allowed
        clientIps: ['203.0.113.1', '10.0.5.100'], // First allowed, second blocked
      };

      await assert.rejects(
        () =>
          filteredDataSource.getData({
            id: 'test-id',
            requestAttributes,
          }),
        {
          message: /Request blocked.*203.0.113.1.*10.0.5.100.*blocked/,
        },
      );
    });

    it('should allow when none of the IPs in clientIps match blocked CIDRs', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '203.0.113.1', // First IP, allowed
        clientIps: ['203.0.113.1', '198.51.100.1', '172.16.0.1'], // All allowed
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
    });

    it('should block when clientIp is blocked even if not in clientIps array', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.100', // Legacy field, blocked
        clientIps: ['203.0.113.1'], // Array has allowed IP
      };

      await assert.rejects(
        () =>
          filteredDataSource.getData({
            id: 'test-id',
            requestAttributes,
          }),
        {
          message: /Request blocked.*blocked/,
        },
      );
    });

    it('should work with empty clientIps array and fall back to clientIp', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIp: '192.168.1.100', // Blocked
        clientIps: [], // Empty array
      };

      await assert.rejects(
        () =>
          filteredDataSource.getData({
            id: 'test-id',
            requestAttributes,
          }),
        {
          message: /Request blocked.*blocked/,
        },
      );
    });

    it('should allow when neither clientIp nor clientIps are present', async () => {
      const requestAttributes: RequestAttributes = {
        hops: 1,
        origin: 'allowed-origin.com',
        clientIps: [], // Empty array
        // No clientIp field
      };

      const data = await filteredDataSource.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(data, mockContiguousData);
    });
  });
});
