/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios, { AxiosError } from 'axios';
import { performance } from 'node:perf_hooks';

interface SamplingConfig {
  gateway: string;
  chainUrl?: string;
  delay: number;
  timeout: number;
  verbose: boolean;
  maxOffset?: number;
}

interface RequestResult {
  success: boolean;
  statusCode: number;
  responseTime: ms;
  error?: string;
}

interface Statistics {
  totalAttempts: number;
  successes: number;
  failures: number;
  errorCounts: Map<string, number>;
  responseTimes: number[];
  startTime: number;
}

type ms = number;

class ChunkOffsetSampler {
  private config: SamplingConfig;
  private stats: Statistics;
  private currentWeaveSize: number = 0;
  private running: boolean = false;

  constructor(config: SamplingConfig) {
    this.config = config;
    this.stats = {
      totalAttempts: 0,
      successes: 0,
      failures: 0,
      errorCounts: new Map(),
      responseTimes: [],
      startTime: performance.now(),
    };
  }

  async initialize(): Promise<void> {
    console.log(`Initializing chunk offset sampler for gateway: ${this.config.gateway}`);
    if (this.config.chainUrl) {
      console.log(`Using chain reference: ${this.config.chainUrl}`);
    }

    try {
      // Get current weave size from chain reference or gateway
      this.currentWeaveSize = await this.getCurrentWeaveSize();

      if (this.config.maxOffset && this.config.maxOffset < this.currentWeaveSize) {
        this.currentWeaveSize = this.config.maxOffset;
        console.log(`Using custom max offset: ${this.currentWeaveSize.toLocaleString()} bytes`);
      } else {
        console.log(`Current weave size: ${this.currentWeaveSize.toLocaleString()} bytes`);
      }
    } catch (error: any) {
      throw new Error(`Failed to initialize: ${error.message}`);
    }
  }

  async getCurrentWeaveSize(): Promise<number> {
    // Use chain URL if provided, otherwise use the gateway
    const sourceUrl = this.config.chainUrl || this.config.gateway;

    try {
      // First try to get network info
      const response = await axios.get(`${sourceUrl}/info`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-chunk-sampler/1.0' },
      });

      if (response.data && typeof response.data.weave_size === 'string') {
        return parseInt(response.data.weave_size, 10);
      }

      // Fallback: get height and then latest block
      const heightResponse = await axios.get(`${sourceUrl}/height`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-chunk-sampler/1.0' },
      });

