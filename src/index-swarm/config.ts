/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Configuration for the index-swarm sidecar.
 *
 * Deliberately not `src/config.ts`. That module is the gateway's, and reading
 * it has side effects: it stats and reads key material, parses filters, and
 * initialises HTTPSIG signing state. A sidecar that only moves files should
 * not do any of that as a consequence of importing its settings.
 *
 * Every setting is read once here so a malformed value fails at startup with
 * a clear message, rather than on the first poll hours later.
 */
import * as path from 'node:path';

import * as env from '../lib/env.js';
import { isValidIndexName } from '../lib/index-publication.js';

/** One index this node publishes. */
export interface PublishConfig {
  /** Index name, matching `^[a-z0-9-]{1,64}$`. */
  name: string;
  /** Artifact kind, selecting the plugin that describes and installs bands. */
  kind: string;
  /** Opaque, passed through to the manifest for subscribers to match on. */
  filter?: unknown;
}

/** One publisher this node subscribes to. */
export interface SubscribeConfig {
  /** The publishing gateway's wallet address, as registered. */
  publisher: string;
  /** Restrict to one index name; all of the publisher's indexes when unset. */
  name?: string;
  /** Override the URL derived from the publisher's gateway record. */
  url?: string;
}

function parseJson(raw: string | undefined, varName: string): unknown {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    throw new Error(
      `${varName} is not valid JSON: ${error?.message ?? 'parse failed'}`,
    );
  }
}

/**
 * Parse the publish configuration.
 *
 * Takes the raw string rather than reading the environment itself, so the
 * rules can be tested directly instead of through module-load ordering.
 */
export function parsePublish(raw: string | undefined): PublishConfig[] {
  const parsed = parseJson(raw, 'INDEX_SWARM_PUBLISH');
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('INDEX_SWARM_PUBLISH must be a JSON array');
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`INDEX_SWARM_PUBLISH[${i}] must be an object`);
    }
    const { name, kind, filter } = entry as Record<string, unknown>;
    // The name becomes a directory, a URL segment and a field of the signed
    // document, which subscribers reject outright if it is malformed.
    if (!isValidIndexName(name)) {
      throw new Error(
        `INDEX_SWARM_PUBLISH[${i}].name must match ^[a-z0-9-]{1,64}$`,
      );
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error(`INDEX_SWARM_PUBLISH[${i}].kind must be a string`);
    }
    return { name, kind, ...(filter !== undefined ? { filter } : {}) };
  });
}

/** Parse the subscribe configuration. See {@link parsePublish}. */
export function parseSubscribe(raw: string | undefined): SubscribeConfig[] {
  const parsed = parseJson(raw, 'INDEX_SWARM_SUBSCRIBE');
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('INDEX_SWARM_SUBSCRIBE must be a JSON array');
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`INDEX_SWARM_SUBSCRIBE[${i}] must be an object`);
    }
    const { publisher, name, url } = entry as Record<string, unknown>;
    if (typeof publisher !== 'string' || publisher.length === 0) {
      throw new Error(
        `INDEX_SWARM_SUBSCRIBE[${i}].publisher must be a wallet address`,
      );
    }
    // A malformed name could never match a published index, so the
    // subscription would silently do nothing.
    if (name !== undefined && !isValidIndexName(name)) {
      throw new Error(
        `INDEX_SWARM_SUBSCRIBE[${i}].name must match ^[a-z0-9-]{1,64}$`,
      );
    }
    if (url !== undefined && typeof url !== 'string') {
      throw new Error(`INDEX_SWARM_SUBSCRIBE[${i}].url must be a string`);
    }
    return {
      publisher,
      ...(name !== undefined ? { name } : {}),
      ...(url !== undefined ? { url } : {}),
    };
  });
}

/** Root of the shared volume the gateway also reads. */
export const DATA_DIR = env.varOrDefault(
  'INDEX_SWARM_DATA_DIR',
  'data/indexes',
);

/** Bands this node offers. The gateway serves these at /ar-io/indexes. */
export const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
/** Downloads in progress. Never read by the gateway. */
export const INCOMING_DIR = path.join(DATA_DIR, 'incoming');
/** Bands in use. The gateway loads these through its collection source. */
export const INSTALLED_DIR = path.join(DATA_DIR, 'installed');
/** Content-addressed links into the published bands, served by hash. */
export const BLOBS_DIR = path.join(PUBLISHED_DIR, 'blobs');
/** The signed document the gateway serves at /ar-io/indexes. */
export const PUBLICATION_FILE = path.join(PUBLISHED_DIR, 'publication.json');
/** Sidecar state: sequences seen, bands installed. Rebuildable from disk. */
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

export const PUBLISH: PublishConfig[] = parsePublish(
  env.varOrUndefined('INDEX_SWARM_PUBLISH'),
);
export const SUBSCRIBE: SubscribeConfig[] = parseSubscribe(
  env.varOrUndefined('INDEX_SWARM_SUBSCRIBE'),
);

/** How often to look for new or changed bands. */
export const PUBLISH_SCAN_INTERVAL_MS =
  env.positiveIntOrDefault('INDEX_SWARM_PUBLISH_SCAN_INTERVAL_SECONDS', 60) *
  1000;

