/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from 'axios';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import pLimit from 'p-limit';

// Error categorization - resource exhaustion errors are flagged in output
const RESOURCE_ERRORS = new Set(['EMFILE', 'ENFILE', 'ENOMEM']);

interface TestConfig {
  gateway: string;
  chainUrl?: string;
  concurrency: number;
  count?: number;
  durationSeconds?: number;
  delay: number;
  timeout: number;
  verbose: boolean;
  maxOffset?: number;
  trackFdsPid?: number;
  fdSampleIntervalMs: number;
}

interface RequestResult {
  offset: number;
  success: boolean;
  statusCode: number;
  responseTime: number;
  error?: string;
  errorCode?: string;
}

interface FdSample {
  timestamp: number;
  count: number;
}

interface Statistics {
  totalRequests: number;
  successes: number;
  failures: number;
  statusCodeCounts: Map<number, number>;
  errorCounts: Map<string, number>;
  errorCodeCounts: Map<string, number>;
  responseTimes: number[];
  startTime: number;
  fdSamples: FdSample[];
}

class ChunkLoadTester {
  private config: TestConfig;
  private stats: Statistics;
  private running: boolean = false;
  private currentWeaveSize: number = 0;
  private fdTrackingInterval?: ReturnType<typeof setInterval>;
  private startTimestamp: number = 0;

  constructor(config: TestConfig) {
    this.config = config;
    this.stats = {
      totalRequests: 0,
      successes: 0,
      failures: 0,
      statusCodeCounts: new Map(),
      errorCounts: new Map(),
      errorCodeCounts: new Map(),
      responseTimes: [],
      startTime: 0,
      fdSamples: [],
    };
  }

  async initialize(): Promise<void> {
    console.log(`Chunk Retrieval Load Tester`);
    console.log(`Gateway: ${this.config.gateway}`);
    if (this.config.chainUrl) {
      console.log(`Chain reference: ${this.config.chainUrl}`);
    }

    try {
      this.currentWeaveSize = await this.getCurrentWeaveSize();

      if (
        this.config.maxOffset &&
        this.config.maxOffset < this.currentWeaveSize
      ) {
        this.currentWeaveSize = this.config.maxOffset;
        console.log(
          `Max offset (custom): ${this.currentWeaveSize.toLocaleString()} bytes`,
        );
      } else {
        console.log(
          `Max offset (weave size): ${this.currentWeaveSize.toLocaleString()} bytes`,
        );
      }
    } catch (error: any) {
      throw new Error(`Failed to initialize: ${error.message}`);
    }
  }

  private async getCurrentWeaveSize(): Promise<number> {
    const sourceUrl = this.config.chainUrl || this.config.gateway;

    try {
      const response = await axios.get(`${sourceUrl}/info`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-chunk-load-tester/1.0' },
      });

      if (response.data && typeof response.data.weave_size === 'string') {
        return parseInt(response.data.weave_size, 10);
      }

      // Fallback: get height and then latest block
      const heightResponse = await axios.get(`${sourceUrl}/height`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-chunk-load-tester/1.0' },
      });

      const height = heightResponse.data;
      const blockResponse = await axios.get(
        `${sourceUrl}/block/height/${height}`,
        {
          timeout: this.config.timeout,
          headers: { 'User-Agent': 'ar-io-node-chunk-load-tester/1.0' },
        },
      );

      if (
        blockResponse.data &&
        typeof blockResponse.data.weave_size === 'string'
      ) {
        return parseInt(blockResponse.data.weave_size, 10);
      }

