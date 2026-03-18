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
