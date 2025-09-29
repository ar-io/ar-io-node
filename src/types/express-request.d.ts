/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { TokenBucket } from '../lib/rate-limiter-redis.js';

declare global {
  namespace Express {
    interface Request {
      serveCacheOnly: boolean | undefined;
      id: string;
      log: import('winston').Logger;
      timedout: boolean;
      resourceBucket?: TokenBucket;
      ipBucket?: TokenBucket;
    }
  }
}

export {};
