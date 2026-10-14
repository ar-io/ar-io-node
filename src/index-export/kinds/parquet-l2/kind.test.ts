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
  MemoryL2Source,
  PUBLISHER,
  writeL1Band,
} from '../../../../test/parquet-l2-fixture.js';
import { createTestLogger } from '../../../../test/test-logger.js';
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
