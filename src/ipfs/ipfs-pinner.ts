/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import winston from 'winston';

import { cidToV1Base32, isValidCid } from '../lib/ipfs-cid.js';

/**
 * Best-effort pinner for "named" IPFS content — the CIDs that ArNS names resolve
 * to. In read-only IPFS mode (no Arweave storage of the content) a name→CID
 * binding is only as available as the public network keeps it; Kubo runs with
 * GC, so unpinned content can vanish and the name 404s. Pinning the CIDs this
 * gateway is responsible for serving keeps them retrievable locally.
 *
 * Deliberately simple: fire-and-forget (never blocks a response), idempotent
 * (Kubo pin/add is idempotent; an in-memory set suppresses duplicate calls), and
 * bounded (oldest pins are removed FIFO past `max` to cap local storage). The set
 * is in-memory, so after a restart already-pinned CIDs are simply re-pinned on
 * next resolution — harmless. Uses the Kubo RPC API (not the read-only gateway).
 */
export class IpfsPinner {
  private log: winston.Logger;
  private apiUrl: string;
  private max: number;
  // Insertion-ordered set of pinned CIDs (v1 base32) for FIFO eviction.
  private pinned = new Set<string>();
  private inFlight = new Set<string>();

  constructor({
    log,
    apiUrl,
    max,
  }: {
    log: winston.Logger;
    apiUrl: string;
    max: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.max = max;
  }

  /** Fire-and-forget pin of a named CID. Never throws; never blocks. */
  pin(cidString: string): void {
    if (!isValidCid(cidString)) return;
    let cid: string;
    try {
      cid = cidToV1Base32(cidString);
    } catch {
      return; // defensive — should not happen after isValidCid
    }
    if (this.pinned.has(cid) || this.inFlight.has(cid)) return;
    this.inFlight.add(cid);
    void this.doPin(cid).finally(() => this.inFlight.delete(cid));
  }

  private async doPin(cid: string): Promise<void> {
    try {
      await this.rpc('pin/add', cid);
      this.pinned.add(cid);
      this.log.debug('Pinned named IPFS CID', { cid });
      // Bound local storage: unpin oldest beyond the cap. Only drop it from the
      // tracked set once Kubo confirms the unpin — otherwise a failed pin/rm
      // would leave the CID pinned but untracked, and the real pin count could
      // drift above `max`. Stop on the first failure to avoid spinning against
      // an unhealthy Kubo; the entry is retried on the next eviction.
      while (this.pinned.size > this.max) {
        const oldest = this.pinned.values().next().value;
        if (oldest === undefined) break;
        try {
          await this.rpc('pin/rm', oldest);
          this.pinned.delete(oldest);
        } catch (error: any) {
          this.log.warn('Failed to unpin evicted CID; will retry later', {
            cid: oldest,
            message: error?.message,
          });
          break;
        }
      }
    } catch (error: any) {
      this.log.warn('Failed to pin named IPFS CID', {
        cid,
        message: error?.message,
      });
    }
  }

  private async rpc(path: string, cid: string): Promise<void> {
    // Kubo RPC is POST-only; args go in the query string.
    await axios.post(
      `${this.apiUrl}/api/v0/${path}?arg=${encodeURIComponent(cid)}`,
      undefined,
      { timeout: 30_000 },
    );
  }
}