/**
 * How long a publication stays fresh.
 *
 * A subscriber alarms once `expiresAt` has passed, so this is the staleness
 * contract rather than a cache hint. Set it to roughly twice the interval at
 * which bands are expected to change, so an ordinary quiet period does not
 * read as a dead publisher.
 */
export const PUBLISH_TTL_MS =
  env.positiveIntOrDefault('INDEX_SWARM_PUBLISH_TTL_SECONDS', 86_400) * 1000;

/**
 * How long a retired band's files stay on disk after it stops being served,
 * giving anything mid-read time to finish.
 */
export const SUPERSEDE_GRACE_MS =
  env.positiveIntOrDefault('INDEX_SWARM_SUPERSEDE_GRACE_SECONDS', 300) * 1000;

/** How often to poll each publisher for a new document. */
export const POLL_INTERVAL_MS =
  env.positiveIntOrDefault('INDEX_SWARM_POLL_INTERVAL_SECONDS', 300) * 1000;

/** Give up on a publisher that has not answered in this long. */
export const MANIFEST_FETCH_TIMEOUT_MS = env.positiveIntOrDefault(
  'INDEX_SWARM_MANIFEST_FETCH_TIMEOUT_MS',
  30_000,
);

/**
 * Give up on a band file download once no bytes have arrived for this long.
 * Band files run to gigabytes, so this bounds a stall, not the transfer: a
 * download still moving is never cut off, however long it takes.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS =
  env.positiveIntOrDefault('INDEX_SWARM_DOWNLOAD_STALL_TIMEOUT_SECONDS', 60) *
  1000;

/** Parallel file downloads within one band. */
export const DOWNLOAD_CONCURRENCY = env.positiveIntOrDefault(
  'INDEX_SWARM_DOWNLOAD_CONCURRENCY',
  4,
);

/**
 * Ceiling on what installed bands may occupy. A band that would take the
 * total past this is skipped and counted rather than filling the volume the
 * gateway serves from. Unset means no ceiling.
 */
export const MAX_DISK_BYTES = env.positiveIntOrUndefined(
  'INDEX_SWARM_MAX_DISK_BYTES',
);

/**
 * Write-rate cap while downloading a band, shared across the files it
 * downloads at once. Unset means no cap.
 */
export const DOWNLOAD_RATE_LIMIT_BYTES_PER_SEC = env.positiveIntOrUndefined(
  'INDEX_SWARM_DOWNLOAD_RATE_LIMIT_BYTES_PER_SEC',
);

/**
 * How long one read of the gateway's peer list, which is where the sidecar
 * gets registry records, is reused. The gateway refreshes it hourly, so
 * reading it more often than every few minutes gains nothing.
 */
export const REGISTRY_CACHE_TTL_MS =
  env.positiveIntOrDefault('INDEX_SWARM_REGISTRY_CACHE_TTL_SECONDS', 300) *
  1000;

/** Optional allowlist that tightens the registry check, never replaces it. */
export const TRUSTED_PUBLISHERS = env
  .varOrDefault('INDEX_SWARM_TRUSTED_PUBLISHERS', '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

export const METRICS_PORT = env.positiveIntOrDefault(
  'INDEX_SWARM_METRICS_PORT',
  9101,
);
/**
 * Bound inside the container, so the compose network can reach it and the
 * healthcheck can too. Nothing is published to the host unless the operator
 * maps the port.
 */
export const METRICS_HOST = env.varOrDefault(
  'INDEX_SWARM_METRICS_HOST',
  '0.0.0.0',
);

/** Where to reach the gateway, for the release-compatibility check. */
export const CORE_URL = env.varOrDefault(
  'INDEX_SWARM_CORE_URL',
  'http://core:4000',
);

/**
 * The gateway release that first understood a collection source. Below it,
 * bands installed here would sit on disk unread, so the subscriber waits
 * rather than filling a directory nothing loads. A pre-release counts as its
 * release (see `parseRelease`). Confirm this against the release the feature
 * actually ships in.
 */
export const MIN_CORE_RELEASE = env.positiveIntOrDefault(
  'INDEX_SWARM_MIN_CORE_RELEASE',
  84,
);

/**
 * This gateway's wallet, as registered. It is the publisher's *identity*:
 * subscribers are configured with it and look the record up by it. The
 * observer key below is the *signer*. They are often the same key, but not
 * always, so publishing requires the wallet rather than inferring it.
 */
export const AR_IO_WALLET = env.varOrUndefined('AR_IO_WALLET');

/**
 * The gateway's registered observer key, used to sign what this node
 * publishes. Read but never written; a publisher without one refuses to run.
 */
export const OBSERVER_KEYPAIR_PATH = env.varOrUndefined(
  'OBSERVER_KEYPAIR_PATH',
);
export const OBSERVER_PRIVATE_KEY = env.varOrUndefined('OBSERVER_PRIVATE_KEY');

/** How long to let work finish on SIGTERM before exiting anyway. */
export const SHUTDOWN_TIMEOUT_MS = env.positiveIntOrDefault(
  'INDEX_SWARM_SHUTDOWN_TIMEOUT_MS',
  10_000,
);

/** True when this process has nothing configured to do. */
export function isIdle(): boolean {
  return PUBLISH.length === 0 && SUBSCRIBE.length === 0;
}
