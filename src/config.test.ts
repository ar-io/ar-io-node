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
  deriveChunkDataCacheMinAgeSeconds,
  matchArnsRootHost,
  resolvePerHostNumber,
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

describe('matchArnsRootHost with apexName', () => {
  it('returns per-host apexName from matched entry', () => {
    const hosts = [
      { host: 'turbo-gateway.com', subdomainLength: 0, apexName: 'turbo' },
      { host: 'ar.io', subdomainLength: 0, apexName: 'ar-io' },
    ];
    const sorted = [...hosts].sort((a, b) => b.host.length - a.host.length);

    const result1 = matchArnsRootHost('turbo-gateway.com', sorted);
    assert.equal(result1?.apexName, 'turbo');

    const result2 = matchArnsRootHost('ar.io', sorted);
    assert.equal(result2?.apexName, 'ar-io');
  });

  it('returns undefined apexName when not set on entry', () => {
    const hosts = [{ host: 'example.com', subdomainLength: 0 }];
    const result = matchArnsRootHost('example.com', hosts);
    assert.equal(result?.apexName, undefined);
  });

  it('subdomain request inherits apexName from matched root host', () => {
    const hosts = [
      { host: 'turbo-gateway.com', subdomainLength: 0, apexName: 'turbo' },
    ];
    const result = matchArnsRootHost('myname.turbo-gateway.com', hosts);
    assert.equal(result?.apexName, 'turbo');
  });

  it('single apex name applies to all hosts (backward compat simulation)', () => {
    // When APEX_ARNS_NAME has one value, config.ts applies it to all hosts
    const hosts = [
      { host: 'host1.com', subdomainLength: 0, apexName: 'shared' },
      { host: 'host2.com', subdomainLength: 0, apexName: 'shared' },
    ];
    const sorted = [...hosts].sort((a, b) => b.host.length - a.host.length);

    assert.equal(matchArnsRootHost('host1.com', sorted)?.apexName, 'shared');
    assert.equal(matchArnsRootHost('host2.com', sorted)?.apexName, 'shared');
  });

  it('host without apex does not match apexName from other hosts', () => {
    const hosts = [
      { host: 'has-apex.com', subdomainLength: 0, apexName: 'myname' },
      { host: 'no-apex.com', subdomainLength: 0 },
    ];
    const sorted = [...hosts].sort((a, b) => b.host.length - a.host.length);

    assert.equal(matchArnsRootHost('has-apex.com', sorted)?.apexName, 'myname');
    assert.equal(matchArnsRootHost('no-apex.com', sorted)?.apexName, undefined);
  });
});

describe('resolvePerHostNumber', () => {
  it('returns a bare number for every host', () => {
    assert.equal(resolvePerHostNumber(64, 'http://10.84.0.82:4000', 16), 64);
    assert.equal(resolvePerHostNumber(64, 'https://arweave.net', 16), 64);
  });

  it('prefers an exact per-host entry', () => {
    const cfg = { 'http://10.84.0.82:4000': 128, default: 64 };
    assert.equal(resolvePerHostNumber(cfg, 'http://10.84.0.82:4000', 16), 128);
  });

  it('falls back to the default key for unlisted hosts', () => {
    const cfg = { 'http://10.84.0.82:4000': 128, default: 64 };
    assert.equal(resolvePerHostNumber(cfg, 'https://arweave.net', 16), 64);
  });

  it('falls back to the built-in fallback with no matching entry or default', () => {
    const cfg = { 'http://10.84.0.82:4000': 128 };
    assert.equal(resolvePerHostNumber(cfg, 'https://arweave.net', 16), 16);
  });
});

describe('deriveChunkDataCacheMinAgeSeconds', () => {
  // The chunk data cache index eviction age floor. This is a correctness
  // control, not a tuning knob: evicting an ingest-cached chunk before its
  // data root confirms on chain breaks upload propagation, and it fails
  // silently. See the comment block on the function in config.ts.

  it('equals the allowlist confirmation timeout when ingest caching is enabled and that timeout is larger', () => {
    // Stock defaults: AGGRESSIVE=3600 (1h), ALLOWLIST_TIMEOUT=86400 (24h).
    assert.equal(
      deriveChunkDataCacheMinAgeSeconds({
        ingestCacheEnabled: true,
        aggressiveMinAgeSeconds: 3600,
        allowlistConfirmationTimeoutSeconds: 86400,
      }),
      86400,
    );

    // Production gw2: AGGRESSIVE=7200 (2h), ALLOWLIST_TIMEOUT=14400 (4h).
    assert.equal(
      deriveChunkDataCacheMinAgeSeconds({
        ingestCacheEnabled: true,
        aggressiveMinAgeSeconds: 7200,
        allowlistConfirmationTimeoutSeconds: 14400,
      }),
      14400,
    );
  });

  it('equals the aggressive min age when ingest caching is disabled', () => {
    // Nothing locally-originated to protect, so the floor is just the same
    // floor the filesystem-walk cleanup worker honors -- even though the
    // allowlist timeout is far larger.
    assert.equal(
      deriveChunkDataCacheMinAgeSeconds({
        ingestCacheEnabled: false,
        aggressiveMinAgeSeconds: 3600,
        allowlistConfirmationTimeoutSeconds: 86400,
      }),
      3600,
    );
  });

  it('keeps the aggressive min age when it already exceeds the allowlist timeout', () => {
    assert.equal(
      deriveChunkDataCacheMinAgeSeconds({
        ingestCacheEnabled: true,
        aggressiveMinAgeSeconds: 172800,
        allowlistConfirmationTimeoutSeconds: 86400,
      }),
      172800,
    );
  });

  it('is never below the allowlist confirmation timeout while ingest caching is enabled', () => {
    const aggressiveValues = [0, 60, 3600, 7200, 14400, 86400, 172800];
    const allowlistValues = [60, 3600, 14400, 21600, 86400, 604800];
    for (const aggressiveMinAgeSeconds of aggressiveValues) {
      for (const allowlistConfirmationTimeoutSeconds of allowlistValues) {
        const floor = deriveChunkDataCacheMinAgeSeconds({
          ingestCacheEnabled: true,
          aggressiveMinAgeSeconds,
          allowlistConfirmationTimeoutSeconds,
        });
        assert.ok(
          floor >= allowlistConfirmationTimeoutSeconds,
          `floor ${floor} must not be below the allowlist confirmation ` +
            `timeout ${allowlistConfirmationTimeoutSeconds} ` +
            `(aggressive=${aggressiveMinAgeSeconds})`,
        );
        assert.ok(
          floor >= aggressiveMinAgeSeconds,
          `floor ${floor} must not be below the aggressive min age ${aggressiveMinAgeSeconds}`,
        );
      }
    }
  });
});
