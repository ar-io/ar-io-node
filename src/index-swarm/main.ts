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
import { release } from '../version.js';
import log from './log.js';
import { StateStore } from './state.js';
import { createKindRegistry } from './kinds/registry.js';
import { Publisher, loadPublisherSigner } from './publisher.js';
import { Subscriber } from './subscriber.js';
import { CoreGatewayRegistry } from './gateway-registry.js';
import { CoreCompatibilityCheck } from './core-compatibility.js';
import {
  buildInfo,
  configuredIndexes,
  startMetricsServer,
  up,
} from './metrics.js';

async function main(): Promise<void> {
  // The sidecar ships in the core image, so the core's release is its own.
  buildInfo.set({ version: release, node_version: process.version }, 1);
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
        // Under compose a keypair file arrives through
        // INDEX_SWARM_OBSERVER_KEYPAIR_FILE, which sets OBSERVER_KEYPAIR_PATH
        // here; run directly, OBSERVER_KEYPAIR_PATH names the file itself.
        'index-swarm publisher requires a registry-bound observer key: set OBSERVER_PRIVATE_KEY, or INDEX_SWARM_OBSERVER_KEYPAIR_FILE (compose) / OBSERVER_KEYPAIR_PATH (direct) to the keypair file',
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
  // and signing key are established. The sidecar reads it through its own
  // gateway's /ar-io/peers rather than the chain, so it adds no load on the
  // Solana RPC provider and needs no RPC configuration of its own.
  let subscriber: Subscriber | undefined;
  if (config.SUBSCRIBE.length > 0) {
    subscriber = new Subscriber({
      log,
      state,
      kinds,
      registry: new CoreGatewayRegistry({
        log,
        coreUrl: config.CORE_URL,
        ttlMs: config.REGISTRY_CACHE_TTL_MS,
      }),
      subscribe: config.SUBSCRIBE,
      trustedPublishers: config.TRUSTED_PUBLISHERS,
      incomingDir: config.INCOMING_DIR,
      installedDir: config.INSTALLED_DIR,
      fetchTimeoutMs: config.MANIFEST_FETCH_TIMEOUT_MS,
      downloadStallTimeoutMs: config.DOWNLOAD_STALL_TIMEOUT_MS,
      downloadConcurrency: config.DOWNLOAD_CONCURRENCY,
      supersedeGraceMs: config.SUPERSEDE_GRACE_MS,
      allowedFileOrigins: config.ALLOWED_FILE_ORIGINS,
      // Names the gateway, so a publisher can tell subscribers apart even
      // when several share one IP. The wallet is already public in the
      // registry.
      userAgent: `ar-io-index-swarm/${release} (${config.AR_IO_WALLET ?? 'unregistered'})`,
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

  // Only the subscriber consults the answer; the publisher serves files the
  // gateway already understands. Checked now for the log and the gauge, and
  // again before each poll until the gateway has answered compatible.
  const compatibility = new CoreCompatibilityCheck({
    log,
    coreUrl: config.CORE_URL,
    minRelease: config.MIN_CORE_RELEASE,
  });
  if (subscriber !== undefined) {
    await compatibility.check();
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
        // Bands installed into a gateway that cannot load them would sit on
        // disk unread, so wait for it to be upgraded.
        if (!(await compatibility.allowsInstalling())) return;
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
      // Let work in progress finish, inside the timeout above: downloads
      // are aborted (they resume on the next start), but a band mid-install
      // or a document mid-write completes rather than being cut off.
      await Promise.allSettled([subscriber?.stop(), publisher?.drain()]);
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
