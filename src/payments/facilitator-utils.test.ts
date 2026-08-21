/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert';
import { before, describe, it } from 'node:test';

import {
  createFacilitatorConfigFromCredentials,
  resolveFacilitatorKeyId,
} from './facilitator-utils.js';

/**
 * Facilitator credential selection.
 *
 * These exist because the failure they guard is invisible. Handing
 * `createFacilitatorConfig` the PUBLIC paywall client key instead of the CDP
 * API key id makes CDP answer 401 on every verify, and that surfaces to callers
 * only as a generic "payment verification failed" — no test failed, no error
 * mentioned credentials, and the gateway kept advertising x402 as enabled while
 * earning nothing.
 *
 * The whole suite passed both before and after that bug was fixed, so nothing
 * here may rely on the processor's own tests to catch a regression.
 */
describe('createFacilitatorConfigFromCredentials', () => {
  const URL = 'https://facilitator.example.test' as `${string}://${string}`;

  it('uses the CDP facilitator when both credentials are present', () => {
    const cfg = createFacilitatorConfigFromCredentials('key-id', 'secret', URL);

    // A CDP config carries auth machinery rather than a bare URL. The exact
    // shape is the SDK's business; what matters is that it did NOT degrade to
    // the URL fallback.
    assert.notDeepStrictEqual(
      cfg,
      { url: URL },
      'both credentials present must select CDP, not the URL fallback',
    );
  });

  it('falls back to the URL when the API key id is missing', () => {
    assert.deepStrictEqual(
      createFacilitatorConfigFromCredentials(undefined, 'secret', URL),
      { url: URL },
    );
  });

  it('falls back to the URL when the secret is missing', () => {
    assert.deepStrictEqual(
      createFacilitatorConfigFromCredentials('key-id', undefined, URL),
      { url: URL },
    );
  });

  it('falls back to the URL when both are missing', () => {
    assert.deepStrictEqual(
      createFacilitatorConfigFromCredentials(undefined, undefined, URL),
      { url: URL },
    );
  });

  it('treats a blank credential as absent', () => {
    // Compose renders an unset variable as `VAR=`, which arrives as ''. Config
    // already normalizes that via env.varOrUndefined, but this helper is
    // exported and takes raw strings, so it must not build a CDP config around
    // an empty key id — that earns a 401 instead of the URL fallback.
    assert.deepStrictEqual(
      createFacilitatorConfigFromCredentials('', '', URL),
      { url: URL },
      'blank credentials must fall back, not authenticate with an empty id',
    );
    assert.deepStrictEqual(
      createFacilitatorConfigFromCredentials('   ', 'secret', URL),
      { url: URL },
      'whitespace-only key id is blank too',
    );
    // The implementation normalizes BOTH arguments, so both need covering --
    // testing only the key id would let a regression on the secret through.
    assert.deepStrictEqual(
      createFacilitatorConfigFromCredentials('key-id', '   ', URL),
      { url: URL },
      'whitespace-only secret is blank too',
    );
  });
});

describe('resolveFacilitatorKeyId', () => {
  // Explicit inputs, no ambient environment. Asserting this through the config
  // module is what made the previous version of these tests vacuous: with
  // neither variable set — which is how CI runs — both sides of the comparison
  // were `undefined`, so the assertion held even with the precedence reversed.
  const API_KEY_ID = 'cdp-api-key-id';
  const PAYWALL_KEY = 'public-paywall-client-key';

  it('prefers the dedicated API key id over the paywall client key', () => {
    assert.strictEqual(
      resolveFacilitatorKeyId(API_KEY_ID, PAYWALL_KEY),
      API_KEY_ID,
      'the paywall client key must never win while a dedicated id exists',
    );
  });

  it('never returns the paywall client key when the API key id is set', () => {
    // Stated separately from the above because this is the security-relevant
    // half: routing the PUBLIC paywall key into facilitator auth is the bug,
    // and it earns a 401 that surfaces only as a generic verification failure.
    assert.notStrictEqual(
      resolveFacilitatorKeyId(API_KEY_ID, PAYWALL_KEY),
      PAYWALL_KEY,
    );
  });

  it('falls back to the paywall client key when no API key id is set', () => {
    // Back-compat for operators who worked around the 401 by putting their API
    // key id in X_402_CDP_CLIENT_KEY.
    assert.strictEqual(
      resolveFacilitatorKeyId(undefined, PAYWALL_KEY),
      PAYWALL_KEY,
    );
  });

  it('returns undefined when neither is set, so the URL fallback applies', () => {
    assert.strictEqual(resolveFacilitatorKeyId(undefined, undefined), undefined);
  });
});

describe('x402 config exports', () => {
  let config: typeof import('../config.js');

  before(async () => {
    config = await import('../config.js');
  });

  it('wires the facilitator credential through resolveFacilitatorKeyId', () => {
    // The config module evaluates once at import, so its values cannot be
    // re-derived per case here. What this pins is that the export is the
    // resolver's output for the ambient inputs -- the precedence itself is
    // covered above with explicit values.
    assert.strictEqual(
      config.X_402_CDP_FACILITATOR_KEY_ID,
      resolveFacilitatorKeyId(
        config.X_402_CDP_API_KEY_ID,
        config.X_402_CDP_CLIENT_KEY,
      ),
    );
  });

  it('keeps the paywall client key as its own export', () => {
    // Collapsing the two back into one value is the bug; they must stay
    // separately addressable so neither can silently stand in for the other.
    assert.ok(Object.hasOwn(config, 'X_402_CDP_CLIENT_KEY'));
    assert.ok(Object.hasOwn(config, 'X_402_CDP_API_KEY_ID'));
    assert.ok(Object.hasOwn(config, 'X_402_CDP_FACILITATOR_KEY_ID'));
  });
});
