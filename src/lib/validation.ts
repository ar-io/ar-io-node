import { validatePath } from 'arweave/node/lib/merkle.js';
import crypto from 'crypto';

import {
  Chunk,
  JsonChunk,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

export function sanityCheckBlock(block: PartialJsonBlock) {
  if (!block.indep_hash) {
    throw new Error("Invalid block: missing 'indep_hash'");
  }

  if (!block.height === undefined) {
    throw new Error("Invalid block: missing 'height'");
  }
}

export function sanityCheckTx(tx: PartialJsonTransaction) {
  if (!tx.id) {
    throw new Error("Invalid transaction: missing 'id'");
  }

  if (!tx.id.match(/^[a-zA-Z0-9_-]{43}/)) {
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

  if (!validChunk) {
    throw Error('Invalid chunk: bad data_path');
  }
}
