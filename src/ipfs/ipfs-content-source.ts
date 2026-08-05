/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Span } from '@opentelemetry/api';

import { IpfsContentResult } from './kubo-data-source.js';

// Shared shape for any IPFS content tier (local Kubo, fleet peers, public Kubo).
// Mirrors KuboDataSource.getContent so the composite (SequentialIpfsSource) can
// compose sources uniformly, and IpfsService can depend on the interface rather
// than the concrete KuboDataSource.
export interface IpfsContentSourceOptions {
  cidString: string;
  path?: string;
  signal?: AbortSignal;
  parentSpan?: Span;
  range?: string;
  // Trustless response format: a single verifiable block (`raw`) or a verifiable
  // DAG archive (`car`). Absent = UnixFS proxy.
  format?: 'raw' | 'car';
  // Serve ONLY from the local blockstore (offline) — never peers, never public
  // IPFS. The recursion guard + holding-measurement primitive.
  localOnly?: boolean;
}

export interface IpfsContentSource {
  getContent(opts: IpfsContentSourceOptions): Promise<IpfsContentResult>;
}
