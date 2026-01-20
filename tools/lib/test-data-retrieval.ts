/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from 'axios';
import fs from 'node:fs';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import pLimit from 'p-limit';

import { Cdb64Reader } from '../../src/lib/cdb64.js';
import {
  decodeCdb64Value,
  getPath,
  getRootTxId,
} from '../../src/lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../../src/lib/encoding.js';
import {
  ID_PATTERN,
  getFileSize,
  getRandomIdFromFile,
  formatDuration,
} from './csv-utils.js';

interface TestConfig {
  csvPath: string;
  gateway: string;
  reference: string | undefined;
  cdb64Path: string | undefined;
  failedIdsPath: string | undefined;
  mode: 'random' | 'sequential';
  count: number | undefined;
  concurrency: number;
  timeout: number;
  delay: number;
  skipHeader: boolean;
  jsonOutput: boolean;
  verbose: boolean;
  continuous: boolean;
  outputFile: string | undefined;
}

interface RequestResult {
  id: string;
  success: boolean;
  statusCode: number;
  responseTime: number;
  contentLength: number | undefined;
  contentType: string | undefined;
  cacheStatus: string | undefined;
  error?: string;
  // Reference comparison fields (only present when --reference is used)
  referenceStatusCode?: number;
  referenceContentLength?: number | undefined;
  referenceContentType?: string | undefined;
  referenceResponseTime?: number;
  referenceError?: string;
  // Comparison results
  statusMatch?: boolean;
  contentLengthMatch?: boolean;
  contentTypeMatch?: boolean;
  // GraphQL verification (for 404 mismatches with --cdb64)
  graphqlVerification?: GraphQLVerificationResult;
}

interface Statistics {
  totalRequests: number;
  successes: number;
  failures: number;
  statusCodeCounts: Map<number, number>;
  cacheHits: number;
  cacheMisses: number;
  cacheUnknown: number;
  errorCounts: Map<string, number>;
  responseTimes: number[];
  totalBytes: number;
  startTime: number;
  endTime: number;
  // Reference comparison stats
  referenceComparisons: number;
  totalMismatches: number;
  statusMismatches: number;
  contentLengthMismatches: number;
  contentTypeMismatches: number;
  referenceErrors: number;
  // GraphQL verification stats
  graphqlVerification?: GraphQLVerificationStats;
  // CDB64 verification stats (for every tested ID)
  cdb64Verification?: Cdb64VerificationStats;
}

interface Cdb64LookupResult {
  /** Bundle path [rootTxId, ...intermediates, parentId] as base64url strings */
  path: string[];
  /** Root transaction ID (path[0]) */
  rootTxId: string;
  /** Immediate parent bundle ID (path[path.length - 1]) */
  parentId: string;
}

interface BundleVerificationResult {
  bundleId: string;
  bundleExists: boolean;
  expectedParent?: string;
  actualParent?: string;
  parentMatch: boolean;
}

interface GraphQLVerificationResult {
  dataItemId: string;
  dataItemExists: boolean;
  expectedParent?: string;
  actualParent?: string;
  parentMatch: boolean;
  pathVerification?: BundleVerificationResult[];
  diagnosis:
    | 'not-in-cdb64'
    | 'data-item-missing'
    | 'parent-mismatch'
    | 'path-broken'
    | 'root-missing'
    | 'verified-ok'
    | 'error';
  errorMessage?: string;
}

interface GraphQLVerificationStats {
  totalEligible: number;
  notInCdb64: number;
  dataItemMissing: number;
  parentMismatch: number;
  pathBroken: number;
  rootMissing: number;
  verifiedOk: number;
  errors: number;
}

interface Cdb64VerificationStats {
  totalChecked: number;
  foundInCdb64: number;
  notFoundInCdb64: number;
  lookupErrors: number;
}

class DataRetrievalTester {
  private config: TestConfig;
  private stats: Statistics;
  private running: boolean = true;
  private processedCount: number = 0;
  private totalToProcess: number = 0;
  private fileSize: number = 0;
  private resultsDisplayed: boolean = false;
  private cdb64Reader: Cdb64Reader | null = null;
  private failedIds: string[] = [];

  constructor(config: TestConfig) {
    this.config = config;
    this.stats = {
      totalRequests: 0,
      successes: 0,
      failures: 0,
      statusCodeCounts: new Map(),
      cacheHits: 0,
      cacheMisses: 0,
      cacheUnknown: 0,
      errorCounts: new Map(),
      responseTimes: [],
      totalBytes: 0,
      startTime: 0,
      endTime: 0,
      // Reference comparison stats
      referenceComparisons: 0,
      totalMismatches: 0,
      statusMismatches: 0,
      contentLengthMismatches: 0,
      contentTypeMismatches: 0,
      referenceErrors: 0,
    };
  }

  /**
   * Initialize resources (e.g., open CDB64 reader).
   */
  async initialize(): Promise<void> {
    if (this.config.cdb64Path) {
      this.cdb64Reader = new Cdb64Reader(this.config.cdb64Path);
      await this.cdb64Reader.open();
      // Initialize CDB64 verification stats (for every tested ID)
      this.stats.cdb64Verification = {
        totalChecked: 0,
        foundInCdb64: 0,
        notFoundInCdb64: 0,
        lookupErrors: 0,
      };
      // Initialize GraphQL verification stats (for 404 mismatches with --reference)
      this.stats.graphqlVerification = {
        totalEligible: 0,
        notInCdb64: 0,
        dataItemMissing: 0,
        parentMismatch: 0,
        pathBroken: 0,
        rootMissing: 0,
        verifiedOk: 0,
        errors: 0,
      };
    }
  }

  /**
   * Cleanup resources (e.g., close CDB64 reader).
   */
  async cleanup(): Promise<void> {
    if (this.cdb64Reader) {
      await this.cdb64Reader.close();
      this.cdb64Reader = null;
    }
  }

