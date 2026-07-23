/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CompositeRootTxIndex } from './composite-root-tx-index.js';
import { DataItemRootIndex } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'CompositeRootTxIndex' });

type RootTxResult = Awaited<ReturnType<DataItemRootIndex['getRootTx']>>;

// Circuit-breaker options that never trip and never time out so tests exercise
// only the composite's own control flow.
const stableBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 100,
  resetTimeout: 1000,
  rollingCountTimeout: 5000,
};

/**
 * Builds a `DataItemRootIndex` stub with a distinct constructor name and a call
 * counter. The composite keys its per-source circuit breakers on
 * `constructor.name`, so each stub must be uniquely named to avoid collisions.
 *
 * @param name - unique class name for the stub (drives the breaker key).
 * @param result - the value (or async factory) returned by `getRootTx`.
 */
function makeIndex(
  name: string,
  result: RootTxResult | (() => Promise<RootTxResult>),
): DataItemRootIndex & { calls: number } {
  const holder = {
    [name]: class {
      calls = 0;
      async getRootTx(): Promise<RootTxResult> {
        this.calls++;
        return typeof result === 'function' ? result() : result;
      }
    },
  };
  return new holder[name]() as DataItemRootIndex & { calls: number };
}

const ID = 'a'.repeat(43); // stand-in data item / tx id

describe('CompositeRootTxIndex', () => {
  it('short-circuits on complete offsets without probing later sources', async () => {
    const first = makeIndex('TurboRootTxIndex', {
      rootTxId: 'root-1',
      rootOffset: 10,
      rootDataOffset: 20,
      size: 100,
      dataSize: 90,
    });
    const second = makeIndex('GraphQLRootTxIndex', { rootTxId: 'should-not' });

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [first, second],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.equal(result?.rootTxId, 'root-1');
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 0, 'later source must not be probed');
  });

  it('short-circuits on a CDB-style result (offsets but no size)', async () => {
    // This is the regression this change targets: prior to the fix a size-less
    // offset result did not satisfy the gate, so GraphQL was probed anyway.
    const cdb = makeIndex('Cdb64RootTxIndex', {
      rootTxId: 'root-2',
      rootOffset: 10,
      rootDataOffset: 20,
    });
    const graphql = makeIndex('GraphQLRootTxIndex', {
      rootTxId: 'root-2',
      dataSize: 90,
    });

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [cdb, graphql],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.equal(result?.rootTxId, 'root-2');
    assert.equal(result?.rootOffset, 10);
    assert.equal(
      graphql.calls,
      0,
      'GraphQL must not be probed after a CDB hit',
    );
  });

  it('short-circuits on a definitive L1 root (rootTxId === id)', async () => {
    const db = makeIndex('StandaloneSqlite', { rootTxId: ID });
    const graphql = makeIndex('GraphQLRootTxIndex', { rootTxId: ID });

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [db, graphql],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.equal(result?.rootTxId, ID);
    assert.equal(graphql.calls, 0, 'L1 root is authoritative; stop probing');
  });

  it('short-circuits on a path-only result', async () => {
    const cdb = makeIndex('Cdb64RootTxIndex', {
      rootTxId: 'root-3',
      path: ['root-3', 'parent-3'],
    });
    const graphql = makeIndex('GraphQLRootTxIndex', { rootTxId: 'root-3' });

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [cdb, graphql],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.deepEqual(result?.path, ['root-3', 'parent-3']);
    assert.equal(graphql.calls, 0);
  });

  it('keeps probing past a bare rootTxId and prefers a later actionable result', async () => {
    // db returns a thin result (nested item, no path/offsets) -> not actionable.
    const db = makeIndex('StandaloneSqlite', { rootTxId: 'root-4' });
    const cdb = makeIndex('Cdb64RootTxIndex', {
      rootTxId: 'root-4',
      rootOffset: 5,
      rootDataOffset: 15,
    });
    const graphql = makeIndex('GraphQLRootTxIndex', { rootTxId: 'root-4' });

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [db, cdb, graphql],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.equal(db.calls, 1);
    assert.equal(cdb.calls, 1);
    assert.equal(result?.rootOffset, 5, 'should return the richer CDB result');
    assert.equal(graphql.calls, 0, 'CDB was actionable; GraphQL not probed');
  });

  it('returns the saved fallback when no source is actionable', async () => {
    const db = makeIndex('StandaloneSqlite', { rootTxId: 'root-5' }); // bare
    const graphql = makeIndex('GraphQLRootTxIndex', undefined); // miss

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [db, graphql],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.equal(
      result?.rootTxId,
      'root-5',
      'bare rootTxId returned as fallback',
    );
    assert.equal(db.calls, 1);
    assert.equal(graphql.calls, 1, 'no actionable hit; full chain is probed');
  });

  it('returns undefined when every source misses', async () => {
    const db = makeIndex('StandaloneSqlite', undefined);
    const cdb = makeIndex('Cdb64RootTxIndex', undefined);

    const composite = new CompositeRootTxIndex({
      log,
      indexes: [db, cdb],
      circuitBreakerOptions: stableBreakerOptions,
    });

    const result = await composite.getRootTx(ID);
    assert.equal(result, undefined);
  });
});
