/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createFilter } from '../filters.js';
import { createTestLogger } from '../../test/test-logger.js';
import { assertMonotoneFilter, isL1OnlyQuery } from './gql-l1-routing.js';

const log = createTestLogger({ suite: 'gql-l1-routing' });

// The canonical case: an operator asserting "App-Name=SmartWeaveAction queries
// are L1-only".
const swaFilter = createFilter(
  { tags: [{ name: 'App-Name', value: 'SmartWeaveAction' }] },
  log,
);

describe('assertMonotoneFilter', () => {
  it('accepts the monotone subset', () => {
    assert.doesNotThrow(() =>
      assertMonotoneFilter({ tags: [{ name: 'App-Name', value: 'X' }] }),
    );
    assert.doesNotThrow(() =>
      assertMonotoneFilter({ attributes: { owner_address: 'abc' } }),
    );
    assert.doesNotThrow(() =>
      assertMonotoneFilter({
        and: [{ tags: [{ name: 'a', value: 'b' }] }, { always: true }],
      }),
    );
    assert.doesNotThrow(() =>
      assertMonotoneFilter({ or: [{ never: true }, { always: true }] }),
    );
    assert.doesNotThrow(() => assertMonotoneFilter(undefined));
    assert.doesNotThrow(() => assertMonotoneFilter(''));
  });

  it('rejects non-monotone / unsupported constructs', () => {
    assert.throws(() => assertMonotoneFilter({ not: { always: true } }), /not/);
    assert.throws(
      () => assertMonotoneFilter({ isNestedBundle: true }),
      /isNestedBundle/,
    );
    assert.throws(
      () => assertMonotoneFilter({ hashPartition: {} }),
      /hashPartition/,
    );
  });

  it('rejects a rejected key nested inside and/or', () => {
    assert.throws(
      () =>
        assertMonotoneFilter({
          and: [
            { tags: [{ name: 'a', value: 'b' }] },
            { not: { always: true } },
          ],
        }),
      /not/,
    );
    assert.throws(
      () => assertMonotoneFilter({ or: [{ isNestedBundle: true }] }),
      /isNestedBundle/,
    );
  });
});

describe('isL1OnlyQuery', () => {
  it('routes a query that pins the asserted tag', () => {
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      true,
    );
  });

  it('routes when the query adds further-narrowing constraints', () => {
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        owners: ['someOwnerAddress'],
        tags: [
          { name: 'App-Name', values: ['SmartWeaveAction'] },
          { name: 'Content-Type', values: ['application/json'] },
        ],
      }),
      true,
    );
  });

  it('does NOT route when a tag value is outside the asserted set', () => {
    // App-Name IN [SmartWeaveAction, Other] — a result could carry "Other".
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction', 'Other'] }],
      }),
      false,
    );
  });

  it('does NOT route a query lacking the asserted tag', () => {
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        tags: [{ name: 'Content-Type', values: ['application/json'] }],
      }),
      false,
    );
    assert.equal(isL1OnlyQuery({ filter: swaFilter, owners: ['x'] }), false);
    assert.equal(isL1OnlyQuery({ filter: swaFilter }), false);
  });

  it('never routes bundledIn queries (they target bundled data items)', () => {
    // Even though the tags entail the filter, a bundledIn array asks for
    // bundled data items — routing to L1-only would drop them.
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
        bundledIn: ['someParentBundleId'],
      }),
      false,
    );
    // `null`/`undefined` bundledIn are not data-item filters — still eligible.
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
        bundledIn: null,
      }),
      true,
    );
  });

  it('never routes id lookups', () => {
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        ids: ['someId'],
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      false,
    );
  });

  it('requires ALL conjuncts of an `and` filter to be pinned', () => {
    const andFilter = createFilter(
      {
        and: [
          { tags: [{ name: 'App-Name', value: 'SmartWeaveAction' }] },
          { attributes: { owner_address: 'ownerA' } },
        ],
      },
      log,
    );
    // Missing the owner → not entailed.
    assert.equal(
      isL1OnlyQuery({
        filter: andFilter,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      false,
    );
    // Both pinned → entailed.
    assert.equal(
      isL1OnlyQuery({
        filter: andFilter,
        owners: ['ownerA'],
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      true,
    );
    // Wrong owner → not entailed.
    assert.equal(
      isL1OnlyQuery({
        filter: andFilter,
        owners: ['ownerB'],
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      false,
    );
  });

  it('handles `or` when the query is entailed by either branch', () => {
    const orFilter = createFilter(
      {
        or: [
          { tags: [{ name: 'App-Name', value: 'SmartWeaveAction' }] },
          { tags: [{ name: 'App-Name', value: 'SmartWeaveContract' }] },
        ],
      },
      log,
    );
    assert.equal(
      isL1OnlyQuery({
        filter: orFilter,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      true,
    );
    // A value covered by neither branch → not entailed.
    assert.equal(
      isL1OnlyQuery({
        filter: orFilter,
        tags: [{ name: 'App-Name', values: ['Warp'] }],
      }),
      false,
    );
  });

  it('routes everything under an `always` filter (operator footgun)', () => {
    const always = createFilter({ always: true }, log);
    assert.equal(isL1OnlyQuery({ filter: always }), true);
    assert.equal(
      isL1OnlyQuery({ filter: always, tags: [{ name: 'x', values: ['y'] }] }),
      true,
    );
  });

  it('never routes under a `never` filter', () => {
    const never = createFilter({ never: true }, log);
    assert.equal(
      isL1OnlyQuery({
        filter: never,
        tags: [{ name: 'App-Name', values: ['SmartWeaveAction'] }],
      }),
      false,
    );
  });

  it('declines (conservatively) when the value cartesian product is too large', () => {
    // 300 values on a single tag exceeds MAX_SYNTHETIC_ITEMS (256).
    const manyValues = Array.from({ length: 300 }, () => 'SmartWeaveAction');
    assert.equal(
      isL1OnlyQuery({
        filter: swaFilter,
        tags: [{ name: 'App-Name', values: manyValues }],
      }),
      false,
    );
  });
});
