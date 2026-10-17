/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l1-audit`: checks the blocks `index-l1-verify` has to skip.
 *
 * A format-1 transaction's `tx_root` leaf is the root of its data, which an
 * index does not store, so a post-fork block holding one cannot be checked
 * from the index alone. This fetches that data, derives the roots and
 * recomputes `tx_root`. Read-only on `core.db`, so the gateway can stay up.
 */
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import {
  AuditRefused,
  DEFAULT_SAMPLE,
  type FetchTxData,
  MAX_MATCHES_LISTED,
  runAudit,
} from '../../lib/parquet-l1/audit.js';
import { FORK_2_0 } from '../../lib/parquet-l1/chain.js';
import { stableHeightRange } from '../../lib/parquet-l1/verify.js';
import type { IndexL1AuditCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';

export interface IndexL1AuditDeps {
  log: Logger;
  fetchTxData?: FetchTxData;
}

/** How long one transaction's data has to arrive. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetches a transaction's own data from its `data` field.
 *
 * Not the data route. `/raw/{id}` and `/{id}` resolve *content*, which for
 * a manifest or a bundled item is not the transaction's bytes at all — a
 * 1,614-byte transaction came back as an 8,847-byte SVG, with a 200. The
 * caller checks the length against `data_size` regardless, and a wrong
 * root can only cause a false alarm, never a false pass.
 */
function txDataFetcher(base: string): FetchTxData {
  const root = base.replace(/\/+$/, '');
  return async (id: string) => {
    const response = await fetch(`${root}/tx/${id}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: unknown;
      signature?: unknown;
    };
    if (typeof body.data !== 'string') {
      throw new Error('the transaction carries no data field');
    }
    return {
      data: Buffer.from(body.data, 'base64url'),
      // Carried so the caller can check the id is the SHA-256 of it.
      // `tx_root` does not bind ids, so this is what makes an id in the
      // index a real transaction's rather than one it chose to write.
      ...(typeof body.signature === 'string' && body.signature.length > 0
        ? { signature: Buffer.from(body.signature, 'base64url') }
        : {}),
    };
  };
}

export async function indexL1AuditCLICommand(
  options: IndexL1AuditCLIOptions,
  { log, fetchTxData }: IndexL1AuditDeps,
): Promise<JsonSerializable> {
  const coreDb = requiredStringFromOptions(options, 'coreDb');
  const whole = (value: string | undefined, flag: string) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new AuditRefused(`${flag} must be a whole number, 0 or above`);
    }
    return n;
  };
  const sample = whole(options.sample, '--sample') ?? DEFAULT_SAMPLE;
  if (sample < 1) throw new AuditRefused('--sample must be at least 1');
  const wantFrom = whole(options.from, '--from');
  const wantTo = whole(options.to, '--to');

  const fetcher =
    fetchTxData ??
    (options.dataFrom !== undefined && options.dataFrom.length > 0
      ? txDataFetcher(options.dataFrom)
      : undefined);
  if (fetcher === undefined) {
    throw new AuditRefused(
      '--data-from is required: an Arweave node or gateway to fetch transaction data from',
    );
  }

  let db: Sqlite.Database;
  try {
    db = new Sqlite(coreDb, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new AuditRefused(
      `Cannot open ${coreDb}: ${(error as Error).message}`,
    );
  }
  try {
    const held = stableHeightRange(db);
    if (held === undefined) {
      throw new AuditRefused(`${coreDb} holds no stable blocks to audit`);
    }
    const from = wantFrom ?? Math.max(held[0], FORK_2_0);
    const to = wantTo ?? held[1];
    if (to < from) {
      throw new AuditRefused(`--to (${to}) is below --from (${from})`);
    }
    log.info('Auditing tx_root where the index cannot', {
      coreDb,
      from,
      to,
      sample,
    });
    const { summary, blocks } = await runAudit(db, {
      from,
      to,
      sample,
      fetchTxData: fetcher,
      onBlock: (b) =>
        b.result === 'match'
          ? undefined
          : log.warn('Block not confirmed', {
              height: b.height,
              result: b.result,
              ...(b.reason !== undefined ? { reason: b.reason } : {}),
            }),
    });
    log.info('Audit finished', { ...summary });

    const answer = {
      coreDb,
      heightRange: [from, to],
      ...summary,
      // Unavailable counts against it: a source that selectively
      // withholds could otherwise hand back a clean-looking audit of
      // whatever it chose to serve.
      ok:
        summary.mismatched === 0 &&
        summary.unavailable === 0 &&
        summary.matched > 0,
      // Everything that did not match, and only a sample of what did:
      // the counts above carry the result, and a thousand matches is
      // tens of kilobytes of JSON that tells a reader nothing.
      blocks: [
        ...blocks.filter((b) => b.result !== 'match'),
        ...blocks
          .filter((b) => b.result === 'match')
          .slice(0, MAX_MATCHES_LISTED),
      ].map((b) => ({
        height: b.height,
        result: b.result,
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
        transactions: b.transactions,
        derived: b.derived,
        bytesFetched: b.bytesFetched,
      })),
      matchesListed: Math.min(summary.matched, MAX_MATCHES_LISTED),
    };
    // A mismatch is a finding, and so is a block that could not be
    // checked: an audit of only what a source chose to serve proves
    // nothing about what it withheld.
    if (!answer.ok) throw answer;
    return answer;
  } finally {
    db.close();
  }
}