  /**
   * Look up an ID in the CDB64 file and return the bundle path.
   */
  private async lookupCdb64(id: string): Promise<Cdb64LookupResult | undefined> {
    if (!this.cdb64Reader) return undefined;

    try {
      // Convert base64url ID to buffer for lookup
      const keyBuffer = fromB64Url(id);
      const valueBuffer = await this.cdb64Reader.get(keyBuffer);

      if (!valueBuffer) {
        return undefined;
      }

      // Decode the value to get the path
      const decoded = decodeCdb64Value(valueBuffer);
      const pathBuffers = getPath(decoded);

      if (!pathBuffers || pathBuffers.length === 0) {
        // Legacy format without path - can't verify
        return undefined;
      }

      // Convert path buffers to base64url strings
      const path = pathBuffers.map((buf) => toB64Url(buf));

      return {
        path,
        rootTxId: path[0],
        parentId: path[path.length - 1],
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Query the reference gateway's GraphQL endpoint for transaction info.
   */
  private async queryReferenceGraphQL(
    id: string,
  ): Promise<{ id: string; bundledIn?: { id: string } } | null> {
    if (!this.config.reference) return null;

    const query = `
      query getTransaction($id: ID!) {
        transaction(id: $id) {
          id
          bundledIn { id }
        }
      }
    `;

    try {
      const response = await axios.post(
        `${this.config.reference}/graphql`,
        { query, variables: { id } },
        {
          timeout: this.config.timeout,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'ar-io-node-data-retrieval-tester/1.0',
          },
        },
      );

      const data = response.data?.data?.transaction;
      if (!data) return null;

      return {
        id: data.id,
        bundledIn: data.bundledIn ? { id: data.bundledIn.id } : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify a 404 mismatch using GraphQL against the CDB64 path.
   */
  private async verifyWithGraphQL(
    id: string,
    cdb64Lookup: Cdb64LookupResult,
  ): Promise<GraphQLVerificationResult> {
    try {
      // Query the data item from reference GraphQL
      const dataItemInfo = await this.queryReferenceGraphQL(id);

      // Data item not indexed in reference gateway
      if (!dataItemInfo) {
        return {
          dataItemId: id,
          dataItemExists: false,
          expectedParent: cdb64Lookup.parentId,
          parentMatch: false,
          diagnosis: 'data-item-missing',
        };
      }

      // Data item exists - check parent
      const actualParent = dataItemInfo.bundledIn?.id;
      const expectedParent = cdb64Lookup.parentId;
      const parentMatch = actualParent === expectedParent;

      if (parentMatch) {
        // Parent matches - this is a timing issue or other transient problem
        return {
          dataItemId: id,
          dataItemExists: true,
          expectedParent,
          actualParent,
          parentMatch: true,
          diagnosis: 'verified-ok',
        };
      }

      // Parent mismatch - verify the full path
      const pathVerification: BundleVerificationResult[] = [];

      // Check each bundle in the path (except the root which is a regular TX)
      for (let i = 1; i < cdb64Lookup.path.length; i++) {
        const bundleId = cdb64Lookup.path[i];
        const expectedBundleParent =
          i > 0 ? cdb64Lookup.path[i - 1] : undefined;

        const bundleInfo = await this.queryReferenceGraphQL(bundleId);
        const actualBundleParent = bundleInfo?.bundledIn?.id;

        pathVerification.push({
          bundleId,
          bundleExists: bundleInfo !== null,
          expectedParent: expectedBundleParent,
          actualParent: actualBundleParent,
          parentMatch:
            !expectedBundleParent || actualBundleParent === expectedBundleParent,
        });

        // Stop if we find a broken link
        if (!bundleInfo) {
          return {
            dataItemId: id,
            dataItemExists: true,
            expectedParent,
            actualParent,
            parentMatch: false,
            pathVerification,
            diagnosis: 'path-broken',
          };
        }
      }

      // Check if root TX exists
      const rootInfo = await this.queryReferenceGraphQL(cdb64Lookup.rootTxId);
      if (!rootInfo) {
        return {
          dataItemId: id,
          dataItemExists: true,
          expectedParent,
          actualParent,
          parentMatch: false,
          pathVerification,
          diagnosis: 'root-missing',
        };
      }

      // Full path verified but parent still doesn't match
      return {
        dataItemId: id,
        dataItemExists: true,
        expectedParent,
        actualParent,
        parentMatch: false,
        pathVerification,
        diagnosis: 'parent-mismatch',
      };
    } catch (error: any) {
      return {
        dataItemId: id,
        dataItemExists: false,
        parentMatch: false,
        diagnosis: 'error',
        errorMessage: error.message,
      };
    }
  }

  /**
   * Parse a CSV line and extract the ID from the first column.
   */
  private parseLineForId(line: string): string | null {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) return null;

    // Handle CSV: take first column (split by comma)
    const firstColumn = trimmedLine.split(',')[0].trim();
    // Remove quotes if present
    const id = firstColumn.replace(/^["']|["']$/g, '');

    if (ID_PATTERN.test(id)) {
      return id;
    }
    return null;
  }

  /**
   * Count total lines in file (for progress reporting).
   */
  private async countLines(): Promise<number> {
    return new Promise((resolve, reject) => {
      let lineCount = 0;
      const stream = fs.createReadStream(this.config.csvPath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', () => {
        lineCount++;
      });

      rl.on('close', () => {
        resolve(lineCount);
      });

      rl.on('error', reject);
    });
  }

  /**
   * Stream IDs sequentially, yielding them one at a time.
   */
  private async *streamIdsSequential(): AsyncGenerator<string> {
    const stream = fs.createReadStream(this.config.csvPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;
    let yieldedCount = 0;
    const maxCount = this.config.count;

    for await (const line of rl) {
      lineNumber++;

      // Skip header if configured
      if (this.config.skipHeader && lineNumber === 1) {
        continue;
      }

      const id = this.parseLineForId(line);
      if (id) {
        yield id;
        yieldedCount++;

        // Stop if we've reached the count limit
        if (maxCount !== undefined && yieldedCount >= maxCount) {
          rl.close();
          break;
        }
      } else if (this.config.verbose && line.trim().length > 0) {
        console.log(`Skipping invalid ID on line ${lineNumber}`);
      }
    }
  }

  /**
   * Get a random valid ID from the CSV file.
   */
  private getRandomId(): string {
    return getRandomIdFromFile(this.config.csvPath, this.fileSize);
  }

  /**
   * Run continuous random sampling until stopped.
   */
  private async runContinuous(): Promise<void> {
    const limit = pLimit(this.config.concurrency);
    const activeTasks: Set<Promise<void>> = new Set();

    while (this.running) {
      // Keep the concurrent request pool full
      while (activeTasks.size < this.config.concurrency && this.running) {
        const task = limit(async () => {
          if (!this.running) return;

          const id = this.getRandomId();
          const result = await this.testId(id);
          this.updateStatistics(result);
          this.logVerboseResult(result);

          if (!this.config.jsonOutput) {
            this.logProgress();
          }

          if (this.config.delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.config.delay));
          }
        }).then(() => {
          activeTasks.delete(task);
        });

        activeTasks.add(task);
      }

      // Wait for at least one task to complete before continuing
      if (activeTasks.size > 0) {
        await Promise.race(activeTasks);
      }
    }

    // Wait for remaining tasks to complete
    await Promise.all(activeTasks);
  }

  async testId(id: string): Promise<RequestResult> {
    const startTime = performance.now();
    let result: RequestResult;

    try {
      // Use HEAD request to test availability without downloading content
      // Use Accept-Encoding: identity to get actual Content-Length (not chunked)
      const response = await axios.head(`${this.config.gateway}/raw/${id}`, {
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'ar-io-node-data-retrieval-tester/1.0',
          'Accept-Encoding': 'identity',
        },
        validateStatus: () => true,
      });

      const responseTime = performance.now() - startTime;
      const contentLength = response.headers['content-length']
        ? parseInt(response.headers['content-length'], 10)
        : undefined;
      const contentType = response.headers['content-type'] as string | undefined;
      const cacheStatus = response.headers['x-cache'] as string | undefined;

      result = {
        id,
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        responseTime,
        contentLength,
        contentType,
        cacheStatus,
      };

      // If reference gateway is configured, make comparison request
      if (this.config.reference) {
        await this.compareWithReference(id, result);
      }
    } catch (error: any) {
      const responseTime = performance.now() - startTime;

      if (error.code === 'ECONNABORTED') {
        result = {
          id,
          success: false,
          statusCode: 0,
          responseTime,
          contentLength: undefined,
          contentType: undefined,
          cacheStatus: undefined,
          error: 'Timeout',
        };
      } else {
        result = {
          id,
          success: false,
          statusCode: 0,
          responseTime,
          contentLength: undefined,
          contentType: undefined,
          cacheStatus: undefined,
          error: error.message,
        };
      }
    }

    // Check CDB64 for every tested ID when --cdb64 is provided
    // This runs regardless of HTTP request success/failure
    // Verifies the value decodes and has a valid root TX ID (matches verify-cdb64 behavior)
    if (this.cdb64Reader && this.stats.cdb64Verification) {
      this.stats.cdb64Verification.totalChecked++;
      try {
        const keyBuffer = fromB64Url(id);
        const valueBuffer = await this.cdb64Reader.get(keyBuffer);
        if (valueBuffer) {
          // Decode and verify the value has a valid root TX ID
          const decoded = decodeCdb64Value(valueBuffer);
          const rootTxId = getRootTxId(decoded);
          if (rootTxId && rootTxId.length === 32) {
            this.stats.cdb64Verification.foundInCdb64++;
          } else {
            this.stats.cdb64Verification.notFoundInCdb64++;
          }
        } else {
          this.stats.cdb64Verification.notFoundInCdb64++;
        }
      } catch {
        this.stats.cdb64Verification.lookupErrors++;
      }
    }

    return result;
  }

  /**
   * Compare the test result with a reference gateway response.
   */
  private async compareWithReference(id: string, result: RequestResult): Promise<void> {
    const refStartTime = performance.now();

    try {
      const refResponse = await axios.head(`${this.config.reference}/raw/${id}`, {
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'ar-io-node-data-retrieval-tester/1.0',
          'Accept-Encoding': 'identity',
        },
        validateStatus: () => true,
      });

      result.referenceResponseTime = performance.now() - refStartTime;
      result.referenceStatusCode = refResponse.status;
      result.referenceContentLength = refResponse.headers['content-length']
        ? parseInt(refResponse.headers['content-length'], 10)
        : undefined;
      result.referenceContentType = refResponse.headers['content-type'] as string | undefined;

      // Compare status codes (both should be success or both should be same error)
      const testSuccess = result.statusCode >= 200 && result.statusCode < 300;
      const refSuccess = refResponse.status >= 200 && refResponse.status < 300;
      result.statusMatch = testSuccess === refSuccess;

      // Compare content length and type only if both succeeded
      // If test gateway returns error (e.g., 404), status mismatch is the finding
      if (testSuccess && refSuccess) {
        result.contentLengthMatch = result.contentLength === result.referenceContentLength;

        // Compare content type (normalize by taking just the mime type, ignoring charset etc.)
        const normalizeContentType = (ct: string | undefined): string | undefined => {
          if (!ct) return undefined;
          return ct.split(';')[0].trim().toLowerCase();
        };
        const testCt = normalizeContentType(result.contentType);
        const refCt = normalizeContentType(result.referenceContentType);
        result.contentTypeMatch = testCt === refCt;
      } else {
        // Don't flag content mismatches when test gateway returned an error
        // The status mismatch (if any) is the meaningful finding
        result.contentLengthMatch = true;
        result.contentTypeMatch = true;
      }

      // Perform GraphQL verification for 404 mismatches when CDB64 is available
      const is404Mismatch =
        result.statusCode === 404 && refSuccess && this.cdb64Reader !== null;
      if (is404Mismatch) {
        // First check if ID exists in CDB64 at all (cdb64Reader is non-null per condition above)
        const keyBuffer = fromB64Url(id);
        const valueBuffer = await this.cdb64Reader!.get(keyBuffer);

        if (!valueBuffer) {
          // ID not in CDB64
          result.graphqlVerification = {
            dataItemId: id,
            dataItemExists: false,
            parentMatch: false,
            diagnosis: 'not-in-cdb64',
          };
        } else {
          // ID exists - check if it has path info for verification
          let cdb64Lookup = await this.lookupCdb64(id);
          if (!cdb64Lookup) {
            // Legacy format without path - use rootTxId as single-level path
            // This handles data items directly in the root bundle
            const decoded = decodeCdb64Value(valueBuffer);
            const rootTxId = toB64Url(getRootTxId(decoded));
            cdb64Lookup = {
              path: [rootTxId],
              rootTxId,
              parentId: rootTxId,
            };
          }
          result.graphqlVerification = await this.verifyWithGraphQL(
            id,
            cdb64Lookup,
          );
        }
      }
    } catch (error: any) {
      result.referenceResponseTime = performance.now() - refStartTime;
      result.referenceError = error.code === 'ECONNABORTED' ? 'Timeout' : error.message;
      result.statusMatch = false;
      result.contentLengthMatch = false;
      result.contentTypeMatch = false;
    }
  }

  updateStatistics(result: RequestResult): void {
    this.stats.totalRequests++;

    if (result.success) {
      this.stats.successes++;
    } else {
      this.stats.failures++;

      const errorKey =
        result.error || `${result.statusCode} ${this.getStatusText(result.statusCode)}`;
      const currentCount = this.stats.errorCounts.get(errorKey) || 0;
      this.stats.errorCounts.set(errorKey, currentCount + 1);
    }

    // Track status codes
    const statusCount = this.stats.statusCodeCounts.get(result.statusCode) || 0;
    this.stats.statusCodeCounts.set(result.statusCode, statusCount + 1);

    // Track cache status
    if (result.cacheStatus) {
      const upperCache = result.cacheStatus.toUpperCase();
      if (upperCache.includes('HIT')) {
        this.stats.cacheHits++;
      } else if (upperCache.includes('MISS')) {
        this.stats.cacheMisses++;
      } else {
        this.stats.cacheUnknown++;
      }
    } else {
      this.stats.cacheUnknown++;
    }

    // Track response times and bytes
    this.stats.responseTimes.push(result.responseTime);
    if (result.contentLength) {
      this.stats.totalBytes += result.contentLength;
    }

    // Track reference comparison results
    if (result.referenceStatusCode !== undefined || result.referenceError !== undefined) {
      this.stats.referenceComparisons++;

      if (result.referenceError) {
        this.stats.referenceErrors++;
      } else {
        const hasAnyMismatch =
          result.statusMatch === false ||
          result.contentLengthMatch === false ||
          result.contentTypeMatch === false;
        if (hasAnyMismatch) {
          this.stats.totalMismatches++;
        }
        if (result.statusMatch === false) {
          this.stats.statusMismatches++;
        }
        if (result.contentLengthMatch === false) {
          this.stats.contentLengthMismatches++;
        }
        if (result.contentTypeMatch === false) {
          this.stats.contentTypeMismatches++;
        }
      }
    }

    // Track GraphQL verification results
    if (result.graphqlVerification && this.stats.graphqlVerification) {
      this.stats.graphqlVerification.totalEligible++;
      switch (result.graphqlVerification.diagnosis) {
        case 'not-in-cdb64':
          this.stats.graphqlVerification.notInCdb64++;
          break;
        case 'data-item-missing':
          this.stats.graphqlVerification.dataItemMissing++;
          break;
        case 'parent-mismatch':
          this.stats.graphqlVerification.parentMismatch++;
          break;
        case 'path-broken':
          this.stats.graphqlVerification.pathBroken++;
          break;
        case 'root-missing':
          this.stats.graphqlVerification.rootMissing++;
          break;
        case 'verified-ok':
          this.stats.graphqlVerification.verifiedOk++;
          break;
        case 'error':
          this.stats.graphqlVerification.errors++;
          break;
      }
    }

    // Collect failed IDs (test failed, reference succeeded)
    if (
      result.statusMatch === false &&
      result.referenceStatusCode !== undefined &&
      result.referenceStatusCode >= 200 &&
      result.referenceStatusCode < 300 &&
      this.config.failedIdsPath
    ) {
      this.failedIds.push(result.id);
    }
  }

  getStatusText(statusCode: number): string {
    const statusTexts: Record<number, string> = {
      0: 'Network Error',
      200: 'OK',
      206: 'Partial Content',
      301: 'Moved Permanently',
      304: 'Not Modified',
      400: 'Bad Request',
      402: 'Payment Required',
      404: 'Not Found',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };

    return statusTexts[statusCode] || 'Unknown';
  }

  logProgress(): void {
    this.processedCount++;
    if (this.totalToProcess > 0) {
      if (this.processedCount % 100 === 0 || this.processedCount === this.totalToProcess) {
        const percent = ((this.processedCount / this.totalToProcess) * 100).toFixed(1);
        const successRate =
          this.stats.totalRequests > 0
            ? ((this.stats.successes / this.stats.totalRequests) * 100).toFixed(1)
            : '0.0';
        console.log(
          `[Progress: ${this.processedCount}/${this.totalToProcess} (${percent}%) | Success: ${successRate}%]`,
        );
      }
    } else {
      // Unknown total (streaming sequential without count)
      if (this.processedCount % 100 === 0) {
        const successRate =
          this.stats.totalRequests > 0
            ? ((this.stats.successes / this.stats.totalRequests) * 100).toFixed(1)
            : '0.0';
        console.log(`[Progress: ${this.processedCount} processed | Success: ${successRate}%]`);
      }
    }
  }

  logVerboseResult(result: RequestResult): void {
    if (!this.config.verbose) return;

    const status = result.success ? '+' : '-';
    const time = result.responseTime.toFixed(0);
    const cache = result.cacheStatus ? ` [${result.cacheStatus}]` : '';
    const error = result.error ? ` (${result.error})` : '';
    const size = result.contentLength ? ` ${this.formatBytes(result.contentLength)}` : '';

    let refInfo = '';
    if (this.config.reference) {
      if (result.referenceError) {
        refInfo = ` | REF: error (${result.referenceError})`;
      } else if (result.referenceStatusCode !== undefined) {
        const mismatches: string[] = [];
        if (!result.statusMatch) {
          mismatches.push(`status: ${result.statusCode} (test) vs ${result.referenceStatusCode} (ref)`);
        }
        if (!result.contentLengthMatch) {
          const testLen = result.contentLength ?? 'none';
          const refLen = result.referenceContentLength ?? 'none';
          mismatches.push(`length: ${testLen} (test) vs ${refLen} (ref)`);
        }
        if (!result.contentTypeMatch) {
          const normalizeCt = (ct: string | undefined) => ct?.split(';')[0].trim().toLowerCase() ?? 'none';
          mismatches.push(`type: ${normalizeCt(result.contentType)} (test) vs ${normalizeCt(result.referenceContentType)} (ref)`);
        }

        if (mismatches.length > 0) {
          refInfo = ` | MISMATCH [${mismatches.join('; ')}]`;
        } else {
          refInfo = ` | REF: OK`;
        }
      }
    }

    // Add GraphQL verification info for 404 mismatches
    let cdb64Info = '';
    if (result.graphqlVerification) {
      const v = result.graphqlVerification;
      if (v.diagnosis === 'not-in-cdb64') {
        cdb64Info = ' | CDB64: not in index';
      } else if (v.diagnosis === 'parent-mismatch') {
        cdb64Info = ` | CDB64: parent-mismatch (expected: ${v.expectedParent?.slice(0, 8)}..., actual: ${v.actualParent?.slice(0, 8) ?? 'none'}...)`;
      } else {
        cdb64Info = ` | CDB64: ${v.diagnosis}`;
      }
    }

    console.log(
      `${status} ${result.id}: ${result.statusCode} in ${time}ms${cache}${size}${error}${refInfo}${cdb64Info}`,
    );
  }

  calculatePercentile(times: number[], percentile: number): number {
    if (times.length === 0) return 0;

    const sorted = [...times].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  displayConsoleResults(): void {
    const duration = this.stats.endTime - this.stats.startTime;
    const successRate =
      this.stats.totalRequests > 0
        ? ((this.stats.successes / this.stats.totalRequests) * 100).toFixed(2)
        : '0.00';
    const failureRate =
      this.stats.totalRequests > 0
        ? ((this.stats.failures / this.stats.totalRequests) * 100).toFixed(2)
        : '0.00';

    const modeStr = this.config.continuous ? 'continuous' : this.config.mode;

    console.log('\n=== Data Retrieval Test Results ===');
    console.log(`CSV File: ${this.config.csvPath}`);
    console.log(`Gateway: ${this.config.gateway}`);
    console.log(`Mode: ${modeStr} | Concurrency: ${this.config.concurrency}`);
    console.log(`Duration: ${formatDuration(duration)}`);

    console.log('\nRequests:');
    console.log(`  Total: ${this.stats.totalRequests.toLocaleString()}`);
    console.log(`  Success: ${this.stats.successes.toLocaleString()} (${successRate}%)`);
    console.log(`  Failed: ${this.stats.failures.toLocaleString()} (${failureRate}%)`);

    if (this.stats.statusCodeCounts.size > 0) {
      console.log('\nStatus Codes:');
      const sortedStatusCodes = Array.from(this.stats.statusCodeCounts.entries()).sort(
        ([a], [b]) => a - b,
      );
      for (const [code, count] of sortedStatusCodes) {
        const statusText = this.getStatusText(code);
        console.log(`  ${code} ${statusText}: ${count.toLocaleString()}`);
      }
    }

    const totalCacheResponses = this.stats.cacheHits + this.stats.cacheMisses;
    if (totalCacheResponses > 0) {
      const hitRate = ((this.stats.cacheHits / totalCacheResponses) * 100).toFixed(2);
      console.log('\nCache Performance:');
      console.log(`  Hits: ${this.stats.cacheHits.toLocaleString()} (${hitRate}%)`);
      console.log(
        `  Misses: ${this.stats.cacheMisses.toLocaleString()} (${(100 - parseFloat(hitRate)).toFixed(2)}%)`,
      );
      if (this.stats.cacheUnknown > 0) {
        console.log(`  Unknown: ${this.stats.cacheUnknown.toLocaleString()}`);
      }
    }

    if (this.stats.responseTimes.length > 0) {
      const min = Math.min(...this.stats.responseTimes);
      const max = Math.max(...this.stats.responseTimes);
      const avg =
        this.stats.responseTimes.reduce((a, b) => a + b, 0) / this.stats.responseTimes.length;
      const p50 = this.calculatePercentile(this.stats.responseTimes, 50);
      const p95 = this.calculatePercentile(this.stats.responseTimes, 95);
      const p99 = this.calculatePercentile(this.stats.responseTimes, 99);

      console.log('\nResponse Times:');
      console.log(`  Min: ${min.toFixed(0)}ms`);
      console.log(`  Max: ${max.toFixed(0)}ms`);
      console.log(`  Avg: ${avg.toFixed(0)}ms`);
      console.log(`  p50: ${p50.toFixed(0)}ms`);
      console.log(`  p95: ${p95.toFixed(0)}ms`);
      console.log(`  p99: ${p99.toFixed(0)}ms`);
    }

    if (this.stats.totalBytes > 0) {
      console.log(`\nData Transferred: ${this.formatBytes(this.stats.totalBytes)}`);
    }

    if (this.stats.errorCounts.size > 0) {
      console.log('\nErrors:');
      const sortedErrors = Array.from(this.stats.errorCounts.entries()).sort(
        ([, a], [, b]) => b - a,
      );
      for (const [error, count] of sortedErrors) {
        console.log(`  ${error}: ${count.toLocaleString()}`);
      }
    }

    // Reference comparison results
    if (this.config.reference && this.stats.referenceComparisons > 0) {
      const matchRate = (
        ((this.stats.referenceComparisons -
          this.stats.referenceErrors -
          this.stats.totalMismatches) /
          this.stats.referenceComparisons) *
        100
      ).toFixed(2);

      console.log('\nReference Comparison:');
      console.log(`  Reference Gateway: ${this.config.reference}`);
      console.log(`  Comparisons: ${this.stats.referenceComparisons.toLocaleString()}`);
      console.log(`  Match Rate: ${matchRate}%`);
      if (this.stats.statusMismatches > 0) {
        console.log(`  Status Mismatches: ${this.stats.statusMismatches.toLocaleString()}`);
      }
      if (this.stats.contentLengthMismatches > 0) {
        console.log(
          `  Content-Length Mismatches: ${this.stats.contentLengthMismatches.toLocaleString()}`,
        );
      }
      if (this.stats.contentTypeMismatches > 0) {
        console.log(
          `  Content-Type Mismatches: ${this.stats.contentTypeMismatches.toLocaleString()}`,
        );
      }
      if (this.stats.referenceErrors > 0) {
        console.log(`  Reference Errors: ${this.stats.referenceErrors.toLocaleString()}`);
      }
    }

    // CDB64 verification results (for every tested ID)
    if (this.stats.cdb64Verification && this.stats.cdb64Verification.totalChecked > 0) {
      const cv = this.stats.cdb64Verification;
      const pct =
        cv.totalChecked > 0 ? ((cv.foundInCdb64 / cv.totalChecked) * 100).toFixed(1) : '0.0';
      console.log('\nCDB64 Verification:');
      console.log(`  CDB64 File: ${this.config.cdb64Path}`);
      console.log(`  Total Checked: ${cv.totalChecked.toLocaleString()}`);
      console.log(`  Found in CDB64: ${cv.foundInCdb64.toLocaleString()} (${pct}%)`);
      console.log(`  Not in CDB64: ${cv.notFoundInCdb64.toLocaleString()}`);
      if (cv.lookupErrors > 0) {
        console.log(`  Lookup Errors: ${cv.lookupErrors.toLocaleString()}`);
      }
    }

    // GraphQL verification results for 404 mismatches
    if (this.stats.graphqlVerification && this.stats.graphqlVerification.totalEligible > 0) {
      const gv = this.stats.graphqlVerification;
      console.log('\nGraphQL Verification (404 Mismatches):');
      console.log(`  CDB64 File: ${this.config.cdb64Path}`);
      console.log(`  Reference: ${this.config.reference}`);
      console.log(`  Total Eligible: ${gv.totalEligible.toLocaleString()}`);
      console.log('  Diagnoses:');
      if (gv.notInCdb64 > 0) {
        console.log(`    Not in CDB64: ${gv.notInCdb64.toLocaleString()}`);
      }
      if (gv.dataItemMissing > 0) {
        console.log(`    Data item not indexed: ${gv.dataItemMissing.toLocaleString()}`);
      }
      if (gv.parentMismatch > 0) {
        console.log(`    Parent mismatch: ${gv.parentMismatch.toLocaleString()}`);
      }
      if (gv.pathBroken > 0) {
        console.log(`    Path broken: ${gv.pathBroken.toLocaleString()}`);
      }
      if (gv.rootMissing > 0) {
        console.log(`    Root TX missing: ${gv.rootMissing.toLocaleString()}`);
      }
      if (gv.verifiedOk > 0) {
        console.log(`    Verified OK: ${gv.verifiedOk.toLocaleString()}`);
      }
      if (gv.errors > 0) {
        console.log(`    Errors: ${gv.errors.toLocaleString()}`);
      }
    }
  }

  private getJsonResults(): object {
    const duration = this.stats.endTime - this.stats.startTime;
    const totalCacheResponses = this.stats.cacheHits + this.stats.cacheMisses;

    return {
      config: {
        csvPath: this.config.csvPath,
        gateway: this.config.gateway,
        mode: this.config.continuous ? 'continuous' : this.config.mode,
        concurrency: this.config.concurrency,
      },
      summary: {
        totalRequests: this.stats.totalRequests,
        successes: this.stats.successes,
        failures: this.stats.failures,
        successRate:
          this.stats.totalRequests > 0
            ? parseFloat(((this.stats.successes / this.stats.totalRequests) * 100).toFixed(2))
            : 0,
        durationMs: duration,
        bytesTransferred: this.stats.totalBytes,
      },
      statusCodes: Object.fromEntries(this.stats.statusCodeCounts),
      cache: {
        hits: this.stats.cacheHits,
        misses: this.stats.cacheMisses,
        unknown: this.stats.cacheUnknown,
        hitRate:
          totalCacheResponses > 0
            ? parseFloat(((this.stats.cacheHits / totalCacheResponses) * 100).toFixed(2))
            : 0,
      },
      responseTimes:
        this.stats.responseTimes.length > 0
          ? {
              min: Math.min(...this.stats.responseTimes),
              max: Math.max(...this.stats.responseTimes),
              avg:
                this.stats.responseTimes.reduce((a, b) => a + b, 0) /
                this.stats.responseTimes.length,
              p50: this.calculatePercentile(this.stats.responseTimes, 50),
              p95: this.calculatePercentile(this.stats.responseTimes, 95),
              p99: this.calculatePercentile(this.stats.responseTimes, 99),
            }
          : null,
      errors: Object.fromEntries(this.stats.errorCounts),
      referenceComparison:
        this.config.reference && this.stats.referenceComparisons > 0
          ? {
              referenceGateway: this.config.reference,
              comparisons: this.stats.referenceComparisons,
              totalMismatches: this.stats.totalMismatches,
              statusMismatches: this.stats.statusMismatches,
              contentLengthMismatches: this.stats.contentLengthMismatches,
              contentTypeMismatches: this.stats.contentTypeMismatches,
              referenceErrors: this.stats.referenceErrors,
            }
          : null,
      cdb64Verification:
        this.stats.cdb64Verification && this.stats.cdb64Verification.totalChecked > 0
          ? {
              cdb64File: this.config.cdb64Path,
              totalChecked: this.stats.cdb64Verification.totalChecked,
              foundInCdb64: this.stats.cdb64Verification.foundInCdb64,
              notFoundInCdb64: this.stats.cdb64Verification.notFoundInCdb64,
              lookupErrors: this.stats.cdb64Verification.lookupErrors,
              foundRate: parseFloat(
                (
                  (this.stats.cdb64Verification.foundInCdb64 /
                    this.stats.cdb64Verification.totalChecked) *
                  100
                ).toFixed(2),
              ),
            }
          : null,
      graphqlVerification:
        this.stats.graphqlVerification &&
        this.stats.graphqlVerification.totalEligible > 0
          ? {
              cdb64File: this.config.cdb64Path,
              reference: this.config.reference,
              totalEligible: this.stats.graphqlVerification.totalEligible,
              notInCdb64: this.stats.graphqlVerification.notInCdb64,
              dataItemMissing: this.stats.graphqlVerification.dataItemMissing,
              parentMismatch: this.stats.graphqlVerification.parentMismatch,
              pathBroken: this.stats.graphqlVerification.pathBroken,
              rootMissing: this.stats.graphqlVerification.rootMissing,
              verifiedOk: this.stats.graphqlVerification.verifiedOk,
              errors: this.stats.graphqlVerification.errors,
            }
          : null,
    };
  }

  displayJsonResults(): void {
    console.log(JSON.stringify(this.getJsonResults(), null, 2));
  }

  writeJsonToFile(filePath: string): void {
    const result = this.getJsonResults();
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nResults written to: ${filePath}`);
  }

  async run(): Promise<void> {
    console.log(`Testing data retrieval from: ${this.config.csvPath}`);
    console.log(`Gateway: ${this.config.gateway}`);
    const modeStr = this.config.continuous ? 'continuous random' : this.config.mode;
    console.log(`Mode: ${modeStr} | Concurrency: ${this.config.concurrency}`);

    this.stats.startTime = performance.now();
    const limit = pLimit(this.config.concurrency);

    if (this.config.continuous) {
      // Continuous random sampling mode - no pre-indexing needed
      this.fileSize = getFileSize(this.config.csvPath);
      console.log(`File size: ${this.formatBytes(this.fileSize)}`);
      this.totalToProcess = 0; // Unknown - continuous
      console.log('Press Ctrl+C to stop and view results...\n');

      await this.runContinuous();
    } else if (this.config.mode === 'random') {
      // Random mode: use random byte seeking
      this.fileSize = getFileSize(this.config.csvPath);
      const count = this.config.count ?? 100;
      this.totalToProcess = count;
      console.log(`File size: ${this.formatBytes(this.fileSize)}`);
      console.log(`Selecting ${count.toLocaleString()} random IDs`);

      if (!this.config.jsonOutput) {
        console.log('Press Ctrl+C to stop and view partial results...\n');
      }

      const promises = Array.from({ length: count }, () =>
        limit(async () => {
          if (!this.running) return;

          const id = this.getRandomId();
          const result = await this.testId(id);
          this.updateStatistics(result);
          this.logVerboseResult(result);

          if (!this.config.jsonOutput) {
            this.logProgress();
          }

          if (this.config.delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.config.delay));
          }

          return result;
        }),
      );

      await Promise.all(promises);
    } else {
      // Sequential mode: stream through file
      if (this.config.count !== undefined) {
        this.totalToProcess = this.config.count;
        console.log(`Testing up to ${this.config.count.toLocaleString()} IDs sequentially`);
      } else {
        // Count lines for progress (optional, can be disabled for huge files)
        console.log('Counting lines in file...');
        const totalLines = await this.countLines();
        const adjustedLines = this.config.skipHeader ? totalLines - 1 : totalLines;
        this.totalToProcess = adjustedLines;
        console.log(`File has ~${adjustedLines.toLocaleString()} lines`);
      }

      if (!this.config.jsonOutput) {
        console.log('Press Ctrl+C to stop and view partial results...\n');
      }

      // Process in batches for better concurrency
      const batchSize = this.config.concurrency * 10;
      let batch: string[] = [];

      for await (const id of this.streamIdsSequential()) {
        if (!this.running) break;

        batch.push(id);

        if (batch.length >= batchSize) {
          await this.processBatch(batch, limit);
          batch = [];
        }
      }

      // Process remaining batch
      if (batch.length > 0 && this.running) {
        await this.processBatch(batch, limit);
      }
    }

    this.stats.endTime = performance.now();
  }

  private async processBatch(
    ids: string[],
    limit: ReturnType<typeof pLimit>,
  ): Promise<void> {
    const promises = ids.map((id) =>
      limit(async () => {
        if (!this.running) return;

        const result = await this.testId(id);
        this.updateStatistics(result);
        this.logVerboseResult(result);

        if (!this.config.jsonOutput) {
          this.logProgress();
        }

        if (this.config.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.config.delay));
        }

        return result;
      }),
    );

    await Promise.all(promises);
  }

  stop(): void {
    this.running = false;
  }

  displayResults(): void {
    // Prevent double display (can happen with SIGINT + normal completion)
    if (this.resultsDisplayed) return;
    this.resultsDisplayed = true;

    // Set end time if not already set (e.g., SIGINT before run completes)
    if (this.stats.endTime === 0) {
      this.stats.endTime = performance.now();
    }

    if (this.config.jsonOutput) {
      this.displayJsonResults();
    } else {
      this.displayConsoleResults();
    }

    // In continuous mode, always write JSON to file (in addition to console/json output)
    if (this.config.continuous) {
      const outputFile =
        this.config.outputFile ||
        `data-retrieval-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      this.writeJsonToFile(outputFile);
    }

    // Write failed IDs to file if configured
    if (this.config.failedIdsPath && this.failedIds.length > 0) {
      fs.writeFileSync(this.config.failedIdsPath, this.failedIds.join('\n') + '\n');
      console.log(
        `\nFailed IDs written to: ${this.config.failedIdsPath} (${this.failedIds.length} IDs)`,
      );
    }
  }
}

function parseArguments(): TestConfig {
  const args = process.argv.slice(2);
  const config: TestConfig = {
    csvPath: '',
    gateway: 'http://localhost:4000',
    reference: undefined,
    cdb64Path: undefined,
    failedIdsPath: undefined,
    mode: 'sequential',
    count: undefined,
    concurrency: 1,
    timeout: 30000,
    delay: 0,
    skipHeader: false,
    jsonOutput: false,
    verbose: false,
    continuous: false,
    outputFile: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--csv':
        if (!nextArg) {
          throw new Error('--csv requires a file path');
        }
        config.csvPath = nextArg;
        i++;
        break;

      case '--gateway':
        if (!nextArg) {
          throw new Error('--gateway requires a URL');
        }
        config.gateway = nextArg;
        i++;
        break;

      case '--reference':
        if (!nextArg) {
          throw new Error('--reference requires a URL');
        }
        config.reference = nextArg;
        i++;
        break;

      case '--cdb64':
        if (!nextArg) {
          throw new Error('--cdb64 requires a file path');
        }
        config.cdb64Path = nextArg;
        i++;
        break;

      case '--failed-ids':
        if (!nextArg) {
          throw new Error('--failed-ids requires a file path');
        }
        config.failedIdsPath = nextArg;
        i++;
        break;

      case '--mode':
        if (!nextArg || !['random', 'sequential'].includes(nextArg)) {
          throw new Error("--mode requires 'random' or 'sequential'");
        }
        config.mode = nextArg as 'random' | 'sequential';
        i++;
        break;

      case '--count':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--count requires a number');
        }
        config.count = parseInt(nextArg);
        i++;
        break;

      case '--concurrency':
        if (!nextArg || isNaN(parseInt(nextArg)) || parseInt(nextArg) < 1) {
          throw new Error('--concurrency requires a positive number');
        }
        config.concurrency = parseInt(nextArg);
        i++;
        break;

      case '--timeout':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--timeout requires a number in milliseconds');
        }
        config.timeout = parseInt(nextArg);
        i++;
        break;

      case '--delay':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--delay requires a number in milliseconds');
        }
        config.delay = parseInt(nextArg);
        i++;
        break;

