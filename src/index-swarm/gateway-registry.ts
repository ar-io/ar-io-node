/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The gateway registry, as the sidecar sees it: through its own gateway.
 *
 * A subscriber needs each publisher's URL and the key its publications must
 * be signed with, and discovery needs every gateway's stake and status. The
 * gateway already reads the whole registry every hour for its own peer
 * selection and serves the result at `/ar-io/peers`, wallet, observer key,
 * stake and status included. Reading that instead of the chain means the
 * sidecar adds no load at all on the Solana RPC provider, needs no RPC
 * configuration of its own, and can never disagree with the gateway about
 * who its peers are.
 *
 * The trade: the view is as fresh as the gateway's last refresh (an hour at
 * most), and it lists the gateways the gateway itself would use, which
 * excludes the gateway's own wallet and, by default, gateways that are
 * leaving. Neither is something a subscriber should subscribe to anyway.
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

/** A registered gateway, as discovery needs it. */
export interface RegistryGateway extends PublisherRecord {
  fqdn: string;
  operatorStake: number;
}

export interface GatewayLister {
  list(): Promise<RegistryGateway[]>;
}

export interface CoreGatewayRegistryOptions {
  log: Logger;
  /** The gateway beside the sidecar, e.g. `http://core:4000`. */
  coreUrl: string;
  /** How long one read of the gateway's peer list is reused. */
  ttlMs: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Registry records from the gateway's own `/ar-io/peers`. */
export class CoreGatewayRegistry implements GatewayRegistry, GatewayLister {
  private readonly log: Logger;
  private readonly coreUrl: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached: { at: number; gateways: RegistryGateway[] } | undefined;
  private inFlight: Promise<RegistryGateway[]> | undefined;
  private warnedOldCore = false;

  constructor(options: CoreGatewayRegistryOptions) {
    this.log = options.log.child({ class: 'CoreGatewayRegistry' });
    this.coreUrl = options.coreUrl.replace(/\/+$/, '');
    this.ttlMs = options.ttlMs;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Every gateway the gateway knows, from a cache no older than the TTL.
   * When the gateway cannot be reached, the last good read is returned
   * rather than nothing, so a brief restart of the gateway does not make
   * every publisher unresolvable. With no good read yet, it throws.
   */
  async list(): Promise<RegistryGateway[]> {
    if (this.cached !== undefined && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.gateways;
    }
    // One request for concurrent callers: several subscriptions resolving
    // at once must not each fetch the whole peer list.
    this.inFlight ??= this.fetchPeers().finally(() => {
      this.inFlight = undefined;
    });
    try {
      const gateways = await this.inFlight;
      this.cached = { at: this.now(), gateways };
      return gateways;
    } catch (error: any) {
      if (this.cached !== undefined) {
        this.log.warn(
          'Could not read the gateway’s peer list; using the last one',
          {
            error: error?.message,
          },
        );
        return this.cached.gateways;
      }
      throw error;
    }
  }

  async lookup(wallet: string): Promise<PublisherRecord | undefined> {
    try {
      const gateway = (await this.list()).find((g) => g.wallet === wallet);
      if (gateway === undefined) return undefined;
      const { wallet: w, observerAddress, url, status } = gateway;
      return { wallet: w, observerAddress, url, status };
    } catch (error: any) {
      this.log.warn('Could not resolve publisher through the gateway', {
        wallet,
        error: error?.message,
      });
      return undefined;
    }
  }

  private async fetchPeers(): Promise<RegistryGateway[]> {
    const response = await fetch(`${this.coreUrl}/ar-io/peers`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} from the gateway’s /ar-io/peers`,
      );
    }
    const body = (await response.json()) as {
      gateways?: Record<string, Record<string, unknown>>;
    };
    const entries = Object.values(body.gateways ?? {});
    const gateways: RegistryGateway[] = [];
    for (const entry of entries) {
      const { url, wallet, observerAddress, operatorStake, status } = entry;
      if (
        typeof url !== 'string' ||
        typeof wallet !== 'string' ||
        typeof observerAddress !== 'string'
      ) {
        continue;
      }
      let fqdn: string;
      try {
        fqdn = new URL(url).hostname;
      } catch {
        continue;
      }
      gateways.push({
        wallet,
        observerAddress,
        url: url.replace(/\/+$/, ''),
        fqdn,
        status: status === 'leaving' ? 'leaving' : 'joined',
        operatorStake: typeof operatorStake === 'number' ? operatorStake : 0,
      });
    }
    if (entries.length > 0 && gateways.length === 0 && !this.warnedOldCore) {
      // Peers without registry fields: a gateway that predates them.
      this.warnedOldCore = true;
      this.log.warn(
        'The gateway’s /ar-io/peers carries no registry fields; upgrade the gateway to subscribe or discover',
        { coreUrl: this.coreUrl },
      );
    }
    return gateways;
  }
}
