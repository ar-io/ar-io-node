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
  expandIpv6,
  ipFaultDomain,
} from './ip-utils.js';

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

    it('should extract IPs from X-Forwarded-For header', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.1, 172.16.0.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      assert.deepStrictEqual(result.clientIps, [
        '203.0.113.1',
        '192.168.1.1',
        '172.16.0.1',
        '10.0.0.1',
      ]);
    });

    it('should handle X-Forwarded-For as array', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': ['203.0.113.1, 192.168.1.1', '172.16.0.1'],
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
      assert.deepStrictEqual(result.clientIps, [
        '203.0.113.1',
        '192.168.1.1',
        '172.16.0.1',
        '10.0.0.1',
      ]);
    });

    it('should extract IPs from X-Real-IP header', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-real-ip': '198.51.100.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '198.51.100.1');
      assert.deepStrictEqual(result.clientIps, ['198.51.100.1', '10.0.0.1']);
    });

    it('should extract IP from socket.remoteAddress', () => {
      const req = createMockRequest('10.0.0.1', {}, '127.0.0.1');

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '127.0.0.1');
      assert.deepStrictEqual(result.clientIps, ['127.0.0.1', '10.0.0.1']);
    });

    it('should normalize IPv4-mapped IPv6 addresses', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '::ffff:192.168.1.1',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '192.168.1.1');
      assert.deepStrictEqual(result.clientIps, ['192.168.1.1', '10.0.0.1']);
    });

    it('should skip invalid and unknown IPs', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for':
          'unknown, invalid-ip, , 192.168.1.1, 256.256.256.256',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '192.168.1.1');
      assert.deepStrictEqual(result.clientIps, ['192.168.1.1', '10.0.0.1']);
    });

    it('should handle empty headers gracefully', () => {
      const req = createMockRequest('10.0.0.1', {
        'x-forwarded-for': '',
        'x-real-ip': '',
      });

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '10.0.0.1');
      assert.deepStrictEqual(result.clientIps, ['10.0.0.1']);
    });

    it('should deduplicate IPs', () => {
      const req = createMockRequest(
        '192.168.1.1',
        {
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
          'x-real-ip': '192.168.1.1',
        },
        '192.168.1.1',
      );

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '192.168.1.1');
      assert.deepStrictEqual(result.clientIps, ['192.168.1.1', '10.0.0.1']);
    });

    it('should handle missing req.ip gracefully', () => {
      const req = createMockRequest('', {
        'x-forwarded-for': '203.0.113.1',
      });
      req.ip = undefined;

      const result = extractAllClientIPs(req);

      assert.strictEqual(result.clientIp, '203.0.113.1');
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

  describe('expandIpv6', () => {
    it('expands full and compressed forms to 8 padded groups', () => {
      assert.deepEqual(expandIpv6('2001:db8::1'), [
        '2001',
        '0db8',
        '0000',
        '0000',
        '0000',
        '0000',
        '0000',
        '0001',
      ]);
      assert.deepEqual(expandIpv6('::'), Array(8).fill('0000'));
      assert.deepEqual(expandIpv6('::1'), [...Array(7).fill('0000'), '0001']);
    });

    it('returns undefined for non-IPv6 / malformed input', () => {
      assert.equal(expandIpv6('1.2.3.4'), undefined);
      assert.equal(expandIpv6('2001::db8::1'), undefined); // two `::`
      assert.equal(expandIpv6('2001:db8:zz::1'), undefined); // bad hex
    });
  });

  describe('ipFaultDomain', () => {
    it('collapses all five tip nodes into one /24', () => {
      const tips = [
        '38.29.227.74',
        '38.29.227.75',
        '38.29.227.76',
        '38.29.227.69',
        '38.29.227.70',
      ];
      const domains = new Set(tips.map((ip) => ipFaultDomain(ip)));
      assert.equal(domains.size, 1);
      assert.equal([...domains][0], '38.29.227.0/24');
    });

    it('keeps distinct /24s distinct', () => {
      assert.notEqual(
        ipFaultDomain('38.29.227.74'),
        ipFaultDomain('38.29.228.74'),
      );
    });

    it('normalizes IPv4-mapped IPv6 to the IPv4 /24', () => {
      assert.equal(ipFaultDomain('::ffff:38.29.227.74'), '38.29.227.0/24');
    });

    it('buckets IPv6 to /48 by default', () => {
      assert.equal(
        ipFaultDomain('2001:db8:abcd:1234::1'),
        '2001:0db8:abcd::/48',
      );
      // same /48, different lower bits -> same bucket
      assert.equal(
        ipFaultDomain('2001:db8:abcd:9999::abcd'),
        ipFaultDomain('2001:db8:abcd:1234::1'),
      );
      // different /48 -> different bucket
      assert.notEqual(
        ipFaultDomain('2001:db8:abce::1'),
        ipFaultDomain('2001:db8:abcd::1'),
      );
    });

    it('honors custom prefix widths', () => {
      assert.equal(
        ipFaultDomain('38.29.227.74', { v4Bits: 16 }),
        '38.29.0.0/16',
      );
    });

    it('treats an unresolved hostname as its own domain', () => {
      assert.equal(ipFaultDomain('tip-1.arweave.xyz'), 'tip-1.arweave.xyz');
      assert.notEqual(
        ipFaultDomain('tip-1.arweave.xyz'),
        ipFaultDomain('tip-2.arweave.xyz'),
      );
    });
  });
});
