/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Resolving a publisher through the gateway registry.
 *
 * A subscriber is configured with a publisher's wallet and nothing else. The
 * registry is what turns that into the two facts it needs: where to fetch
 * from, and which key a signature must carry. Anchoring on the registry
 * rather than on configured URLs is what makes the trust model work, because
 * an operator never types a hostname that could be pointed somewhere else.
 *
 * Defined as an interface so tests can supply records directly, and because
 * the Solana RPC behind the real one is a shared, rate-limited resource that
 * a test has no business touching.
 */
import { Logger } from 'winston';

export interface PublisherRecord {
  /** The gateway's registered wallet: the publisher's identity. */
  wallet: string;
  /** The key that must have signed a publication from this publisher. */
  observerAddress: string;
  /** Base URL built from the gateway's registered settings. */
  url: string;
  status: 'joined' | 'leaving';
}

export interface GatewayRegistry {
  lookup(wallet: string): Promise<PublisherRecord | undefined>;
}

/** Build the base URL a gateway's registered settings describe. */
export function gatewayUrl(settings: {
  protocol?: string;
  fqdn?: string;
  port?: number;
}): string | undefined {
  const { protocol = 'https', fqdn, port } = settings;
  if (typeof fqdn !== 'string' || fqdn.length === 0) {
    return undefined;
  }
  const defaultPort = protocol === 'https' ? 443 : 80;
  const suffix =
    port === undefined || port === defaultPort ? '' : `:${String(port)}`;
  return `${protocol}://${fqdn}${suffix}`;
}

/** The shape this module needs from the SDK, so tests need no SDK at all. */
export interface GatewayReader {
  getGateway(params: { address: string }): Promise<
    | {
        settings: { protocol?: string; fqdn?: string; port?: number };
        observerAddress: string;
        status: 'joined' | 'leaving';
      }
    | undefined
  >;
}

interface CacheEntry {
  record: PublisherRecord | undefined;
  expiresAt: number;
}

/**
 * Registry lookups backed by the AR.IO SDK, cached.
 *
 * Gateway records change rarely, while subscriptions poll on a timer, so an
 * uncached lookup would spend a Solana RPC call per publisher per poll on an
 * answer that is almost always identical. The RPC is shared with the gateway
 * and the observer, and exhausting it is how a free-tier endpoint took this
 * node's observer down before.
 */
export class CachedGatewayRegistry implements GatewayRegistry {
  private readonly log: Logger;
  private readonly reader: GatewayReader;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<PublisherRecord | undefined>
  >();
  private readonly now: () => number;

  constructor({
    log,
    reader,
    ttlMs,
    now = () => Date.now(),
  }: {
    log: Logger;
    reader: GatewayReader;
    ttlMs: number;
    now?: () => number;
  }) {
    this.log = log.child({ class: 'CachedGatewayRegistry' });
    this.reader = reader;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async lookup(wallet: string): Promise<PublisherRecord | undefined> {
    const cached = this.cache.get(wallet);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.record;
    }

    // Collapse concurrent lookups of the same wallet onto one RPC call.
    const existing = this.inFlight.get(wallet);
    if (existing !== undefined) {
      return existing;
    }

    const request = this.fetchRecord(wallet).finally(() => {
      this.inFlight.delete(wallet);
    });
    this.inFlight.set(wallet, request);
    return request;
  }

  private async fetchRecord(
    wallet: string,
  ): Promise<PublisherRecord | undefined> {
    let record: PublisherRecord | undefined;
    try {
      const gateway = await this.reader.getGateway({ address: wallet });
      const url =
        gateway !== undefined ? gatewayUrl(gateway.settings) : undefined;
      if (gateway === undefined || url === undefined) {
        this.log.warn('Publisher is not in the gateway registry', { wallet });
      } else {
        record = {
          wallet,
          observerAddress: gateway.observerAddress,
          url,
          status: gateway.status,
        };
      }
    } catch (error: any) {
      // A registry that cannot be read is a transient problem. Cache the miss
      // briefly so a flapping RPC does not turn into a request storm, but far
      // more briefly than a successful answer.
      this.log.warn('Could not read the gateway registry', {
        wallet,
        error: error?.message,
      });
      this.cache.set(wallet, {
        record: undefined,
        expiresAt: this.now() + Math.min(this.ttlMs, 30_000),
      });
      return undefined;
    }

    this.cache.set(wallet, {
      record,
      expiresAt: this.now() + this.ttlMs,
    });
    return record;
  }
}
