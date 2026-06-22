/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import awsLite from '@aws-lite/client';
import awsLiteS3 from '@aws-lite/s3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

import * as env from './lib/env.js';

async function canInitAwsClient() {
  // 1. Region must be set
  if (!process.env.AWS_REGION!) return false;

  // 2. At least one credential source must resolve
  try {
    await fromNodeProviderChain()(); // throws if none found
    return true;
  } catch {
    return false;
  }
}

export const awsClient = (await canInitAwsClient())
  ? await awsLite({
      endpoint: process.env.AWS_ENDPOINT,
      region: process.env.AWS_REGION, // guaranteed non-undefined now
      plugins: [awsLiteS3],
    }).catch((err) => {
      console.error('Failed to initialize AWS client', err);
      return undefined; // keep graceful fallback
    })
  : undefined;

/**
 * Whether a dedicated Turbo AWS client should be created.
 *
 * Returns `true` only when both `TURBO_AWS_REGION` and `TURBO_AWS_ENDPOINT` are
 * set to non-empty values. Empty strings — e.g. the unset compose default
 * `${TURBO_AWS_REGION:-}` — are treated as unset (via {@link env.varOrUndefined}),
 * so the shared {@link awsClient} is used instead of a misconfigured dedicated
 * client.
 */
function hasTurboAwsConfig() {
  return (
    env.varOrUndefined('TURBO_AWS_REGION') !== undefined &&
    env.varOrUndefined('TURBO_AWS_ENDPOINT') !== undefined
  );
}

/**
 * AWS client used by the Turbo S3 data source.
 *
 * A dedicated aws-lite client is instantiated only when both `TURBO_AWS_REGION`
 * and `TURBO_AWS_ENDPOINT` are set, letting the Turbo S3 source target a
 * different AWS account or S3-compatible endpoint than the default client.
 * Otherwise this is the shared {@link awsClient} reference (which is itself
 * `undefined` when AWS is not configured at all), preserving existing behavior.
 *
 * Credentials resolve per field: the Turbo-specific value
 * (`TURBO_AWS_ACCESS_KEY_ID` / `TURBO_AWS_SECRET_ACCESS_KEY` /
 * `TURBO_AWS_SESSION_TOKEN`) when set, otherwise the default `AWS_*` value,
 * otherwise `undefined` so aws-lite resolves credentials from the ambient
 * provider chain (e.g. IAM role) — matching the default client. Empty-string
 * env values are treated as unset throughout. On initialization failure the
 * shared {@link awsClient} is used as a graceful fallback.
 */
export const turboAwsClient = hasTurboAwsConfig()
  ? await awsLite({
      endpoint: env.varOrUndefined('TURBO_AWS_ENDPOINT'),
      region: env.varOrUndefined('TURBO_AWS_REGION'),
      accessKeyId:
        env.varOrUndefined('TURBO_AWS_ACCESS_KEY_ID') ??
        env.varOrUndefined('AWS_ACCESS_KEY_ID'),
      secretAccessKey:
        env.varOrUndefined('TURBO_AWS_SECRET_ACCESS_KEY') ??
        env.varOrUndefined('AWS_SECRET_ACCESS_KEY'),
      sessionToken:
        env.varOrUndefined('TURBO_AWS_SESSION_TOKEN') ??
        env.varOrUndefined('AWS_SESSION_TOKEN'),
      plugins: [awsLiteS3],
    }).catch((err) => {
      console.error('Failed to initialize Turbo AWS client', err);
      return awsClient; // fall back to the shared client
    })
  : awsClient;

// Check if legacy S3 credentials are explicitly configured
function hasLegacyS3Credentials() {
  return (
    process.env.LEGACY_AWS_S3_ACCESS_KEY_ID !== undefined &&
    process.env.LEGACY_AWS_S3_SECRET_ACCESS_KEY !== undefined &&
    process.env.LEGACY_AWS_S3_REGION !== undefined
  );
}

// Separate AWS client for legacy S3 chunk source (optional - uses explicit credentials)
export const legacyAwsS3Client = hasLegacyS3Credentials()
  ? await awsLite({
      accessKeyId: process.env.LEGACY_AWS_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.LEGACY_AWS_S3_SECRET_ACCESS_KEY,
      region: process.env.LEGACY_AWS_S3_REGION,
      endpoint: process.env.LEGACY_AWS_S3_ENDPOINT,
      plugins: [awsLiteS3],
    }).catch((err) => {
      console.error('Failed to initialize legacy AWS S3 client', err);
      return undefined;
    })
  : undefined;
