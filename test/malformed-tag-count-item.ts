/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A root holding an item whose header's tag count field says the tag bytes'
 * length rather than the number of tags, as an early bundler wrote it (an
 * Arweave-signed item at height 789,458): signature type 1, no target or
 * anchor, nine tags in 264 bytes, the count field 264, the header 1,308
 * bytes, at offset 160 of its root (the first of two items). Its signature
 * still hashes to its id: the item is malformed, its location right.
 */
import { ArweaveSigner, createData, DataItem } from '@dha-team/arbundles';
import Arweave from 'arweave';

export interface MalformedTagCountRoot {
  root: Buffer;
  /** The malformed item: base64url id, offsets in the root. */
  item: {
    id: string;
    rawId: Buffer;
    rootOffset: number;
    rootDataOffset: number;
    /** Header and payload. */
    size: number;
    /** Its owner's key: 512 bytes, after the signature. */
    owner: Buffer;
    tags: Array<{ name: string; value: string }>;
  };
  /** The well-formed item after it. */
  other: { id: string; rootOffset: number; rootDataOffset: number };
}

/** Nine tags whose Avro encoding is 264 bytes. */
export function nineTags(): Array<{ name: string; value: string }> {
  // Each tag is 2 length bytes plus its name and value; the array adds a
  // count byte and a terminator: 2 + 9 × (2 + 2) + 226 = 264.
  return Array.from({ length: 9 }, (_, i) => ({
    name: `T${i}`,
    value: String(i).repeat(i === 8 ? 26 : 25),
  }));
}

/** Puts a 64-bit little-endian number into 8 bytes. */
const long = (n: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(n));
  return bytes;
};

export async function malformedTagCountRoot(): Promise<MalformedTagCountRoot> {
  const signer = new ArweaveSigner(await Arweave.init({}).wallets.generate());
  const malformed = createData('payload of the malformed item', signer, {
    tags: nineTags(),
  });
  await malformed.sign(signer);
  const raw = Buffer.from(malformed.getRaw());
  // Type, signature, owner, two empty presence bytes: the tag count field.
  const countAt = 2 + 512 + 512 + 1 + 1;
  const tagBytes = Number(raw.readBigUInt64LE(countAt + 8));
  if (raw.readBigUInt64LE(countAt) !== 9n || tagBytes !== 264) {
    throw new Error('the fixture item is not the shape it should be');
  }
  long(tagBytes).copy(raw, countAt);
  const other = createData('a well-formed item', signer, {
    tags: [{ name: 'App-Name', value: 'fixture' }],
  });
  await other.sign(signer);
  const otherRaw = Buffer.from(other.getRaw());
  // A bundle of the two, written by hand: the malformed item can't be
  // signed again without its count being read back.
  const entry = (bytes: Buffer, id: Buffer) => {
    const out = Buffer.alloc(64);
    out.writeBigUInt64LE(BigInt(bytes.length), 0);
    id.copy(out, 32);
    return out;
  };
  const head = Buffer.alloc(32);
  head.writeBigUInt64LE(2n, 0);
  const root = Buffer.concat([
    head,
    entry(raw, malformed.rawId),
    entry(otherRaw, other.rawId),
    raw,
    otherRaw,
  ]);
  const headerOf = (item: DataItem) =>
    item.getRaw().length - item.rawData.length;
  const first = 32 + 64 * 2;
  return {
    root,
    item: {
      id: malformed.id,
      rawId: malformed.rawId,
      rootOffset: first,
      rootDataOffset: first + headerOf(malformed),
      size: raw.length,
      owner: Buffer.from(malformed.rawOwner),
      tags: nineTags(),
    },
    other: {
      id: other.id,
      rootOffset: first + raw.length,
      rootDataOffset: first + raw.length + headerOf(other),
    },
  };
}
