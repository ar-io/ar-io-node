import { validatePath } from 'arweave/node/lib/merkle.js';

import {
  JsonChunk,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';
import { fromB64Url } from './encoding.js';

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
  chunk: JsonChunk,
  dataRoot: Buffer,
  relativeOffset: number,
) {
  const validChunk = await validatePath(
    dataRoot,
    relativeOffset,
    0,
    fromB64Url(chunk.chunk).byteLength,
    fromB64Url(chunk.data_path),
  );

  if (!validChunk) {
    throw Error('Invalid chunk based on offset, data_root and data_path');
  }
}
