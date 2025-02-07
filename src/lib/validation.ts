/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { validatePath } from 'arweave/node/lib/merkle.js';
import crypto from 'node:crypto';

import {
  Chunk,
  JsonChunk,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

export const isValidBlockIndepHash = (hash: string): boolean => {
  return !!hash.match(/^[a-zA-Z0-9_-]{64}$/);
};

export const isValidTxId = (id: string): boolean => {
  return !!id.match(/^[a-zA-Z0-9_-]{43}$/);
};

export const isValidDataId = isValidTxId;

export function sanityCheckBlock(block: PartialJsonBlock) {
  if (!block.indep_hash) {
    throw new Error("Invalid block: missing 'indep_hash'");
  }

  if (!isValidBlockIndepHash(block.indep_hash)) {
    throw new Error("Invalid block: invalid 'indep_hash' format");
  }

  if (typeof block.height !== 'number') {
    throw new Error("Invalid block: 'height' must be a number");
  }

  if (
    block.height !== 0 &&
    (typeof block.previous_block !== 'string' ||
      !isValidBlockIndepHash(block.previous_block))
  ) {
    throw new Error("Invalid block: missing or invalid 'previous_block'");
  }
}

export function sanityCheckTx(tx: PartialJsonTransaction) {
  if (!tx.id) {
    throw new Error("Invalid transaction: missing 'id'");
  }

  if (!isValidTxId(tx.id)) {
    throw new Error("Invalid transaction: invalid 'id' format");
  }
}

export function sanityCheckChunk(chunk: JsonChunk) {
  if (!chunk.chunk) {
    throw new Error("Invalid chunk: missing 'chunk'");
  }

  if (!chunk.tx_path) {
    throw new Error("Invalid chunk: missing 'tx_path'");
  }

  if (!chunk.data_path) {
    throw new Error("Invalid chunk: missing 'data_path'");
  }
}

export async function validateChunk(
  txSize: number,
  chunk: Chunk,
  dataRoot: Buffer,
  relativeOffset: number,
) {
  const chunkHash = crypto.createHash('sha256').update(chunk.chunk).digest();

  if (!chunkHash.equals(chunk.data_path.slice(-64, -32))) {
    throw new Error('Invalid chunk: hash does not match data_path');
  }

  const validChunk = await validatePath(
    dataRoot,
    relativeOffset,
    0,
    txSize,
    chunk.data_path,
  );

  if (typeof validChunk !== 'object') {
    throw Error('Invalid chunk: bad data_path');
  }
}
