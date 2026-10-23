/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The re-settle diff's throughput on local disk: two bands of
 * INDEX_EXPORT_TEST_DIFF_BENCH entries each (1,000,000 for the figure in the
 * docs), one entry in a thousand relocated, compared by `diffBands`.
 * Skipped unless the variable is set: building the bands takes a while.
 * INDEX_EXPORT_TEST_DIFF_BENCH_MIN_MBPS sets the floor (default 50).
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Cdb64Writer } from '../../../lib/cdb64.js';
import { encodeCdb64Value } from '../../../lib/cdb64-encoding.js';
import {
  Cdb64Manifest,
  indexToPrefix,
  PartitionInfo,
  serializeManifest,
} from '../../../lib/cdb64-manifest.js';
import { diffBands } from './grid.js';

const ENTRIES = Number(process.env.INDEX_EXPORT_TEST_DIFF_BENCH ?? 0);
const MIN_MBPS = Number(
  process.env.INDEX_EXPORT_TEST_DIFF_BENCH_MIN_MBPS ?? 50,
);

/**
 * A band of `ENTRIES` entries as `buildBand` writes one: a partition per
 * first id byte, ids in order within it. `relocated` picks the entries
 * given another root.
 */
async function writeBand(
  dir: string,
  relocated: (n: number) => boolean,
): Promise<{ dir: string; manifest: Cdb64Manifest; bytes: number }> {
  await fs.mkdir(dir, { recursive: true });
  const byPartition = new Map<number, Array<{ id: Buffer; n: number }>>();
  for (let n = 0; n < ENTRIES; n++) {
    const id = crypto.createHash('sha256').update(`item-${n}`).digest();
    const list = byPartition.get(id[0]) ?? [];
    list.push({ id, n });
    byPartition.set(id[0], list);
  }
  const partitions: PartitionInfo[] = [];
  let bytes = 0;
  for (const prefix of [...byPartition.keys()].sort((a, b) => a - b)) {
    const list = (byPartition.get(prefix) ?? []).sort((a, b) =>
      a.id.compare(b.id),
    );
    const filename = `${indexToPrefix(prefix)}.cdb`;
    const writer = new Cdb64Writer(path.join(dir, filename));
    await writer.open();
    for (const { id, n } of list) {
      await writer.add(
        id,
        encodeCdb64Value({
          rootTxId: Buffer.alloc(32, relocated(n) ? 7 : 9),
          rootDataItemOffset: n * 1000,
          rootDataOffset: n * 1000 + 100,
          dataItemSize: 900,
        }),
      );
    }
    await writer.finalize();
    const size = (await fs.stat(path.join(dir, filename))).size;
    bytes += size;
    partitions.push({
      prefix: indexToPrefix(prefix),
      location: { type: 'file', filename },
      recordCount: list.length,
      size,
    });
  }
  const manifest: Cdb64Manifest = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    totalRecords: ENTRIES,
    partitions,
  };
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    serializeManifest(manifest),
  );
  return { dir, manifest, bytes };
}

describe(
  'diffBands throughput',
  {
    skip:
      ENTRIES > 0
        ? false
        : 'set INDEX_EXPORT_TEST_DIFF_BENCH (entries per band) to run',
  },
  () => {
    let dir: string;
    let old: Awaited<ReturnType<typeof writeBand>>;
    let next: Awaited<ReturnType<typeof writeBand>>;

    before(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grid-diff-bench-'));
      old = await writeBand(path.join(dir, 'old'), () => false);
      next = await writeBand(path.join(dir, 'new'), (n) => n % 1000 === 0);
    });

    after(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it(`compares two bands at ${MIN_MBPS} MB/s or more`, async () => {
      const started = process.hrtime.bigint();
      const diff = await diffBands(old, next, {
        maxChanged: 20_000,
        addedSampleSize: 150,
      });
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const mbps = (old.bytes + next.bytes) / 1e6 / seconds;
      process.stdout.write(
        `# diffBands: ${ENTRIES} entries a band, ${((old.bytes + next.bytes) / 1e6).toFixed(1)} MB in ${seconds.toFixed(2)} s: ${mbps.toFixed(1)} MB/s\n`,
      );
      assert.equal(diff.oldEntries, ENTRIES);
      assert.equal(diff.changed, Math.ceil(ENTRIES / 1000));
      assert.equal(diff.unchanged, ENTRIES - diff.changed);
      assert.equal(diff.added + diff.removed, 0);
      assert.ok(mbps >= MIN_MBPS, `${mbps.toFixed(1)} MB/s, under ${MIN_MBPS}`);
    });
  },
);
