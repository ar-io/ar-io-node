/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The release this node reports (the `release` label on every metric, and
 * `/ar-io/info`): `AR_IO_NODE_RELEASE`, else the build's own release. Its own
 * module, re-exported by `src/config.ts`, so `metrics.ts` needn't load the
 * gateway's whole configuration.
 */
import * as env from './lib/env.js';
import { release } from './version.js';

export const AR_IO_NODE_RELEASE = env.varOrDefault(
  'AR_IO_NODE_RELEASE',
  release,
);
