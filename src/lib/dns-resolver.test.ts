/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { promises as dns } from 'node:dns';
import { DnsResolver } from './dns-resolver.js';
import { createTestLogger } from '../../test/test-logger.js';

describe('DnsResolver', () => {
  let dnsResolver: DnsResolver;
  let logger: ReturnType<typeof createTestLogger>;

  beforeEach(() => {
    logger = createTestLogger({ suite: 'DnsResolver' });
    dnsResolver = new DnsResolver({ log: logger });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('resolveUrl', () => {
    it('should resolve hostname to IPv4 address', async () => {
      const mockResolve4 = mock.fn(async () => ['192.168.1.1', '192.168.1.2']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'http://example.com:8080/path',
      );

      assert.equal(result.hostname, 'example.com');
      assert.equal(result.originalUrl, 'http://example.com:8080/path');
      assert.equal(result.resolvedUrl, 'http://192.168.1.1:8080/path');
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

      const result = await dnsResolver.resolveUrl('http://example.com/path');

      assert.equal(result.hostname, 'example.com');
      assert.equal(result.resolvedUrl, 'http://[2001:db8::1]/path');
      assert.deepEqual(result.ips, ['2001:db8::1']);
      assert.equal(mockResolve4.mock.calls.length, 1);
      assert.equal(mockResolve6.mock.calls.length, 1);
    });

    it('should preserve port in resolved URL', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'http://data.example.com:8080/chunk',
      );

      assert.equal(result.resolvedUrl, 'http://10.0.0.1:8080/chunk');
    });

    it('should preserve path in resolved URL', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'http://example.com/chunk/12345',
      );

      assert.equal(result.resolvedUrl, 'http://10.0.0.1/chunk/12345');
    });

    it('should preserve hostname for HTTPS URLs (SNI/TLS cert validity)', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1', '10.0.0.2']);
      mock.method(dns, 'resolve4', mockResolve4);

      const result = await dnsResolver.resolveUrl(
        'https://example.com/chunk/12345',
      );

      // Hostname must NOT be substituted with the IP for HTTPS, otherwise
      // fetch() sends TLS SNI = IP and the server cert (issued for the
      // hostname) trips ERR_TLS_CERT_ALTNAME_INVALID.
      assert.equal(result.hostname, 'example.com');
      assert.equal(result.originalUrl, 'https://example.com/chunk/12345');
      assert.equal(result.resolvedUrl, 'https://example.com/chunk/12345');
      // DNS resolution still runs so change-detection logging and the IP
      // cache stay accurate.
      assert.deepEqual(result.ips, ['10.0.0.1', '10.0.0.2']);
      assert.equal(result.resolutionError, undefined);
      assert.equal(mockResolve4.mock.calls.length, 1);
    });

    it('should preserve HTTPS hostname even when IPv4 falls back to IPv6', async () => {
      const mockResolve4 = mock.fn(async () => {
        throw new Error('IPv4 resolution failed');
      });
      const mockResolve6 = mock.fn(async () => ['2001:db8::1']);
      mock.method(dns, 'resolve4', mockResolve4);
      mock.method(dns, 'resolve6', mockResolve6);

      const result = await dnsResolver.resolveUrl('https://example.com/path');

      assert.equal(result.resolvedUrl, 'https://example.com/path');
      assert.deepEqual(result.ips, ['2001:db8::1']);
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

      const urls = ['http://example1.com/path1', 'http://example2.com/path2'];

      const results = await dnsResolver.resolveUrls(urls);

      assert.equal(results.length, 2);
      assert.equal(results[0].resolvedUrl, 'http://10.0.0.1/path1');
      assert.equal(results[1].resolvedUrl, 'http://10.0.0.2/path2');
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

      const urls = ['http://success.com/path', 'http://failure.com/path'];

      const results = await dnsResolver.resolveUrls(urls);

      assert.equal(results.length, 2);
      assert.equal(results[0].resolvedUrl, 'http://10.0.0.1/path');
      assert.equal(results[0].resolutionError, undefined);
      assert.equal(results[1].resolvedUrl, 'http://failure.com/path');
      assert(results[1].resolutionError !== undefined);
    });
  });

  describe('getResolvedUrl', () => {
    it('should retrieve cached resolution', async () => {
      const mockResolve4 = mock.fn(async () => ['10.0.0.1']);
      mock.method(dns, 'resolve4', mockResolve4);

      await dnsResolver.resolveUrl('http://example.com/path');
      const cached = dnsResolver.getResolvedUrl('example.com');

      assert(cached);
      assert.equal(cached.hostname, 'example.com');
      assert.equal(cached.resolvedUrl, 'http://10.0.0.1/path');
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

      await dnsResolver.resolveUrl('http://known.com/path');

      const urls = [
        'http://known.com/different-path',
        'http://unknown.com/path',
      ];

      const resolved = dnsResolver.getResolvedUrlStrings(urls);

      assert.equal(resolved.length, 2);
      assert.equal(resolved[0], 'http://10.0.0.1/different-path');
      assert.equal(resolved[1], 'http://unknown.com/path');
    });

    it('should handle invalid URLs gracefully', () => {
      const urls = ['not-a-valid-url', 'https://example.com/path'];

      const resolved = dnsResolver.getResolvedUrlStrings(urls);

      assert.equal(resolved.length, 2);
      assert.equal(resolved[0], 'not-a-valid-url');
      assert.equal(resolved[1], 'https://example.com/path');
    });
  });

  describe('change detection', () => {
    it('should detect changes in DNS resolution when resolveUrls is called', async () => {
      let callCount = 0;
      const mockResolve4 = mock.fn(async () => {
        callCount++;
        return callCount === 1 ? ['10.0.0.1'] : ['10.0.0.2'];
      });
      mock.method(dns, 'resolve4', mockResolve4);

      // Initial resolution
      await dnsResolver.resolveUrl('http://example.com/path');
      const initial = dnsResolver.getResolvedUrl('example.com');
      assert.equal(initial?.resolvedUrl, 'http://10.0.0.1/path');

      // Re-resolve URLs - should detect change
      await dnsResolver.resolveUrls(['http://example.com/path']);

      const updated = dnsResolver.getResolvedUrl('example.com');
      assert.equal(updated?.resolvedUrl, 'http://10.0.0.2/path');
    });
  });
});
