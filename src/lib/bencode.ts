/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Bencoding (BEP 3), the serialization torrent metainfo is written in.
 *
 * Small on purpose: torrents are built and read by the index-swarm sidecar,
 * and an infohash is a hash of exact bytes, so every byte this produces has
 * to be accounted for.
 *
 * Dictionary keys are byte strings. They are represented here as `latin1`
 * JavaScript strings, which map each byte to one code unit and back without
 * loss, so a key that is not text (a BEP 52 `piece layers` key is a raw
 * 32-byte hash) survives a round trip. Keys are sorted by those raw bytes, as
 * BEP 3 requires. String *values* given as JavaScript strings are encoded as
 * UTF-8; decoded string values are always Buffers.
 */

export type BencodeValue =
  | number
  | Buffer
  | string
  | BencodeValue[]
  | { [key: string]: BencodeValue };

const key = (k: string): Buffer => Buffer.from(k, 'latin1');

/** Encode a value. Integers must be safe integers; there are no floats. */
export function bencode(value: BencodeValue): Buffer {
  const parts: Buffer[] = [];
  const walk = (v: BencodeValue): void => {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) {
        throw new Error(`bencode: ${v} is not a safe integer`);
      }
      parts.push(Buffer.from(`i${v}e`));
    } else if (typeof v === 'string' || Buffer.isBuffer(v)) {
      const bytes = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
      parts.push(Buffer.from(`${bytes.length}:`), bytes);
    } else if (Array.isArray(v)) {
      parts.push(Buffer.from('l'));
      v.forEach(walk);
      parts.push(Buffer.from('e'));
    } else {
      parts.push(Buffer.from('d'));
      const keys = Object.keys(v).sort((a, b) =>
        Buffer.compare(key(a), key(b)),
      );
      for (const k of keys) {
        const kb = key(k);
        parts.push(Buffer.from(`${kb.length}:`), kb);
        walk(v[k]);
      }
      parts.push(Buffer.from('e'));
    }
  };
  walk(value);
  return Buffer.concat(parts);
}

export interface DecodedWithSpans {
  value: BencodeValue;
  /** Byte range of each top-level dictionary value, by key. */
  spans: Map<string, [number, number]>;
}

/**
 * Decode a value, rejecting anything BEP 3 does not allow: leading zeros,
 * negative zero, unsorted or duplicate keys, trailing bytes. Being strict
 * matters because the infohash is computed over the original bytes; a
 * lenient decoder would accept two encodings that hash differently.
 *
 * When the top level is a dictionary, the byte range of each of its values
 * is returned too, so the `info` dictionary can be hashed exactly as sent.
 */
export function bdecodeWithSpans(input: Buffer): DecodedWithSpans {
  let pos = 0;
  const spans = new Map<string, [number, number]>();
  const fail = (msg: string): never => {
    throw new Error(`bdecode: ${msg} at byte ${pos}`);
  };
  const readInt = (terminator: number): number => {
    const end = input.indexOf(terminator, pos);
    if (end < 0) fail('unterminated integer');
    const text = input.toString('latin1', pos, end);
    if (!/^(0|-?[1-9][0-9]*)$/.test(text)) fail(`malformed integer "${text}"`);
    const n = Number(text);
    if (!Number.isSafeInteger(n)) fail('integer out of range');
    pos = end + 1;
    return n;
  };
  const walk = (depth: number): BencodeValue => {
    if (depth > 64) fail('nested too deeply');
    const c = input[pos];
    if (c === undefined) return fail('unexpected end');
    if (c === 0x69 /* i */) {
      pos++;
      return readInt(0x65);
    }
    if (c === 0x6c /* l */) {
      pos++;
      const list: BencodeValue[] = [];
      while (input[pos] !== 0x65) {
        if (pos >= input.length) fail('unterminated list');
        list.push(walk(depth + 1));
      }
      pos++;
      return list;
    }
    if (c === 0x64 /* d */) {
      pos++;
      // No prototype: a key such as `__proto__` in hostile input must be an
      // ordinary key, not a way to plant values every lookup would inherit.
      const dict: { [key: string]: BencodeValue } = Object.create(null);
      let previous: Buffer | undefined;
      while (input[pos] !== 0x65) {
        if (pos >= input.length) fail('unterminated dictionary');
        const k = walk(depth + 1);
        if (!Buffer.isBuffer(k)) return fail('dictionary key is not a string');
        if (previous !== undefined && Buffer.compare(previous, k) >= 0) {
          fail('dictionary keys are not strictly sorted');
        }
        previous = k;
        const start = pos;
        dict[k.toString('latin1')] = walk(depth + 1);
        if (depth === 0) spans.set(k.toString('latin1'), [start, pos]);
      }
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const length = readInt(0x3a /* : */);
      if (length < 0 || pos + length > input.length)
        fail('string overruns input');
      const bytes = input.subarray(pos, pos + length);
      pos += length;
      return Buffer.from(bytes);
    }
    return fail(`unexpected byte 0x${c.toString(16)}`);
  };
  const value = walk(0);
  if (pos !== input.length) fail('trailing bytes');
  return { value, spans };
}

export function bdecode(input: Buffer): BencodeValue {
  return bdecodeWithSpans(input).value;
}
