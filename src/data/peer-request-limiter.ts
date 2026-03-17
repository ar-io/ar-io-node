/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Counter-based fail-fast per-peer concurrency limiter.
 *
 * Unlike queue-based limiters (e.g. p-limit), this does NOT wait for a slot —
 * it returns false immediately when a peer is saturated so callers can skip
 * to the next candidate.
 */
export class PeerRequestLimiter {
  private active: Map<string, number> = new Map();
  private maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  tryAcquire(peerUrl: string): boolean {
    const current = this.active.get(peerUrl) ?? 0;
    if (current >= this.maxConcurrent) {
      return false;
    }
    this.active.set(peerUrl, current + 1);
    return true;
  }

  release(peerUrl: string): void {
    const current = this.active.get(peerUrl);
    if (current === undefined) {
      return;
    }
    if (current <= 1) {
      this.active.delete(peerUrl);
    } else {
      this.active.set(peerUrl, current - 1);
    }
  }

  isAvailable(peerUrl: string): boolean {
    return (this.active.get(peerUrl) ?? 0) < this.maxConcurrent;
  }

  getActiveCount(peerUrl: string): number {
    return this.active.get(peerUrl) ?? 0;
  }
}
