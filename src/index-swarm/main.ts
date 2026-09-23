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
 * Either role is optional and they are independent: a node may publish, or
 * subscribe, or do both, or neither, in which case it serves health and
 * metrics and idles.
 */
import * as fs from 'node:fs/promises';

import * as config from './config.js';
import log from './log.js';
import { StateStore } from './state.js';
import { createKindRegistry } from './kinds/registry.js';
import { Publisher, loadPublisherSigner } from './publisher.js';
import { Subscriber } from './subscriber.js';
import { CachedGatewayRegistry } from './gateway-registry.js';
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

  const kinds = createKindRegistry({ log });

  // Publishing needs a key a subscriber can check against, so this is fatal
  // rather than a warning: a publisher that signs with an unregistered key
  // produces documents nobody can verify, which is worse than not publishing.
  let publisher: Publisher | undefined;
  if (config.PUBLISH.length > 0) {
    const signer = loadPublisherSigner({
      keypairPath: config.OBSERVER_KEYPAIR_PATH,
      privateKeyBase58: config.OBSERVER_PRIVATE_KEY,
      wallet: config.AR_IO_WALLET,
    });
    if (signer === undefined) {
      throw new Error(
        'index-swarm publisher requires a registry-bound observer key: set OBSERVER_KEYPAIR_PATH or OBSERVER_PRIVATE_KEY',
      );
    }
    publisher = new Publisher({
      log,
      state,
      kinds,
      signer,
      publish: config.PUBLISH,
      publishedDir: config.PUBLISHED_DIR,
      blobsDir: config.BLOBS_DIR,
      publicationFile: config.PUBLICATION_FILE,
      ttlMs: config.PUBLISH_TTL_MS,
      supersedeGraceMs: config.SUPERSEDE_GRACE_MS,
    });
    log.info('Publishing as', {
      publisher: signer.wallet,
      signingKey: signer.keyId,
    });
    if (config.AR_IO_WALLET === undefined) {
      log.warn(
        'AR_IO_WALLET is not set; publishing under the observer address as identity. Set it if this gateway registers a different wallet, or subscribers will not resolve this publisher.',
      );
    }
  }

  // Subscribing reads the gateway registry, which is how a publisher's URL
  // and signing key are established. Without it there is no way to decide
  // whether a document is authentic, so this is fatal rather than degraded.
  let subscriber: Subscriber | undefined;
  if (config.SUBSCRIBE.length > 0) {
    if (config.SOLANA_RPC_URL === undefined) {
      throw new Error(
        'index-swarm subscriber requires SOLANA_RPC_URL: publishers are resolved through the gateway registry',
      );
    }
    const { SolanaARIOReadable } = await import('@ar.io/sdk');
    const { createSolanaRpc, address } = await import('@solana/kit');
    const reader = new SolanaARIOReadable({
      rpc: createSolanaRpc(config.SOLANA_RPC_URL),
      ...(config.ARIO_CORE_PROGRAM_ID !== undefined
        ? { coreProgramId: address(config.ARIO_CORE_PROGRAM_ID) }
        : {}),
      ...(config.ARIO_GAR_PROGRAM_ID !== undefined
        ? { garProgramId: address(config.ARIO_GAR_PROGRAM_ID) }
        : {}),
    } as never);

    subscriber = new Subscriber({
      log,
      state,
      kinds,
      registry: new CachedGatewayRegistry({
        log,
        reader: reader as never,
        ttlMs: config.REGISTRY_CACHE_TTL_MS,
      }),
      subscribe: config.SUBSCRIBE,
      trustedPublishers: config.TRUSTED_PUBLISHERS,
      incomingDir: config.INCOMING_DIR,
      installedDir: config.INSTALLED_DIR,
      fetchTimeoutMs: config.MANIFEST_FETCH_TIMEOUT_MS,
      downloadConcurrency: config.DOWNLOAD_CONCURRENCY,
      supersedeGraceMs: config.SUPERSEDE_GRACE_MS,
      ...(config.MAX_DISK_BYTES !== undefined
        ? { maxDiskBytes: config.MAX_DISK_BYTES }
        : {}),
      ...(config.DOWNLOAD_RATE_LIMIT_BYTES_PER_SEC !== undefined
        ? {
            downloadRateLimitBytesPerSec:
              config.DOWNLOAD_RATE_LIMIT_BYTES_PER_SEC,
          }
        : {}),
    });
    log.info('Subscribing to publishers', {
      publishers: config.SUBSCRIBE.map((entry) => entry.publisher),
    });
  }

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

  let publishTimer: NodeJS.Timeout | undefined;
  if (publisher !== undefined) {
    const runScan = async () => {
      if (shuttingDown) return;
      try {
        await publisher.scanOnce();
      } catch (error: any) {
        // One bad scan must not end the loop; the next one may well succeed.
        log.error('Publish scan failed', {
          error: error?.message,
          stack: error?.stack,
        });
      }
    };

    await runScan();
    publishTimer = setInterval(
      () => void runScan(),
      config.PUBLISH_SCAN_INTERVAL_MS,
    );
  }

  let pollTimer: NodeJS.Timeout | undefined;
  if (subscriber !== undefined) {
    const runPoll = async () => {
      if (shuttingDown) return;
      try {
        await subscriber.pollOnce();
      } catch (error: any) {
        // One bad poll must not end the loop.
        log.error('Subscription poll failed', {
          error: error?.message,
          stack: error?.stack,
        });
      }
    };

    await runPoll();
    pollTimer = setInterval(() => void runPoll(), config.POLL_INTERVAL_MS);
  }

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
      if (publishTimer !== undefined) clearInterval(publishTimer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
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
