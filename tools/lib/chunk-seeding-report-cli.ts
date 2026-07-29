/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  analyzeSeeding,
  renderConsole,
  type AnalyzeOptions,
} from './chunk-seeding-report.js';

function usage(): never {
  console.error(`Usage: chunk-seeding-report <txID> [options]

Reports how much of an L1 Arweave transaction's data is actually seeded
(retrievable as chunks) on the network, as found/missing byte ranges.

Options:
  --nodes <urls>      Comma-separated chunk-serving nodes; a chunk counts as
                      found if ANY node has it (default: https://arweave.net)
  --info-node <url>   Node for the /tx/<id>/offset lookup (default: first --nodes)
  --samples <n>       Chunk probe budget for large txs (default: 400)
  --full              Probe every chunk (exhaustive; slow for large txs)
  --refine            Binary-search exact boundaries between found/missing samples
  --concurrency <n>   Parallel probes (default: 4; keep low for arweave.net)
  --timeout <s>       Per-request timeout seconds (default: 20)
  --retries <n>       Retries per node on 429/5xx/timeout (default: 3)
  --size <n>          Skip /offset lookup: supply data size in bytes
  --end-offset <n>    Skip /offset lookup: supply absolute end offset
  --json              Emit the raw SeedingReport as JSON instead of a table
  --no-color          Disable ANSI colors
  --quiet             Suppress progress output
  --help              Show this help

Notes:
  * Each probe pulls up to one 256 KiB chunk over the wire (stream + discard).
  * "missing" means "not served by the queried node(s)"; the bytes may still
    exist on other peers. Use ./tools/find-chunk-peer.sh <offset> to deep-search.
  * Data items nested inside a bundle have no /offset — pass the L1 root txID.`);
  process.exit(1);
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const hasFlag = (args: string[], name: string) => args.includes(name);

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || hasFlag(args, '--help') || hasFlag(args, '-h'))
    usage();

  // base64url txIDs may begin with '-' or '_', so validate by shape, not prefix.
  const txId = args[0];
  if (!/^[A-Za-z0-9_-]{43}$/.test(txId)) {
    console.error(
      `Error: first argument must be a 43-char base64url txID, got "${txId}"\n`,
    );
    usage();
  }

  const nodes = (getFlag(args, '--nodes') ?? 'https://turbo-gateway.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const color = !hasFlag(args, '--no-color') && process.stdout.isTTY === true;
  const quiet = hasFlag(args, '--quiet') || hasFlag(args, '--json');
  const asJson = hasFlag(args, '--json');

  const opts: AnalyzeOptions = {
    nodes,
    infoNode: getFlag(args, '--info-node'),
    samples: getFlag(args, '--samples')
      ? Number(getFlag(args, '--samples'))
      : undefined,
    exhaustive: hasFlag(args, '--full'),
    refine: hasFlag(args, '--refine'),
    concurrency: getFlag(args, '--concurrency')
      ? Number(getFlag(args, '--concurrency'))
      : undefined,
    timeoutMs: getFlag(args, '--timeout')
      ? Number(getFlag(args, '--timeout')) * 1000
      : undefined,
    retries: getFlag(args, '--retries')
      ? Number(getFlag(args, '--retries'))
      : undefined,
    size: getFlag(args, '--size') ? Number(getFlag(args, '--size')) : undefined,
    endOffset: getFlag(args, '--end-offset')
      ? Number(getFlag(args, '--end-offset'))
      : undefined,
    onProgress: quiet
      ? undefined
      : (done, total) => {
          const pct = ((done / total) * 100).toFixed(0);
          process.stderr.write(
            `\r  probing chunks… ${done}/${total} (${pct}%)   `,
          );
        },
  };

  try {
    const report = await analyzeSeeding(txId, opts);
    if (!quiet) process.stderr.write('\r' + ' '.repeat(40) + '\r');
    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(renderConsole(report, color) + '\n');
    }
    // Exit code: 0 fully seeded, 1 partial/missing, 3 indeterminate.
    const v = report.summary.verdict;
    process.exit(v === 'FULLY_SEEDED' ? 0 : v === 'INDETERMINATE' ? 3 : 1);
  } catch (err) {
    if (!quiet) process.stderr.write('\r' + ' '.repeat(40) + '\r');
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  }
}

main();
