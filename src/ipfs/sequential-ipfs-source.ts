/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  IpfsContentSource,
  IpfsContentSourceOptions,
} from './ipfs-content-source.js';
import {
  IpfsBlockedError,
  IpfsContentResult,
  IpfsRangeNotSatisfiableError,
  IpfsSizeLimitError,
  KuboDataSource,
} from './kubo-data-source.js';

/**
 * Composite IPFS source realizing the serving order:
 *
 *   1. local Kubo (offline)   — do we already hold it?      fast, no network
 *   2. peer AR.IO gateways    — does a fleet peer hold it?   verified CAR import
 *   3. Kubo (public IPFS)     — public DHT fallback          existing behavior
 *
 * Design note (serving vs. acquisition): normal (non-local-only) requests are
 * always SERVED through the Kubo gateway (:8080) so they get the correct sniffed
 * Content-Type and a local-first serve. Tier 2's job is purely ACQUISITION —
 * import a verified CAR into local Kubo — after which the gateway serves it
 * locally. This avoids the offline-RPC's octet-stream default leaking into
 * browser-facing responses, and it touches nothing in the ingress/proxy layer:
 * the only added I/O is an internal Kubo RPC presence check and outbound peer
 * HTTP fetches (the same shape existing Arweave peer sources already use).
 *
 * Local-only requests run tier 1 ONLY (genuinely offline) — never peers, never
 * public — which is what prevents peer-fetch recursion and makes holding
 * trustlessly measurable. When peer-fetch is disabled the composite is a pure
 * passthrough to Kubo (zero behavior change).
 */
export class SequentialIpfsSource implements IpfsContentSource {
  private log: winston.Logger;
  private kuboDataSource: KuboDataSource;
  private peerDataSource?: IpfsContentSource;

  constructor({
    log,
    kuboDataSource,
    peerDataSource,
  }: {
    log: winston.Logger;
    kuboDataSource: KuboDataSource;
    // Omit to disable peer-fetch (pure Kubo passthrough).
    peerDataSource?: IpfsContentSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kuboDataSource = kuboDataSource;
    this.peerDataSource = peerDataSource;
  }

  async getContent(opts: IpfsContentSourceOptions): Promise<IpfsContentResult> {
    // Tier 1 ONLY: genuinely offline. Never peers, never public. This is the
    // recursion guard and the holding-measurement primitive.
    if (opts.localOnly === true) {
      return this.kuboDataSource.getContent(opts);
    }

    // Peer-fetch disabled → pure passthrough to Kubo (zero behavior change).
    if (this.peerDataSource === undefined) {
      return this.kuboDataSource.getContent(opts);
    }

    opts.signal?.throwIfAborted();

    // Tier 1: already held locally? Serve via the gateway (local-first, correct
    // Content-Type, no public walk for content we hold).
    if (await this.kuboDataSource.isHeldLocally(opts.cidString, opts.signal)) {
      this.log.debug('IPFS content held locally, serving via gateway', {
        cidString: opts.cidString,
      });
      return this.kuboDataSource.getContent(opts);
    }

    // Tier 2: not held → acquire from a fleet peer (verified CAR import) and
    // serve. On a recoverable miss, fall through to public IPFS.
    try {
      return await this.peerDataSource.getContent(opts);
    } catch (error: any) {
      this.rethrowIfFatal(error, opts.signal);
      this.log.debug('IPFS peer-fetch missed, falling through to public IPFS', {
        cidString: opts.cidString,
        message: error?.message,
      });
    }

    // Tier 3: public IPFS via the gateway (existing behavior).
    return this.kuboDataSource.getContent(opts);
  }

  // Errors that must NOT fall through to the next tier:
  //  - a genuine client disconnect (short-circuit the whole cascade);
  //  - moderation (a blocked CID stays blocked across every tier);
  //  - size / range errors (not an availability miss).
  // Everything else (NotFound / Timeout / Unavailable / transport) is a
  // recoverable miss and falls through.
  private rethrowIfFatal(error: any, signal?: AbortSignal): void {
    if (error?.name === 'AbortError' && signal?.aborted === true) {
      throw error;
    }
    if (
      error instanceof IpfsBlockedError ||
      error instanceof IpfsSizeLimitError ||
      error instanceof IpfsRangeNotSatisfiableError
    ) {
      throw error;
    }
  }
}

/**
 * Wraps a KuboDataSource to force `localOnly: true` on every call — a fixed
 * tier-1 (offline) source. Retained as a reusable primitive (e.g. for an
 * explicit tier list or an observer holding-probe wiring); the composite above
 * reaches tier 1 directly via KuboDataSource, so this is not required by it.
 */
export class LocalOnlyKuboSource implements IpfsContentSource {
  constructor(private inner: KuboDataSource) {}

  getContent(opts: IpfsContentSourceOptions): Promise<IpfsContentResult> {
    return this.inner.getContent({ ...opts, localOnly: true });
  }
}
