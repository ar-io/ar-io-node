/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import {
  RootArweaveAnnotatingDataAttributesSource,
  RootArweaveLocationSource,
  rootArweaveCandidate,
  withRootArweaveLocation,
} from './root-arweave-location-source.js';
import { ContiguousDataAttributes, TxGeometry } from '../types.js';

const log = createTestLogger({ suite: 'RootArweaveLocationSource' });

const ROOT = 'Dfi5LEHn79AoBSsdi1Oyvh8JfT1cwmu-CJ2K5C6T958';
const ITEM = 'wndEaLf1BwnhuNmpDisdl0wWLnIrsVhQnPE0W24cWM8';
const PARENT = 'LPMc8z6reldKo_KitgnV6i3RgHnFLAKnn5jDK7ar4qo';

// Real values for ROOT on mainnet: /tx/{id}/offset END offset and size.
const ROOT_END_OFFSET = 392971323892121;
const ROOT_SIZE = 3555491;
const ROOT_START = ROOT_END_OFFSET - ROOT_SIZE + 1;

/** A geometry source answering from `answers` (an Error is thrown), recording calls. */
function geometrySource(
  answers: Record<string, TxGeometry | undefined | Error>,
) {
  const calls: string[] = [];
  return {
    calls,
    source: {
      getTxGeometry: async (txId: string) => {
        calls.push(txId);
        const answer = answers[txId];
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    },
  };
}

/** Attributes for a stable item with no root or parent unless overridden. */
function attributes(
  overrides: Partial<ContiguousDataAttributes> = {},
): ContiguousDataAttributes {
  return {
    size: 10,
    isManifest: false,
    stable: true,
    verified: false,
    ...overrides,
  } as ContiguousDataAttributes;
}

describe('RootArweaveLocationSource', () => {
  it('converts the stored END offset to the inclusive start offset', async () => {
    const { source } = geometrySource({
      [ROOT]: { dataRoot: 'dr', offset: ROOT_END_OFFSET, size: ROOT_SIZE },
    });
    const locations = new RootArweaveLocationSource({
      log,
      txGeometrySource: source,
    });

    assert.deepEqual(await locations.getRootArweaveLocation(ROOT), {
      startOffset: ROOT_START,
      dataSize: ROOT_SIZE,
    });
  });

  it('caches a found location (stable rows never change)', async () => {
    const { source, calls } = geometrySource({
      [ROOT]: { dataRoot: 'dr', offset: ROOT_END_OFFSET, size: ROOT_SIZE },
    });
    const locations = new RootArweaveLocationSource({
      log,
      txGeometrySource: source,
    });

    await locations.getRootArweaveLocation(ROOT);
    await locations.getRootArweaveLocation(ROOT);
    assert.deepEqual(calls, [ROOT]);
  });

  it('remembers a miss only for the miss TTL', async () => {
    const answers: Record<string, TxGeometry | undefined> = {};
    const { source, calls } = geometrySource(answers);
    const locations = new RootArweaveLocationSource({
      log,
      txGeometrySource: source,
      missTtlMs: 20,
    });

    assert.equal(await locations.getRootArweaveLocation(ROOT), undefined);
    assert.equal(await locations.getRootArweaveLocation(ROOT), undefined);
    assert.equal(calls.length, 1, 'a fresh miss is not re-read');

    // The offset importer records the offset; after the TTL it is found.
    answers[ROOT] = {
      dataRoot: 'dr',
      offset: ROOT_END_OFFSET,
      size: ROOT_SIZE,
    };
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(await locations.getRootArweaveLocation(ROOT), {
      startOffset: ROOT_START,
      dataSize: ROOT_SIZE,
    });
  });

  it('treats a failed read as a miss, without throwing', async () => {
    const { source } = geometrySource({ [ROOT]: new Error('db busy') });
    const locations = new RootArweaveLocationSource({
      log,
      txGeometrySource: source,
    });

    assert.equal(await locations.getRootArweaveLocation(ROOT), undefined);
  });

  it('rejects impossible geometry rather than publishing it', async () => {
    const { source } = geometrySource({
      a: { dataRoot: 'dr', offset: 10, size: 0 },
      b: { dataRoot: 'dr', offset: 5, size: 10 },
      c: { dataRoot: 'dr', offset: Number.MAX_SAFE_INTEGER + 2, size: 1 },
    });
    const locations = new RootArweaveLocationSource({
      log,
      txGeometrySource: source,
    });

    for (const id of ['a', 'b', 'c']) {
      assert.equal(await locations.getRootArweaveLocation(id), undefined, id);
    }
  });
});

describe('rootArweaveCandidate', () => {
  it('uses the transaction itself for an L1 transaction', () => {
    assert.equal(rootArweaveCandidate(ROOT, attributes()), ROOT);
  });

  it('uses the root for a data item directly inside its root bundle', () => {
    assert.equal(
      rootArweaveCandidate(
        ITEM,
        attributes({ rootTransactionId: ROOT, parentId: ROOT }),
      ),
      ROOT,
    );
  });

  it('uses the root for a location placed by a fetch or index (no parent)', () => {
    assert.equal(
      rootArweaveCandidate(ITEM, attributes({ rootTransactionId: ROOT })),
      ROOT,
    );
  });

  it('excludes items nested more than one level in our bundle index (#907)', () => {
    assert.equal(
      rootArweaveCandidate(
        ITEM,
        attributes({ rootTransactionId: ROOT, parentId: PARENT }),
      ),
      undefined,
    );
  });

  it('excludes an item with a parent but no root, and unknown IDs', () => {
    assert.equal(
      rootArweaveCandidate(ITEM, attributes({ parentId: PARENT })),
      undefined,
    );
    assert.equal(rootArweaveCandidate(ITEM, undefined), undefined);
  });
});

describe('withRootArweaveLocation', () => {
  const locations = () =>
    new RootArweaveLocationSource({
      log,
      txGeometrySource: geometrySource({
        [ROOT]: { dataRoot: 'dr', offset: ROOT_END_OFFSET, size: ROOT_SIZE },
      }).source,
    });

  it('adds the root location to a new object and leaves the input alone', async () => {
    const input = attributes({ rootTransactionId: ROOT, parentId: ROOT });
    const output = await withRootArweaveLocation(ITEM, input, locations());

    assert.equal(output?.rootArweaveStartOffset, ROOT_START);
    assert.equal(output?.rootArweaveDataSize, ROOT_SIZE);
    assert.notEqual(output, input);
    assert.equal(input.rootArweaveStartOffset, undefined);
  });

  it('returns the input unchanged when no location may be published', async () => {
    const nested = attributes({ rootTransactionId: ROOT, parentId: PARENT });
    assert.equal(
      await withRootArweaveLocation(ITEM, nested, locations()),
      nested,
    );
    const unknownRoot = attributes({ rootTransactionId: 'not-stable' });
    assert.equal(
      await withRootArweaveLocation(ITEM, unknownRoot, locations()),
      unknownRoot,
    );
    assert.equal(
      await withRootArweaveLocation(ITEM, undefined, locations()),
      undefined,
    );
  });

  it('is applied on every read by the annotating source', async () => {
    const source = new RootArweaveAnnotatingDataAttributesSource({
      source: { getDataAttributes: async () => attributes() },
      locations: locations(),
    });

    const answer = await source.getDataAttributes(ROOT);
    assert.equal(answer?.rootArweaveStartOffset, ROOT_START);
    assert.equal(answer?.rootArweaveDataSize, ROOT_SIZE);
  });
});
