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

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: 'DnsResolver' });
  }

  /**
   * Resolve a URL's hostname to IP addresses.
   *
   * DNS lookup runs for both protocols, but the returned `resolvedUrl`
   * differs by protocol:
   * - HTTPS: `resolvedUrl === originalUrl`. The hostname is preserved so
   *   TLS SNI/Host stay valid (otherwise `ERR_TLS_CERT_ALTNAME_INVALID`).
   *   DNS is used only for the in-memory cache and change-detection logs.
   * - HTTP: the first resolved IP is substituted into `resolvedUrl`, so
   *   `resolvedUrl !== originalUrl`.
   *
   * Callers must not assume `resolvedUrl !== originalUrl`.
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
      log.silly('Resolving hostname to IP addresses');
      let ips: string[] = [];

      try {
        // Try IPv4 first
        const ipv4Addresses = await dns.resolve4(hostname);
        ips = ipv4Addresses;
        log.silly('Resolved IPv4 addresses', { hostname, ips });
      } catch (error) {
        // If IPv4 fails, try IPv6
        log.silly('IPv4 resolution failed, trying IPv6', { hostname });
        try {
          const ipv6Addresses = await dns.resolve6(hostname);
          ips = ipv6Addresses;
          log.silly('Resolved IPv6 addresses', { hostname, ips });
        } catch (ipv6Error) {
          throw new Error(`Failed to resolve hostname: ${hostname}`);
        }
      }

      if (ips.length === 0) {
        throw new Error(`No IP addresses found for hostname: ${hostname}`);
      }

      // For HTTPS URLs, do NOT substitute the hostname with an IP. fetch()
      // would otherwise set TLS SNI and Host to the IP, which mismatches the
      // server certificate (cert is for the hostname, not the IP) and trips
      // ERR_TLS_CERT_ALTNAME_INVALID. The DNS resolution still runs so
      // change-detection logging and the IP cache stay accurate; we just
      // return the original URL and let Node's native DNS resolve it at
      // request time with the correct hostname for SNI.
      let resolvedUrl: string;
      let selectedIp: string | undefined;
      if (url.protocol === 'https:') {
        resolvedUrl = urlString;
        log.debug('Preserving hostname for HTTPS URL to maintain SNI', {
          hostname,
          resolvedIps: ips.length,
        });
      } else {
        // Use the first IP address
        selectedIp = ips[0];
        // IPv6 addresses need brackets when setting hostname
        if (selectedIp.includes(':')) {
          url.hostname = `[${selectedIp}]`;
        } else {
          url.hostname = selectedIp;
        }
        resolvedUrl = url.toString();
      }

      const result: ResolvedUrl = {
        hostname,
        originalUrl: urlString,
        resolvedUrl,
        ips,
        lastResolved: Date.now(),
      };

      this.resolvedUrls.set(hostname, result);
      log.debug('Successfully resolved URL', {
        hostname,
        ...(selectedIp !== undefined ? { selectedIp } : {}),
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

    // Take a snapshot before updating for change detection
    const previousResults = new Map(this.resolvedUrls);

    const results = await Promise.all(urls.map((url) => this.resolveUrl(url)));

    // Check for changes and log them
    for (const result of results) {
      const previous = previousResults.get(result.hostname);
      if (previous && previous.resolvedUrl !== result.resolvedUrl) {
        log.info('DNS resolution changed for host', {
          hostname: result.hostname,
          oldIp: previous.ips[0],
          newIp: result.ips[0],
        });
      }
    }

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
