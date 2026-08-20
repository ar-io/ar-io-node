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
  if (cdpApiKeyId !== undefined && cdpApiKeySecret !== undefined) {
    // Use CDP-enabled facilitator configuration when credentials are provided
    return createFacilitatorConfig(cdpApiKeyId, cdpApiKeySecret);
  } else {
    // Use basic URL-based facilitator configuration
    return { url: facilitatorUrl };
  }
}
