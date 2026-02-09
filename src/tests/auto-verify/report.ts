/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';

import { Discrepancy, IterationResult } from './types.js';

export function writeIterationReport(
  resultsDir: string,
  iteration: number,
  result: IterationResult,
): void {
  const iterDir = path.join(resultsDir, `iteration-${iteration}`);
  fs.mkdirSync(iterDir, { recursive: true });

  // Write JSONL discrepancies
  const discrepanciesPath = path.join(iterDir, 'discrepancies.jsonl');
  const lines = result.discrepancies.map((d) => JSON.stringify(d));
  fs.writeFileSync(discrepanciesPath, lines.join('\n') + '\n');

  // Write iteration summary
  const summaryPath = path.join(iterDir, 'summary.json');
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        blockRange: result.blockRange,
        totalDataItems: result.totalDataItems,
        discrepancyCount: result.discrepancies.length,
        sourceCounts: result.sourceCounts,
        durationMs: result.durationMs,
        passed: result.discrepancies.length === 0,
      },
      null,
      2,
    ),
  );
}

export function writeFinalSummary(
  resultsDir: string,
  results: IterationResult[],
): void {
  const summary = {
    totalIterations: results.length,
    passedIterations: results.filter((r) => r.discrepancies.length === 0)
      .length,
    failedIterations: results.filter((r) => r.discrepancies.length > 0).length,
    totalDataItemsChecked: results.reduce(
      (sum, r) => sum + r.totalDataItems,
      0,
    ),
    totalDiscrepancies: results.reduce(
      (sum, r) => sum + r.discrepancies.length,
      0,
    ),
    iterations: results.map((r, i) => ({
      iteration: i,
      blockRange: r.blockRange,
      totalDataItems: r.totalDataItems,
      discrepancyCount: r.discrepancies.length,
      passed: r.discrepancies.length === 0,
      durationMs: r.durationMs,
    })),
  };

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
}

export function printIterationSummary(
  iteration: number,
  result: IterationResult,
): void {
  const status = result.discrepancies.length === 0 ? 'PASS' : 'FAIL';
  const rangeStr = `${result.blockRange.start}-${result.blockRange.end}`;
  const discStr =
    result.discrepancies.length > 0
      ? ` (${result.discrepancies.length} discrepancies)`
      : '';
  const durationStr = `${(result.durationMs / 1000).toFixed(1)}s`;

  console.log(
    `[Iteration ${iteration}] ${status} | blocks ${rangeStr} | ${result.totalDataItems} data items | ${durationStr}${discStr}`,
  );

  if (result.discrepancies.length > 0) {
    // Show first few discrepancies
    const preview = result.discrepancies.slice(0, 5);
    for (const d of preview) {
      console.log(`  - ${d.type}: ${d.details ?? d.field ?? ''}`);
    }
    if (result.discrepancies.length > 5) {
      console.log(`  ... and ${result.discrepancies.length - 5} more`);
    }
  }
}
