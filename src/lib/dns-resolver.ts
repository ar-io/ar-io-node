/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { URL } from 'node:url';
import * as winston from 'winston';

export interface ResolvedUrl {
  hostname: string;
  originalUrl: string;
  resolvedUrl: string;
  ips: string[];
  lastResolved: number;
  resolutionError?: string;
}

export class DnsResolver {
  private log: winston.Logger;
  private resolvedUrls: Map<string, ResolvedUrl> = new Map();
  private resolutionTimer?: NodeJS.Timeout;
  private isResolving = false;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: 'DnsResolver' });
  }

  /**
   * Resolve a single URL to its IP addresses
   */
  async resolveUrl(urlString: string): Promise<ResolvedUrl> {
    const log = this.log.child({ method: 'resolveUrl', url: urlString });

    // Parse URL first - if this fails, we can't proceed
    let url: URL;
    let hostname: string;
    try {
      url = new URL(urlString);
      hostname = url.hostname;
    } catch (error: any) {
      log.warn('Invalid URL provided for resolution', {
        url: urlString,
        error: error.message,
      });
      // Return unresolved result for invalid URLs (don't cache)
      return {
        hostname: urlString,
        originalUrl: urlString,
        resolvedUrl: urlString,
        ips: [],
        lastResolved: Date.now(),
        resolutionError: `Invalid URL: ${error.message}`,
      };
    }

    try {
      // Skip resolution for IP addresses
      if (this.isIpAddress(hostname)) {
        log.debug('URL already uses IP address, skipping resolution');
        const result: ResolvedUrl = {
          hostname,
          originalUrl: urlString,
          resolvedUrl: urlString,
          ips: [hostname],
          lastResolved: Date.now(),
        };
        this.resolvedUrls.set(hostname, result);
        return result;
      }

      // Resolve hostname to IP addresses
      log.debug('Resolving hostname to IP addresses');
      let ips: string[] = [];

      try {
        // Try IPv4 first
        const ipv4Addresses = await dns.resolve4(hostname);
        ips = ipv4Addresses;
        log.debug('Resolved IPv4 addresses', { hostname, ips });
      } catch (error) {
        // If IPv4 fails, try IPv6
        log.debug('IPv4 resolution failed, trying IPv6', { hostname });
        try {
          const ipv6Addresses = await dns.resolve6(hostname);
          ips = ipv6Addresses;
          log.debug('Resolved IPv6 addresses', { hostname, ips });
        } catch (ipv6Error) {
          throw new Error(`Failed to resolve hostname: ${hostname}`);
        }
      }

      if (ips.length === 0) {
        throw new Error(`No IP addresses found for hostname: ${hostname}`);
      }

      // Use the first IP address
      const selectedIp = ips[0];
      // IPv6 addresses need brackets when setting hostname
      if (selectedIp.includes(':')) {
        url.hostname = `[${selectedIp}]`;
      } else {
        url.hostname = selectedIp;
      }
      const resolvedUrl = url.toString();

      const result: ResolvedUrl = {
        hostname,
        originalUrl: urlString,
        resolvedUrl,
        ips,
        lastResolved: Date.now(),
      };

      this.resolvedUrls.set(hostname, result);
      log.info('Successfully resolved URL', {
        hostname,
        selectedIp,
        totalIps: ips.length,
      });

      return result;
    } catch (error: any) {
      log.warn('Failed to resolve URL, using original', {
        url: urlString,
        error: error.message,
      });

      // Return original URL on failure
      const result: ResolvedUrl = {
        hostname,
        originalUrl: urlString,
        resolvedUrl: urlString,
        ips: [],
        lastResolved: Date.now(),
        resolutionError: error.message,
      };

      this.resolvedUrls.set(hostname, result);
      return result;
    }
  }

  /**
   * Resolve multiple URLs in parallel
   */
  async resolveUrls(urls: string[]): Promise<ResolvedUrl[]> {
    const log = this.log.child({ method: 'resolveUrls', count: urls.length });
    log.info('Resolving multiple URLs');

    const results = await Promise.all(urls.map((url) => this.resolveUrl(url)));

    const successCount = results.filter(
      (r) => r.resolutionError === undefined,
    ).length;
    log.info('Batch resolution complete', {
      total: urls.length,
      succeeded: successCount,
      failed: urls.length - successCount,
    });

    return results;
  }

  /**
   * Get the resolved URL for a hostname
   */
  getResolvedUrl(hostname: string): ResolvedUrl | undefined {
    return this.resolvedUrls.get(hostname);
  }

  /**
   * Get all resolved URLs
   */
  getAllResolvedUrls(): ResolvedUrl[] {
    return Array.from(this.resolvedUrls.values());
  }

  /**
   * Start periodic DNS re-resolution
   */
  startPeriodicResolution(urls: string[], intervalMs: number): void {
    const log = this.log.child({
      method: 'startPeriodicResolution',
      intervalMs,
      urlCount: urls.length,
    });

    if (this.resolutionTimer) {
      log.debug('Stopping existing resolution timer');
      this.stopPeriodicResolution();
    }

    log.info('Starting periodic DNS resolution', {
      intervalSeconds: intervalMs / 1000,
    });

    // Set up periodic resolution
    this.resolutionTimer = setInterval(async () => {
      // Prevent overlapping resolutions
      if (this.isResolving) {
        log.debug('Skipping periodic resolution - already in progress');
        return;
      }

      this.isResolving = true;
      log.debug('Running periodic DNS re-resolution');

      try {
        // Take a snapshot before updating
        const previousResults = new Map(this.resolvedUrls);
        const newResults = await this.resolveUrls(urls);

        // Check for changes against the snapshot
        for (const result of newResults) {
          const previous = previousResults.get(result.hostname);
          if (previous && previous.resolvedUrl !== result.resolvedUrl) {
            log.info('DNS resolution changed for host', {
              hostname: result.hostname,
              oldIp: previous.ips[0],
              newIp: result.ips[0],
            });
          }
        }
      } catch (error: any) {
        log.error('Error during periodic DNS resolution', {
          error: error.message,
          stack: error.stack,
        });
      } finally {
        this.isResolving = false;
      }
    }, intervalMs);

    // Don't block the event loop
    this.resolutionTimer.unref();
  }

  /**
   * Stop periodic DNS resolution
   */
  stopPeriodicResolution(): void {
    if (this.resolutionTimer) {
      clearInterval(this.resolutionTimer);
      this.resolutionTimer = undefined;
      this.log.info('Stopped periodic DNS resolution');
    }
  }

  /**
   * Check if a string is an IP address
   */
  private isIpAddress(hostname: string): boolean {
    // Remove brackets if present for IPv6
    const unbracketed = hostname.replace(/^\[|\]$/g, '');
    return isIP(unbracketed) !== 0;
  }

  /**
   * Get resolved URLs for use in ArweaveCompositeClient
   */
  getResolvedUrlStrings(urls: string[]): string[] {
    return urls.map((url) => {
      try {
        const urlObj = new URL(url);
        const resolved = this.resolvedUrls.get(urlObj.hostname);

        if (resolved !== undefined && resolved.resolutionError === undefined) {
          // Reconstruct the URL with the resolved IP but keep the original path
          const resolvedUrlObj = new URL(resolved.resolvedUrl);
          const newUrl = new URL(url);
          newUrl.hostname = resolvedUrlObj.hostname;
          return newUrl.toString();
        }

        return url;
      } catch {
        return url;
      }
    });
  }
}
