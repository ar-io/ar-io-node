import { createHash } from 'crypto';
import { Packr } from 'msgpackr';

import { JsonTransaction, MsgpackTransaction } from '../types.js';

// Base64 encoding and decoding

export function fromB64Url(input: string): Buffer {
  return Buffer.from(input, 'base64');
}

export function toB64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function b64UrlToUtf8(input: string): string {
  return fromB64Url(input).toString('utf8');
}

export function utf8ToB64Url(input: string): string {
  return toB64Url(Buffer.from(input, 'utf8'));
}

export function sha256B64Url(input: Buffer): string {
  return toB64Url(createHash('sha256').update(input).digest());
}

// MessagePack encoding and decoding

export function toMsgpack(x: any): Buffer {
  const packr = new Packr({
    useRecords: false, // stay compatible with other implementations
    variableMapSize: true, // sacrifice speed for space
  });

  return packr.pack(x);
}

export function fromMsgpack(buffer: Buffer): any {
  const packr = new Packr({
    useRecords: false, // stay compatible with other implementations
    variableMapSize: true, // sacrifice speed for space
  });

  return packr.unpack(buffer);
}

// Transaction MessagePack encoding and decoding

export function jsonTxToMsgpackTx(jsonTx: JsonTransaction): MsgpackTransaction {
  return {
    id: fromB64Url(jsonTx.id),
    signature: fromB64Url(jsonTx.signature),
    format: jsonTx.format,
    last_tx: fromB64Url(jsonTx.last_tx),
    owner: fromB64Url(jsonTx.owner),
    target: fromB64Url(jsonTx.target),
    quantity: jsonTx.quantity,
    reward: jsonTx.reward,
    data_size: jsonTx.data_size,
    data_root: fromB64Url(jsonTx.data_root),
    tags: jsonTx.tags.map((tag) => ({
      name: fromB64Url(tag.name),
      value: fromB64Url(tag.value),
    })),
  };
}

export function msgpackTxToJsonTx(
  msgpackTx: MsgpackTransaction,
): JsonTransaction {
  return {
    id: toB64Url(msgpackTx.id),
    signature: toB64Url(msgpackTx.signature),
    format: msgpackTx.format,
    last_tx: toB64Url(msgpackTx.last_tx),
    owner: toB64Url(msgpackTx.owner),
    target: toB64Url(msgpackTx.target),
    quantity: msgpackTx.quantity,
    reward: msgpackTx.reward,
    data_size: msgpackTx.data_size,
    data_root: toB64Url(msgpackTx.data_root),
    tags: msgpackTx.tags.map((tag) => ({
      name: toB64Url(tag.name),
      value: toB64Url(tag.value),
    })),
  };
}

export function jsonTxToMsgpack(jsonTx: JsonTransaction): Buffer {
  return toMsgpack(jsonTxToMsgpackTx(jsonTx));
}

export function msgpackToJsonTx(buffer: Buffer): JsonTransaction {
  return msgpackTxToJsonTx(fromMsgpack(buffer));
}
