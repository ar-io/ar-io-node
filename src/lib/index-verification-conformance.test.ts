/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The index-verification conformance suite, run through this
 * implementation's verifiers: every case in
 * test/conformance/index-verification/cases must give its expected verdict,
 * and, when it isn't `verified`, fire its named check. This is the gate for
 * changes to verification code (see that directory's README).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import {
  buildBandsCase,
  type Case,
  loadCases,
  runOnchainCase,
  scratch,
} from '../../test/conformance/index-verification/harness.js';

const cases: Case[] = await loadCases();

describe('index-verification conformance', () => {
  let duck: Database;
  let root: string;
  before(async () => {
    duck = await Database.create(':memory:');
    root = await scratch();
  });
  after(async () => {
    await duck.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('has each id once across the case files', () => {
    const ids = cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'an id is repeated');
  });

  it('has cases of every verdict', () => {
    for (const verdict of ['verified', 'refuted', 'unknown']) {
      assert.ok(
        cases.some((c) => c.expect.verdict === verdict),
        `no ${verdict} case`,
      );
    }
  });

  for (const c of cases) {
    it(`${c.id}: ${c.expect.verdict}${c.expect.check !== undefined ? ` (${c.expect.check})` : ''}`, async () => {
      const expectFailing = (failing: string[]) => {
        // Exactly the checks the case names fail: none more.
        assert.deepEqual(
          [...failing].sort(),
          [...(c.expect.failing ?? [])].sort(),
          `failing ${failing.join(', ')}`,
        );
        if (c.expect.check !== undefined && c.expect.verdict !== 'verified') {
          assert.ok(failing.includes(c.expect.check));
        }
      };
      if (c.kind === 'onchain') {
        const result = await runOnchainCase(c);
        assert.equal(result.verdict, c.expect.verdict, c.description);
        expectFailing(result.failing);
        assert.deepEqual(result.reason, c.expect.reason ?? [], c.description);
        if (c.expect.assurancePercent !== undefined) {
          assert.match(
            result.assurance,
            new RegExp(`a band in which ${c.expect.assurancePercent}% or more`),
            result.assurance,
          );
        }
        return;
      }
      const built = await buildBandsCase(duck, root, c);
      const result = await built.run();
      assert.equal(
        result.verdict,
        c.expect.verdict,
        `${c.description}: failing ${result.failing.join(', ')}`,
      );
      expectFailing(result.failing);
      if (c.expect.publisherBound !== undefined) {
        assert.equal(result.publisherBound, c.expect.publisherBound);
      }
      if (c.expect.draw !== undefined) {
        assert.equal(result.drawnUniform, c.expect.draw.drawnUniform);
        if (c.expect.draw.nestedAtLeast !== undefined) {
          assert.ok(
            (result.drawnNested ?? 0) >= c.expect.draw.nestedAtLeast,
            `${result.drawnNested} nested drawn`,
          );
        }
        for (const offset of c.expect.draw.readsInclude ?? []) {
          assert.ok(result.reads.includes(offset), `${offset} not read`);
        }
        if (c.expect.draw.bandsDiffer === true) {
          // The same layout, one seed: the draws sit at different places in
          // the two files, since each band's draw is salted by its id.
          const [one, two] = result.positionsByBand;
          assert.ok(one.length > 0 && two.length > 0, 'both bands drawn');
          assert.notDeepEqual(one, two, 'two bands drew the same positions');
        }
      }
      if (c.expect.repeatable === true) {
        const again = await built.run();
        assert.deepEqual(
          [...again.reads].sort((x, y) => x - y),
          [...result.reads].sort((x, y) => x - y),
        );
      }
    });
  }
});
