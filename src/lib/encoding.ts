import { createHash } from 'crypto';
import { Packr } from 'msgpackr';

import {
  JsonBlock,
  JsonTransaction,
  MsgpackBlock,
  MsgpackTransaction,
} from '../types.js';

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

// Block MessagePack encoding and decoding

export function jsonBlockToMsgpackBlock(jsonBlock: JsonBlock): MsgpackBlock {
  return {
    indep_hash: fromB64Url(jsonBlock.indep_hash),
    height: jsonBlock.height,
    nonce: fromB64Url(jsonBlock.nonce),
    hash: fromB64Url(jsonBlock.hash),
    previous_block: jsonBlock.previous_block
      ? fromB64Url(jsonBlock.previous_block)
      : undefined,
    timestamp: jsonBlock.timestamp,
    diff: jsonBlock.diff,
    cumulative_diff: jsonBlock.cumulative_diff,
    last_retarget: jsonBlock.last_retarget,
    reward_addr: jsonBlock.reward_addr
      ? fromB64Url(jsonBlock.reward_addr)
      : undefined,
    reward_pool: jsonBlock.reward_pool,
    block_size: jsonBlock.block_size,
    weave_size: jsonBlock.weave_size,
    usd_to_ar_rate: jsonBlock.usd_to_ar_rate,
    scheduled_usd_to_ar_rate: jsonBlock.scheduled_usd_to_ar_rate,
    hash_list_merkle: jsonBlock.hash_list_merkle
      ? fromB64Url(jsonBlock.hash_list_merkle)
      : undefined,
    wallet_list: fromB64Url(jsonBlock.wallet_list),
    tx_root: fromB64Url(jsonBlock.tx_root),
    tags: jsonBlock.tags.map((tag) => ({
      name: fromB64Url(tag.name),
      value: fromB64Url(tag.value),
    })),
    txs: jsonBlock.txs.map((tx) => fromB64Url(tx)),
  };
}

export function msgpackBlockToJsonBlock(msgpackBlock: MsgpackBlock): JsonBlock {
  return {
    indep_hash: toB64Url(msgpackBlock.indep_hash),
    height: msgpackBlock.height,
    nonce: toB64Url(msgpackBlock.nonce),
    hash: toB64Url(msgpackBlock.hash),
    previous_block: msgpackBlock.previous_block
      ? toB64Url(msgpackBlock.previous_block)
      : undefined,
    timestamp: msgpackBlock.timestamp,
    diff: msgpackBlock.diff,
    cumulative_diff: msgpackBlock.cumulative_diff,
    last_retarget: msgpackBlock.last_retarget,
    reward_addr: msgpackBlock.reward_addr
      ? toB64Url(msgpackBlock.reward_addr)
      : undefined,
    reward_pool: msgpackBlock.reward_pool,
    block_size: msgpackBlock.block_size,
    weave_size: msgpackBlock.weave_size,
    usd_to_ar_rate: msgpackBlock.usd_to_ar_rate,
    scheduled_usd_to_ar_rate: msgpackBlock.scheduled_usd_to_ar_rate,
    hash_list_merkle: msgpackBlock.hash_list_merkle
      ? toB64Url(msgpackBlock.hash_list_merkle)
      : undefined,
    wallet_list: toB64Url(msgpackBlock.wallet_list),
    tx_root: toB64Url(msgpackBlock.tx_root),
    tags: msgpackBlock.tags.map((tag) => ({
      name: toB64Url(tag.name),
      value: toB64Url(tag.value),
    })),
    txs: msgpackBlock.txs.map((tx) => toB64Url(tx)),
  };
}

export function jsonBlockToMsgpack(jsonBlock: JsonBlock): Buffer {
  return toMsgpack(jsonBlockToMsgpackBlock(jsonBlock));
}

export function msgpackToJsonBlock(msgpack: Buffer): JsonBlock {
  return msgpackBlockToJsonBlock(fromMsgpack(msgpack));
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
