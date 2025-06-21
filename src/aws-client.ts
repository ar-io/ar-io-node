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
