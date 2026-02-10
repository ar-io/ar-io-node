/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import * as winston from 'winston';

import * as metrics from '../metrics.js';
import { ChainIndex } from '../types.js';
import wait from '../lib/wait.js';

const HEALTH_CHECK_CONCURRENCY = 20;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

interface PeerInfo {
  ip: string;
  height: number;
  blocks: number;
}

interface EdsEndpoint {
  address: string;
  port: number;
}

/** Periodically resolves DNS records, health-checks discovered Arweave peers, and writes Envoy EDS files. */
export class EnvoyEndpointHealthWorker {
  private log: winston.Logger;
  private chainIndex: ChainIndex;
  private dnsRecords: string[];
  private port: number;
  private useTls: boolean;
  private maxHeightLag: number;
  private maxHeightLead: number;
  private minConsensusCount: number;
  private fullSyncThreshold: number;
  private intervalMs: number;
  private edsDirectory: string;

  private shouldRun = true;

  constructor({
    log,
    chainIndex,
    dnsRecords,
    port,
    useTls,
    maxHeightLag,
    maxHeightLead,
    minConsensusCount,
    fullSyncThreshold,
    intervalMs,
    edsDirectory,
  }: {
    log: winston.Logger;
    chainIndex: ChainIndex;
    dnsRecords: string[];
    port: number;
    useTls: boolean;
    maxHeightLag: number;
    maxHeightLead: number;
    minConsensusCount: number;
    fullSyncThreshold: number;
    intervalMs: number;
    edsDirectory: string;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chainIndex = chainIndex;
    this.dnsRecords = dnsRecords;
    this.port = port;
    this.useTls = useTls;
    this.maxHeightLag = maxHeightLag;
    this.maxHeightLead = maxHeightLead;
    this.minConsensusCount = minConsensusCount;
    this.fullSyncThreshold = fullSyncThreshold;
    this.intervalMs = intervalMs;
    this.edsDirectory = edsDirectory;
  }

  async start(): Promise<void> {
    this.log.info('Starting Envoy EDS endpoint health worker', {
      dnsRecords: this.dnsRecords,
      port: this.port,
      intervalMs: this.intervalMs,
    });

    while (this.shouldRun) {
      try {
        await this.runCycle();
      } catch (error: any) {
        this.log.error('Error in health check cycle', {
          error: error?.message,
          stack: error?.stack,
        });
      }
      await wait(this.intervalMs);
    }
  }

  async stop(): Promise<void> {
    this.log.info('Stopping Envoy EDS endpoint health worker');
    this.shouldRun = false;
  }

  async runCycle(): Promise<void> {
    // 1. Resolve DNS
    const ips = await this.resolveAllDns();
    metrics.envoyEdsPeersDiscovered.set(ips.length);

    if (ips.length === 0) {
      this.log.warn('No IPs resolved from DNS, keeping previous endpoints');
      metrics.envoyEdsHealthCheckCyclesTotal.inc();
      return;
    }

    // 2. Health-check peers
    const peers = await this.healthCheckPeers(ips);
    metrics.envoyEdsPeersHealthy.set(peers.length);

    if (peers.length === 0) {
      this.log.warn(
        'No peers responded to health checks, keeping previous endpoints',
      );
      metrics.envoyEdsHealthCheckCyclesTotal.inc();
      return;
    }

    // 3. Compute reference height
    const referenceHeight = await this.computeReferenceHeight(peers);
    metrics.envoyEdsReferenceHeight.set(referenceHeight);

    // 4. Classify peers
    const { full, partial, excluded } = this.classifyPeers(
      peers,
      referenceHeight,
    );
    metrics.envoyEdsPeersFull.set(full.length);
    metrics.envoyEdsPeersPartial.set(partial.length);
    metrics.envoyEdsPeersExcluded.set(excluded.length);

    this.log.info('Peer classification complete', {
      discovered: ips.length,
      healthy: peers.length,
      full: full.length,
      partial: partial.length,
      excluded: excluded.length,
      referenceHeight,
    });

    // 5. Write EDS files
    const fullEndpoints = full.map((p) => ({
      address: p.ip,
      port: this.port,
    }));
    const partialEndpoints = partial.map((p) => ({
      address: p.ip,
      port: this.port,
    }));

    if (fullEndpoints.length === 0 && partialEndpoints.length === 0) {
      this.log.warn('All peers excluded, keeping previous EDS files');
    } else {
      await this.writeEdsFiles(fullEndpoints, partialEndpoints);
    }

    metrics.envoyEdsHealthCheckCyclesTotal.inc();
  }

  async resolveAllDns(): Promise<string[]> {
    const allIps = new Set<string>();
    let allFailed = true;

    for (const hostname of this.dnsRecords) {
      try {
        const ips = await dns.promises.resolve4(hostname);
        for (const ip of ips) {
          allIps.add(ip);
        }
        allFailed = false;
      } catch (error: any) {
        this.log.warn('DNS resolution failed for hostname', {
          hostname,
          error: error?.message,
        });
      }
    }

    if (allFailed && this.dnsRecords.length > 0) {
      this.log.warn('All DNS resolutions failed, keeping previous endpoints');
      return [];
    }

    return Array.from(allIps);
  }

  async healthCheckPeers(ips: string[]): Promise<PeerInfo[]> {
    const limit = pLimit(HEALTH_CHECK_CONCURRENCY);
    const results = await Promise.all(
      ips.map((ip) =>
        limit(async (): Promise<PeerInfo | null> => {
          try {
            const protocol = this.useTls ? 'https' : 'http';
            const url = `${protocol}://${ip}:${this.port}/info`;
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(),
              HEALTH_CHECK_TIMEOUT_MS,
            );

            try {
              const response = await fetch(url, {
                signal: controller.signal,
              });

              if (!response.ok) {
                metrics.envoyEdsHealthCheckErrorsTotal.inc();
                return null;
              }

              const data = (await response.json()) as {
                height?: number;
                blocks?: number;
              };
              if (
                typeof data.height !== 'number' ||
                typeof data.blocks !== 'number'
              ) {
                this.log.warn('Invalid /info response from peer', { ip });
                metrics.envoyEdsHealthCheckErrorsTotal.inc();
                return null;
              }

              return { ip, height: data.height, blocks: data.blocks };
            } finally {
              clearTimeout(timeout);
            }
          } catch (error: any) {
            this.log.debug('Health check failed for peer', {
              ip,
              error: error?.message,
            });
            metrics.envoyEdsHealthCheckErrorsTotal.inc();
            return null;
          }
        }),
      ),
    );

    return results.filter((r): r is PeerInfo => r !== null);
  }

