/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l2-verify`: check a directory of `parquet-l2` bands (an L2 index,
 * such as `ardrive-l2`) as their holder can, with no gateway and no database,
 * and, with `--onchain`, against Arweave itself.
 *
 * Read-only. See `docs/index-verification.md`.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  type GatewayRegistry,
  CoreGatewayRegistry,
} from '../../index-swarm/gateway-registry.js';
import {
  gatewayRootSource,
  type RootSourceFactory,
} from '../../lib/index-band/verify.js';
import {
  INDEX_PUBLICATION_MAX_BYTES,
  parseIndexPublication,
} from '../../lib/index-publication.js';
import {
  ArweaveNodePool,
  DEFAULT_ARWEAVE_NODE_URLS,
  parseNodeUrls,
} from '../../lib/onchain/arweave-nodes.js';
import { onChainRootSource } from '../../lib/onchain/root-source.js';
import type {
  VerifyCheck,
  VerifyFailure,
} from '../../lib/parquet-l1/verify.js';
import { verifyL2Bands } from '../../lib/parquet-l2/verify-bands.js';
import type { IndexL2VerifyCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';
import { openBandsDuck, SPILL_RESERVE_BYTES } from './indexL1VerifyCommands.js';

/** Items per band read on chain when `--onchain` is not given. */
export const DEFAULT_ONCHAIN_PER_BAND = 20;
/** Seconds one band's on-chain reads may take when `--band-deadline` is not given. */
export const DEFAULT_BAND_DEADLINE_SECONDS = 1200;
/**
 * Spill the lookup and consistency checks are expected to need, per byte of
 * a band's Parquet files: the h1.8M band of `ardrive-l2` (about 8 GB of
 * Parquet) peaked at about 65 GB of spill when both sides of every lookup
 * were sorted; the file side is now read in its own order. An estimate, to
 * refuse a run that cannot finish before it starts; the cap on the spill is
 * what keeps the disk from filling.
 */
export const SPILL_PER_PARQUET_BYTE = 4;

export class L2VerifyRefused extends Error {}

const whole = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new L2VerifyRefused(`${flag} must be a whole number, 0 or above`);
  }
  return n;
};

const fraction = (
  value: string | undefined,
  flag: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new L2VerifyRefused(`${flag} must be a number from 0 to 1`);
  }
  return n;
};

/** `--arweave-nodes`, read as {@link parseNodeUrls} reads it. */
export function urlList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    return parseNodeUrls(value);
  } catch (error) {
    throw new L2VerifyRefused((error as Error).message);
  }
}

/** A publication document from a file or a URL, at most its size cap. */
async function readPublication(
  where: string,
  timeoutMs: number,
): Promise<Buffer> {
  if (/^https?:\/\//i.test(where)) {
    const response = await fetch(where, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new L2VerifyRefused(
        `--publication: HTTP ${response.status} from ${where}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > INDEX_PUBLICATION_MAX_BYTES) {
      throw new L2VerifyRefused(
        `--publication is over ${INDEX_PUBLICATION_MAX_BYTES} bytes`,
      );
    }
    return bytes;
  }
  const { size } = await fsp.stat(where).catch((error) => {
    throw new L2VerifyRefused(
      `--publication: cannot read ${where}: ${(error as Error).message}`,
    );
  });
  if (size > INDEX_PUBLICATION_MAX_BYTES) {
    throw new L2VerifyRefused(
      `--publication is over ${INDEX_PUBLICATION_MAX_BYTES} bytes`,
    );
  }
  return fsp.readFile(where);
}

const isDirectory = (dir: string) =>
  fsp.stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * The L1 index to find roots in: `--l1-bands-dir`, or, unless it is `none`,
 * the node's own beside the L2 index (`installed/parquet-l1`, then
 * `published/parquet-l1`, two levels up from `--bands-dir`).
 */
