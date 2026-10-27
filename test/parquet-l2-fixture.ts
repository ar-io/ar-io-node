/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Real signed ANS-104 roots for the `parquet-l2` exporter's tests: bundles
 * (nested as deep as wanted) of items with chosen tags and owners, every
 * item's place in its root, the rows a ClickHouse index holds for them, an
 * in-memory item source, a gateway serving the roots' bytes, and an L1 band
 * on disk placing the roots on the chain.
 */
import {
  bundleAndSignData,
  createData,
  DataItem,
  EthereumSigner,
} from '@dha-team/arbundles';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { decodeDataItemHeader } from '../src/lib/ans104-bundle-scan.js';
import type { ByteRangeSource } from '../src/lib/byte-range-source.js';
import { toB64Url } from '../src/lib/encoding.js';
import { bandPublisherTag } from '../src/lib/index-band/build.js';
import {
  PARQUET_L1_TABLES,
  writePublisherFacts,
} from '../src/lib/parquet-l1/layout.js';
import {
  parseSelection,
  ParquetL2Selection,
} from '../src/lib/parquet-l2/layout.js';
import { withBandWriter } from '../src/index-export/kinds/parquet-l1/export.js';
import { selectionMatcher } from '../src/lib/parquet-l2/selection.js';
import type {
  L2ItemSource,
  L2SourceRow,
  L2SourceWindow,
  RootPosition,
} from '../src/index-export/kinds/parquet-l2/source.js';
import { BufferByteRangeSource } from './buffer-byte-range-source.js';

export const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';

export const ARDRIVE: ParquetL2Selection = parseSelection({
  kind: 'ans104-data-items',
  tag: {
    name: 'App-Name',
    valuePrefix: 'ArDrive',
    excludeValuePrefix: 'ArDriver',
  },
});

export const signers = {
  one: new EthereumSigner(`0x${'11'.repeat(32)}`),
  two: new EthereumSigner(`0x${'22'.repeat(32)}`),
};

type Tag = { name: string; value: string };

/** An item, or a nested bundle of items. */
export type ItemSpec =
  | { name: string; tags: Tag[]; data?: string; signer?: EthereumSigner }
  | {
      name: string;
      nested: ItemSpec[];
      tags?: Tag[];
      signer?: EthereumSigner;
    };

/** Every item of a root, placed. */
export interface PlacedItem {
  name: string;
  item: DataItem;
  id: Buffer;
  /** The bundle it is directly in: the root, or a nested bundle. */
  parentId: Buffer;
  /** Where its parent's payload starts in the root's data. */
  payloadStart: number;
  /** In its parent's payload. */
  offset: number;
  size: number;
  headerSize: number;
  nested: boolean;
  /** The name of the nested bundle it is in, if any. */
  parent?: string;
}

export interface FixtureRoot {
  id: Buffer;
  bytes: Buffer;
  height: number;
  blockTransactionIndex: number;
  items: Map<string, PlacedItem>;
}

const BUNDLE_TAGS: Tag[] = [
  { name: 'Bundle-Format', value: 'binary' },
  { name: 'Bundle-Version', value: '2.0.0' },
];

async function signItems(
  specs: ItemSpec[],
): Promise<Array<{ spec: ItemSpec; item: DataItem; inner?: Buffer }>> {
  const out: Array<{ spec: ItemSpec; item: DataItem; inner?: Buffer }> = [];
  for (const spec of specs) {
    const signer = spec.signer ?? signers.one;
    if ('nested' in spec) {
      const children = await signItems(spec.nested);
      const inner = (
        await bundleAndSignData(
          children.map((c) => c.item),
          signer,
        )
      ).getRaw();
      const item = createData(inner, signer, {
        tags: [...BUNDLE_TAGS, ...(spec.tags ?? [])],
      });
      await item.sign(signer);
      out.push({ spec, item, inner });
      // Children are placed by the caller from the inner bytes.
      (out.at(-1) as { children?: unknown }).children = children;
    } else {
      const item = createData(spec.data ?? `data of ${spec.name}`, signer, {
        tags: spec.tags,
      });
      await item.sign(signer);
      out.push({ spec, item });
    }
  }
  return out;
}

/** Each item's offset and size within a bundle's bytes. */
export function bundleLayout(
  raw: Buffer,
): Array<{ id: Buffer; offset: number; size: number; headerSize: number }> {
  const count = Number(raw.readBigUInt64LE(0));
  let offset = 32 + 64 * count;
  const out = [];
  for (let i = 0; i < count; i++) {
    const entry = 32 + 64 * i;
    const size = Number(raw.readBigUInt64LE(entry));
    const id = raw.subarray(entry + 32, entry + 64);
    const decoded = decodeDataItemHeader(raw.subarray(offset, offset + size));
    if (!decoded.complete) throw new Error('incomplete header');
    out.push({
      id: Buffer.from(id),
      offset,
      size,
      headerSize: decoded.header.headerSize,
    });
    offset += size;
  }
  return out;
}

