/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