      case '--skip-header':
        config.skipHeader = true;
        break;

      case '--json':
        config.jsonOutput = true;
        break;

      case '--verbose':
        config.verbose = true;
        break;

      case '--continuous':
        config.continuous = true;
        break;

      case '--output':
        if (!nextArg) {
          throw new Error('--output requires a file path');
        }
        config.outputFile = nextArg;
        i++;
        break;

      case '--help':
      case '-h':
        printUsage();
        process.exit(0);

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config.csvPath) {
    throw new Error('--csv is required');
  }

  if (!fs.existsSync(config.csvPath)) {
    throw new Error(`CSV file not found: ${config.csvPath}`);
  }

  // Normalize gateway URL
  if (!config.gateway.startsWith('http://') && !config.gateway.startsWith('https://')) {
    config.gateway = `https://${config.gateway}`;
  }

  // Remove trailing slash
  config.gateway = config.gateway.replace(/\/$/, '');

  // Normalize reference URL if provided
  if (config.reference) {
    if (!config.reference.startsWith('http://') && !config.reference.startsWith('https://')) {
      config.reference = `https://${config.reference}`;
    }
    config.reference = config.reference.replace(/\/$/, '');
  }

  // Validate CDB64 option
  if (config.cdb64Path) {
    if (!fs.existsSync(config.cdb64Path)) {
      throw new Error(`CDB64 file not found: ${config.cdb64Path}`);
    }
  }

  // Validate --failed-ids option
  if (config.failedIdsPath && !config.reference) {
    throw new Error('--failed-ids requires --reference to also be specified');
  }

  return config;
}

