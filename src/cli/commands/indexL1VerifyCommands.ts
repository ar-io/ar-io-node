/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l1-verify`: check a gateway's L1 index against the weave size the
 * chain commits to, and against itself.
 *
 * Read-only, so it is safe to run while the gateway is up.
 */
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import {
  chooseRange,
  stableHeightRange,
  verifyRange,
  VerifyRefused,
} from '../../lib/parquet-l1/verify.js';
import type { IndexL1VerifyCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';

export interface IndexL1VerifyDeps {
  log: Logger;
}

const height = (
  value: string | undefined,
  flag: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VerifyRefused(`${flag} must be a whole height, 0 or above`);
  }
  return parsed;
};

export async function indexL1VerifyCLICommand(
  options: IndexL1VerifyCLIOptions,
  { log }: IndexL1VerifyDeps,
): Promise<JsonSerializable> {
  const coreDb = requiredStringFromOptions(options, 'coreDb');
  const wantFrom = height(options.from, '--from');
  const wantTo = height(options.to, '--to');

  let db: Sqlite.Database;
  try {
    db = new Sqlite(coreDb, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new VerifyRefused(
      `Cannot open ${coreDb}: ${(error as Error).message}`,
    );
  }
  try {
    const held = stableHeightRange(db);
    if (held === undefined) {
      throw new VerifyRefused(`${coreDb} holds no stable blocks to check`);
    }
    const [from, to] = chooseRange(held, {
      ...(wantFrom !== undefined ? { from: wantFrom } : {}),
      ...(wantTo !== undefined ? { to: wantTo } : {}),
    });
    log.info('Checking the L1 index', { coreDb, from, to });
    const result = verifyRange(db, { from, to });
    log.info('Checked the L1 index', {
      ok: result.ok,
      blocks: result.blocks,
      seconds: Math.round(result.seconds),
    });
    const answer = {
      coreDb,
      heightRange: result.heightRange,
      blocks: result.blocks,
      anchored: result.anchored,
      ...(result.anchorHeight !== undefined
        ? { anchorHeight: result.anchorHeight }
        : {}),
      ...(result.weaveSize !== undefined
        ? { weaveSize: result.weaveSize, accountedFor: result.accountedFor }
        : {}),
      merkleChecked: result.merkleChecked,
      merkleSkipped: result.merkleSkipped,
      accountingChecked: result.accountingChecked,
      accountingSkipped: result.accountingSkipped,
      ok: result.ok,
      checks: result.checks.map((c) => ({
        name: c.name,
        ok: c.ok,
        detail: c.detail,
        ...(c.failures !== undefined
          ? {
              failures: c.failures.map((f) => ({
                height: f.height,
                found: f.found,
                expected: f.expected,
              })),
            }
          : {}),
        ...(c.more !== undefined ? { more: c.more } : {}),
      })),
      seconds: Math.round(result.seconds * 10) / 10,
    };
    // A failed check has to fail the command. `runCommand` prints a
    // thrown result on stderr and exits 1; returning it would print the
    // same JSON and exit 0, and a script would read a broken index as a
    // good one.
    if (!result.ok) throw answer;
    return answer;
  } finally {
    db.close();
  }
}
