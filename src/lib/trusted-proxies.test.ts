/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  clientAddressBehindProxies,
  forwardedHops,
  isTrustedProxy,
  parseTrustedProxies,
} from './trusted-proxies.js';

describe('parseTrustedProxies', () => {
  it('takes addresses and CIDRs of both families', () => {
    const list = parseTrustedProxies([
      '10.0.0.0/8',
      ' 198.51.100.20 ',
      'fd00::/8',
      '::ffff:192.0.2.1',
      '',
    ]);
    assert.equal(isTrustedProxy('10.9.9.9', list), true);
    assert.equal(isTrustedProxy('198.51.100.20', list), true);
    assert.equal(isTrustedProxy('198.51.100.21', list), false);
    assert.equal(isTrustedProxy('fd12::1', list), true);
    assert.equal(isTrustedProxy('192.0.2.1', list), true, 'mapped form');
    assert.equal(isTrustedProxy('not-an-ip', list), false);
  });

  it('refuses anything that is not strictly an address or CIDR', () => {
    // '10.0.0.0/' must not read as /0 and trust everyone.
    for (const bad of [
      'lb.example',
      '10.0.0.0/',
      '10.0.0.0/33',
      '10.0.0.0/8/9',
      '/8',
      '10.0.0.0/x',
      '::/129',
    ]) {
      assert.throws(() => parseTrustedProxies([bad]), /Not an IP/, bad);
    }
  });
});

describe('forwardedHops', () => {
  it('lists valid addresses in order, from a string or an array', () => {
    assert.deepEqual(forwardedHops(' 1.2.3.4 , bogus, ::ffff:5.6.7.8'), [
      '1.2.3.4',
      '5.6.7.8',
    ]);
    assert.deepEqual(forwardedHops(['1.2.3.4, 2001:db8::1', '9.9.9.9']), [
      '1.2.3.4',
      '2001:db8::1',
      '9.9.9.9',
    ]);
    assert.deepEqual(forwardedHops(undefined), []);
  });
});

describe('clientAddressBehindProxies', () => {
  const proxies = parseTrustedProxies(['10.0.0.0/8', '172.16.0.0/12']);

  it('is the connecting address when that is not a proxy', () => {
    assert.equal(
      clientAddressBehindProxies('203.0.113.9', '1.1.1.1', proxies),
      '203.0.113.9',
    );
  });

  it('is the nearest hop that is not a proxy, never one to its left', () => {
    assert.equal(
      clientAddressBehindProxies(
        '10.0.0.1',
        '6.6.6.6, 203.0.113.9, 172.16.0.2',
        proxies,
      ),
      '203.0.113.9',
    );
  });

  it('is the leftmost hop when all are proxies, and the socket without any', () => {
    assert.equal(
      clientAddressBehindProxies('10.0.0.1', '10.5.5.5, 172.16.0.2', proxies),
      '10.5.5.5',
    );
    assert.equal(
      clientAddressBehindProxies('::ffff:10.0.0.1', undefined, proxies),
      '10.0.0.1',
    );
  });
});
