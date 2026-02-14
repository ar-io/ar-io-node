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
import {
  compareAllBlocks,
  compareAllSources,
  compareAllTransactions,
} from './compare.js';
import {
  cleanClickHouseTables,
  cleanGatewayState,
  exportParquet,
  flushToStable,
  importToClickHouse,
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
import { BundleParserSource } from './sources/bundle-parser-source.js';
import { ClickHouseSource } from './sources/clickhouse-source.js';
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
      startGateway(config, range.start, range.end);

      // 3. Wait for indexing completion
      await waitForIndexingComplete(config, range.end);

      // 4. Prefetch bundle data from local gateway before stopping it
      const bundleParserSource = new BundleParserSource(
        config.bundlesDbPath,
        config.coreDbPath,
        config.referenceUrl,
      );
      await bundleParserSource.prefetchBundles(
        range.start,
        range.end,
        config.gatewayUrl,
      );

      // 5. Stop gateway and flush new data to stable tables
      stopGateway();
      flushToStable(config, range.end);

      // 6. Export to Parquet
      const stagingDir = await exportParquet(config, range.start, range.end);

      // 6b. Optionally import to ClickHouse
      if (config.clickhouseUrl !== null) {
        await cleanClickHouseTables(config);
        importToClickHouse(config, stagingDir);
      }

      // 7. Collect data from all sources
      console.log('Collecting data from all sources...');

      const sqliteSource = new SqliteSource(
        config.bundlesDbPath,
        config.coreDbPath,
      );
      const parquetSource = new ParquetSource(stagingDir);
      const clickhouseSource =
        config.clickhouseUrl !== null
          ? new ClickHouseSource(config.clickhouseUrl)
          : null;

      const dataPromises: Promise<any>[] = [
        sqliteSource.getBlocks(range.start, range.end),
        parquetSource.getBlocks(range.start, range.end),
        sqliteSource.getDataItems(range.start, range.end),
        parquetSource.getDataItems(range.start, range.end),
        bundleParserSource.getDataItems(range.start, range.end),
        sqliteSource.getTransactions(range.start, range.end),
        parquetSource.getTransactions(range.start, range.end),
      ];

      if (clickhouseSource) {
        dataPromises.push(
          clickhouseSource.getDataItems(range.start, range.end),
          clickhouseSource.getTransactions(range.start, range.end),
        );
      }

      const dataResults = await Promise.all(dataPromises);

      const sqliteBlocks = dataResults[0];
      const parquetBlocks = dataResults[1];
      const sqliteItems = dataResults[2];
      const parquetItems = dataResults[3];
      const bundleParserItems = dataResults[4];
      const sqliteTxs = dataResults[5];
      const parquetTxs = dataResults[6];
      const clickhouseItems = clickhouseSource ? dataResults[7] : null;
      const clickhouseTxs = clickhouseSource ? dataResults[8] : null;

      if (clickhouseSource) {
        await clickhouseSource.close();
      }

      console.log(
        `  Blocks - SQLite: ${sqliteBlocks.length}, Parquet: ${parquetBlocks.length}`,
      );
      const itemCounts = `SQLite: ${sqliteItems.length}, Parquet: ${parquetItems.length}, BundleParser: ${bundleParserItems.length}`;
      console.log(
        `  Data items - ${itemCounts}${clickhouseItems ? `, ClickHouse: ${clickhouseItems.length}` : ''}`,
      );
      const txCounts = `SQLite: ${sqliteTxs.length}, Parquet: ${parquetTxs.length}`;
      console.log(
        `  Transactions - ${txCounts}${clickhouseTxs ? `, ClickHouse: ${clickhouseTxs.length}` : ''}`,
      );

      // 8. Run comparison
      const blockDiscrepancies = compareAllBlocks([
        { name: 'sqlite', items: sqliteBlocks },
        { name: 'parquet', items: parquetBlocks },
      ]);

      const dataItemSources = [
        { name: 'sqlite', items: sqliteItems },
        { name: 'parquet', items: parquetItems },
        { name: 'bundle-parser', items: bundleParserItems },
      ];
      if (clickhouseItems) {
        dataItemSources.push({ name: 'clickhouse', items: clickhouseItems });
      }
      const dataItemDiscrepancies = compareAllSources(dataItemSources);

      const transactionSources = [
        { name: 'sqlite', items: sqliteTxs },
        { name: 'parquet', items: parquetTxs },
      ];
      if (clickhouseTxs) {
        transactionSources.push({ name: 'clickhouse', items: clickhouseTxs });
      }
      const transactionDiscrepancies =
        compareAllTransactions(transactionSources);

      const discrepancies = [
        ...blockDiscrepancies,
        ...dataItemDiscrepancies,
        ...transactionDiscrepancies,
      ];

      const totalBlocks = Math.max(sqliteBlocks.length, parquetBlocks.length);

      const dataItemCounts = [
        sqliteItems.length,
        parquetItems.length,
        bundleParserItems.length,
      ];
      if (clickhouseItems) dataItemCounts.push(clickhouseItems.length);
      const totalDataItems = Math.max(...dataItemCounts);

      const txCountValues = [sqliteTxs.length, parquetTxs.length];
      if (clickhouseTxs) txCountValues.push(clickhouseTxs.length);
      const totalTransactions = Math.max(...txCountValues);

      const sourceCounts: Record<string, number> = {
        sqlite: sqliteItems.length,
        parquet: parquetItems.length,
        'bundle-parser': bundleParserItems.length,
      };
      if (clickhouseItems) {
        sourceCounts['clickhouse'] = clickhouseItems.length;
      }

      const transactionSourceCounts: Record<string, number> = {
        sqlite: sqliteTxs.length,
        parquet: parquetTxs.length,
      };
      if (clickhouseTxs) {
        transactionSourceCounts['clickhouse'] = clickhouseTxs.length;
      }

      const result: IterationResult = {
        blockRange: range,
        totalBlocks,
        totalDataItems,
        totalTransactions,
        discrepancies,
        blockSourceCounts: {
          sqlite: sqliteBlocks.length,
          parquet: parquetBlocks.length,
        },
        sourceCounts,
        transactionSourceCounts,
        durationMs: Date.now() - iterStart,
      };

      // 9. Write reports
      writeIterationReport(config.resultsDir, i, result);
      printIterationSummary(i, result);
      results.push(result);

      // 10. Fail fast check
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
        totalBlocks: 0,
        totalDataItems: 0,
        totalTransactions: 0,
        discrepancies: [
          {
            type: 'count_mismatch',
            sources: {},
            details: `Iteration error: ${err.message}`,
          },
        ],
        blockSourceCounts: {},
        sourceCounts: {},
        transactionSourceCounts: {},
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