/** Builds a root transaction's data: a bundle of these items. */
export async function buildRoot(
  name: string,
  specs: ItemSpec[],
  height: number,
  blockTransactionIndex = 0,
): Promise<FixtureRoot> {
  const signed = await signItems(specs);
  const bytes = (
    await bundleAndSignData(
      signed.map((s) => s.item),
      signers.one,
    )
  ).getRaw();
  const id = crypto.createHash('sha256').update(`root ${name}`).digest();
  const items = new Map<string, PlacedItem>();
  const place = (
    level: Array<{ spec: ItemSpec; item: DataItem; inner?: Buffer }>,
    raw: Buffer,
    parentId: Buffer,
    payloadStart: number,
    parent?: string,
  ) => {
    const layout = bundleLayout(raw);
    for (const [i, s] of level.entries()) {
      const at = layout[i];
      const placed: PlacedItem = {
        name: s.spec.name,
        item: s.item,
        id: at.id,
        parentId,
        payloadStart,
        offset: at.offset,
        size: at.size,
        headerSize: at.headerSize,
        nested: parent !== undefined,
        ...(parent !== undefined ? { parent } : {}),
      };
      items.set(s.spec.name, placed);
      const children = (s as { children?: typeof level }).children;
      if (children !== undefined && s.inner !== undefined) {
        place(
          children,
          s.inner,
          at.id,
          payloadStart + at.offset + at.headerSize,
          s.spec.name,
        );
      }
    }
  };
  place(signed, bytes, id, 0);
  return { id, bytes, height, blockTransactionIndex, items };
}

const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest();

/**
 * The row a ClickHouse index holds for a placed item: offsets in its
 * parent's payload, `root_parent_offset` its parent's payload start (0 in
 * the root), every header offset, tags, owner. `more` overrides any field.
 */
export function sourceRow(
  root: FixtureRoot,
  name: string,
  more: Partial<L2SourceRow> = {},
): L2SourceRow {
  const placed = root.items.get(name);
  if (placed === undefined) throw new Error(`no item ${name}`);
  const { item } = placed;
  const sigLength = item.signatureLength;
  const ownerLength = item.ownerLength;
  return {
    id: placed.id,
    parentId: placed.parentId,
    rootTxId: root.id,
    height: root.height,
    offset: placed.offset,
    size: placed.size,
    dataOffset: placed.offset + placed.headerSize,
    signatureOffset: placed.offset + 2,
    signatureSize: sigLength,
    ownerOffset: placed.offset + 2 + sigLength,
    ownerSize: ownerLength,
    rootParentOffset: placed.payloadStart,
    dataSize: placed.size - placed.headerSize,
    signatureType: item.signatureType,
    ownerAddress: sha256(item.rawOwner),
    ...(item.rawTarget.length > 0 ? { target: item.rawTarget } : {}),
    ...(item.rawAnchor.length > 0 ? { anchor: item.rawAnchor } : {}),
    tags: item.tags.map((tag) => ({
      name: Buffer.from(tag.name, 'utf8'),
      value: Buffer.from(tag.value, 'utf8'),
    })),
    ...more,
  };
}

/** An item source over fixed rows, as a ClickHouse source gives them. */
export class MemoryL2Source implements L2ItemSource {
  readonly name = 'memory';
  top = 0;
  windowBlocks = 1000;
  /** L1 rows, when the source has them. */
  positions?: RootPosition[];
  times = new Map<number, number>();

  constructor(
    public items: L2SourceRow[],
    public ancestors: L2SourceRow[] = [],
  ) {}

  async stableHeight(): Promise<number> {
    return this.top;
  }

  async count(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): Promise<number> {
    const selected = selectionMatcher(selection);
    return this.items.filter(
      (row) =>
        row.height >= from && row.height <= to && selected(row.tags ?? []),
    ).length;
  }

  async *windows(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): AsyncIterable<L2SourceWindow> {
    const selected = selectionMatcher(selection);
    for (let start = from; start <= to; start += this.windowBlocks) {
      const end = Math.min(to, start + this.windowBlocks - 1);
      const inWindow = (row: L2SourceRow) =>
        row.height >= start && row.height <= end;
      yield {
        from: start,
        to: end,
        items: this.items.filter(
          (row) => inWindow(row) && selected(row.tags ?? []),
        ),
        ancestors: this.ancestors.filter(inWindow),
      };
    }
  }

