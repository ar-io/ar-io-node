/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import * as metrics from '../metrics.js';

/**
 * Remembers which upstream gateways are throttling us, so requests skip them
 * until they ask to be retried.
 *
 * A gateway answering 429 is refusing work for a while, and says how long with
 * `Retry-After` (arweave.net, behind CDN77, sends 299 seconds). Without this,
 * every cold item still goes to that gateway first: it queues for one of the
 * gateway's sockets (capped per host), often until the connection timeout, and
 * then gets another 429. On a busy node that is thousands of wasted requests a
 * day and seconds added to each cold item, and it keeps the throttle going.
 *
 * Shared by every GatewaysDataSource in a process, since they talk to the same
 * gateways.
 */
export class GatewayThrottle {
  private readonly log: winston.Logger;
  private readonly enabled: boolean;
  private readonly defaultMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  /** Gateway URL to the time (ms) it may be tried again. */
  private readonly until = new Map<string, number>();

  /**
   * @param defaultMs cooldown when a 429 carries no usable `Retry-After`.
   * @param maxMs ceiling on any cooldown, so a misconfigured or hostile
   *   `Retry-After` cannot take a gateway out of rotation for long.
   */
  constructor({
    log,
    enabled = true,
    defaultMs = 30_000,
    maxMs = 300_000,
    now = () => Date.now(),
  }: {
    log: winston.Logger;
    enabled?: boolean;
    defaultMs?: number;
    maxMs?: number;
    now?: () => number;
  }) {
    this.log = log.child({ class: 'GatewayThrottle' });
    this.enabled = enabled;
    this.defaultMs = Math.max(0, defaultMs);
    this.maxMs = Math.max(0, maxMs);
    this.now = now;
  }

  /** Milliseconds until `gatewayUrl` may be tried again; 0 when it may now. */
  remainingMs(gatewayUrl: string): number {
    if (!this.enabled) return 0;
    const until = this.until.get(gatewayUrl);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.until.delete(gatewayUrl);
      this.log.info('Gateway throttle cooldown ended', { gatewayUrl });
      return 0;
    }
    return remaining;
  }

  /**
   * Record a 429 from `gatewayUrl`. The cooldown is its `Retry-After`, either
   * delta-seconds or an HTTP date, capped at `maxMs`; without a usable value,
   * `defaultMs`. A later 429 only ever extends a cooldown, never shortens it.
   */
  recordThrottled(gatewayUrl: string, retryAfter?: string | string[]): number {
    if (!this.enabled) return 0;
    const cooldownMs = Math.min(
      this.maxMs,
      parseRetryAfterMs(retryAfter, this.now()) ?? this.defaultMs,
    );
    // Retry-After: 0 (or a zero default) asks for no wait: nothing to record.
    if (cooldownMs <= 0) return 0;
    const until = this.now() + cooldownMs;
    const existing = this.until.get(gatewayUrl);
    if (existing !== undefined && existing >= until) {
      return existing - this.now();
    }
    if (existing === undefined) {
      metrics.gatewayThrottleCooldownsTotal.inc({ gateway_url: gatewayUrl });
      this.log.info('Gateway is throttling us; skipping it until retry', {
        gatewayUrl,
        cooldownMs,
        retryAfter,
      });
    }
    this.until.set(gatewayUrl, until);
    return cooldownMs;
  }
}

/**
 * A `Retry-After` value in milliseconds from `now`: delta-seconds or an
 * HTTP-date (RFC 9110 §10.2.3). Undefined when absent or unparseable; a date in
 * the past is 0.
 */
export function parseRetryAfterMs(
  value: string | string[] | undefined,
  now: number,
): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }
  // Date.parse accepts far more than HTTP dates ("-5", "1.5"); an HTTP date
  // always names its month.
  if (!/[A-Za-z]{3}/.test(raw)) return undefined;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
