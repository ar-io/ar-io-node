/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The conformance cases run on four databases side by side
 * (`verifyL2Bands`' `moreDucks`), against the same cases on one: the same
 * verdict, failing checks, report and on-chain reads, case by case.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import {
  assertSameSideBySide,
  type Case,
  loadCases,
  scratch,
} from '../../test/conformance/index-verification/harness.js';

const cases: Case[] = (await loadCases()).filter((c) => c.kind === 'bands');

describe('index-verification conformance, four databases', () => {
  let duck: Database;
  let root: string;
  const more: Database[] = [];
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
      await assertSameSideBySide(duck, root, c, { moreDucks: more });
    });
  }

  it('ran on four databases', () => {
    assert.equal(more.length, 3);
  });
});
