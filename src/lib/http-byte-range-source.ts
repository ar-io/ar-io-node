/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { default as axios, AxiosInstance } from 'axios';
import { ByteRangeSource } from './byte-range-source.js';
import { AgentPair, createAgentPair } from './http-agent.js';
import { buildRangeHeader } from './http-utils.js';
import { Semaphore } from './semaphore.js';

/**
 * ByteRangeSource implementation for HTTP endpoints.
 *
 * Fetches byte ranges using HTTP Range requests. The server must support
 * RFC 7233 Range requests and return 206 Partial Content responses.
 *
 * Suitable for accessing CDB64 files from:
 * - S3-compatible object storage with pre-signed URLs
 * - CDN endpoints
 * - Dedicated index servers
 */
export class HttpByteRangeSource implements ByteRangeSource {
  private url: string;
  private httpClient: AxiosInstance;
  private opened = true;
  private semaphore: Semaphore | undefined;
  private semaphoreTimeoutMs: number | undefined;
  /**
   * Agents this instance created and therefore owns. Undefined when an axios
   * instance was injected — those agents belong to the caller and destroying
   * them here would tear down a shared pool.
   */
  private ownedAgents: AgentPair | undefined;

  constructor({
    url,
    timeout = 30000,
    semaphore,
    semaphoreTimeoutMs,
    httpClient,
  }: {
    /** URL to fetch byte ranges from */
    url: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Optional shared semaphore for limiting concurrent HTTP requests */
    semaphore?: Semaphore;
    /** Timeout for acquiring the semaphore in milliseconds */
    semaphoreTimeoutMs?: number;
    /** Optional pre-configured axios instance */
    httpClient?: AxiosInstance;
  }) {
    this.url = url;
    this.semaphore = semaphore;
    this.semaphoreTimeoutMs = semaphoreTimeoutMs;
    if (httpClient === undefined) {
      this.ownedAgents = createAgentPair({ client: 'HttpByteRangeSource' });
    }
    this.httpClient =
      httpClient ??
      axios.create({
        timeout,
        ...this.ownedAgents,
        // Disable automatic response transformation
        transformResponse: [],
        // Don't follow redirects automatically for range requests
        maxRedirects: 0,
        // Only accept 2xx status codes (we require 206 Partial Content)
        validateStatus: (status) => status >= 200 && status < 300,
      });
  }

  async read(offset: number, size: number): Promise<Buffer> {
    if (this.semaphore) {
      await this.semaphore.acquire(this.semaphoreTimeoutMs);
    }
    try {
      const response = await this.httpClient.get(this.url, {
        headers: {
          Range: buildRangeHeader(offset, offset + size - 1),
        },
        responseType: 'arraybuffer',
        // PE-9081: bound axios's pre-buffered allocation. Without these,
        // axios will fully buffer whatever the upstream sends before any
        // post-hoc length check fires — heap pressure is realized before
        // we get to throw. Setting these to `size` makes axios reject the
        // body early, before the oversized allocation completes.
        maxContentLength: size,
        maxBodyLength: size,
      });

      // Verify we got a partial content response
      if (response.status !== 206) {
        throw new Error(
          `HTTP byte range request failed: expected 206 Partial Content, got ${response.status}`,
        );
      }

      const buffer = Buffer.from(response.data);

      if (buffer.length !== size) {
        throw new Error(
          `HTTP byte range short read: expected ${size} bytes, got ${buffer.length}`,
        );
      }

      return buffer;
    } finally {
      if (this.semaphore) {
        this.semaphore.release();
      }
    }
  }

  async close(): Promise<void> {
    this.opened = false;
    // Keep-alive agents hold idle sockets open until their idle timeout. These
    // sources are created per remote CDB source, so without an explicit
    // teardown a discarded source leaves its pool lingering.
    this.ownedAgents?.httpAgent.destroy();
    this.ownedAgents?.httpsAgent.destroy();
    this.ownedAgents = undefined;
  }

  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Returns the URL this source reads from.
   */
  getUrl(): string {
    return this.url;
  }
}
