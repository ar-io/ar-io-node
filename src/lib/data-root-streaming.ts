/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Arweave from 'arweave';
import {
  Chunk,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  buildLayers,
  generateLeaves,
} from 'arweave/node/lib/merkle.js';
import { toB64Url } from '../lib/encoding.js';

import { Readable } from 'node:stream';

export async function computeDataRootFromReadable(
  readStream: Readable,
): Promise<string> {
  const chunks: Chunk[] = [];
  let leftover = new Uint8Array(0);
  let cursor = 0;

  // Read the file in chunks (raw node Buffers).
  // We'll accumulate in `leftover`, then slice off
  // pieces that match your chunking logic.
  for await (const data of readStream) {
    // Convert incoming data (which is a Buffer) to Uint8Array
    // This avoids copying the entire underlying ArrayBuffer multiple times.
    const inputChunk = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

    // Combine with any leftover from the previous loop
    const combined = new Uint8Array(leftover.length + inputChunk.length);
    combined.set(leftover, 0);
    combined.set(inputChunk, leftover.length);

    // Now apply the same logic as chunkData in a loop
    let startIndex = 0;
    while (combined.length - startIndex >= MAX_CHUNK_SIZE) {
      // We can carve out chunk blocks up to MAX_CHUNK_SIZE
      let chunkSize = MAX_CHUNK_SIZE;

      // If the remainder after this chunk is < MIN_CHUNK_SIZE,
      // adjust so that we don't create a tiny chunk at the end
      const remainderAfterThis = combined.length - startIndex - MAX_CHUNK_SIZE;
      if (remainderAfterThis > 0 && remainderAfterThis < MIN_CHUNK_SIZE) {
        chunkSize = Math.ceil((combined.length - startIndex) / 2);
      }

      const chunkData = combined.slice(startIndex, startIndex + chunkSize);
      const dataHash = await Arweave.crypto.hash(chunkData);

      chunks.push({
        dataHash,
        minByteRange: cursor,
        maxByteRange: cursor + chunkSize,
      });

      cursor += chunkSize;
      startIndex += chunkSize;
    }

    // Store any leftover portion that didn't get chunked out
    leftover = combined.slice(startIndex);
  }

  // After the stream ends, we may still have some leftover data
  if (leftover.length > 0) {
    const dataHash = await Arweave.crypto.hash(leftover);
    chunks.push({
      dataHash,
      minByteRange: cursor,
      maxByteRange: cursor + leftover.length,
    });
    cursor += leftover.length;
  }

  // Now produce the merkle tree from these chunks to get root
  const leaves = await generateLeaves(chunks);
  const root = await buildLayers(leaves);

  return toB64Url(Buffer.from(root.id));
}