      const height = heightResponse.data;
      const blockResponse = await axios.get(`${sourceUrl}/block/height/${height}`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-chunk-sampler/1.0' },
      });

      if (blockResponse.data && typeof blockResponse.data.weave_size === 'string') {
        return parseInt(blockResponse.data.weave_size, 10);
      }

      throw new Error('Unable to determine weave size from gateway');
    } catch (error: any) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      }
      throw new Error(`Network error: ${error.message}`);
    }
  }

  generateRandomOffset(): number {
    return Math.floor(Math.random() * this.currentWeaveSize);
  }

  async sampleChunkOffset(offset: number): Promise<RequestResult> {
    const startTime = performance.now();

    try {
      const response = await axios.get(`${this.config.gateway}/chunk/${offset}`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-chunk-sampler/1.0' },
        validateStatus: () => true, // Don't throw on non-2xx status codes
      });

      const responseTime = performance.now() - startTime;

      return {
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        responseTime,
      };
    } catch (error: any) {
      const responseTime = performance.now() - startTime;

      if (error.code === 'ECONNABORTED') {
        return {
          success: false,
          statusCode: 0,
          responseTime,
          error: 'Timeout',
        };
      }

      return {
        success: false,
        statusCode: 0,
        responseTime,
        error: error.message,
      };
    }
  }

  updateStatistics(result: RequestResult): void {
    this.stats.totalAttempts++;

    if (result.success) {
      this.stats.successes++;
    } else {
      this.stats.failures++;

      const errorKey = result.error || `${result.statusCode} ${this.getStatusText(result.statusCode)}`;
      const currentCount = this.stats.errorCounts.get(errorKey) || 0;
      this.stats.errorCounts.set(errorKey, currentCount + 1);
    }

    this.stats.responseTimes.push(result.responseTime);
  }

  getStatusText(statusCode: number): string {
    const statusTexts: Record<number, string> = {
      0: 'Network Error',
      404: 'Not Found',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };

    return statusTexts[statusCode] || 'Unknown';
  }

  logProgress(): void {
    if (this.stats.totalAttempts % 100 === 0) {
      const successRate = (this.stats.successes / this.stats.totalAttempts * 100).toFixed(1);
      console.log(`[Sampling... ${this.stats.totalAttempts} requests completed, ${successRate}% success rate]`);
    }
  }

  logVerboseResult(offset: number, result: RequestResult): void {
    if (!this.config.verbose) return;

    const status = result.success ? '✓' : '✗';
    const time = result.responseTime.toFixed(0);
    const error = result.error ? ` (${result.error})` : '';

    console.log(`${status} Offset ${offset}: ${result.statusCode} in ${time}ms${error}`);
  }

  calculatePercentile(times: number[], percentile: number): number {
    if (times.length === 0) return 0;

    const sorted = [...times].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  displayFinalStatistics(): void {
    const duration = (performance.now() - this.stats.startTime) / 1000;
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    const successRate = this.stats.totalAttempts > 0
      ? (this.stats.successes / this.stats.totalAttempts * 100).toFixed(2)
      : '0.00';

    const failureRate = this.stats.totalAttempts > 0
      ? (this.stats.failures / this.stats.totalAttempts * 100).toFixed(2)
      : '0.00';

    console.log('\n=== Chunk Offset Sampling Results ===');
    console.log(`Gateway: ${this.config.gateway}`);
    console.log(`Duration: ${durationStr}`);
    console.log(`Total Attempts: ${this.stats.totalAttempts.toLocaleString()}`);
    console.log(`Successes: ${this.stats.successes.toLocaleString()} (${successRate}%)`);
    console.log(`Failures: ${this.stats.failures.toLocaleString()} (${failureRate}%)`);

    if (this.stats.errorCounts.size > 0) {
      const sortedErrors = Array.from(this.stats.errorCounts.entries())
        .sort(([, a], [, b]) => b - a);

      for (const [error, count] of sortedErrors) {
        console.log(`  - ${error}: ${count.toLocaleString()}`);
      }
    }

    if (this.stats.responseTimes.length > 0) {
      const min = Math.min(...this.stats.responseTimes);
      const max = Math.max(...this.stats.responseTimes);
      const avg = this.stats.responseTimes.reduce((a, b) => a + b, 0) / this.stats.responseTimes.length;
      const p50 = this.calculatePercentile(this.stats.responseTimes, 50);
      const p95 = this.calculatePercentile(this.stats.responseTimes, 95);
      const p99 = this.calculatePercentile(this.stats.responseTimes, 99);

      console.log('Response Times:');
      console.log(`  - Min: ${min.toFixed(0)}ms`);
      console.log(`  - Max: ${max.toFixed(0)}ms`);
      console.log(`  - Average: ${avg.toFixed(0)}ms`);
      console.log(`  - p50: ${p50.toFixed(0)}ms`);
      console.log(`  - p95: ${p95.toFixed(0)}ms`);
      console.log(`  - p99: ${p99.toFixed(0)}ms`);
    }
  }

  async start(): Promise<void> {
    this.running = true;

    console.log('Press Ctrl+C to stop and view statistics...\n');

    while (this.running) {
      const offset = this.generateRandomOffset();
      const result = await this.sampleChunkOffset(offset);

      this.updateStatistics(result);
      this.logVerboseResult(offset, result);
      this.logProgress();

      if (this.config.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.config.delay));
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

function parseArguments(): SamplingConfig {
  const args = process.argv.slice(2);
  const config: SamplingConfig = {
    gateway: '',
    delay: 100,
    timeout: 300000,
    verbose: false,
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

      case '--verbose':
        config.verbose = true;
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

  if (!config.gateway) {
    throw new Error('--gateway is required');
  }

  // Normalize gateway URL
  if (!config.gateway.startsWith('http://') && !config.gateway.startsWith('https://')) {
    config.gateway = `https://${config.gateway}`;
  }

  // Normalize chain URL if provided
  if (config.chainUrl && !config.chainUrl.startsWith('http://') && !config.chainUrl.startsWith('https://')) {
    config.chainUrl = `https://${config.chainUrl}`;
  }

  return config;
}

function printUsage(): void {
  console.log(`
Chunk Offset Sampling Tool

Usage: ./tools/sample-chunk-offsets [options]

Options:
  --gateway <url>        Gateway URL to test (required)
  --chain-url <url>      Chain reference URL for weave size discovery (optional)
  --delay <ms>           Delay between requests in milliseconds (default: 100)
  --timeout <ms>         Request timeout in milliseconds (default: 300000)
  --max-offset <number>  Override maximum offset for testing (optional)
  --verbose              Show detailed logs for each request
  --help, -h             Show this help message

Examples:
  ./tools/sample-chunk-offsets --gateway https://ar-io.dev
  ./tools/sample-chunk-offsets --gateway http://localhost:4000 --chain-url https://arweave.net
  ./tools/sample-chunk-offsets --gateway http://localhost:4000 --delay 500 --verbose
  ./tools/sample-chunk-offsets --gateway https://gateway.example.com --timeout 5000
`);
}

async function main(): Promise<void> {
  try {
    const config = parseArguments();
    const sampler = new ChunkOffsetSampler(config);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, stopping sampler...');
      sampler.stop();
      sampler.displayFinalStatistics();
      process.exit(0);
    });

    await sampler.initialize();
    await sampler.start();
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    console.log('\nUse --help for usage information');
    process.exit(1);
  }
}

// Run the tool
main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});