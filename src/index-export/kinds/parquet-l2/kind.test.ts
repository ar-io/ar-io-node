/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';

import { BufferByteRangeSource } from '../../../../test/buffer-byte-range-source.js';
import {
  malformedTagCountRoot,
  MalformedTagCountRoot,
} from '../../../../test/malformed-tag-count-item.js';
import {
  ARDRIVE,
  buildRoot,
  gatewayOf,
  MemoryL2Source,
  PUBLISHER,
  sourceRow,
  writeL1Band,
} from '../../../../test/parquet-l2-fixture.js';
import { createTestLogger } from '../../../../test/test-logger.js';
import { readPublisherFacts } from '../../../lib/parquet-l1/layout.js';
import { parseSelection } from '../../../lib/parquet-l2/layout.js';
import { deriveL1Bands } from '../parquet-l1/kind.js';
import { runL2Step } from './kind.js';
import type { L2SourceRow } from './source.js';

const log = createTestLogger({ suite: 'parquet-l2 kind' });
const ROOT = crypto.createHash('sha256').update('malformed root').digest();

describe('runL2Step', () => {
  let fixture: MalformedTagCountRoot;
  let dir: string;

  before(async () => {
    fixture = await malformedTagCountRoot();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-kind-'));
  });

  it('publishes a band whose header check meets an item with a malformed tag count, counting it', async () => {
    const { item } = fixture;
    // As ClickHouse holds it: its header offsets item-relative.
    const row: L2SourceRow = {
      id: item.rawId,
      parentId: ROOT,
      rootTxId: ROOT,
      height: 789_458,
      offset: item.rootOffset,
      size: item.size,
      dataOffset: item.rootDataOffset,
      signatureOffset: 2,
      signatureSize: 512,
      ownerOffset: 2 + 512,
      ownerSize: 512,
      rootParentOffset: 0,
      dataSize: item.size - (item.rootDataOffset - item.rootOffset),
      signatureType: 1,
      ownerAddress: crypto.createHash('sha256').update(item.owner).digest(),
      tags: item.tags.map((tag) => ({
        name: Buffer.from(tag.name),
        value: Buffer.from(tag.value),
      })),
    };
    const l1 = path.join(dir, 'parquet-l1');
    await writeL1Band(l1, 785_000, 789_999, [
      { id: ROOT, height: 789_458, blockTransactionIndex: 4 },
    ]);
    const publishDir = path.join(dir, 'published', 't0-l2');
    const outcome = await runL2Step(
      {
        step: 'freeze',
        role: 'd',
        heightRange: [785_000, 789_999],
        replaces: [],
        settles: true,
      },
      {
        index: {
          name: 't0-l2',
          selection: parseSelection({
            kind: 'ans104-data-items',
            tag: { name: 'T0', valuePrefix: '0' },
          }),
          publishDir,
        },
        publisher: PUBLISHER,
        workDir: path.join(dir, 'work'),
        source: new MemoryL2Source([row]),
        l1Bands: await deriveL1Bands(l1, PUBLISHER),
        openRoot: () => new BufferByteRangeSource(fixture.root),
        maxReads: 10,
        resettleMaxChanged: 10,
        dryRun: false,
        log,
      },
    );
    assert.deepEqual(
      [outcome.result, outcome.reason],
      ['published', 'new'],
      JSON.stringify(outcome.details),
    );
    assert.equal(outcome.checks?.normalised, 1);
    assert.equal(outcome.header?.wrong, 0);
    assert.equal(outcome.header?.malformedTags, 1);
    assert.equal(outcome.header?.byTag.normalised?.malformedTags, 1);
    // The owner's key read from the root, at the normalised offset.
    assert.equal(outcome.rows?.wallets, 1);
    assert.deepEqual(await fs.readdir(publishDir), [outcome.id]);
  });
});

describe('runL2Step, band.json', () => {
  /** A seeded random source (mulberry32). */
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('is the same bytes for the same rows whatever the sample read and the gateway answered it', async () => {
    const tag = (value: string) => [{ name: 'App-Name', value }];
    const roots = await Promise.all(
      [10, 10, 3].map((n, r) =>
        buildRoot(
          `same-${r}`,
          Array.from({ length: n }, (_, i) => ({
            name: `i${i}`,
            tags: tag('ArDrive-App'),
          })),
          100_500 + r,
          0,
        ),
      ),
    );
    // Owners' keys from the source: the build reads nothing.
    const rows: L2SourceRow[] = roots.flatMap((root) =>
      [...root.items.keys()].map((name) =>
        sourceRow(root, name, {
          owner: root.items.get(name)!.item.rawOwner,
        }),
      ),
    );
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-same-'));
    try {
      const l1 = path.join(dir, 'parquet-l1');
      await writeL1Band(l1, 100_000, 199_999, roots);
      const build = async (seed: number, gone: number[], keep: string) => {
        const fixture = gatewayOf(roots.filter((_, r) => !gone.includes(r)));
        const outcome = await runL2Step(
          {
            step: 'pin',
            role: 'd',
            heightRange: [100_000, 104_999],
            replaces: [],
            settles: true,
          },
          {
            index: {
              name: 'ardrive-l2',
              selection: ARDRIVE,
              publishDir: path.join(dir, 'published', 'ardrive-l2'),
            },
            publisher: PUBLISHER,
            keepDir: path.join(dir, keep),
            workDir: path.join(dir, 'work'),
            source: new MemoryL2Source(rows),
            l1Bands: await deriveL1Bands(l1, PUBLISHER),
            openRoot: fixture.openRoot,
            maxReads: 100,
            resettleMaxChanged: 10,
            dryRun: true,
            log,
            random: seeded(seed),
            headerCheck: { retryDelayMs: 1 },
          },
        );
        assert.equal(
          outcome.result,
          'dry_run',
          JSON.stringify(outcome.details),
        );
        return outcome;
      };
      const a = await build(1, [], 'a');
      const b = await build(99, [2], 'b');
      // The samples differ: b passed over the gone root's three rows.
      assert.equal(a.header?.unreadable, 0);
      assert.equal(b.header?.unreadable, 3);
      assert.equal(a.id, b.id);
      const bytes = async (outcome: typeof a) =>
        fs.readFile(path.join(outcome.keptAt as string, 'band.json'), 'utf8');
      assert.equal(await bytes(a), await bytes(b));
      // What the sample read is the publisher's own.
      const facts = await readPublisherFacts(b.keptAt as string);
      assert.equal(facts?.headerCheck?.unreadable, 3);
      assert.equal(facts?.headerCheck?.sampled, 20);
      assert.deepEqual(facts?.unreadable, { proofs: 0, keys: 0 });
      assert.deepEqual(Object.keys(JSON.parse(await bytes(a)).checks).sort(), [
        'ambiguousProven',
        'ambiguousUnlocated',
        'located',
        'normalised',
        'ownersWithoutKey',
        'repaired',
        'unlocated',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