async function l1Index(
  bandsDir: string,
  given: string | undefined,
): Promise<{ bandsDir: string; required: boolean } | undefined> {
  if (given === 'none') return undefined;
  if (given !== undefined) {
    if (!(await isDirectory(given))) {
      throw new L2VerifyRefused(`--l1-bands-dir: ${given} is not a directory`);
    }
    return { bandsDir: given, required: true };
  }
  for (const kind of ['installed', 'published']) {
    const dir = path.resolve(bandsDir, '..', '..', kind, 'parquet-l1');
    if (await isDirectory(dir)) return { bandsDir: dir, required: false };
  }
  return undefined;
}

/** The bytes of Parquet in the largest band of a directory. */
async function largestBandBytes(bandsDir: string): Promise<number> {
  let largest = 0;
  for (const name of await fsp.readdir(bandsDir).catch(() => [])) {
    if (name.startsWith('.')) continue;
    const dir = path.join(bandsDir, name);
    let bytes = 0;
    for (const file of await fsp.readdir(dir).catch(() => [])) {
      if (!file.endsWith('.parquet')) continue;
      bytes += (await fsp.stat(path.join(dir, file)).catch(() => ({ size: 0 })))
        .size;
    }
    largest = Math.max(largest, bytes);
  }
  return largest;
}

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

export interface IndexL2VerifyDeps {
  log: Logger;
  /** Injected in tests: where root bytes are read from. */
  openRoot?: RootSourceFactory;
  /** Injected in tests: the registry `--registry-url` reads. */
  registry?: GatewayRegistry;
}

