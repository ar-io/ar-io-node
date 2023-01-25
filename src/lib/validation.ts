import { validatePath } from 'arweave/node/lib/merkle.js';
import crypto from 'crypto';

import {
  Chunk,
  JsonChunk,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

export const isValidTx = (id: string): boolean => {
  return !!id.match(/^[a-zA-Z0-9_-]{43}$/);
};

export const isValidDataId = isValidTx;

export function sanityCheckBlock(block: PartialJsonBlock) {
  if (!block.indep_hash) {
    throw new Error("Invalid block: missing 'indep_hash'");
  }

  if (!block.height === undefined) {
    throw new Error("Invalid block: missing 'height'");
  }

  if (
    block.height !== 0 &&
    (typeof block.previous_block !== 'string' || block.previous_block === '')
  ) {
    throw new Error("Invalid block: missing or invalid 'previous_block'");
  }
}

export function sanityCheckTx(tx: PartialJsonTransaction) {
  if (!tx.id) {
    throw new Error("Invalid transaction: missing 'id'");
  }

  if (!isValidTx(tx.id)) {
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
