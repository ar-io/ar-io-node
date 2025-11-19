/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios, { AxiosError } from 'axios';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MonitorConfig {
  startDataNode: number;
  endDataNode: number;
  startTipNode: number;
  endTipNode: number;
  interval: number;
  timeout: number;
  verbose: boolean;
  outputFile?: string;
  skipJson: boolean;
}

interface EndpointResult {
  url: string;
  success: boolean;
  statusCode: number;
  responseTime: number;
  error?: string;
  timestamp: number;
}

interface EndpointStats {
  url: string;
  totalAttempts: number;
  successes: number;
  failures: number;
  responseTimes: number[];
  lastError?: string;
}

interface OverallStats {
  startTime: number;
  totalCycles: number;
  endpoints: Map<string, EndpointStats>;
}

type ms = number;

class HistoricalDHAChunkNodesMonitor {
  private config: MonitorConfig;
  private stats: OverallStats;
  private running: boolean = false;
  private endpoints: string[];
  private results: EndpointResult[] = [];

  constructor(config: MonitorConfig) {
    this.config = config;

    // Generate data-N endpoints
    const dataCount = config.endDataNode - config.startDataNode + 1;
    const dataEndpoints = Array.from({ length: dataCount }, (_, i) =>
      `http://data-${config.startDataNode + i}.arweave.xyz:1984`
    );

    // Generate tip-N endpoints
    const tipCount = config.endTipNode - config.startTipNode + 1;
    const tipEndpoints = Array.from({ length: tipCount }, (_, i) =>
      `http://tip-${config.startTipNode + i}.arweave.xyz:1984`
    );

    // Combine both sets of endpoints
    this.endpoints = [...dataEndpoints, ...tipEndpoints];

    this.stats = {
      startTime: Date.now(),
      totalCycles: 0,
      endpoints: new Map(),
    };

    // Initialize stats for each endpoint
    for (const url of this.endpoints) {
      this.stats.endpoints.set(url, {
        url,
        totalAttempts: 0,
        successes: 0,
        failures: 0,
        responseTimes: [],
      });
    }
  }

