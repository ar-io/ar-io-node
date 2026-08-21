/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert';
import { before, describe, it } from 'node:test';

import { createFacilitatorConfigFromCredentials } from './facilitator-utils.js';

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
      'whitespace-only is blank too',
    );
  });
});

describe('x402 credential wiring', () => {
  let config: typeof import('../config.js');

  before(async () => {
    config = await import('../config.js');
  });

  it('resolves the facilitator key id from CDP_API_KEY_ID, not the paywall key', () => {
    // The regression this pins: X_402_CDP_CLIENT_KEY is the PUBLIC client key
    // that brands the paywall. If someone routes it back into facilitator auth,
    // the resolved value stops tracking CDP_API_KEY_ID and this fails.
    if (config.X_402_CDP_API_KEY_ID !== undefined) {
      assert.strictEqual(
        config.X_402_CDP_FACILITATOR_KEY_ID,
        config.X_402_CDP_API_KEY_ID,
        'CDP_API_KEY_ID must win when set',
      );
    } else {
      assert.strictEqual(
        config.X_402_CDP_FACILITATOR_KEY_ID,
        config.X_402_CDP_CLIENT_KEY,
        'without CDP_API_KEY_ID the documented back-compat fallback applies',
      );
    }
  });

  it('keeps the paywall client key distinct from the facilitator credential', () => {
    // These are separate exports precisely so one cannot silently stand in for
    // the other. Collapsing them back into a single value is the bug.
    assert.ok(
      Object.hasOwn(config, 'X_402_CDP_CLIENT_KEY'),
      'the paywall client key must remain its own config export',
    );
    assert.ok(
      Object.hasOwn(config, 'X_402_CDP_FACILITATOR_KEY_ID'),
      'facilitator auth must have a config export separate from the paywall key',
    );
  });
});
