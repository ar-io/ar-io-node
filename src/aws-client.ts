/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import awsLite from '@aws-lite/client';
import awsLiteS3 from '@aws-lite/s3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

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