export async function indexL2VerifyCLICommand(
  options: IndexL2VerifyCLIOptions,
  { log, openRoot: injected, registry: injectedRegistry }: IndexL2VerifyDeps,
): Promise<JsonSerializable> {
  const bandsDir = requiredStringFromOptions(options, 'bandsDir');
  const from = whole(options.from, '--from');
  const to = whole(options.to, '--to');
  const perBand =
    whole(options.onchain, '--onchain') ?? DEFAULT_ONCHAIN_PER_BAND;
  const timeoutMs = whole(options.readTimeout, '--read-timeout') ?? 30000;
  const seed = whole(options.seed, '--seed');
  const maxUnreadableShare = fraction(
    options.maxUnreadableShare,
    '--max-unreadable-share',
  );
  const maxUnlocatedShare = fraction(
    options.maxUnlocatedShare,
    '--max-unlocated-share',
  );
  const deadlineSeconds =
    whole(options.bandDeadline, '--band-deadline') ??
    DEFAULT_BAND_DEADLINE_SECONDS;
  if (options.gatewayUrl !== undefined && options.arweaveNodes !== undefined) {
    throw new L2VerifyRefused(
      '--gateway-url and --arweave-nodes are exclusive',
    );
  }
  if (options.publication === undefined) {
    for (const [flag, value] of [
      ['--publisher-key', options.publisherKey],
      ['--registry-url', options.registryUrl],
      ['--index', options.index],
      ['--allow-expired', options.allowExpired === true ? 'yes' : undefined],
    ] as const) {
      if (value !== undefined) {
        throw new L2VerifyRefused(`${flag} is only for --publication`);
      }
    }
  } else if (
    (options.publisherKey === undefined) ===
    (options.registryUrl === undefined && injectedRegistry === undefined)
  ) {
    throw new L2VerifyRefused(
      "--publication needs the publisher's key: one of --publisher-key or --registry-url",
    );
  }

  // The publication, and the key it must be signed with: given, or the one
  // the publisher's gateway record names.
  let publication:
    | {
        document: Buffer;
        publisherKey: string;
        index?: string;
        source: string;
        keyFrom?: string;
      }
    | undefined;
  if (options.publication !== undefined) {
    const document = await readPublication(options.publication, timeoutMs);
    let publisherKey = options.publisherKey;
    if (publisherKey === undefined) {
      let wallet: string;
      try {
        wallet = parseIndexPublication(document).publisher;
      } catch (error) {
        throw new L2VerifyRefused(
          `--publication is not a publication: ${(error as Error).message}`,
        );
      }
      const registry =
        injectedRegistry ??
        new CoreGatewayRegistry({
          log,
          coreUrl: options.registryUrl as string,
          ttlMs: 0,
          timeoutMs,
        });
      const record = await registry.lookup(wallet);
      if (record === undefined) {
        throw new L2VerifyRefused(
          `the registry has no gateway ${wallet} to read the publication's key from`,
        );
      }
      publisherKey = record.observerAddress;
    }
    publication = {
      document,
      publisherKey,
      source: options.publication,
      ...(options.publisherKey === undefined
        ? {
            keyFrom: `the registry at ${options.registryUrl ?? 'the injected registry'}`,
          }
        : {}),
      ...(options.index !== undefined ? { index: options.index } : {}),
    };
  }

  const l1 = await l1Index(bandsDir, options.l1BandsDir);

  // Where root bytes come from for the on-chain check: Arweave nodes,
  // every byte proven and every root found in a block (the default), or a
  // gateway, trusted.
  let source:
    | {
        openRoot: RootSourceFactory;
        describe: () => JsonSerializable;
        close: () => void;
      }
    | undefined;
  if (perBand > 0) {
    if (injected !== undefined) {
      source = {
        openRoot: injected,
        describe: () => ({ from: 'injected' }),
        close: () => undefined,
      };
    } else if (options.gatewayUrl !== undefined) {
      const gateway = gatewayRootSource(options.gatewayUrl, timeoutMs);
      source = {
        openRoot: gateway.openRoot,
        describe: () => ({
          from: 'gateway',
          url: options.gatewayUrl as string,
          trusted: true,
          // A gateway's word for the bytes, and nobody's that roots are mined.
          minedVia: 'none',
        }),
        close: gateway.close,
      };
    } else {
      const urls = urlList(options.arweaveNodes) ?? DEFAULT_ARWEAVE_NODE_URLS;
      const pool = new ArweaveNodePool({ urls, timeoutMs });
      const onchain = onChainRootSource({
        pool,
        allowAgreement: options.allowAgreement === true,
      });
      source = {
        openRoot: onchain.openRoot,
        describe: () => ({
          from: 'arweave-nodes',
          proven: true,
          allowAgreement: options.allowAgreement === true,
          ...onchain.stats(),
          // Names that didn't resolve: each counted a machine of its own.
          unresolvedNodes: [...pool.unresolved],
          // Answers single nodes gave that didn't hold up: their faults,
          // passed over for other nodes, never held against a band.
          nodeFaultCount: onchain.nodeFaultCount(),
          nodeFaults: onchain.nodeFaults().map((f) => ({ ...f })),
        }),
        close: () => {
          for (const fault of onchain.nodeFaults()) {
            log.warn('An Arweave node gave an answer that did not hold up', {
              ...fault,
            });
          }
        },
      };
    }
  }

  let session;
  try {
    session = await openBandsDuck({
      prefix: 'ar-io-node-l2-verify-',
      ...(options.spillMax !== undefined ? { spillMax: options.spillMax } : {}),
    });
  } catch (error) {
    if (/--spill-max/.test((error as Error).message)) {
      throw new L2VerifyRefused((error as Error).message);
    }
    throw error;
  }
  try {
    // Refuse a run whose largest band can't be checked in the spill there
    // is room for, before it starts rather than hours in.
    if (options.skipLookups !== true) {
      const need = (await largestBandBytes(bandsDir)) * SPILL_PER_PARQUET_BYTE;
      if (need > session.spillCapBytes) {
        throw new L2VerifyRefused(
          `the largest band is expected to spill about ${gib(need)}, more than the ${gib(session.spillCapBytes)} the spill is capped at (--spill-max; 80% of the ${gib(session.freeBytes)} free under ${path.dirname(session.spill)}; and that free space less a ${gib(SPILL_RESERVE_BYTES)} reserve): free space there, point TMPDIR elsewhere, or --skip-lookups`,
        );
      }
    }
    for (const dir of session.removedStale) {
      log.warn('Removed a spill folder a killed run left', { dir });
    }
    log.info('Checking L2 bands', {
      bandsDir,
      spill: session.spill,
      spillCap: gib(session.spillCapBytes),
      onchainPerBand: perBand,
      l1BandsDir: l1?.bandsDir,
      publication: publication?.source,
    });
    const out = await verifyL2Bands(session.duck, bandsDir, {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(options.publisher !== undefined
        ? { publisher: options.publisher }
        : {}),
      lookups: options.skipLookups !== true,
      ...(publication !== undefined
        ? {
            publication: {
              document: publication.document,
              publisherKey: publication.publisherKey,
              ...(publication.index !== undefined
                ? { index: publication.index }
                : {}),
              ...(publication.keyFrom !== undefined
                ? { keyFrom: publication.keyFrom }
                : {}),
              allowExpired: options.allowExpired === true,
            },
          }
        : {}),
      ...(l1 !== undefined ? { l1 } : {}),
      allowUnlocated: options.allowUnlocated === true,
      ...(maxUnlocatedShare !== undefined ? { maxUnlocatedShare } : {}),
      ...(source !== undefined
        ? {
            onchain: {
              perBand,
              openRoot: source.openRoot,
              deadlineMs: deadlineSeconds * 1000,
              ...(maxUnreadableShare !== undefined
                ? { maxUnreadableShare }
                : {}),
              ...(seed !== undefined ? { seed } : {}),
            },
          }
        : {}),
      progress: (done, total, id) =>
        log.info('Checked band', { done, total, id }),
    });
    const roots = source?.describe() as Record<string, unknown> | undefined;
    // Sampled roots found in blocks by nodes count only with Arweave nodes.
    const skipped = [...out.skipped];
    if (
      skipped.includes('mined') &&
      roots?.minedVia === 'node-status' &&
      out.onchain !== undefined
    ) {
      skipped.splice(skipped.indexOf('mined'), 1);
    }
    const assurance = [
      ...out.assurance,
      ...(roots?.minedVia === 'node-status'
        ? [
            "sampled roots placed in a block at their items' height by two or more machines (by address); their position in the block is not checked",
          ]
        : []),
      ...(roots?.trusted === true
        ? [
            `root bytes trusted to ${String(roots.url)}, and nothing says the sampled roots are mined`,
          ]
        : []),
    ];
    const answer = {
      bandsDir: out.bandsDir,
      selection: out.selection,
      bands: out.bands,
      heightRange: out.heightRange,
      items: out.items,
      ok: out.ok,
      publisherBound: out.publisherBound,
      skipped,
      assurance,
      checks: out.checks.map((c: VerifyCheck) => ({
        name: c.name,
        ok: c.ok,
        detail: c.detail,
        ...(c.failures !== undefined
          ? {
              failures: c.failures.map((f: VerifyFailure) => ({
                height: f.height,
                found: f.found,
                expected: f.expected,
              })),
            }
          : {}),
        ...(c.more !== undefined ? { more: c.more } : {}),
      })),
      ...(out.publication !== undefined
        ? { publication: { ...out.publication, source: publication?.source } }
        : {}),
      located: out.located,
      ...(out.mined !== undefined ? { mined: out.mined } : {}),
      superseded: out.superseded,
      partial: out.partial,
      vanished: out.vanished,
      ...(out.onchain !== undefined && source !== undefined
        ? {
            onchain: {
              perBand,
              ...out.onchain,
              roots: {
                ...(roots as object),
                // What finding a root in a block checks, by this source.
                ...(roots?.minedVia === 'node-status'
                  ? { checks: { height: true, position: false } }
                  : {}),
              },
            },
          }
        : {}),
      spill: {
        capBytes: session.spillCapBytes,
        freeBytes: session.freeBytes,
      },
      seconds: Math.round(out.seconds * 10) / 10,
    };
    log.info('Checked L2 bands', {
      ok: out.ok,
      bands: out.bands,
      items: out.items,
    });
    if (!out.ok) throw answer;
    return answer as unknown as JsonSerializable;
  } finally {
    source?.close();
    await session.close();
  }
}