  async start(): Promise<void> {
    console.log('Historical DHA Chunk Nodes Monitor');
    console.log('==================================\n');
    console.log(`Monitoring ${this.endpoints.length} endpoints:`);
    this.endpoints.forEach((url) => console.log(`  - ${url}`));
    console.log(`\nCheck interval: ${this.config.interval}ms`);
    console.log(`Request timeout: ${this.config.timeout}ms`);
    if (this.config.outputFile) {
      console.log(`Output file: ${this.config.outputFile}`);
    }
    console.log('\nPress Ctrl+C to stop\n');

    this.running = true;

    // Set up graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\nShutting down...');
      this.running = false;
    });

    // Main monitoring loop
    while (this.running) {
      await this.checkAllEndpoints();
      this.stats.totalCycles++;

      if (this.running) {
        await this.sleep(this.config.interval);
      }
    }

    // Save results and display final stats
    await this.finalize();
  }

  private async checkAllEndpoints(): Promise<void> {
    const startTime = Date.now();

    if (this.config.verbose) {
      console.log(`\n[${new Date().toISOString()}] Starting check cycle ${this.stats.totalCycles + 1}...`);
    }

    // Check all endpoints in parallel
    const results = await Promise.all(
      this.endpoints.map((url) => this.checkEndpoint(url))
    );

    // Update stats and store results
    for (const result of results) {
      const endpointStats = this.stats.endpoints.get(result.url)!;
      endpointStats.totalAttempts++;

      if (result.success) {
        endpointStats.successes++;
        endpointStats.responseTimes.push(result.responseTime);
      } else {
        endpointStats.failures++;
        endpointStats.lastError = result.error;
      }

      this.results.push(result);
    }

    // Display results
    this.displayResults(results);

    const cycleTime = Date.now() - startTime;
    if (this.config.verbose) {
      console.log(`Cycle completed in ${cycleTime}ms`);
    }
  }

  private async checkEndpoint(url: string): Promise<EndpointResult> {
    const startTime = performance.now();

    try {
      const response = await axios.get(`${url}/`, {
        timeout: this.config.timeout,
        headers: { 'User-Agent': 'ar-io-node-dha-monitor/1.0' },
        validateStatus: () => true, // Accept all status codes
      });

      const responseTime = performance.now() - startTime;

      return {
        url,
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        responseTime,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      const responseTime = performance.now() - startTime;
      let errorMessage = 'Unknown error';

      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Timeout';
      } else if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'Host not found';
      } else if (error.code === 'ETIMEDOUT') {
        errorMessage = 'Connection timeout';
      } else if (error instanceof AxiosError) {
        errorMessage = error.message;
      } else if (error.message) {
        errorMessage = error.message;
      }

      return {
        url,
        success: false,
        statusCode: 0,
        responseTime,
        error: errorMessage,
        timestamp: Date.now(),
      };
    }
  }

  private displayResults(results: EndpointResult[]): void {
    console.log('\n┌────────────────────────────────────────┬────────┬───────────┬──────────────┐');
    console.log('│ Endpoint                               │ Status │ Time (ms) │ Success %    │');
    console.log('├────────────────────────────────────────┼────────┼───────────┼──────────────┤');

    for (const result of results) {
      const endpointStats = this.stats.endpoints.get(result.url)!;
      const successRate = endpointStats.totalAttempts > 0
        ? ((endpointStats.successes / endpointStats.totalAttempts) * 100).toFixed(1)
        : '0.0';

      const endpointName = result.url.replace('http://', '');
      const status = result.success
        ? String(result.statusCode)
        : (result.error || 'ERROR').substring(0, 6);
      const time = result.success
        ? result.responseTime.toFixed(1)
        : 'N/A';
      const rate = `${successRate}%`;

      console.log(
        `│ ${endpointName.padEnd(38)} │ ${status.padStart(6)} │ ${time.padStart(9)} │ ${rate.padStart(12)} │`
      );
    }

    console.log('└────────────────────────────────────────┴────────┴───────────┴──────────────┘');

    // Display overall statistics
    this.displayOverallStats();
  }

  private displayOverallStats(): void {
    const allResponseTimes: number[] = [];
    let totalAttempts = 0;
    let totalSuccesses = 0;

    for (const stats of this.stats.endpoints.values()) {
      totalAttempts += stats.totalAttempts;
      totalSuccesses += stats.successes;
      allResponseTimes.push(...stats.responseTimes);
    }

    if (allResponseTimes.length === 0) {
      return;
    }

    const sorted = allResponseTimes.sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = sorted.reduce((sum, t) => sum + t, 0) / sorted.length;
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

    const overallSuccessRate = totalAttempts > 0
      ? ((totalSuccesses / totalAttempts) * 100).toFixed(1)
      : '0.0';

    const runtime = Math.floor((Date.now() - this.stats.startTime) / 1000);

    console.log('\nOverall Statistics:');
    console.log(`  Cycles: ${this.stats.totalCycles} | Runtime: ${runtime}s | Success Rate: ${overallSuccessRate}%`);
    console.log(`  Response Times (ms) - Min: ${min.toFixed(1)} | Max: ${max.toFixed(1)} | Avg: ${avg.toFixed(1)} | Median: ${median.toFixed(1)}`);
  }

  private async finalize(): Promise<void> {
    console.log('\n\nFinal Statistics');
    console.log('================\n');

    // Display per-endpoint summary
    console.log('Per-Endpoint Summary:');
    console.log('┌────────────────────────────────────────┬──────────┬──────────┬──────────────┬──────────────┐');
    console.log('│ Endpoint                               │ Attempts │ Successes│ Success %    │ Avg Time (ms)│');
    console.log('├────────────────────────────────────────┼──────────┼──────────┼──────────────┼──────────────┤');

    for (const stats of this.stats.endpoints.values()) {
      const endpointName = stats.url.replace('http://', '');
      const attempts = String(stats.totalAttempts);
      const successes = String(stats.successes);
      const successRate = stats.totalAttempts > 0
        ? `${((stats.successes / stats.totalAttempts) * 100).toFixed(1)}%`
        : 'N/A';
      const avgTime = stats.responseTimes.length > 0
        ? (stats.responseTimes.reduce((sum, t) => sum + t, 0) / stats.responseTimes.length).toFixed(1)
        : 'N/A';

      console.log(
        `│ ${endpointName.padEnd(38)} │ ${attempts.padStart(8)} │ ${successes.padStart(9)} │ ${successRate.padStart(12)} │ ${avgTime.padStart(13)} │`
      );
    }

    console.log('└────────────────────────────────────────┴──────────┴──────────┴──────────────┴──────────────┘');

    // Save JSON output
    if (!this.config.skipJson) {
      await this.saveJsonOutput();
    }
  }

  private async saveJsonOutput(): Promise<void> {
    const outputFile = this.config.outputFile ||
      `dha-monitor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    const output = {
      metadata: {
        startTime: new Date(this.stats.startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationSeconds: Math.floor((Date.now() - this.stats.startTime) / 1000),
        totalCycles: this.stats.totalCycles,
        dataNodeRange: {
          start: this.config.startDataNode,
          end: this.config.endDataNode,
        },
        tipNodeRange: {
          start: this.config.startTipNode,
          end: this.config.endTipNode,
        },
        interval: this.config.interval,
        timeout: this.config.timeout,
      },
      endpointStats: Array.from(this.stats.endpoints.values()).map(stats => ({
        url: stats.url,
        totalAttempts: stats.totalAttempts,
        successes: stats.successes,
        failures: stats.failures,
        successRate: stats.totalAttempts > 0
          ? (stats.successes / stats.totalAttempts) * 100
          : 0,
        responseTimes: {
          min: stats.responseTimes.length > 0 ? Math.min(...stats.responseTimes) : null,
          max: stats.responseTimes.length > 0 ? Math.max(...stats.responseTimes) : null,
          avg: stats.responseTimes.length > 0
            ? stats.responseTimes.reduce((sum, t) => sum + t, 0) / stats.responseTimes.length
            : null,
          median: this.calculateMedian(stats.responseTimes),
        },
        lastError: stats.lastError,
      })),
      rawResults: this.results,
    };

    try {
      await fs.promises.writeFile(outputFile, JSON.stringify(output, null, 2));
      console.log(`\nResults saved to: ${outputFile}`);
    } catch (error: any) {
      console.error(`Failed to save JSON output: ${error.message}`);
    }
  }

  private calculateMedian(values: number[]): number | null {
    if (values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// CLI argument parsing
function parseArgs(): MonitorConfig {
  const args = process.argv.slice(2);
  const config: MonitorConfig = {
    startDataNode: 1,
    endDataNode: 17,
    startTipNode: 1,
    endTipNode: 5,
    interval: 30000,
    timeout: 10000,
    verbose: false,
    skipJson: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start-data-node':
        config.startDataNode = parseInt(args[++i], 10);
        break;
      case '--end-data-node':
        config.endDataNode = parseInt(args[++i], 10);
        break;
      case '--start-tip-node':
        config.startTipNode = parseInt(args[++i], 10);
        break;
      case '--end-tip-node':
        config.endTipNode = parseInt(args[++i], 10);
        break;
      case '--interval':
        config.interval = parseInt(args[++i], 10);
        break;
      case '--timeout':
        config.timeout = parseInt(args[++i], 10);
        break;
      case '--output':
        config.outputFile = args[++i];
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--no-json':
        config.skipJson = true;
        break;
      case '--help':
        console.log(`
Historical DHA Chunk Nodes Monitor

Usage: monitor-historical-dha-chunk-nodes [options]

Options:
  --start-data-node <n>  First data node to monitor (default: 1)
  --end-data-node <n>    Last data node to monitor (default: 17)
  --start-tip-node <n>   First tip node to monitor (default: 1)
  --end-tip-node <n>     Last tip node to monitor (default: 5)
  --interval <ms>        Delay between check cycles (default: 30000)
  --timeout <ms>         Request timeout (default: 10000)
  --output <file>        JSON output file path (default: auto-generated)
  --verbose              Enable detailed logging
  --no-json              Skip JSON file output
  --help                 Show this help message

Examples:
  ./tools/monitor-historical-dha-chunk-nodes
  ./tools/monitor-historical-dha-chunk-nodes --start-data-node 1 --end-data-node 10
  ./tools/monitor-historical-dha-chunk-nodes --start-tip-node 1 --end-tip-node 3
  ./tools/monitor-historical-dha-chunk-nodes --interval 60000 --verbose
  ./tools/monitor-historical-dha-chunk-nodes --output monitoring-results.json
`);
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        console.error('Use --help for usage information');
        process.exit(1);
    }
  }

  // Validate data node range
  if (config.startDataNode < 1) {
    console.error('Error: --start-data-node must be at least 1');
    process.exit(1);
  }

  if (config.endDataNode < config.startDataNode) {
    console.error('Error: --end-data-node must be greater than or equal to --start-data-node');
    process.exit(1);
  }

  // Validate tip node range
  if (config.startTipNode < 1) {
    console.error('Error: --start-tip-node must be at least 1');
    process.exit(1);
  }

  if (config.endTipNode < config.startTipNode) {
    console.error('Error: --end-tip-node must be greater than or equal to --start-tip-node');
    process.exit(1);
  }

  return config;
}

// Main execution
async function main() {
  const config = parseArgs();
  const monitor = new HistoricalDHAChunkNodesMonitor(config);

  try {
    await monitor.start();
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
