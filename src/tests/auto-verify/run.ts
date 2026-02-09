/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadConfig } from './config.js';
import { compareAllSources } from './compare.js';
import {
  cleanGatewayState,
  exportParquet,
  startGateway,
  stopGateway,
  waitForIndexingComplete,
} from './gateway-control.js';
import {
  printIterationSummary,
  writeFinalSummary,
  writeIterationReport,
} from './report.js';
import { SqliteSource } from './sources/sqlite-source.js';
import { ParquetSource } from './sources/parquet-source.js';
import { GraphqlSource } from './sources/graphql-source.js';
import { BundleParserSource } from './sources/bundle-parser-source.js';
import { BlockRange, IterationResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const blockRanges: BlockRange[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'block-ranges.json'), 'utf8'),
  );

  // Determine which ranges to run
  let rangesToRun = [...blockRanges];
  if (config.iterations > 0 && config.iterations < rangesToRun.length) {
    // Shuffle and take a subset
    for (let i = rangesToRun.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rangesToRun[i], rangesToRun[j]] = [rangesToRun[j], rangesToRun[i]];
    }
    rangesToRun = rangesToRun.slice(0, config.iterations);
  }

  console.log(`Auto-verify: running ${rangesToRun.length} iteration(s)`);
  console.log(`Results directory: ${config.resultsDir}`);
  fs.mkdirSync(config.resultsDir, { recursive: true });

  const results: IterationResult[] = [];

  for (let i = 0; i < rangesToRun.length; i++) {
    const range = rangesToRun[i];
    console.log(
      `\n=== Iteration ${i} | blocks ${range.start}-${range.end} | ${range.description} ===`,
    );

    const iterStart = Date.now();

    try {
      // 1. Clean gateway state
      await cleanGatewayState(config);

      // 2. Start gateway with range config
      startGateway(range.start, range.end);

      // 3. Wait for indexing completion
      await waitForIndexingComplete(config, range.end);

      // 4. Export to Parquet
      const stagingDir = await exportParquet(config, range.start, range.end);

      // 5. Collect data from all sources
      console.log('Collecting data from all sources...');

      const sqliteSource = new SqliteSource(config.bundlesDbPath);
      const parquetSource = new ParquetSource(stagingDir);
      const graphqlSource = new GraphqlSource(config.gatewayPort);
      const bundleParserSource = new BundleParserSource(
        config.bundlesDbPath,
        config.coreDbPath,
        config.referenceUrl,
      );

      const [sqliteItems, parquetItems, graphqlItems, bundleParserItems] =
        await Promise.all([
          sqliteSource.getDataItems(range.start, range.end),
          parquetSource.getDataItems(range.start, range.end),
          graphqlSource.getDataItems(range.start, range.end),
          bundleParserSource.getDataItems(range.start, range.end),
        ]);

      console.log(
        `  SQLite: ${sqliteItems.length}, Parquet: ${parquetItems.length}, GraphQL: ${graphqlItems.length}, BundleParser: ${bundleParserItems.length}`,
      );

      // 6. Run comparison
      const discrepancies = compareAllSources([
        { name: 'sqlite', items: sqliteItems },
        { name: 'parquet', items: parquetItems },
        { name: 'graphql', items: graphqlItems },
        { name: 'bundle-parser', items: bundleParserItems },
      ]);

      const totalDataItems = Math.max(
        sqliteItems.length,
        parquetItems.length,
        graphqlItems.length,
        bundleParserItems.length,
      );

      const result: IterationResult = {
        blockRange: range,
        totalDataItems,
        discrepancies,
        sourceCounts: {
          sqlite: sqliteItems.length,
          parquet: parquetItems.length,
          graphql: graphqlItems.length,
          'bundle-parser': bundleParserItems.length,
        },
        durationMs: Date.now() - iterStart,
      };

      // 7. Write reports
      writeIterationReport(config.resultsDir, i, result);
      printIterationSummary(i, result);
      results.push(result);

      // 8. Stop gateway
      stopGateway();

      // 9. Fail fast check
      if (config.failFast && discrepancies.length > 0) {
        console.log('\nFail-fast enabled: stopping on first failure.');
        writeFinalSummary(config.resultsDir, results);
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`Iteration ${i} failed with error: ${err.message}`);
      stopGateway();

      results.push({
        blockRange: range,
        totalDataItems: 0,
        discrepancies: [
          {
            type: 'count_mismatch',
            sources: {},
            details: `Iteration error: ${err.message}`,
          },
        ],
        sourceCounts: {},
        durationMs: Date.now() - iterStart,
      });

      if (config.failFast) {
        writeFinalSummary(config.resultsDir, results);
        process.exit(1);
      }
    }
  }

  writeFinalSummary(config.resultsDir, results);

  const passed = results.filter((r) => r.discrepancies.length === 0).length;
  const failed = results.filter((r) => r.discrepancies.length > 0).length;
  console.log(
    `\nAuto-verify complete: ${passed} passed, ${failed} failed out of ${results.length} iterations.`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
