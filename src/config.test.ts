/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ARNS_ROOT_HOSTS,
  ARNS_ROOT_HOST,
  matchArnsRootHost,
} from './config.js';

describe('ARNS_ROOT_HOSTS parsing', () => {
  // These tests verify the runtime values based on the ARNS_ROOT_HOST env var
  // set at import time. They serve as smoke tests for the parsing logic.

  it('ARNS_ROOT_HOST is the primary (first) host or undefined', () => {
    if (ARNS_ROOT_HOSTS.length > 0) {
      assert.equal(ARNS_ROOT_HOST, ARNS_ROOT_HOSTS[0].host);
    } else {
      assert.equal(ARNS_ROOT_HOST, undefined);
    }
  });

  it('each entry has a host string and subdomainLength number', () => {
    for (const entry of ARNS_ROOT_HOSTS) {
      assert.equal(typeof entry.host, 'string');
      assert.equal(typeof entry.subdomainLength, 'number');
      assert.ok(entry.host.length > 0);
    }
  });
});

describe('matchArnsRootHost', () => {
  // matchArnsRootHost is a pure function that can be tested independently
  // of the env var parsing.

  it('returns undefined when no hosts match', () => {
    const result = matchArnsRootHost('unrelated.example.com');
    // If ARNS_ROOT_HOSTS is empty, this will always be undefined.
    // If hosts are configured but don't match, also undefined.
    if (ARNS_ROOT_HOSTS.length === 0) {
      assert.equal(result, undefined);
    }
    // We can't assert more without knowing the env, but the function shouldn't throw.
  });

  it('matches exact root host', () => {
    if (ARNS_ROOT_HOSTS.length > 0) {
      const entry = ARNS_ROOT_HOSTS[0];
      const result = matchArnsRootHost(entry.host);
      assert.deepStrictEqual(result, entry);
    }
  });

  it('matches subdomain of root host', () => {
    if (ARNS_ROOT_HOSTS.length > 0) {
      const entry = ARNS_ROOT_HOSTS[0];
      const result = matchArnsRootHost('test.' + entry.host);
      assert.deepStrictEqual(result, entry);
    }
  });

  it('does not match partial host names', () => {
    if (ARNS_ROOT_HOSTS.length > 0) {
      const entry = ARNS_ROOT_HOSTS[0];
      // Prepend without dot — should not match
      const result = matchArnsRootHost('prefix' + entry.host);
      assert.equal(result, undefined);
    }
  });
});

describe('matchArnsRootHost with explicit hosts', () => {
  // Sorted by descending host length (longest first) to match production behavior
  const hosts = [
    { host: 'foo.example.com', subdomainLength: 1 },
    { host: 'example.com', subdomainLength: 0 },
  ];

  it('matches the most specific (longest) host first', () => {
    const result = matchArnsRootHost('foo.example.com', hosts);
    assert.deepStrictEqual(result, {
      host: 'foo.example.com',
      subdomainLength: 1,
    });
  });

  it('falls back to shorter host when longer does not match', () => {
    const result = matchArnsRootHost('bar.example.com', hosts);
    assert.deepStrictEqual(result, {
      host: 'example.com',
      subdomainLength: 0,
    });
  });

  it('matches subdomain of the longer host', () => {
    const result = matchArnsRootHost('bar.foo.example.com', hosts);
    assert.deepStrictEqual(result, {
      host: 'foo.example.com',
      subdomainLength: 1,
    });
  });

  it('returns undefined when no host matches', () => {
    const result = matchArnsRootHost('other.net', hosts);
    assert.equal(result, undefined);
  });

  it('matches exact root host', () => {
    const result = matchArnsRootHost('example.com', hosts);
    assert.deepStrictEqual(result, {
      host: 'example.com',
      subdomainLength: 0,
    });
  });

  it('does not match partial hostname without dot separator', () => {
    const result = matchArnsRootHost('notexample.com', hosts);
    assert.equal(result, undefined);
  });

  it('computes correct subdomainLength', () => {
    const threeLevel = [{ host: 'a.b.example.com', subdomainLength: 2 }];
    const result = matchArnsRootHost('test.a.b.example.com', threeLevel);
    assert.deepStrictEqual(result, {
      host: 'a.b.example.com',
      subdomainLength: 2,
    });
  });

  it('ArNS subdomain on longer host returns that host (not the shorter one)', () => {
    // Middleware uses `req.hostname === matchedEntry.host` to detect root vs ArNS
    const result = matchArnsRootHost('myname.foo.example.com', hosts);
    assert.notEqual(result, undefined);
    // Must match foo.example.com so middleware sees this as an ArNS subdomain
    assert.equal(result!.host, 'foo.example.com');
    // hostname !== matchedEntry.host, confirming it's not a root host hit
    assert.notEqual('myname.foo.example.com', result!.host);
  });

  it('single-host list: subdomainLength 0 means one subdomain triggers ArNS', () => {
    // Middleware checks req.subdomains.length > matched.subdomainLength
    const single = [{ host: 'example.com', subdomainLength: 0 }];
    const result = matchArnsRootHost('arns.example.com', single);
    assert.equal(result!.subdomainLength, 0);
    // 1 subdomain > 0 subdomainLength → middleware treats as ArNS/sandbox
  });
});
