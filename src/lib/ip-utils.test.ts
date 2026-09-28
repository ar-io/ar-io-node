/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Request } from 'express';
import {
  isValidIpFormat,
  normalizeIpv4MappedIpv6,
  extractAllClientIPs,
  isIpInCidr,
  isAnyIpAllowlisted,
  isAnyIpBlocked,
} from './ip-utils.js';
import { parseTrustedProxies } from './trusted-proxies.js';

describe('IP Utilities', () => {
  describe('isValidIpFormat', () => {
    it('should validate IPv4 addresses correctly', () => {
      assert.strictEqual(isValidIpFormat('192.168.1.1'), true);
      assert.strictEqual(isValidIpFormat('10.0.0.1'), true);
      assert.strictEqual(isValidIpFormat('127.0.0.1'), true);
      assert.strictEqual(isValidIpFormat('0.0.0.0'), true);
      assert.strictEqual(isValidIpFormat('255.255.255.255'), true);
    });

    it('should reject invalid IPv4 addresses', () => {
      assert.strictEqual(isValidIpFormat('256.1.1.1'), false);
      assert.strictEqual(isValidIpFormat('192.168.1'), false);
      assert.strictEqual(isValidIpFormat('192.168.1.1.1'), false);
      assert.strictEqual(isValidIpFormat('192.168.1.01'), false); // Leading zeros
      assert.strictEqual(isValidIpFormat('192.168.1.'), false);
      assert.strictEqual(isValidIpFormat('.192.168.1.1'), false);
    });

    it('should validate IPv6 addresses correctly', () => {
      assert.strictEqual(isValidIpFormat('2001:db8::1'), true);
      assert.strictEqual(isValidIpFormat('::1'), true);
      assert.strictEqual(isValidIpFormat('::ffff:192.168.1.1'), true);
      assert.strictEqual(
        isValidIpFormat('2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
        true,
      );
    });

    it('should reject invalid IPv6 addresses', () => {
      assert.strictEqual(isValidIpFormat('2001:db8::1::1'), false); // Double ::
      assert.strictEqual(isValidIpFormat('2001:db8:gggg::1'), false); // Invalid hex
      assert.strictEqual(isValidIpFormat('192.168.1.1:8080'), false); // Port included
    });

    it('should reject empty and invalid strings', () => {
      assert.strictEqual(isValidIpFormat(''), false);
      assert.strictEqual(isValidIpFormat('not-an-ip'), false);
      assert.strictEqual(isValidIpFormat('192.168.1.1/24'), false);
    });
  });

  describe('normalizeIpv4MappedIpv6', () => {
    it('should normalize IPv4-mapped IPv6 addresses', () => {
      assert.strictEqual(
        normalizeIpv4MappedIpv6('::ffff:192.168.1.1'),
        '192.168.1.1',
      );
      assert.strictEqual(
        normalizeIpv4MappedIpv6('::FFFF:10.0.0.1'),
        '10.0.0.1',
      );
      assert.strictEqual(
        normalizeIpv4MappedIpv6('::ffff:127.0.0.1'),
        '127.0.0.1',
      );
    });

    it('should leave regular IPv4 addresses unchanged', () => {
      assert.strictEqual(normalizeIpv4MappedIpv6('192.168.1.1'), '192.168.1.1');
      assert.strictEqual(normalizeIpv4MappedIpv6('10.0.0.1'), '10.0.0.1');
    });

    it('should leave regular IPv6 addresses unchanged', () => {
      assert.strictEqual(normalizeIpv4MappedIpv6('2001:db8::1'), '2001:db8::1');
      assert.strictEqual(normalizeIpv4MappedIpv6('::1'), '::1');
    });

    it('should handle edge cases', () => {
      assert.strictEqual(normalizeIpv4MappedIpv6(''), '');
      assert.strictEqual(normalizeIpv4MappedIpv6('not-an-ip'), 'not-an-ip');
    });
  });

  describe('extractAllClientIPs', () => {
    function createMockRequest(
      ip: string,
      headers: Record<string, string | string[]> = {},
      remoteAddress?: string,
    ): Request {
      const req = {
        ip,
        headers,
        socket: remoteAddress !== undefined ? { remoteAddress } : undefined,
      } as Request;
      return req;
    }

    // 10.0.0.1 is a proxy on the private network, trusted by default.
    it('takes the address a trusted proxy appended to X-Forwarded-For', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '203.0.113.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      assert.deepStrictEqual(result.clientIps, ['203.0.113.1', '10.0.0.1']);
    });

    it('reads X-Forwarded-For from the right, past every trusted proxy', () => {
      // A client claimed 198.51.100.7; the first proxy saw 203.0.113.1; a
      // second, private proxy (172.16.0.1) passed it on.
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '198.51.100.7, 203.0.113.1, 172.16.0.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      // Every address is still listed, for logs and blocklists.
      assert.deepStrictEqual(result.clientIps, [
        '198.51.100.7',
        '203.0.113.1',
        '172.16.0.1',
        '10.0.0.1',
      ]);
    });

    it('ignores the headers of a client that is not a trusted proxy', () => {
      const req = createMockRequest('198.51.100.9', {
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
      });

      assert.strictEqual(extractAllClientIPs(req).clientIp, '198.51.100.9');
    });

    it('ignores X-Real-IP from a client that is not a trusted proxy', () => {
      const req = createMockRequest('198.51.100.9', {
        'x-real-ip': '10.20.30.40',
      });

      assert.strictEqual(extractAllClientIPs(req).clientIp, '198.51.100.9');
    });

    it('believes proxies it is told to trust, and only those', () => {
      const cdn = parseTrustedProxies(['10.0.0.0/8', '198.51.100.0/24']);
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 198.51.100.10',
      });

      assert.strictEqual(extractAllClientIPs(req, cdn).clientIp, '203.0.113.1');
      assert.strictEqual(
        extractAllClientIPs(req, parseTrustedProxies([])).clientIp,
        '10.0.0.1',
        'no proxy trusted: the connecting address',
      );
    });

    it('takes the leftmost hop when every hop is a trusted proxy', () => {
      // A client inside the proxies' own network.
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '192.168.1.5, 172.16.0.1',
      });

      assert.strictEqual(extractAllClientIPs(req).clientIp, '192.168.1.5');
    });

    it('handles X-Forwarded-For as array', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': ['198.51.100.7, 203.0.113.1', '172.16.0.1'],
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      assert.deepStrictEqual(result.clientIps, [
        '198.51.100.7',
        '203.0.113.1',
        '172.16.0.1',
        '10.0.0.1',
      ]);
    });

    it('uses X-Real-IP from a trusted proxy when there is no X-Forwarded-For', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-real-ip': '198.51.100.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '198.51.100.1');
      assert.deepStrictEqual(result.clientIps, ['198.51.100.1', '10.0.0.1']);
    });

    it('prefers X-Forwarded-For to X-Real-IP', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '198.51.100.1',
      });

      assert.strictEqual(extractAllClientIPs(req).clientIp, '203.0.113.1');
    });

    it('prefers socket.remoteAddress to req.ip for the connecting address', () => {
      const req = createMockRequest('10.0.0.1', {}, '198.51.100.20');

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '198.51.100.20');
      assert.deepStrictEqual(result.clientIps, ['198.51.100.20', '10.0.0.1']);
    });

    it('normalizes IPv4-mapped IPv6 addresses', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '::ffff:203.0.113.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      assert.deepStrictEqual(result.clientIps, ['203.0.113.1', '10.0.0.1']);
    });

    it('treats an IPv4-mapped proxy address as the proxy', () => {
      const req = createMockRequest('', { 'x-forwarded-for': '203.0.113.1' });
      (req as any).socket = { remoteAddress: '::ffff:10.0.0.1' };
      (req as any).ip = undefined;

      assert.strictEqual(extractAllClientIPs(req).clientIp, '203.0.113.1');
    });

    it('skips invalid and unknown entries', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for':
          'unknown, invalid-ip, , 203.0.113.1, 256.256.256.256',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      assert.deepStrictEqual(result.clientIps, ['203.0.113.1', '10.0.0.1']);
    });

    it('handles empty headers gracefully', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '',
        'x-real-ip': '',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '10.0.0.1');
      assert.deepStrictEqual(result.clientIps, ['10.0.0.1']);
    });

    it('deduplicates addresses', () => {
      const req = createMockRequest(
        '192.168.1.1',
        {
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
          'x-real-ip': '192.168.1.1',
        },
        '192.168.1.1',
      );

      const result = extractAllClientIPs(req);

      assert.deepStrictEqual(result.clientIps, ['192.168.1.1', '10.0.0.1']);
    });

    it('has no client address without a connection address', () => {
      // Headers alone prove nothing about who sent them.
      const req = createMockRequest('', {
        'x-forwarded-for': '203.0.113.1',
      });
      req.ip = undefined;

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, undefined);
      assert.deepStrictEqual(result.clientIps, ['203.0.113.1']);
    });
  });

  describe('isIpInCidr', () => {
    it('should match IPs in CIDR ranges', () => {
      assert.strictEqual(isIpInCidr('192.168.1.100', '192.168.1.0/24'), true);
      assert.strictEqual(isIpInCidr('10.0.5.1', '10.0.0.0/16'), true);
      assert.strictEqual(isIpInCidr('172.16.255.255', '172.16.0.0/12'), true);
      assert.strictEqual(isIpInCidr('127.0.0.1', '127.0.0.0/8'), true);
    });

    it('should not match IPs outside CIDR ranges', () => {
      assert.strictEqual(isIpInCidr('192.168.2.1', '192.168.1.0/24'), false);
      assert.strictEqual(isIpInCidr('10.1.0.1', '10.0.0.0/16'), false);
      assert.strictEqual(isIpInCidr('172.15.0.1', '172.16.0.0/12'), false);
      assert.strictEqual(isIpInCidr('128.0.0.1', '127.0.0.0/8'), false);
    });

    it('should handle /32 masks (exact match)', () => {
      assert.strictEqual(isIpInCidr('192.168.1.1', '192.168.1.1/32'), true);
      assert.strictEqual(isIpInCidr('192.168.1.2', '192.168.1.1/32'), false);
    });

    it('should handle /0 mask (match all)', () => {
      assert.strictEqual(isIpInCidr('192.168.1.1', '0.0.0.0/0'), true);
      assert.strictEqual(isIpInCidr('8.8.8.8', '0.0.0.0/0'), true);
    });

    it('should reject IPv6 addresses', () => {
      assert.strictEqual(isIpInCidr('2001:db8::1', '192.168.1.0/24'), false);
      assert.strictEqual(isIpInCidr('::1', '127.0.0.0/8'), false);
    });

    it('should handle invalid inputs gracefully', () => {
      assert.strictEqual(isIpInCidr('192.168.1.1', 'invalid-cidr'), false);
      assert.strictEqual(isIpInCidr('invalid-ip', '192.168.1.0/24'), false);
      assert.strictEqual(isIpInCidr('192.168.1.1', '192.168.1.0/33'), false); // Invalid prefix
      assert.strictEqual(isIpInCidr('192.168.1.1', '192.168.1.0/-1'), false); // Invalid prefix
    });

    it('should NOT treat malformed CIDR network like foo/0 as match-all', () => {
      assert.strictEqual(
        isIpInCidr('203.0.113.5', 'foo/0'),
        false,
        'Malformed CIDR foo/0 should not match any IP',
      );
    });
  });

  describe('isAnyIpAllowlisted', () => {
    it('should return true when any IP matches exact allowlist entry', () => {
      const clientIps = ['203.0.113.1', '192.168.1.1', '10.0.0.1'];
      const allowlist = ['192.168.1.1', '172.16.0.1'];

      assert.strictEqual(isAnyIpAllowlisted(clientIps, allowlist), true);
    });

    it('should return true when any IP matches CIDR allowlist entry', () => {
      const clientIps = ['203.0.113.1', '192.168.1.100', '10.0.0.1'];
      const allowlist = ['192.168.1.0/24', '172.16.0.0/12'];

      assert.strictEqual(isAnyIpAllowlisted(clientIps, allowlist), true);
    });

    it('should return false when no IP matches allowlist', () => {
      const clientIps = ['203.0.113.1', '198.51.100.1', '10.0.0.1'];
      const allowlist = ['192.168.1.1', '172.16.0.1'];

      assert.strictEqual(isAnyIpAllowlisted(clientIps, allowlist), false);
    });

    it('should handle IPv4-mapped IPv6 normalization', () => {
      const clientIps = ['::ffff:192.168.1.1', '10.0.0.1'];
      const allowlist = ['192.168.1.1'];

      assert.strictEqual(isAnyIpAllowlisted(clientIps, allowlist), true);
    });

    it('should handle empty arrays', () => {
      assert.strictEqual(isAnyIpAllowlisted([], ['192.168.1.1']), false);
      assert.strictEqual(isAnyIpAllowlisted(['192.168.1.1'], []), false);
      assert.strictEqual(isAnyIpAllowlisted([], []), false);
    });

    it('should filter out invalid IPs', () => {
      const clientIps = ['  ', '', '192.168.1.1', 'invalid-ip'];
      const allowlist = ['192.168.1.1'];

      assert.strictEqual(isAnyIpAllowlisted(clientIps, allowlist), true);
    });

    it('should deduplicate IPs', () => {
      const clientIps = ['192.168.1.1', '192.168.1.1', '10.0.0.1'];
      const allowlist = ['192.168.1.1'];

      assert.strictEqual(isAnyIpAllowlisted(clientIps, allowlist), true);
    });

    it('should NOT allowlist via malformed CIDR like foo/0', () => {
      assert.strictEqual(
        isAnyIpAllowlisted(['203.0.113.5'], ['foo/0']),
        false,
        'Malformed CIDR foo/0 should not cause allowlisting',
      );
    });
  });

  describe('isAnyIpBlocked', () => {
    it('should return true when any IP matches exact blocklist entry', () => {
      const clientIps = ['203.0.113.1', '192.168.1.1', '10.0.0.1'];
      const blocklist = ['192.168.1.1', '172.16.0.1'];

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), true);
    });

    it('should return true when any IP matches CIDR blocklist entry', () => {
      const clientIps = ['203.0.113.1', '192.168.1.100', '10.0.0.1'];
      const blocklist = ['192.168.1.0/24', '172.16.0.0/12'];

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), true);
    });

    it('should return false when no IP matches blocklist', () => {
      const clientIps = ['203.0.113.1', '198.51.100.1', '10.0.0.1'];
      const blocklist = ['192.168.1.1', '172.16.0.1'];

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), false);
    });

    it('should handle IPv4-mapped IPv6 normalization', () => {
      const clientIps = ['::ffff:192.168.1.1', '10.0.0.1'];
      const blocklist = ['192.168.1.1'];

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), true);
    });

    it('should handle empty arrays', () => {
      assert.strictEqual(isAnyIpBlocked([], ['192.168.1.1']), false);
      assert.strictEqual(isAnyIpBlocked(['192.168.1.1'], []), false);
      assert.strictEqual(isAnyIpBlocked([], []), false);
    });

    it('should filter out invalid IPs', () => {
      const clientIps = ['  ', '', '192.168.1.1', 'invalid-ip'];
      const blocklist = ['192.168.1.1'];

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), true);
    });

    it('should support mixed exact and CIDR entries', () => {
      const clientIps = ['192.168.1.1', '172.16.5.5', '10.0.0.1'];
      const blocklist = ['192.168.1.1', '172.16.0.0/12']; // Exact + CIDR

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), true);
    });

    it('should handle complex CIDR scenarios', () => {
      const clientIps = ['8.8.8.8', '1.1.1.1'];
      const blocklist = ['0.0.0.0/0']; // Block all IPv4

      assert.strictEqual(isAnyIpBlocked(clientIps, blocklist), true);
    });

    it('should NOT blocklist via malformed CIDR like foo/0', () => {
      assert.strictEqual(
        isAnyIpBlocked(['203.0.113.5'], ['foo/0']),
        false,
        'Malformed CIDR foo/0 should not block IPs',
      );
    });
  });
});
