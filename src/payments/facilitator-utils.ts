/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createFacilitatorConfig } from '@coinbase/x402';
import type { FacilitatorConfig } from 'x402/types';

/**
 * Creates a facilitator configuration object based on available credentials.
 * When CDP API credentials are provided, returns a CDP-enabled facilitator config.
 * Otherwise, returns a basic URL-based facilitator config.
 *
 * `createFacilitatorConfig` authenticates with a CDP **API key id** and its
 * secret. It is NOT the public Client API key that brands the paywall — passing
 * that one here makes CDP reject every verify with 401 Unauthorized, and
 * because the failure surfaces only as a generic "payment verification failed"
 * it is invisible without reading the gateway's own logs.
 *
 * @param cdpApiKeyId - Coinbase Developer Platform API key ID (see CDP_API_KEY_ID)
 * @param cdpApiKeySecret - Coinbase Developer Platform API secret (private)
 * @param facilitatorUrl - Fallback facilitator endpoint URL
 * @returns Facilitator configuration object compatible with useFacilitator()
 */
export function createFacilitatorConfigFromCredentials(
  cdpApiKeyId: string | undefined,
  cdpApiKeySecret: string | undefined,
  facilitatorUrl: `${string}://${string}`,
): FacilitatorConfig {
  // Blank is absent. Callers coming through config.ts are already normalized by
  // env.varOrUndefined, but this helper is exported and takes raw strings, so a
  // direct caller passing '' would otherwise build a CDP config around an empty
  // key id and earn a 401 rather than falling back.
  const id = cdpApiKeyId?.trim() === '' ? undefined : cdpApiKeyId;
  const secret = cdpApiKeySecret?.trim() === '' ? undefined : cdpApiKeySecret;

  if (id !== undefined && secret !== undefined) {
    // Use CDP-enabled facilitator configuration when credentials are provided
    return createFacilitatorConfig(id, secret);
  } else {
    // Use basic URL-based facilitator configuration
    return { url: facilitatorUrl };
  }
}

/**
 * Choose the credential used to authenticate against the Coinbase facilitator.
 *
 * Prefers the dedicated API key id. Falls back to the PUBLIC paywall client key
 * only because operators who hit the 401 before this was fixed were told,
 * correctly for the code at the time, to put their API key id there; reading
 * only the dedicated variable would turn that working workaround into a silent
 * fallback to a facilitator URL that cannot settle on mainnet.
 *
 * Extracted so the precedence can be tested with explicit inputs. Asserting it
 * through the config module instead makes the test depend on ambient
 * environment: with neither variable set, both sides of the comparison are
 * `undefined` and the assertion holds no matter which credential wins.
 *
 * @param apiKeyId - dedicated CDP API key id (CDP_API_KEY_ID)
 * @param paywallClientKey - public paywall client key (X_402_CDP_CLIENT_KEY)
 */
export function resolveFacilitatorKeyId(
  apiKeyId: string | undefined,
  paywallClientKey: string | undefined,
): string | undefined {
  return apiKeyId ?? paywallClientKey;
}
