/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module '@aws-lite/s3' {
  import { AwsLiteS3 } from '@aws-lite/s3-types';

  const plugin: {
    exports: AwsLiteS3;
  };
  export default plugin;
}
