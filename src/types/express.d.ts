/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare global {
  namespace Express {
    interface Request {
      dataId?: string; // The data ID to serve
      manifestPath?: string; // Path within manifest (if applicable)
      arns?: {
        // Only present for successful ArNS resolution
        name: string;
        basename: string;
        record: string;
        ttl?: number;
        processId?: string;
        resolvedAt?: number;
        limit?: number;
        index?: number;
      };
    }
  }
}

export {};
