/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The conformance cases run on four databases sharing a spill budget
 * whose every read that reserves less than all of it runs out part way
 * and runs again with all of it (`overflowing`), against the same cases
 * on one database: the same verdict, failing checks, report and on-chain
 * reads, case by case. Reruns keep only their last run's findings.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import {
  assertSameSideBySide,
  type Case,
  loadCases,
  overflowing,
  scratch,
} from '../../test/conformance/index-verification/harness.js';

/** The spill budget the databases share. */
const BUDGET_MIB = 64;

const cases: Case[] = (await loadCases()).filter((c) => c.kind === 'bands');

describe('index-verification conformance, reads run again', () => {
  let duck: Database;
  let root: string;
  const more: Database[] = [];
  const injected = { count: 0 };
  before(async () => {
    duck = await Database.create(':memory:');
    root = await scratch();
    for (let i = 0; i < 3; i += 1) more.push(await Database.create(':memory:'));
  });
  after(async () => {
    await duck.close();
    for (const d of more) await d.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const c of cases) {
    it(`${c.id}: as on one database`, async () => {
      await assertSameSideBySide(duck, root, c, {
        moreDucks: more.map((d) => overflowing(d, BUDGET_MIB, injected)),
        spillBytes: BUDGET_MIB * 2 ** 20,
      });
    });
  }

  it('ran reads out of spill, and they ran again', () => {
    assert.ok(injected.count > 0, 'no read ran out of spill');
  });
});
