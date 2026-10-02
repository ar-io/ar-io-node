/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Entry point for the index-export service: builds this gateway's index
 * bands from its own index and publishes them for the index-swarm sidecar to
 * sign and offer.
 *
 *   main.js              the service: a run a day, retries, /healthz
 *   main.js --once       one run now (an operator's: retries a rejected
 *                        fold), its report as JSON on stdout, then exit
 *     --dry-run          build and check, publish nothing
 *     --keep <dir>       a dry run that keeps its bands in <dir>
 *     --to <height>      read no higher, to compare runs at a fixed height
 *   main.js --adopt <band> --as h|r|d [--top <height>]
 *                        record an existing band as this service's
 *
 * A `--once` run exits 1 when rejected, unable to check, or locked out.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { gatewayRootSource } from '../lib/index-band/verify.js';
import { release } from '../version.js';
import { ExportConfig, parseExportConfig } from './config.js';
import { INDEX_NAME } from './kinds/root-tx/kind.js';
import { openSource } from './kinds/root-tx/sources/config.js';
import { ExportLock } from './lock.js';
import log from './log.js';
import { startMetricsServer } from './metrics.js';
import { ExportService, reportForOutput, runResult } from './service.js';
import { updateIndexState } from './state.js';

const USAGE =
  'Usage: main.js [--once [--dry-run | --keep <dir>] [--to <height>]] | [--adopt <band-id> --as h|r|d [--top <height>]]';

const height = (value: string, flag: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a block height`);
  return Number(value);
};

/**
 * Records an existing band as this service's, under the lock so a run in
 * progress can't overwrite it.
 */
async function adopt(
  config: ExportConfig,
  id: string,
  as: string | undefined,
  top: string | undefined,
): Promise<void> {
  if (as !== 'h' && as !== 'r' && as !== 'd') {
    throw new Error(`--as must be h, r or d. ${USAGE}`);
  }
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(config.publishDir, id, 'manifest.json'),
      'utf8',
    ),
  ) as { metadata?: { heightRange?: [number, number | null] } };
  const range = manifest.metadata?.heightRange;
  if (!Array.isArray(range)) {
    throw new Error(`${id} has no heightRange in its manifest`);
  }
  let bandTop: number;
  if (range[1] !== null) {
    bandTop = range[1];
    if (top !== undefined && height(top, '--top') !== bandTop) {
      throw new Error(
        `${id} ends at ${bandTop}; --top must match or be left out`,
      );
    }
  } else {
    // Bands store no heights: the top of an open band can't be read from it.
    if (top === undefined) {
      throw new Error(
        `${id} is open at the tip: give --top, the highest height it covers. Its builder knows it; err low, since the fold reads the sources from just below it`,
      );
    }
    bandTop = height(top, '--top');
    if (bandTop < range[0]) {
      throw new Error(
        `--top ${bandTop} is below the band's start, ${range[0]}`,
      );
    }
  }
  if (as === 'r' && bandTop - range[0] + 1 >= config.recentMaxBlocks) {
    throw new Error(
      `${id} spans ${bandTop - range[0] + 1} blocks, at least INDEX_EXPORT_RECENT_MAX_BLOCKS (${config.recentMaxBlocks}): as r it would be frozen and never folded; adopt it as h`,
    );
  }

  await fs.mkdir(config.workDir, { recursive: true });
  const lock = await ExportLock.acquire(path.join(config.workDir, 'lock'));
  if (!lock.acquired) {
    throw new Error(
      `A run holds the lock (${Math.round(lock.ageMs / 1000)} s since it touched it); adopt when it has finished`,
    );
  }
  try {
    await updateIndexState(
      path.join(config.workDir, 'state.json'),
      INDEX_NAME,
      (state) => {
        state.adoptions[id] = {
          as,
          top: bandTop,
          adoptedAt: new Date().toISOString(),
        };
      },
    );
  } finally {
    await lock.lock.release();
  }
  process.stdout.write(
    `${JSON.stringify({ adopted: id, as, top: bandTop }, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      once: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      keep: { type: 'string' },
      to: { type: 'string' },
      adopt: { type: 'string' },
      as: { type: 'string' },
      top: { type: 'string' },
    },
    strict: true,
  });
  if (
    values.once !== true &&
    (values['dry-run'] === true ||
      values.keep !== undefined ||
      values.to !== undefined)
  ) {
    throw new Error(`--dry-run, --keep and --to go with --once. ${USAGE}`);
  }

  const config = parseExportConfig(process.env);
  if (values.adopt !== undefined) {
    await adopt(config, values.adopt, values.as, values.top);
    return;
  }

  // Scratch files land beside the bands, never in the image's volume on /.
  process.env.TMPDIR = path.resolve(config.workDir);
  const service = new ExportService({
    config,
    log,
    openSources: async () =>
      Promise.all(
        config.sources.map(async (resolved) => ({
          source: await openSource(resolved, config.sourceEnv),
          optional: resolved.optional,
        })),
      ),
    openRoots: () =>
      gatewayRootSource(config.headerCheckUrl, config.headerCheckTimeoutMs),
  });

  // /healthz in either mode: a long --once run under the compose healthcheck
  // must not look dead.
  const metrics = await startMetricsServer({
    port: config.metricsPort,
    alive: () => service.alive(),
    log,
  });
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('Stopping', { signal });
    await service.stop();
    await metrics.close();
    process.exit(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  if (values.once === true) {
    service.startHeartbeat();
    let keepDir: string | undefined;
    if (values.keep !== undefined) {
      keepDir = path.resolve(values.keep);
      const relative = path.relative(
        path.resolve(config.workDir, '..'),
        keepDir,
      );
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
          `--keep ${values.keep} must be under ${path.resolve(config.workDir, '..')}, on the same filesystem as the bands`,
        );
      }
    }
    const report = await service.runOnce({
      dryRun: values['dry-run'] === true,
      ...(keepDir !== undefined ? { keepDir } : {}),
      ...(values.to !== undefined
        ? { toHeight: height(values.to, '--to') }
        : {}),
      force: true,
    });
    // Wait for the write: stdout to a pipe is asynchronous, and exiting
    // before it drains cuts the report short.
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(
        `${JSON.stringify(reportForOutput(report), null, 2)}\n`,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    const result = runResult(report);
    await service.stop(0);
    await metrics.close();
    process.exit(
      result === 'rejected' || result === 'couldnt_check' || result === 'locked'
        ? 1
        : 0,
    );
  }

  log.info('Starting index-export', {
    release,
    publisher: config.publisher,
    sources: config.sources.map((s) => s.config.name),
    headerCheckUrl: config.headerCheckUrl,
  });
  service.start();
}

main().catch((error: Error) => {
  log.error('index-export failed', { error: error.message });
  process.exit(1);
});
