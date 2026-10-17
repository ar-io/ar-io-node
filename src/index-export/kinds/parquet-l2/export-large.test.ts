/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A band of millions of items in bounded memory: a synthetic source of
 * INDEX_EXPORT_TEST_L2_LARGE items (3,000,000 for the figure in the docs)
 * over a whole 100,000-height range, built with DuckDB held to 512 MB.
 * Skipped unless the variable is set: it takes minutes.
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { PUBLISHER } from '../../../../test/parquet-l2-fixture.js';
import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { PARQUET_L1_TABLES } from '../../../lib/parquet-l1/layout.js';
import {
  parseSelection,
  ParquetL2Selection,
} from '../../../lib/parquet-l2/layout.js';
import type { ByteRangeSource } from '../../../lib/byte-range-source.js';
import { withBandWriter } from '../parquet-l1/export.js';
import { deriveL1Bands } from '../parquet-l1/kind.js';
import { exportL2Band } from './export.js';
import { GatewayReads } from './gateway-reads.js';
import type { L2ItemSource, L2SourceRow, L2SourceWindow } from './source.js';

const ITEMS = Number(process.env.INDEX_EXPORT_TEST_L2_LARGE ?? 0);
const FROM = 100_000;
const TO = 199_999;
const OWNERS = 50_000;

const sha256 = (text: string) =>
  crypto.createHash('sha256').update(text).digest();
const rootAt = (height: number) => sha256(`root-${height}`);

/**
 * Items generated as a window asks for them, never all held: item `i` sits
 * at height FROM + i mod 100,000, in that height's root, signed (Ed25519:
 * a 64-byte signature, a 32-byte key, kept in the row as ClickHouse keeps
 * short keys) by one of OWNERS owners, with seven tags.
 */
class GeneratedSource implements L2ItemSource {
  readonly name = 'generated';
  private readonly keys = Array.from({ length: OWNERS }, (_, i) =>
    sha256(`key-${i}`),
  );

  async stableHeight(): Promise<number> {
    return TO;
  }

  async *windows(
    from: number,
    to: number,
    _selection: ParquetL2Selection,
  ): AsyncIterable<L2SourceWindow> {
    const heights = TO - FROM + 1;
    for (let start = from; start <= to; start += 250) {
      const end = Math.min(to, start + 249);
      const items: L2SourceRow[] = [];
      for (let height = start; height <= end; height++) {
        const perHeight =
          Math.floor(ITEMS / heights) +
          (height - FROM < ITEMS % heights ? 1 : 0);
        let offset = 32 + 64 * perHeight;
        for (let k = 0; k < perHeight; k++) {
          const i = k * heights + (height - FROM);
          const owner = this.keys[i % OWNERS];
          const tags = [
            ['App-Name', 'ArDrive-App'],
            ['App-Version', '2.49.0'],
            ['Content-Type', 'application/json'],
            ['ArFS', '0.14'],
            ['Entity-Type', 'file'],
            ['File-Id', crypto.randomUUID()],
            ['Unix-Time', String(1_700_000_000 + i)],
          ].map(([name, value]) => ({
            name: Buffer.from(name),
            value: Buffer.from(value),
          }));
          const header = 2 + 64 + 32 + 1 + 1 + 16 + 160;
          const size = header + 300 + (i % 700);
          items.push({
            id: sha256(`item-${i}`),
            parentId: rootAt(height),
            rootTxId: rootAt(height),
            height,
            offset,
            size,
            dataOffset: offset + header,
            signatureOffset: offset + 2,
            signatureSize: 64,
            ownerOffset: offset + 66,
            ownerSize: 32,
            rootParentOffset: 0,
            dataSize: size - header,
            signatureType: 2,
            ownerAddress: crypto.createHash('sha256').update(owner).digest(),
            owner,
            tags,
          });
          offset += size;
        }
      }
      yield { from: start, to: end, items, ancestors: [] };
    }
  }

  async close(): Promise<void> {}
}

/** This publisher's L1 band over the range: one root a height. */
async function writeL1(dir: string): Promise<void> {
  const digest = '0'.repeat(64);
  const id = `l1-h${FROM}-${TO}-${bandPublisherTag(PUBLISHER)}-${digest.slice(0, 12)}`;
  const band = path.join(dir, id);
  await fs.mkdir(band, { recursive: true });
  const file = (name: string) =>
    path
      .join(band, PARQUET_L1_TABLES.find((t) => t.name === name)!.file)
      .replace(/'/g, "''");
  await withBandWriter(band, async (duck) => {
    await duck.exec(
      `COPY (SELECT range::UBIGINT AS height, 0::USMALLINT AS block_transaction_index, unhex(sha256('root-' || range::VARCHAR)) AS transaction_id FROM range(${FROM}, ${TO + 1})) TO '${file('block_transactions')}' (FORMAT PARQUET)`,
    );
    await duck.exec(
      `COPY (SELECT range::UBIGINT AS height, (1600000000 + range)::BIGINT AS block_timestamp FROM range(${FROM}, ${TO + 1})) TO '${file('blocks')}' (FORMAT PARQUET)`,
    );
  });
  await fs.writeFile(
    path.join(band, 'band.json'),
    JSON.stringify({
      version: 1,
      schema: 'l1-2',
      heightRange: [FROM, TO],
      tables: Object.fromEntries(
        PARQUET_L1_TABLES.map((t) => [t.name, { rows: 0, rowDigest: digest }]),
      ),
      createdAt: new Date((1_600_000_000 + TO) * 1000).toISOString(),
    }),
  );
}

describe(
  'exportL2Band, a large band',
  {
    skip:
      ITEMS > 0
        ? false
        : 'INDEX_EXPORT_TEST_L2_LARGE (an item count) is not set',
  },
  () => {
    it(
      `builds ${ITEMS} items with DuckDB held to 512 MB`,
      { timeout: 4 * 3600_000 },
      async (t) => {
        const dir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'parquet-l2-large-'),
        );
        try {
          const l1 = path.join(dir, 'parquet-l1');
          await writeL1(l1);
          const started = Date.now();
          const result = await exportL2Band({
            selection: parseSelection({
              kind: 'ans104-data-items',
              tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
            }),
            from: FROM,
            to: TO,
            source: new GeneratedSource(),
            l1Bands: await deriveL1Bands(l1, PUBLISHER),
            reads: new GatewayReads(
              (): ByteRangeSource => {
                throw new Error('no read is needed');
              },
              { maxReads: 0 },
            ),
            workDir: path.join(dir, 'work'),
            limits: { memoryLimit: '512MB', threads: 2, spillMaxGb: 64 },
          });
          const seconds = (Date.now() - started) / 1000;
          const maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
          const figures = {
            items: ITEMS,
            seconds,
            maxRssMb,
            bandBytes: result.bandBytes,
            stagingBytes: result.stagingBytes,
            tables: result.band.tables,
          };
          t.diagnostic(JSON.stringify(figures));
          process.stdout.write(`L2_LARGE ${JSON.stringify(figures)}\n`);
          assert.equal(result.band.tables.data_items.rows, ITEMS);
          assert.equal(result.band.tables.tags.rows, ITEMS * 7);
          assert.equal(
            result.band.tables.wallets.rows,
            Math.min(ITEMS, OWNERS),
          );
          assert.equal(result.band.checks?.located, ITEMS);
          await fs.rm(result.staging, { recursive: true, force: true });
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
