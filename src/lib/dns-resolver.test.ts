/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as winston from 'winston';
import { promises as dns } from 'node:dns';
import { DnsResolver } from './dns-resolver.js';

describe('DnsResolver', () => {
  let dnsResolver: DnsResolver;
  let logger: winston.Logger;

  beforeEach(() => {
    logger = winston.createLogger({ silent: true });
    dnsResolver = new DnsResolver({ log: logger });
  });

  afterEach(() => {
    dnsResolver.stopPeriodicResolution();
    mock.restoreAll();
  });

  describe('resolveUrl', () => {
    it('should resolve hostname to IPv4 address', async () => {
      const mockResolve4 = mock.fn(async () => ['192.168.1.1', '192.168.1.2']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'https://example.com:8080/path',
      );

      assert.equal(result.hostname, 'example.com');
      assert.equal(result.originalUrl, 'https://example.com:8080/path');
      assert.equal(result.resolvedUrl, 'https://192.168.1.1:8080/path');
      assert.deepEqual(result.ips, ['192.168.1.1', '192.168.1.2']);
      assert.equal(result.resolutionError, undefined);
      assert.equal(mockResolve4.mock.calls.length, 1);
      assert.equal(mockResolve4.mock.calls[0].arguments[0], 'example.com');
    });

    it('should fallback to IPv6 when IPv4 fails', async () => {
      const mockResolve4 = mock.fn(async () => {
        throw new Error('IPv4 resolution failed');
      });
      const mockResolve6 = mock.fn(async () => ['2001:db8::1']);
      mock.method(dns, 'resolve4', mockResolve4);
      mock.method(dns, 'resolve6', mockResolve6);

      const result = await dnsResolver.resolveUrl('https://example.com/path');

      assert.equal(result.hostname, 'example.com');
      assert.equal(result.resolvedUrl, 'https://[2001:db8::1]/path');
      assert.deepEqual(result.ips, ['2001:db8::1']);
      assert.equal(mockResolve4.mock.calls.length, 1);
      assert.equal(mockResolve6.mock.calls.length, 1);
    });

    it('should preserve port in resolved URL', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'https://data.example.com:8080/chunk',
      );

      assert.equal(result.resolvedUrl, 'https://10.0.0.1:8080/chunk');
    });

    it('should preserve path in resolved URL', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'https://example.com/chunk/12345',
      );

      assert.equal(result.resolvedUrl, 'https://10.0.0.1/chunk/12345');
    });

    it('should skip resolution for IP addresses', async () => {
      const mockResolve4 = mock.fn();
      const mockResolve6 = mock.fn();
      mock.method(dns, 'resolve4', mockResolve4);
      mock.method(dns, 'resolve6', mockResolve6);

      const result = await dnsResolver.resolveUrl(
        'https://192.168.1.1:8080/path',
      );

      assert.equal(result.hostname, '192.168.1.1');
      assert.equal(result.originalUrl, 'https://192.168.1.1:8080/path');
      assert.equal(result.resolvedUrl, 'https://192.168.1.1:8080/path');
      assert.deepEqual(result.ips, ['192.168.1.1']);
      assert.equal(mockResolve4.mock.calls.length, 0);
      assert.equal(mockResolve6.mock.calls.length, 0);
    });

    it('should skip resolution for IPv6 addresses', async () => {
      const mockResolve4 = mock.fn();
      const mockResolve6 = mock.fn();
      mock.method(dns, 'resolve4', mockResolve4);
      mock.method(dns, 'resolve6', mockResolve6);

      const result = await dnsResolver.resolveUrl('https://[2001:db8::1]/path');

      assert.equal(result.hostname, '[2001:db8::1]');
      assert.equal(result.resolvedUrl, 'https://[2001:db8::1]/path');
      assert.equal(mockResolve4.mock.calls.length, 0);
      assert.equal(mockResolve6.mock.calls.length, 0);
    });

    it('should return original URL on resolution failure', async () => {
      const mockResolve4 = mock.fn(async () => {
        throw new Error('IPv4 failed');
      });
      const mockResolve6 = mock.fn(async () => {
        throw new Error('IPv6 failed');
      });
      mock.method(dns, 'resolve4', mockResolve4);
      mock.method(dns, 'resolve6', mockResolve6);

      const result = await dnsResolver.resolveUrl('https://example.com/path');

      assert.equal(result.hostname, 'example.com');
      assert.equal(result.originalUrl, 'https://example.com/path');
      assert.equal(result.resolvedUrl, 'https://example.com/path');
      assert.deepEqual(result.ips, []);
      assert(result.resolutionError?.includes('Failed to resolve hostname'));
    });
  });

  describe('resolveUrls', () => {
    it('should resolve multiple URLs in parallel', async () => {
      const mockResolve4 = mock.fn(async (hostname: string) => {
        if (hostname === 'example1.com') return ['10.0.0.1'];
        if (hostname === 'example2.com') return ['10.0.0.2'];
        throw new Error('Unknown hostname');
      });
      mock.method(dns, 'resolve4', mockResolve4);

      const urls = ['https://example1.com/path1', 'https://example2.com/path2'];

      const results = await dnsResolver.resolveUrls(urls);

      assert.equal(results.length, 2);
      assert.equal(results[0].resolvedUrl, 'https://10.0.0.1/path1');
      assert.equal(results[1].resolvedUrl, 'https://10.0.0.2/path2');
      assert.equal(mockResolve4.mock.calls.length, 2);
    });

    it('should handle mixed success and failure', async () => {
      const mockResolve4 = mock.fn(async (hostname: string) => {
        if (hostname === 'success.com') return ['10.0.0.1'];
        throw new Error('Resolution failed');
      });
      const mockResolve6 = mock.fn(async () => {
        throw new Error('IPv6 failed');
      });
      mock.method(dns, 'resolve4', mockResolve4);
      mock.method(dns, 'resolve6', mockResolve6);

      const urls = ['https://success.com/path', 'https://failure.com/path'];

      const results = await dnsResolver.resolveUrls(urls);

      assert.equal(results.length, 2);
      assert.equal(results[0].resolvedUrl, 'https://10.0.0.1/path');
      assert.equal(results[0].resolutionError, undefined);
      assert.equal(results[1].resolvedUrl, 'https://failure.com/path');
      assert(results[1].resolutionError !== undefined);
    });
  });

  describe('getResolvedUrl', () => {
    it('should retrieve cached resolution', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      await dnsResolver.resolveUrl('https://example.com/path');
      const cached = dnsResolver.getResolvedUrl('example.com');

      assert(cached);
      assert.equal(cached.hostname, 'example.com');
      assert.equal(cached.resolvedUrl, 'https://10.0.0.1/path');
    });

    it('should return undefined for unknown hostname', () => {
      const cached = dnsResolver.getResolvedUrl('unknown.com');
      assert.equal(cached, undefined);
    });
  });

  describe('getResolvedUrlStrings', () => {
    it('should return resolved URLs for known hosts', async () => {
      const mockResolve4 = mock.fn(async (hostname: string) => {
        if (hostname === 'known.com') return ['10.0.0.1'];
        throw new Error('Unknown');
      });
      mock.method(dns, 'resolve4', mockResolve4);

      await dnsResolver.resolveUrl('https://known.com/path');

      const urls = [
        'https://known.com/different-path',
        'https://unknown.com/path',
      ];

      const resolved = dnsResolver.getResolvedUrlStrings(urls);

      assert.equal(resolved.length, 2);
      assert.equal(resolved[0], 'https://10.0.0.1/different-path');
      assert.equal(resolved[1], 'https://unknown.com/path');
    });

    it('should handle invalid URLs gracefully', () => {
      const urls = ['not-a-valid-url', 'https://example.com/path'];

      const resolved = dnsResolver.getResolvedUrlStrings(urls);

      assert.equal(resolved.length, 2);
      assert.equal(resolved[0], 'not-a-valid-url');
      assert.equal(resolved[1], 'https://example.com/path');
    });
  });

  describe('periodic resolution', () => {
    it('should start and stop periodic resolution', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      const urls = ['https://example.com/path'];

      // Start periodic resolution with a very short interval for testing
      dnsResolver.startPeriodicResolution(urls, 50);

      // Wait for at least one interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have been called at least once
      assert(mockResolve4.mock.calls.length >= 1);

      // Stop periodic resolution
      dnsResolver.stopPeriodicResolution();

      const callCount = mockResolve4.mock.calls.length;

      // Wait to ensure no more calls
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(mockResolve4.mock.calls.length, callCount);
    });

    it('should detect changes in DNS resolution', async () => {
      let callCount = 0;
      const mockResolve4 = mock.fn(async () => {
        callCount++;
        return callCount === 1 ? ['10.0.0.1'] : ['10.0.0.2'];
      });
      mock.method(dns, 'resolve4', mockResolve4);

      // Initial resolution
      await dnsResolver.resolveUrl('https://example.com/path');
      const initial = dnsResolver.getResolvedUrl('example.com');
      assert.equal(initial?.resolvedUrl, 'https://10.0.0.1/path');

      // Start periodic resolution
      dnsResolver.startPeriodicResolution(['https://example.com/path'], 50);

      // Wait for re-resolution
      await new Promise((resolve) => setTimeout(resolve, 100));

      const updated = dnsResolver.getResolvedUrl('example.com');
      assert.equal(updated?.resolvedUrl, 'https://10.0.0.2/path');
    });
  });
});
