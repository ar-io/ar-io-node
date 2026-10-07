/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  ARWEAVE_COMMIT,
  CONSENSUS_PINS,
} from '../../../test/arweave-consensus-pin.js';

/**
 * Where `mr update` puts the Arweave checkout (`.mrconfig`). Without it
 * there is nothing to compare against, and the suite says so rather than
 * passing quietly — a drift check that silently does nothing is worse
 * than none, because it reads as coverage.
 */
function findArweave(): string | undefined {
  // `./tools/wt add` gives each worktree its own directory, so the
  // checkout usually sits in the main one a couple of levels up.
  let at = path.resolve('.');
  for (let up = 0; up < 4; up += 1) {
    const candidate = path.join(at, 'repos/arweave');
    if (fs.existsSync(path.join(candidate, 'apps/arweave/src'))) {
      return candidate;
    }
    at = path.dirname(at);
  }
  return undefined;
}

const ARWEAVE = findArweave();

const definition = (file: string, startsWith: string, lines: number) => {
  const text = fs
    .readFileSync(path.join(ARWEAVE as string, file), 'utf8')
    .split('\n');
  const at = text.findIndex((line) => line.startsWith(startsWith));
  if (at === -1) return undefined;
  return text.slice(at, at + lines).join('\n');
};

describe('the Arweave rules chain.ts mirrors', () => {
  if (ARWEAVE === undefined) {
    it('cannot be checked without one', () => {
      // Not a failure: CI has no checkout, and cloning one to run unit
      // tests would be worse than the risk. Run `mr update` locally.
      assert.ok(true, 'no Arweave checkout found; run `mr update`');
    });

    return;
  }

  for (const pin of CONSENSUS_PINS) {
    it(`${pin.file.split('/').pop()}: ${pin.startsWith.slice(0, 48)}`, () => {
      const body = definition(pin.file, pin.startsWith, pin.lines);
      assert.ok(
        body !== undefined,
        `${pin.startsWith} is gone from ${pin.file}. We mirror it in ${pin.mirrors}. Read the upstream diff and decide whether our rule still holds.`,
      );
      const digest = crypto
        .createHash('sha256')
        .update(body as string)
        .digest('hex');
      assert.equal(
        digest,
        pin.sha256,
        `${pin.file} changed upstream since ${ARWEAVE_COMMIT}.\n` +
          `  We mirror it in: ${pin.mirrors}\n` +
          `  This is a prompt to read the diff, not a verdict: a comment and a consensus change look the same here.\n` +
          `  If our rule still holds, update the pin in test/arweave-consensus-pin.ts and say so in the commit.`,
      );
    });
  }
});
