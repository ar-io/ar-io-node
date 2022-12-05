/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import ArModule from 'arweave/node/ar.js';
import { createHash } from 'crypto';
import { Packr } from 'msgpackr';

import {
  PartialJsonBlock,
  PartialJsonTransaction,
  PartialMsgpackBlock,
  PartialMsgpackTransaction,
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

export function jsonBlockToMsgpackBlock(
  jsonBlock: PartialJsonBlock,
): PartialMsgpackBlock {
  return {
    indep_hash: fromB64Url(jsonBlock.indep_hash),
    height: jsonBlock.height,
    nonce: fromB64Url(jsonBlock.nonce),
    hash: fromB64Url(jsonBlock.hash),
    previous_block:
      jsonBlock.previous_block === ''
        ? fromB64Url(jsonBlock.previous_block)
        : undefined,
    timestamp: jsonBlock.timestamp,
    diff: jsonBlock.diff,
    cumulative_diff: jsonBlock.cumulative_diff,
    last_retarget: jsonBlock.last_retarget,
    reward_addr:
      jsonBlock.reward_addr === 'unclaimed'
        ? fromB64Url(jsonBlock.reward_addr)
        : undefined,
    reward_pool: jsonBlock.reward_pool,
    block_size: jsonBlock.block_size,
    weave_size: jsonBlock.weave_size,
    usd_to_ar_rate: jsonBlock.usd_to_ar_rate,
    scheduled_usd_to_ar_rate: jsonBlock.scheduled_usd_to_ar_rate,
    hash_list_merkle:
      jsonBlock.hash_list_merkle !== undefined
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

export function msgpackBlockToJsonBlock(
  msgpackBlock: PartialMsgpackBlock,
): PartialJsonBlock {
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
      : 'unclaimed',
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

export function jsonBlockToMsgpack(jsonBlock: PartialJsonBlock): Buffer {
  return toMsgpack(jsonBlockToMsgpackBlock(jsonBlock));
}

export function msgpackToJsonBlock(msgpack: Buffer): PartialJsonBlock {
  return msgpackBlockToJsonBlock(fromMsgpack(msgpack));
}

// Transaction MessagePack encoding and decoding

export function jsonTxToMsgpackTx(
  jsonTx: PartialJsonTransaction,
): PartialMsgpackTransaction {
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
  msgpackTx: PartialMsgpackTransaction,
): PartialJsonTransaction {
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

export function jsonTxToMsgpack(jsonTx: PartialJsonTransaction): Buffer {
  return toMsgpack(jsonTxToMsgpackTx(jsonTx));
}

export function msgpackToJsonTx(buffer: Buffer): PartialJsonTransaction {
  return msgpackTxToJsonTx(fromMsgpack(buffer));
}

// AR/Winston conversion

/* eslint-disable */
// @ts-ignore
const { default: Ar } = ArModule;
const ar = new Ar();

export function winstonToAr(amount: string) {
  return ar.winstonToAr(amount);
}
