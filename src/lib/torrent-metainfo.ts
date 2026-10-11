/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';

import { bdecodeWithSpans, bencode } from './bencode.js';

const KEY = (k: string): Buffer => Buffer.from(k, 'latin1');

/**
 * A `.torrent` naming these WebSeeds (BEP 19 `url-list`) and no others.
 *
 * Every other top-level entry is copied byte for byte, the info dictionary
 * included, so both infohashes are those of the torrent given: the torrent
 * is the same one, with another place to fetch its pieces from. An existing
 * `url-list` is replaced, and an empty `urls` removes it.
 *
 * @throws when the input is not a torrent: not a strict bencoded dictionary,
 *   or one without an `info` dictionary
 */
export function withWebSeeds(torrent: Buffer, urls: readonly string[]): Buffer {
  const { value, spans } = bdecodeWithSpans(torrent);
  if (
    typeof value !== 'object' ||
    Buffer.isBuffer(value) ||
    Array.isArray(value)
  ) {
    throw new Error('not a torrent');
  }
  const info = value['info'];
  if (
    info === undefined ||
    typeof info !== 'object' ||
    Buffer.isBuffer(info) ||
    Array.isArray(info)
  ) {
    throw new Error('not a torrent: no info dictionary');
  }

  const entries = new Map<string, Buffer>();
  for (const [key, [start, end]] of spans) {
    if (key !== 'url-list') entries.set(key, torrent.subarray(start, end));
  }
  if (urls.length > 0) {
    entries.set('url-list', bencode(urls.map((url) => Buffer.from(url))));
  }
  // BEP 3: keys in the order of their raw bytes.
  const keys = [...entries.keys()].sort((a, b) =>
    Buffer.compare(KEY(a), KEY(b)),
  );
  const parts: Buffer[] = [Buffer.from('d')];
  for (const key of keys) {
    parts.push(bencode(KEY(key)), entries.get(key)!);
  }
  parts.push(Buffer.from('e'));
  return Buffer.concat(parts);
}

/**
 * A torrent's v1 infohash: the SHA-1 of its info dictionary's bytes, as
 * written.
 *
 * @throws when the input is not a strict bencoded dictionary with `info`
 */
export function infohashV1Of(torrent: Buffer): string {
  const span = bdecodeWithSpans(torrent).spans.get('info');
  if (span === undefined) throw new Error('not a torrent: no info dictionary');
  return crypto
    .createHash('sha1')
    .update(torrent.subarray(span[0], span[1]))
    .digest('hex');
}
