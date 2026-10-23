/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Re-reads every pinned piece of Arweave's source and fails when one has
 * changed (see `test/arweave-consensus-pin.ts`).
 *
 * The checkout is found at `$ARWEAVE_REPO` when that is set (say, to run
 * from a worktree, or against a scratch copy to check that an edit is
 * caught), and otherwise at `repos/arweave` in this directory or up to
 * three above it, where `mr update` puts it. Without one the suite skips:
 * CI has no checkout.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  ARWEAVE_COMMIT,
  CONSENSUS_PINS,
  FILE_PINS,
  HISTORICAL_PINS,
} from '../../../test/arweave-consensus-pin.js';

/**
 * Where `mr update` puts the Arweave checkout (`.mrconfig`). Without it
 * there is nothing to compare against, and the suite says so rather than
 * passing quietly — a drift check that silently does nothing is worse
 * than none, because it reads as coverage.
 */
function findArweave(): string | undefined {
  const given = process.env.ARWEAVE_REPO;
  if (given !== undefined && given !== '') {
    // Named explicitly: a wrong path is an error, not a quiet skip.
    if (!fs.existsSync(path.join(given, 'apps/arweave/src'))) {
      throw new Error(`ARWEAVE_REPO=${given} is not an Arweave checkout`);
    }
    return path.resolve(given);
  }
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

const sha256 = (data: string | Buffer) =>
  crypto.createHash('sha256').update(data).digest('hex');

/** The `lines` lines from the `occurrence`th line starting with `startsWith`. */
const definition = (
  file: string,
  startsWith: string,
  lines: number,
  occurrence = 1,
) => {
  const text = fs
    .readFileSync(path.join(ARWEAVE as string, file), 'utf8')
    .split('\n');
  let seen = 0;
  const at = text.findIndex(
    (line) => line.startsWith(startsWith) && (seen += 1) === occurrence,
  );
  if (at === -1) return undefined;
  return text.slice(at, at + lines).join('\n');
};

const changed = (what: string, mirrors: string) =>
  `${what} changed upstream since ${ARWEAVE_COMMIT}.\n` +
  `  We mirror it in: ${mirrors}\n` +
  `  This is a prompt to read the diff, not a verdict: a comment and a consensus change look the same here.\n` +
  `  If our rule still holds, update the pin in test/arweave-consensus-pin.ts and say so in the commit.`;

/** `git rev-parse <spec>` in the checkout, or undefined when it can't say. */
const revParse = (spec: string): string | undefined => {
  try {
    return execFileSync(
      'git',
      ['-C', ARWEAVE as string, 'rev-parse', '--verify', '--quiet', spec],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return undefined;
  }
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
    const label = pin.occurrence !== undefined ? ` (#${pin.occurrence})` : '';

    it(`${pin.file.split('/').pop()}: ${pin.startsWith.trim().slice(0, 48)}${label}`, () => {
      const body = definition(
        pin.file,
        pin.startsWith,
        pin.lines,
        pin.occurrence,
      );
      assert.ok(
        body !== undefined,
        `${pin.startsWith} is gone from ${pin.file}${label}. We mirror it in ${pin.mirrors}. Read the upstream diff and decide whether our rule still holds.`,
      );
      assert.equal(
        sha256(body as string),
        pin.sha256,
        changed(pin.file, pin.mirrors),
      );
    });
  }

  for (const pin of FILE_PINS) {
    it(`${pin.file}: whole file`, () => {
      const at = path.join(ARWEAVE, pin.file);
      assert.ok(
        fs.existsSync(at),
        `${pin.file} is gone. We rely on it for ${pin.mirrors}.`,
      );
      assert.equal(
        sha256(fs.readFileSync(at)),
        pin.sha256,
        changed(pin.file, pin.mirrors),
      );
    });
  }

  for (const pin of HISTORICAL_PINS) {
    it(`${pin.commit}:${pin.path}: blob`, (t) => {
      // A shallow clone or a copy without .git has no history to check.
      if (revParse(`${pin.commit}^{commit}`) === undefined) {
        t.skip(`the checkout has no commit ${pin.commit}`);
        return;
      }
      assert.equal(
        revParse(`${pin.commit}:${pin.path}`),
        pin.blob,
        `${pin.commit}:${pin.path} is not the blob we cited for ${pin.mirrors}`,
      );
    });
  }
});
