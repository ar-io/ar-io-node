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

interface TestConfig {
  csvPath: string;
  gateway: string;
  reference: string | undefined;
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
}

// Valid base64url TX/data item ID pattern (43 characters)
const ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

class DataRetrievalTester {
  private config: TestConfig;
  private stats: Statistics;
  private running: boolean = true;
  private processedCount: number = 0;
  private totalToProcess: number = 0;
  private fileSize: number = 0;
  private resultsDisplayed: boolean = false;

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
   * Get file size for random seeking.
   */
  private getFileSize(): number {
    const stat = fs.statSync(this.config.csvPath);
    return stat.size;
  }

  /**
   * Get a random ID by seeking to a random position in the file.
   * Seeks to random byte, finds next line boundary, reads that line.
   */
  private getRandomIdFromFile(): string | null {
    const fd = fs.openSync(this.config.csvPath, 'r');
    try {
      // Pick random position (leave room to find a complete line)
      const randomPos = Math.floor(Math.random() * Math.max(1, this.fileSize - 100));

      // Read a chunk starting from random position
      const chunkSize = 256; // Enough for a line with ID
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, randomPos);

      if (bytesRead === 0) return null;

      const chunk = buffer.toString('utf-8', 0, bytesRead);

      // Find start of next complete line (skip partial line we landed in)
      let lineStart = chunk.indexOf('\n');
      if (lineStart === -1) return null;
      lineStart++; // Move past the newline

      // Find end of that line
      let lineEnd = chunk.indexOf('\n', lineStart);
      if (lineEnd === -1) lineEnd = bytesRead;

      const line = chunk.substring(lineStart, lineEnd);
      return this.parseLineForId(line);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Get a random valid ID, retrying if we land on an invalid line.
   */
  private async getRandomId(): Promise<string> {
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      const id = this.getRandomIdFromFile();
      if (id) return id;
      attempts++;
    }

    throw new Error('Failed to find valid ID after maximum attempts');
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

          const id = await this.getRandomId();
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

      const result: RequestResult = {
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

      return result;
    } catch (error: any) {
      const responseTime = performance.now() - startTime;

      if (error.code === 'ECONNABORTED') {
        return {
          id,
          success: false,
          statusCode: 0,
          responseTime,
          contentLength: undefined,
          contentType: undefined,
          cacheStatus: undefined,
          error: 'Timeout',
        };
      }

      return {
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

    console.log(
      `${status} ${result.id}: ${result.statusCode} in ${time}ms${cache}${size}${error}${refInfo}`,
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

  formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
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
    console.log(`Duration: ${this.formatDuration(duration)}`);

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
      this.fileSize = this.getFileSize();
      console.log(`File size: ${this.formatBytes(this.fileSize)}`);
      this.totalToProcess = 0; // Unknown - continuous
      console.log('Press Ctrl+C to stop and view results...\n');

      await this.runContinuous();
    } else if (this.config.mode === 'random') {
      // Random mode: use random byte seeking
      this.fileSize = this.getFileSize();
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

          const id = await this.getRandomId();
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
  }
}

function parseArguments(): TestConfig {
  const args = process.argv.slice(2);
  const config: TestConfig = {
    csvPath: '',
    gateway: 'http://localhost:4000',
    reference: undefined,
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
        break;

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

Examples:
  ./tools/test-data-retrieval --csv ids.csv
  ./tools/test-data-retrieval --csv ids.csv --gateway https://ar-io.dev
  ./tools/test-data-retrieval --csv ids.csv --mode random --count 500
  ./tools/test-data-retrieval --csv ids.csv --concurrency 10 --verbose
  ./tools/test-data-retrieval --csv ids.csv --json > results.json

  # Compare with reference gateway
  ./tools/test-data-retrieval --csv ids.csv --gateway http://localhost:4000 \\
    --reference https://arweave.net --verbose

  # Continuous random sampling (Ctrl+C to stop and save results)
  ./tools/test-data-retrieval --csv ids.csv --continuous --concurrency 10
  ./tools/test-data-retrieval --csv ids.csv --continuous --output results.json
`);
}

async function main(): Promise<void> {
  try {
    const config = parseArguments();
    const tester = new DataRetrievalTester(config);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      if (!config.jsonOutput) {
        console.log('\nReceived SIGINT, stopping test...');
      }
      tester.stop();
      // Wait a moment for in-flight requests to complete
      setTimeout(() => {
        tester.displayResults();
        process.exit(0);
      }, 500);
    });

    await tester.run();
    tester.displayResults();
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
