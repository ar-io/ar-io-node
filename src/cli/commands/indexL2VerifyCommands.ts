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
import { Logger } from 'winston';

import {
  gatewayRootSource,
  type RootSourceFactory,
} from '../../lib/index-band/verify.js';
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
import { openBandsDuck } from './indexL1VerifyCommands.js';

/** Items per band read on chain when `--onchain` is not given. */
export const DEFAULT_ONCHAIN_PER_BAND = 20;

export class L2VerifyRefused extends Error {}

const whole = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new L2VerifyRefused(`${flag} must be a whole number, 0 or above`);
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

export interface IndexL2VerifyDeps {
  log: Logger;
  /** Injected in tests: where root bytes are read from. */
  openRoot?: RootSourceFactory;
}

export async function indexL2VerifyCLICommand(
  options: IndexL2VerifyCLIOptions,
  { log, openRoot: injected }: IndexL2VerifyDeps,
): Promise<JsonSerializable> {
  const bandsDir = requiredStringFromOptions(options, 'bandsDir');
  const from = whole(options.from, '--from');
  const to = whole(options.to, '--to');
  const perBand =
    whole(options.onchain, '--onchain') ?? DEFAULT_ONCHAIN_PER_BAND;
  const timeoutMs = whole(options.readTimeout, '--read-timeout') ?? 30000;
  const seed = whole(options.seed, '--seed');
  if (options.gatewayUrl !== undefined && options.arweaveNodes !== undefined) {
    throw new L2VerifyRefused(
      '--gateway-url and --arweave-nodes are exclusive',
    );
  }

  // Where root bytes come from for the on-chain check: Arweave nodes,
  // every byte proven (the default), or a gateway, trusted.
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
        }),
        close: gateway.close,
      };
    } else {
      const urls = urlList(options.arweaveNodes) ?? DEFAULT_ARWEAVE_NODE_URLS;
      const onchain = onChainRootSource({
        pool: new ArweaveNodePool({ urls, timeoutMs }),
      });
      source = {
        openRoot: onchain.openRoot,
        describe: () => ({
          from: 'arweave-nodes',
          proven: true,
          ...onchain.stats(),
        }),
        close: () => undefined,
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
    log.info('Checking L2 bands', {
      bandsDir,
      spill: session.spill,
      onchainPerBand: perBand,
    });
    const out = await verifyL2Bands(session.duck, bandsDir, {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(options.publisher !== undefined
        ? { publisher: options.publisher }
        : {}),
      lookups: options.skipLookups !== true,
      ...(source !== undefined
        ? {
            onchain: {
              perBand,
              openRoot: source.openRoot,
              ...(seed !== undefined ? { seed } : {}),
            },
          }
        : {}),
      progress: (done, total, id) =>
        log.info('Checked band', { done, total, id }),
    });
    const answer = {
      bandsDir: out.bandsDir,
      selection: out.selection,
      bands: out.bands,
      heightRange: out.heightRange,
      items: out.items,
      ok: out.ok,
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
      superseded: out.superseded,
      ...(out.onchain !== undefined && source !== undefined
        ? { onchain: { perBand, ...out.onchain, roots: source.describe() } }
        : {}),
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
