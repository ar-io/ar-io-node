/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { AoARIORead } from '@ar.io/sdk';
import CircuitBreaker from 'opossum';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

const DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS = 3_600_000; // 1 hour

export interface ArIOPeer {
  address: string;
  url: string;
}

export class ArIOPeerManager {
  private log: winston.Logger;
  private nodeWallet: string | undefined;
  private updatePeersRefreshIntervalMs: number;
  private networkProcess: AoARIORead;
  private peers: Record<string, string> = {};
  private intervalId?: NodeJS.Timeout;

  // circuit breaker for getGateways
  private arioGatewaysCircuitBreaker: CircuitBreaker<
    Parameters<AoARIORead['getGateways']>,
    Awaited<ReturnType<AoARIORead['getGateways']>>
  >;

  constructor({
    log,
    networkProcess,
    nodeWallet,
    updatePeersRefreshIntervalMs = DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS,
    circuitBreakerOptions = {
      timeout: config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      rollingCountTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS,
      resetTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    networkProcess: AoARIORead;
    nodeWallet?: string;
    updatePeersRefreshIntervalMs?: number;
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.nodeWallet = nodeWallet;
    this.updatePeersRefreshIntervalMs = updatePeersRefreshIntervalMs;
    this.networkProcess = networkProcess;

    this.arioGatewaysCircuitBreaker = new CircuitBreaker(
      this.networkProcess.getGateways.bind(this.networkProcess),
      {
        ...circuitBreakerOptions,
        capacity: 1, // only allow one request at a time
        name: 'getGateways',
      },
    );

    this.updatePeerList();
    this.intervalId = setInterval(
      this.updatePeerList.bind(this),
      this.updatePeersRefreshIntervalMs,
    );

    // TODO: Remove deprecated circuit breaker metrics setup
    metrics.circuitBreakerMetrics.add(this.arioGatewaysCircuitBreaker);
    metrics.setUpCircuitBreakerListenerMetrics(
      'ar-io-peer-manager',
      this.arioGatewaysCircuitBreaker,
      this.log,
    );
  }

  /**
   * Get the current list of peers
   * @returns Record of peer addresses to URLs
   */
  getPeers(): Record<string, string> {
    return { ...this.peers };
  }

  /**
   * Get a list of peer URLs
   * @returns Array of peer URLs
   */
  getPeerUrls(): string[] {
    return Object.values(this.peers);
  }

  /**
   * Stop updating the peer list
   */
  stopUpdatingPeers(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Force an immediate update of the peer list
   */
  async refreshPeers(): Promise<void> {
    await this.updatePeerList();
  }

  private async updatePeerList(): Promise<void> {
    const log = this.log.child({ method: 'updatePeerList' });
    log.info('Fetching AR.IO network peer list');

    const peers: Record<string, string> = {};
    let cursor: string | undefined;
    do {
      try {
        const { nextCursor, items } =
          await this.arioGatewaysCircuitBreaker.fire({
            cursor,
            limit: 1000,
          });

        for (const gateway of items) {
          // skip our own node wallet
          if (
            this.nodeWallet !== undefined &&
            this.nodeWallet === gateway.gatewayAddress
          ) {
            continue;
          }

          peers[gateway.gatewayAddress] =
            `${gateway.settings.protocol}://${gateway.settings.fqdn}`;
        }
        cursor = nextCursor;
      } catch (error: any) {
        log.error(
          'Failed to fetch gateways from ARIO. Returning current peer list.',
          {
            message: error.message,
            stack: error.stack,
          },
        );
        break;
      }
    } while (cursor !== undefined);

    log.info('Successfully fetched AR.IO network peer list', {
      count: Object.keys(peers).length,
    });
    this.peers = peers;
  }
}