      throw new Error('Unable to determine weave size from gateway');
    } catch (error: any) {
      if (error.response) {
        throw new Error(
          `HTTP ${error.response.status}: ${error.response.statusText}`,
        );
      }
      throw new Error(`Network error: ${error.message}`);
    }
  }

  private generateRandomOffset(): number {
    return Math.floor(Math.random() * this.currentWeaveSize);
  }

  private async fetchChunk(offset: number): Promise<RequestResult> {
    const startTime = performance.now();

    try {
      const response = await axios.get(
        `${this.config.gateway}/chunk/${offset}`,
        {
          timeout: this.config.timeout,
          headers: { 'User-Agent': 'ar-io-node-chunk-load-tester/1.0' },
          validateStatus: () => true,
        },
      );

      const responseTime = performance.now() - startTime;

      return {
        offset,
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        responseTime,
      };
    } catch (error: any) {
      const responseTime = performance.now() - startTime;
      const errorCode = error.code || 'UNKNOWN';

      return {
        offset,
        success: false,
        statusCode: 0,
        responseTime,
        error: error.message,
        errorCode,
      };
    }
  }

  private updateStatistics(result: RequestResult): void {
    this.stats.totalRequests++;

    if (result.success) {
      this.stats.successes++;
    } else {
      this.stats.failures++;

      // Track error messages
      const errorKey =
        result.error ||
        `HTTP ${result.statusCode} ${this.getStatusText(result.statusCode)}`;
      const currentErrorCount = this.stats.errorCounts.get(errorKey) || 0;
      this.stats.errorCounts.set(errorKey, currentErrorCount + 1);

      // Track error codes
      if (result.errorCode) {
        const currentCodeCount =
          this.stats.errorCodeCounts.get(result.errorCode) || 0;
        this.stats.errorCodeCounts.set(result.errorCode, currentCodeCount + 1);
      }
    }

    // Track status codes
    const currentStatusCount =
      this.stats.statusCodeCounts.get(result.statusCode) || 0;
    this.stats.statusCodeCounts.set(result.statusCode, currentStatusCount + 1);

    this.stats.responseTimes.push(result.responseTime);
  }

  private getStatusText(statusCode: number): string {
    const statusTexts: Record<number, string> = {
      0: 'Network Error',
      200: 'OK',
      400: 'Bad Request',
      404: 'Not Found',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };

    return statusTexts[statusCode] || 'Unknown';
  }

  private logProgress(): void {
    if (this.stats.totalRequests % 100 === 0) {
      const elapsed = (performance.now() - this.startTimestamp) / 1000;
      const rps = (this.stats.totalRequests / elapsed).toFixed(1);
      const successRate = (
        (this.stats.successes / this.stats.totalRequests) *
        100
      ).toFixed(1);

      let progressInfo = `[${this.stats.totalRequests.toLocaleString()} requests, ${rps} req/s, ${successRate}% success`;

      if (this.config.count) {
        const pct = (
          (this.stats.totalRequests / this.config.count) *
          100
        ).toFixed(0);
        progressInfo += `, ${pct}% complete`;
      }

      if (this.config.durationSeconds) {
        const remaining = Math.max(
          0,
          this.config.durationSeconds - Math.floor(elapsed),
        );
        progressInfo += `, ${remaining}s remaining`;
      }

      progressInfo += ']';
      console.log(progressInfo);
    }
  }

  private logVerboseResult(result: RequestResult): void {
    if (!this.config.verbose) return;

    const status = result.success ? '✓' : '✗';
    const time = result.responseTime.toFixed(0);
    const error = result.error ? ` (${result.errorCode || result.error})` : '';

    console.log(
      `${status} Offset ${result.offset}: ${result.statusCode} in ${time}ms${error}`,
    );
  }

  private shouldStop(): boolean {
    if (
      this.config.count !== undefined &&
      this.stats.totalRequests >= this.config.count
    ) {
      return true;
    }

    if (this.config.durationSeconds !== undefined) {
      const elapsedSeconds =
        (performance.now() - this.startTimestamp) / 1000;
      if (elapsedSeconds >= this.config.durationSeconds) {
        return true;
      }
    }

    return false;
  }

  private async getFdCount(pid: number): Promise<number | null> {
    try {
      const fdDir = `/proc/${pid}/fd`;
      const entries = await fs.promises.readdir(fdDir);
      return entries.length;
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        return null;
      }
      return null;
    }
  }

  private async sampleFdCount(): Promise<void> {
    if (!this.config.trackFdsPid) return;

    const count = await this.getFdCount(this.config.trackFdsPid);
    if (count !== null) {
      this.stats.fdSamples.push({
        timestamp: performance.now() - this.startTimestamp,
        count,
      });
    }
  }

  private startFdTracking(): void {
    if (!this.config.trackFdsPid) return;

    // Check if /proc exists (Linux only)
    if (!fs.existsSync('/proc')) {
      console.log(
        'WARNING: FD tracking only available on Linux (/proc not found)',
      );
      return;
    }

    // Take initial sample
    this.sampleFdCount();

    // Set up periodic sampling
    this.fdTrackingInterval = setInterval(() => {
      this.sampleFdCount();
    }, this.config.fdSampleIntervalMs);

    console.log(`FD tracking enabled for PID ${this.config.trackFdsPid}`);
  }

  private async stopFdTracking(): Promise<void> {
    if (this.fdTrackingInterval) {
      clearInterval(this.fdTrackingInterval);
      this.fdTrackingInterval = undefined;
    }
    // Take final sample
    await this.sampleFdCount();
  }

  async start(): Promise<void> {
    this.running = true;
    this.startTimestamp = performance.now();
    this.stats.startTime = this.startTimestamp;

    const limit = pLimit(this.config.concurrency);
    const activeTasks: Set<Promise<void>> = new Set();

    console.log(`Concurrency: ${this.config.concurrency}`);
    if (this.config.count) {
      console.log(`Target count: ${this.config.count.toLocaleString()}`);
    }
    if (this.config.durationSeconds) {
      console.log(`Duration: ${this.config.durationSeconds}s`);
    }
    if (!this.config.count && !this.config.durationSeconds) {
      console.log('Mode: continuous (Ctrl+C to stop)');
    }
    console.log('');

    // Start FD tracking if configured
    this.startFdTracking();

    while (this.running && !this.shouldStop()) {
      // Keep the concurrent request pool full
      while (
        activeTasks.size < this.config.concurrency &&
        this.running &&
        !this.shouldStop()
      ) {
        const task = limit(async () => {
          if (!this.running || this.shouldStop()) return;

          const offset = this.generateRandomOffset();
          const result = await this.fetchChunk(offset);

          this.updateStatistics(result);
          this.logVerboseResult(result);
          this.logProgress();

          if (this.config.delay > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.config.delay),
            );
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

    // Stop FD tracking
    await this.stopFdTracking();
  }

  stop(): void {
    this.running = false;
  }

  private calculatePercentile(times: number[], percentile: number): number {
    if (times.length === 0) return 0;

    const sorted = [...times].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  displayResults(): void {
    const duration = (performance.now() - this.startTimestamp) / 1000;
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    const durationStr =
      minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds.toFixed(1)}s`;

    const successRate =
      this.stats.totalRequests > 0
        ? ((this.stats.successes / this.stats.totalRequests) * 100).toFixed(2)
        : '0.00';

    const failureRate =
      this.stats.totalRequests > 0
        ? ((this.stats.failures / this.stats.totalRequests) * 100).toFixed(2)
        : '0.00';

    const rps = (this.stats.totalRequests / duration).toFixed(1);

    console.log('\n=== Chunk Retrieval Load Test Results ===');
    console.log(`Gateway: ${this.config.gateway}`);
    console.log(`Duration: ${durationStr}`);
    console.log(`Concurrency: ${this.config.concurrency}`);
    console.log(`Requests/sec: ${rps}`);
    console.log(
      `Total Requests: ${this.stats.totalRequests.toLocaleString()}`,
    );
    console.log(
      `Successes: ${this.stats.successes.toLocaleString()} (${successRate}%)`,
    );
    console.log(
      `Failures: ${this.stats.failures.toLocaleString()} (${failureRate}%)`,
    );

    // Status code breakdown
    if (this.stats.statusCodeCounts.size > 0) {
      console.log('\nStatus Codes:');
      const sortedCodes = Array.from(
        this.stats.statusCodeCounts.entries(),
      ).sort(([, a], [, b]) => b - a);

      for (const [code, count] of sortedCodes) {
        const statusText = this.getStatusText(code);
        console.log(`  - ${code} ${statusText}: ${count.toLocaleString()}`);
      }
    }

    // Error code breakdown
    if (this.stats.errorCodeCounts.size > 0) {
      console.log('\nError Codes:');
      const sortedCodes = Array.from(
        this.stats.errorCodeCounts.entries(),
      ).sort(([, a], [, b]) => b - a);

      for (const [code, count] of sortedCodes) {
        const isResourceError = RESOURCE_ERRORS.has(code);
        const marker = isResourceError ? ' [RESOURCE EXHAUSTION]' : '';
        console.log(`  - ${code}: ${count.toLocaleString()}${marker}`);
      }
    }

    // Response times
    if (this.stats.responseTimes.length > 0) {
      // Use iterative approach to avoid call stack overflow for large arrays
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const time of this.stats.responseTimes) {
        if (time < min) min = time;
        if (time > max) max = time;
        sum += time;
      }
      const avg = sum / this.stats.responseTimes.length;
      const p50 = this.calculatePercentile(this.stats.responseTimes, 50);
      const p95 = this.calculatePercentile(this.stats.responseTimes, 95);
      const p99 = this.calculatePercentile(this.stats.responseTimes, 99);

      console.log('\nResponse Times:');
      console.log(`  - Min: ${min.toFixed(0)}ms`);
      console.log(`  - Max: ${max.toFixed(0)}ms`);
      console.log(`  - Avg: ${avg.toFixed(0)}ms`);
      console.log(`  - p50: ${p50.toFixed(0)}ms`);
      console.log(`  - p95: ${p95.toFixed(0)}ms`);
      console.log(`  - p99: ${p99.toFixed(0)}ms`);
    }

    // FD statistics
    if (this.stats.fdSamples.length > 0) {
      const counts = this.stats.fdSamples.map((s) => s.count);
      const initial = counts[0];
      const final = counts[counts.length - 1];
      const min = Math.min(...counts);
      const max = Math.max(...counts);
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      const delta = final - initial;

      console.log(`\nFile Descriptor Tracking (PID: ${this.config.trackFdsPid}):`);
      console.log(`  - Initial: ${initial}`);
      console.log(`  - Final: ${final}`);
      console.log(`  - Min: ${min}`);
      console.log(`  - Max: ${max}`);
      console.log(`  - Average: ${avg.toFixed(1)}`);
      console.log(`  - Delta: ${delta >= 0 ? '+' : ''}${delta}`);

      if (max > initial * 1.5) {
        console.log('  - WARNING: Significant FD growth detected!');
      }
    }
  }
}

function parseArguments(): TestConfig {
  const args = process.argv.slice(2);
  const config: TestConfig = {
    gateway: '',
    concurrency: 10,
    delay: 0,
    timeout: 30000,
    verbose: false,
    fdSampleIntervalMs: 1000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--gateway':
        if (!nextArg) {
          throw new Error('--gateway requires a URL');
        }
        config.gateway = nextArg;
        i++;
        break;

      case '--chain-url':
        if (!nextArg) {
          throw new Error('--chain-url requires a URL');
        }
        config.chainUrl = nextArg;
        i++;
        break;

      case '--concurrency':
        if (!nextArg || isNaN(parseInt(nextArg)) || parseInt(nextArg) < 1) {
          throw new Error('--concurrency requires a positive number');
        }
        config.concurrency = parseInt(nextArg);
        i++;
        break;

      case '--count':
        if (!nextArg || isNaN(parseInt(nextArg)) || parseInt(nextArg) < 1) {
          throw new Error('--count requires a positive number');
        }
        config.count = parseInt(nextArg);
        i++;
        break;

      case '--duration':
        if (!nextArg || isNaN(parseInt(nextArg)) || parseInt(nextArg) < 1) {
          throw new Error('--duration requires a positive number (seconds)');
        }
        config.durationSeconds = parseInt(nextArg);
        i++;
        break;

      case '--delay':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--delay requires a number in milliseconds');
        }
        config.delay = parseInt(nextArg);
        i++;
        break;

      case '--timeout':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--timeout requires a number in milliseconds');
        }
        config.timeout = parseInt(nextArg);
        i++;
        break;

      case '--max-offset':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--max-offset requires a number');
        }
        config.maxOffset = parseInt(nextArg);
        i++;
        break;

      case '--track-fds':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--track-fds requires a PID');
        }
        config.trackFdsPid = parseInt(nextArg);
        i++;
        break;

      case '--fd-interval':
        if (!nextArg || isNaN(parseInt(nextArg)) || parseInt(nextArg) < 100) {
          throw new Error(
            '--fd-interval requires a number >= 100 (milliseconds)',
          );
        }
        config.fdSampleIntervalMs = parseInt(nextArg);
        i++;
        break;

      case '--verbose':
        config.verbose = true;
        break;

      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break; // unreachable but satisfies linter

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config.gateway) {
    throw new Error('--gateway is required');
  }

  // Normalize gateway URL
  if (
    !config.gateway.startsWith('http://') &&
    !config.gateway.startsWith('https://')
  ) {
    config.gateway = `https://${config.gateway}`;
  }

  // Normalize chain URL if provided
  if (
    config.chainUrl &&
    !config.chainUrl.startsWith('http://') &&
    !config.chainUrl.startsWith('https://')
  ) {
    config.chainUrl = `https://${config.chainUrl}`;
  }

  return config;
}

function printUsage(): void {
  console.log(`
Chunk Retrieval Load Testing Tool

Usage: ./tools/test-chunk-retrieval [options]

Options:
  --gateway <url>        Gateway URL to test (required)
  --chain-url <url>      Chain reference URL for weave size discovery
  --concurrency <n>      Number of parallel requests (default: 10)
  --count <n>            Stop after N total requests
  --duration <seconds>   Run for specified duration
  --delay <ms>           Delay between requests per slot (default: 0)
  --timeout <ms>         Request timeout in milliseconds (default: 30000)
  --max-offset <number>  Override maximum offset for testing
  --track-fds <pid>      Track file descriptors for specified PID
  --fd-interval <ms>     FD sampling interval in ms (default: 1000)
  --verbose              Show detailed logs for each request
  --help, -h             Show this help message

Examples:
  # Basic load test for 60 seconds
  ./tools/test-chunk-retrieval --gateway http://localhost:4000 --duration 60

  # High concurrency with FD tracking
  ./tools/test-chunk-retrieval --gateway http://localhost:4000 \\
    --concurrency 100 --duration 120 --track-fds $(pgrep -f "node.*system")

  # Fixed count test
  ./tools/test-chunk-retrieval --gateway http://localhost:4000 \\
    --count 5000 --concurrency 50

  # Stress test
  ./tools/test-chunk-retrieval --gateway http://localhost:4000 \\
    --concurrency 500 --duration 300
`);
}

async function main(): Promise<void> {
  try {
    const config = parseArguments();
    const tester = new ChunkLoadTester(config);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, stopping...');
      tester.stop();
    });

    await tester.initialize();
    await tester.start();
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