  async computeReferenceHeight(peers: PeerInfo[]): Promise<number> {
    const heights = peers.map((p) => p.height).sort((a, b) => b - a);

    // Find consensus height: first candidate where enough nodes are nearby
    let consensusHeight: number | undefined;
    for (const candidateHeight of heights) {
      const nodesNearCandidate = heights.filter(
        (h) => Math.abs(h - candidateHeight) <= this.maxHeightLag,
      ).length;
      if (nodesNearCandidate >= this.minConsensusCount) {
        consensusHeight = candidateHeight;
        break;
      }
    }

    // Fallback: use max height if no consensus found
    if (consensusHeight === undefined) {
      consensusHeight = heights[0];
    }

    // Use the max of consensus height and local chain height
    const localHeight = await this.chainIndex.getMaxHeight();
    return Math.max(consensusHeight, localHeight);
  }

  classifyPeers(
    peers: PeerInfo[],
    referenceHeight: number,
  ): { full: PeerInfo[]; partial: PeerInfo[]; excluded: PeerInfo[] } {
    const full: PeerInfo[] = [];
    const partial: PeerInfo[] = [];
    const excluded: PeerInfo[] = [];

    for (const peer of peers) {
      if (peer.height > referenceHeight + this.maxHeightLead) {
        // Forward outlier
        excluded.push(peer);
      } else if (peer.height < referenceHeight - this.maxHeightLag) {
        // Behind
        excluded.push(peer);
      } else if (peer.blocks >= peer.height + 1 - this.fullSyncThreshold) {
        full.push(peer);
      } else {
        partial.push(peer);
      }
    }

    return { full, partial, excluded };
  }

  async writeEdsFiles(
    fullEndpoints: EdsEndpoint[],
    partialEndpoints: EdsEndpoint[],
  ): Promise<void> {
    await fs.promises.mkdir(this.edsDirectory, { recursive: true });

    await this.writeEdsFile(
      path.join(this.edsDirectory, 'arweave_full_nodes.json'),
      'arweave_full_nodes',
      fullEndpoints,
    );

    await this.writeEdsFile(
      path.join(this.edsDirectory, 'arweave_partial_nodes.json'),
      'arweave_partial_nodes',
      partialEndpoints,
    );
  }

  private async writeEdsFile(
    filePath: string,
    clusterName: string,
    endpoints: EdsEndpoint[],
  ): Promise<void> {
    const edsJson = {
      version_info: new Date().toISOString(),
      resources: [
        {
          '@type':
            'type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment',
          cluster_name: clusterName,
          endpoints: [
            {
              lb_endpoints: endpoints.map((ep) => ({
                endpoint: {
                  address: {
                    socket_address: {
                      address: ep.address,
                      port_value: ep.port,
                    },
                  },
                },
                health_status: 'HEALTHY',
              })),
            },
          ],
        },
      ],
    };

    const content = JSON.stringify(edsJson, null, 2);

    // Atomic write: write to temp file in same directory then rename
    const tmpFile = path.join(
      this.edsDirectory,
      `.eds-${clusterName}-${Date.now()}.tmp`,
    );
    await fs.promises.writeFile(tmpFile, content, 'utf-8');
    await fs.promises.rename(tmpFile, filePath);

    metrics.envoyEdsFileWritesTotal.inc({ cluster: clusterName });

    this.log.debug('Wrote EDS file', {
      filePath,
      clusterName,
      endpointCount: endpoints.length,
    });
  }
}