function printUsage(): void {
  console.log(`
Data Retrieval Testing Tool

Usage: ./tools/test-data-retrieval [options]

Options:
  --csv <file>           CSV file with TX/data item IDs in first column (required)
  --gateway <url>        Gateway URL to test (default: http://localhost:4000)
  --reference <url>      Reference gateway URL for comparison (optional)
  --cdb64 <file>         CDB64 file for verifying IDs exist in the index (optional)
  --failed-ids <file>    Write IDs that fail on test but succeed on reference to file (requires --reference)
  --mode <mode>          Sampling mode: 'random' or 'sequential' (default: sequential)
  --count <n>            Number of IDs to test (default: all for sequential, 100 for random)
  --concurrency <n>      Number of concurrent requests (default: 1)
  --timeout <ms>         Request timeout in milliseconds (default: 30000)
  --delay <ms>           Delay between requests in ms (default: 0)
  --skip-header          Skip the first row of CSV (if it's a header)
  --continuous           Run continuously until Ctrl+C (random sampling)
  --output <file>        JSON output file path (used with --continuous)
  --json                 Output results as JSON instead of console table
  --verbose              Show detailed logs for each request
  --help, -h             Show this help message

Reference Comparison:
  When --reference is specified, the tool makes a HEAD request to both the test
  gateway and the reference gateway for each ID, comparing:
    - Status code (both success or both error)
    - Content-Length header
    - Content-Type header (normalized, ignoring charset)

  Mismatches are reported in verbose mode and summarized in results.

CDB64 Verification:
  When --cdb64 is specified, every tested ID is checked against the CDB64 file
  to verify it exists in the index. This provides visibility into what percentage
  of the tested IDs are covered by the CDB64 index.

  Can be used standalone (without --reference) to check index coverage.

GraphQL Verification (404 Mismatches):
  When both --cdb64 and --reference are specified, the tool performs additional
  verification on 404 mismatches (test gateway returns 404, reference returns 2xx).
  It queries the reference gateway's GraphQL endpoint to verify CDB64 parent/child
  relationships.

  Diagnoses:
    - not-in-cdb64: ID not found in the CDB64 file
    - data-item-missing: Data item not indexed in reference gateway
    - parent-mismatch: CDB64 has different parent than GraphQL reports
    - path-broken: An intermediate bundle in the path is missing from GraphQL
    - root-missing: Root transaction not found in GraphQL index
    - verified-ok: Everything matches (likely a timing issue)
    - error: GraphQL query failure

Examples:
  ./tools/test-data-retrieval --csv ids.csv
  ./tools/test-data-retrieval --csv ids.csv --gateway https://ar-io.dev
  ./tools/test-data-retrieval --csv ids.csv --mode random --count 500
  ./tools/test-data-retrieval --csv ids.csv --concurrency 10 --verbose
  ./tools/test-data-retrieval --csv ids.csv --json > results.json

  # Compare with reference gateway
  ./tools/test-data-retrieval --csv ids.csv --gateway http://localhost:4000 \\
    --reference https://arweave.net --verbose

  # Save IDs that fail on test gateway but succeed on reference
  ./tools/test-data-retrieval --csv ids.csv --gateway http://localhost:4000 \\
    --reference https://arweave.net --failed-ids /tmp/missing-ids.txt

  # Verify IDs exist in CDB64 index (standalone, no reference needed)
  ./tools/test-data-retrieval --csv ids.csv --cdb64 /path/to/root-tx-index.cdb

  # Verify 404 mismatches with CDB64 GraphQL verification
  ./tools/test-data-retrieval --csv ids.csv --gateway http://localhost:4000 \\
    --reference https://arweave.net --cdb64 /path/to/root-tx-index.cdb --verbose

  # Continuous random sampling (Ctrl+C to stop and save results)
  ./tools/test-data-retrieval --csv ids.csv --continuous --concurrency 10
  ./tools/test-data-retrieval --csv ids.csv --continuous --output results.json
`);
}

async function main(): Promise<void> {
  try {
    const config = parseArguments();
    const tester = new DataRetrievalTester(config);

    // Initialize resources (e.g., CDB64 reader)
    await tester.initialize();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      if (!config.jsonOutput) {
        console.log('\nReceived SIGINT, stopping test...');
      }
      tester.stop();
      // Wait a moment for in-flight requests to complete
      setTimeout(async () => {
        tester.displayResults();
        await tester.cleanup();
        process.exit(0);
      }, 500);
    });

    await tester.run();
    tester.displayResults();
    await tester.cleanup();
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    console.log('\nUse --help for usage information');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
