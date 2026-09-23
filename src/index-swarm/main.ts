/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Entry point for the index-swarm sidecar.
 *
 * Publishes the index artifacts this gateway offers and subscribes to those
 * published by others, so bands can be installed and retired under a running
 * gateway without a restart. It shares the gateway's data volume and nothing
 * else: no database, no chain access, and no ability to disturb the gateway
 * process, which reads what lands on disk through its own watcher.
 *
 * The scaffold starts, serves health and metrics, checks that the gateway it
 * sits beside is new enough to load what it installs, and idles. The publish
 * and subscribe loops arrive in later changes.
 */
import * as fs from 'node:fs/promises';

import * as config from './config.js';
import log from './log.js';
import { StateStore } from './state.js';
import {
  buildInfo,
  configuredIndexes,
  setCoreCompatibility,
  startMetricsServer,
  up,
} from './metrics.js';

/** Release of the gateway this sidecar is sitting beside, if it answers. */
interface CoreRelease {
  release: number | undefined;
  raw: string | undefined;
}

/**
 * Ask the gateway what release it is.
 *
 * Deliberately advisory: a gateway that is down, slow, or on an unparseable
 * release must not stop the sidecar from starting, because the sidecar
 * restarting in a loop beside a struggling gateway helps nobody. The answer
 * only decides whether installing bands is useful yet.
 */
async function fetchCoreRelease(): Promise<CoreRelease> {
  try {
    const response = await fetch(`${config.CORE_URL}/ar-io/info`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { release: undefined, raw: undefined };
    }
    const info = (await response.json()) as { release?: unknown };
    const raw = typeof info.release === 'string' ? info.release : undefined;
    // Releases are reported as "84" or "84-pre"; the numeric prefix is what
    // orders them, and a pre-release of N does not yet carry N's features.
    const match = raw !== undefined ? /^(\d+)(-pre)?$/.exec(raw) : null;
    if (match === null) {
      return { release: undefined, raw };
    }
    const numeric = Number(match[1]);
    return {
      release: match[2] === undefined ? numeric : numeric - 1,
      raw,
    };
  } catch {
    return { release: undefined, raw: undefined };
  }
}

async function main(): Promise<void> {
  buildInfo.set({ version: 'dev', node_version: process.version }, 1);
  configuredIndexes.set({ role: 'publish' }, config.PUBLISH.length);
  configuredIndexes.set({ role: 'subscribe' }, config.SUBSCRIBE.length);

  // Create the volume layout up front so a misconfigured mount fails here,
  // with a clear message, rather than mid-install.
  for (const dir of [
    config.PUBLISHED_DIR,
    config.INCOMING_DIR,
    config.INSTALLED_DIR,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }

  const state = new StateStore({ log, filePath: config.STATE_FILE });
  await state.load();

  let shuttingDown = false;
  const metrics = await startMetricsServer({
    log,
    host: config.METRICS_HOST,
    port: config.METRICS_PORT,
    isHealthy: () => ({
      healthy: !shuttingDown,
      detail: {
        idle: config.isIdle(),
        publishing: config.PUBLISH.length,
        subscribing: config.SUBSCRIBE.length,
      },
    }),
  });

  const core = await fetchCoreRelease();
  if (core.release === undefined) {
    setCoreCompatibility('unknown');
    log.warn(
      'Could not determine the gateway release; continuing without the compatibility check',
      { coreUrl: config.CORE_URL, reported: core.raw },
    );
  } else if (core.release < config.MIN_CORE_RELEASE) {
    setCoreCompatibility('too_old');
    log.error(
      'Gateway is too old to load installed index bands; not installing anything',
      {
        coreUrl: config.CORE_URL,
        reported: core.raw,
        required: config.MIN_CORE_RELEASE,
      },
    );
  } else {
    setCoreCompatibility('compatible');
    log.info('Gateway release is compatible', {
      reported: core.raw,
      required: config.MIN_CORE_RELEASE,
    });
  }

  up.set(1);

  if (config.isIdle()) {
    log.info(
      'index-swarm idle: nothing configured. Set INDEX_SWARM_PUBLISH or INDEX_SWARM_SUBSCRIBE to give it work.',
      { dataDir: config.DATA_DIR },
    );
  } else {
    log.info('index-swarm started', {
      dataDir: config.DATA_DIR,
      publish: config.PUBLISH.map((p) => `${p.name} (${p.kind})`),
      subscribe: config.SUBSCRIBE.map((s) => s.publisher),
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    up.set(0);
    log.info('Shutting down', { signal });

    // Bound the wait: a hung close must not turn a restart into a kill, which
    // is what leaves a half-written band behind.
    const timer = setTimeout(() => {
      log.error('Shutdown timed out; exiting anyway', {
        timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
      });
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await metrics.close();
      await state.save();
    } catch (error: any) {
      log.error('Error during shutdown', { error: error?.message });
    }

    clearTimeout(timer);
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  log.error('index-swarm failed to start', { error: message, stack });
  process.exit(1);
});