  get rootPositions() {
    if (this.positions === undefined) return undefined;
    return async (roots: Buffer[], from: number, to: number) => {
      const wanted = new Set(roots.map((root) => root.toString('hex')));
      return (this.positions ?? []).filter(
        (p) =>
          wanted.has(p.id.toString('hex')) &&
          p.height >= from &&
          p.height <= to,
      );
    };
  }

  async *owners(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): AsyncIterable<Buffer> {
    const selected = selectionMatcher(selection);
    const seen = new Set<string>();
    for (const row of this.items) {
      if (
        row.height < from ||
        row.height > to ||
        row.ownerAddress === undefined
      ) {
        continue;
      }
      if (!selected(row.tags ?? [])) continue;
      const k = row.ownerAddress.toString('hex');
      if (seen.has(k)) continue;
      seen.add(k);
      yield row.ownerAddress;
    }
  }

  async blockTime(height: number): Promise<number | undefined> {
    return this.times.get(height) ?? 1_600_000_000 + height;
  }

  async close(): Promise<void> {}
}

/**
 * A gateway serving the roots' bytes, counting requests; any other root is
 * answered `missing` (404, by default), and every read `failing` when set
 * (503, say, or 429).
 */
export function gatewayOf(
  roots: FixtureRoot[],
  { missing = 404, failing }: { missing?: number; failing?: number } = {},
) {
  const byId = new Map(roots.map((root) => [toB64Url(root.id), root.bytes]));
  const fail = (status: number) =>
    ({
      read: async () => {
        gateway.reads += 1;
        throw Object.assign(
          new Error(`Request failed with status code ${status}`),
          { response: { status } },
        );
      },
      close: async () => undefined,
    }) as unknown as ByteRangeSource;
  const gateway = {
    reads: 0,
    openRoot(rootTxId: string): ByteRangeSource {
      if (failing !== undefined) return fail(failing);
      const bytes = byId.get(rootTxId);
      if (bytes === undefined) return fail(missing);
      const source = new BufferByteRangeSource(bytes);
      return {
        read: async (offset: number, size: number) => {
          gateway.reads += 1;
          return source.read(offset, size);
        },
        close: async () => undefined,
      } as unknown as ByteRangeSource;
    },
  };
  return gateway;
}

/**
 * A `parquet-l1` band of this publisher's on disk placing the roots, with
 * the blocks table's timestamps (`1_600_000_000 + height`) for every height
 * of `[from, to]`. Only the tables the L2 exporter reads are real.
 */
export async function writeL1Band(
  publishDir: string,
  from: number,
  to: number,
  roots: Array<{ id: Buffer; height: number; blockTransactionIndex: number }>,
): Promise<string> {
  const digest = crypto
    .createHash('sha256')
    .update(`${from}-${to}-${roots.length}`)
    .digest('hex');
  const id = `l1-h${from}-${to}-${bandPublisherTag(PUBLISHER)}-${digest.slice(0, 12)}`;
  const dir = path.join(publishDir, id);
  await fs.mkdir(dir, { recursive: true });
  const file = (name: string) =>
    path
      .join(dir, PARQUET_L1_TABLES.find((t) => t.name === name)!.file)
      .replace(/'/g, "''");
  await withBandWriter(dir, async (duck) => {
    const values =
      roots.length === 0
        ? `SELECT NULL::UBIGINT AS height, NULL::USMALLINT AS block_transaction_index, NULL::BLOB AS transaction_id WHERE false`
        : `SELECT * FROM (VALUES ${roots
            .map(
              (r) =>
                `(${r.height}::UBIGINT, ${r.blockTransactionIndex}::USMALLINT, unhex('${r.id.toString('hex')}'))`,
            )
            .join(', ')}) v(height, block_transaction_index, transaction_id)`;
    await duck.exec(
      `COPY (${values} ORDER BY height, block_transaction_index) TO '${file('block_transactions')}' (FORMAT PARQUET)`,
    );
    await duck.exec(
      `COPY (SELECT range::UBIGINT AS height, (1600000000 + range)::BIGINT AS block_timestamp FROM range(${from}, ${to + 1})) TO '${file('blocks')}' (FORMAT PARQUET)`,
    );
  });
  const tables = Object.fromEntries(
    PARQUET_L1_TABLES.map((t) => [t.name, { rows: 0, rowDigest: digest }]),
  );
  await fs.writeFile(
    path.join(dir, 'band.json'),
    JSON.stringify({
      version: 1,
      schema: 'l1-2',
      heightRange: [from, to],
      tables,
      createdAt: new Date((1_600_000_000 + to) * 1000).toISOString(),
    }),
  );
  await writePublisherFacts(dir, { builtAt: new Date().toISOString() });
  return dir;
}
