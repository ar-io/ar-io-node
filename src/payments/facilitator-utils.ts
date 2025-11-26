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
 * @param cdpClientKey - Coinbase Developer Platform client API key (public)
 * @param cdpClientSecret - Coinbase Developer Platform API secret (private)
 * @param facilitatorUrl - Fallback facilitator endpoint URL
 * @returns Facilitator configuration object compatible with useFacilitator()
 */
export function createFacilitatorConfigFromCredentials(
  cdpClientKey: string | undefined,
  cdpClientSecret: string | undefined,
  facilitatorUrl: `${string}://${string}`,
): FacilitatorConfig {
  if (cdpClientKey !== undefined && cdpClientSecret !== undefined) {
    // Use CDP-enabled facilitator configuration when credentials are provided
    return createFacilitatorConfig(cdpClientKey, cdpClientSecret);
  } else {
    // Use basic URL-based facilitator configuration
    return { url: facilitatorUrl };
  }
}
