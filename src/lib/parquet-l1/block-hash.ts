/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Recomputing an Arweave block's identity hash (`indep_hash`) from its
 * header, as `ar_block` does, for every era from the 2.0 fork on.
 *
 * This is what lets one fetched header be believed on its own: a source
 * that changes any hashed field (`weave_size`, `tx_root`, `hash_list_merkle`,
 * the ordered `txs`, `previous_block`, …) changes the hash, and a source
 * that also changes the hash no longer agrees with the chain. So a header
 * whose recomputed hash equals a hash already bound to the chain is the
 * chain's own header, whoever served it.
 *
 * **Fails closed.** A header this cannot recompute exactly throws
 * {@link HeaderUnverifiable} with a named reason, never a pass:
 * - below the 2.0 fork (a 1.0 block hash is a deep hash over the full wallet
 *   list, which no header carries; see {@link hash20Of10Block} for what can
 *   be checked there instead);
 * - a JSON key this does not know for the header's era, so a future fork
 *   that adds a field cannot pass by having it ignored;
 * - a feature mainnet has not exercised in any header this was tested
 *   against, so there is no vector to prove the encoding: an ECDSA (or any
 *   non-4096-bit RSA) `reward_key`, a non-empty `double_signing_proof`, and
 *   non-empty block `tags`.
 *
 * The rules mirror `apps/arweave/src/ar_block.erl` at 18d402c7
 * (`indep_hash/1`, `generate_signed_hash/1`, `indep_hash2/2`,
 * `indep_hash/2`, `generate_block_data_segment(_base)/1`, `poa_to_list/1`)
 * and the encoders in `ar_serialize.erl` (`encode_int`, `encode_bin`,
 * `encode_bin_list` — which emits its elements in reverse, because it
 * prepends — and `encode_double_signing_proof`). Verified against 120 real
 * mainnet headers across every era, from two gateways (2026-10-22), and
 * pinned by `test/arweave-consensus-pin.ts`.
 */
import crypto from 'node:crypto';

/** Arweave's mainnet fork heights (`ar_fork.erl`, the non-`FORKS_RESET` clauses). */
export const FORK_1_6 = 95_000;
export const FORK_2_0 = 422_250;
export const FORK_2_4 = 633_720;
export const FORK_2_5 = 812_970;
export const FORK_2_6 = 1_132_210;
export const FORK_2_7 = 1_275_480;
export const FORK_2_8 = 1_547_120;
export const FORK_2_9 = 1_602_350;

/** A header whose identity hash this cannot recompute exactly; `message` says why. */
export class HeaderUnverifiable extends Error {}

const sha384 = (...parts: Buffer[]) => {
  const hash = crypto.createHash('sha384');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const sha256 = (part: Buffer) =>
  crypto.createHash('sha256').update(part).digest();

/** A value of Arweave's deep hash: a binary, or a list of them. */
export type DeepHashItem = Buffer | DeepHashItem[];

/**
 * Arweave's deep hash (`ar_deep_hash:hash/1`), SHA-384 throughout. The one
 * copy: `chain.ts` takes it from here.
 */
export function deepHash(item: DeepHashItem): Buffer {
  if (Array.isArray(item)) {
    let acc = sha384(Buffer.from('list'), Buffer.from(String(item.length)));
    for (const part of item) acc = sha384(acc, deepHash(part));
    return acc;
  }
  return sha384(
    sha384(Buffer.from('blob'), Buffer.from(String(item.length))),
    sha384(item),
  );
}

type Json = Record<string, unknown>;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const unverifiable = (height: unknown, why: string) =>
  new HeaderUnverifiable(`header at ${String(height)}: ${why}`);

/** JSON keys every header from the 2.0 fork carries (`ar_serialize:block_to_json_struct`). */
const KEYS_2_0 = [
  'nonce',
  'previous_block',
  'timestamp',
  'last_retarget',
  'diff',
  'height',
  'hash',
  'indep_hash',
  'txs',
  'tx_root',
  'wallet_list',
  'reward_addr',
  'tags',
  'reward_pool',
  'weave_size',
  'block_size',
  'cumulative_diff',
  'hash_list_merkle',
  'poa',
];
const KEYS_2_5 = [
  'usd_to_ar_rate',
  'scheduled_usd_to_ar_rate',
  'packing_2_5_threshold',
  'strict_data_split_threshold',
];
const KEYS_2_6 = [
  'hash_preimage',
  'recall_byte',
  'reward',
  'previous_solution_hash',
  'partition_number',
  'nonce_limiter_info',
  'poa2',
  'signature',
  'reward_key',
  'price_per_gib_minute',
  'scheduled_price_per_gib_minute',
  'reward_history_hash',
  'debt_supply',
  'kryder_plus_rate_multiplier',
  'kryder_plus_rate_multiplier_latch',
  'denomination',
  'redenomination_height',
  'double_signing_proof',
  'previous_cumulative_diff',
];
const KEYS_2_7 = [
  'merkle_rebase_support_threshold',
  'chunk_hash',
  'block_time_history_hash',
];

/** The keys a header of `height` must carry, and those it may. */
function keysFor(height: number): { required: string[]; optional: string[] } {
  const required = [...KEYS_2_0];
  // Serialized for the blocks that kept one; not part of any hash.
  const optional = height < FORK_2_4 ? ['tx_tree'] : [];
  if (height >= FORK_2_5) required.push(...KEYS_2_5);
  if (height >= FORK_2_6) {
    required.push(...KEYS_2_6);
    optional.push('recall_byte2');
  }
  if (height >= FORK_2_7) {
    required.push(...KEYS_2_7);
    optional.push('chunk2_hash');
  }
  if (height >= FORK_2_8) {
    optional.push(
      'packing_difficulty',
      'unpacked_chunk_hash',
      'unpacked_chunk2_hash',
    );
  }
  if (height >= FORK_2_9) optional.push('replica_format');
  return { required, optional };
}

const POA_KEYS = ['option', 'tx_path', 'data_path', 'chunk'];
const POA_OPTIONAL = ['unpacked_chunk'];
const NONCE_LIMITER_KEYS = [
  'output',
  'global_step_number',
  'seed',
  'next_seed',
  'zone_upper_bound',
  'next_zone_upper_bound',
  'prev_output',
  'last_step_checkpoints',
  'checkpoints',
];
const NONCE_LIMITER_KEYS_2_7 = ['vdf_difficulty', 'next_vdf_difficulty'];

function checkKeys(
  height: number,
  what: string,
  value: unknown,
  required: string[],
  optional: string[],
): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw unverifiable(height, `${what} is not an object`);
  }
  const object = value as Json;
  for (const key of required) {
    if (!(key in object)) throw unverifiable(height, `${what} has no ${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw unverifiable(
        height,
        `${what} carries ${key}, which no header of this era is known to (a later fork?)`,
      );
    }
  }
  return object;
}

/** A field's bytes from its base64url text. */
function bin(height: number, object: Json, key: string): Buffer {
  const value = object[key];
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    throw unverifiable(height, `${key} is not base64url`);
  }
  return Buffer.from(value, 'base64url');
}

/** A field's bytes, or undefined where the header leaves it out. */
function optBin(height: number, object: Json, key: string): Buffer | undefined {
  return object[key] === undefined ? undefined : bin(height, object, key);
}

/** A non-negative integer field, from a JSON number or its decimal text. */
function int(height: number, object: Json, key: string): bigint {
  const value = object[key];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value);
  }
  throw unverifiable(height, `${key} is not a whole number`);
}

function optInt(height: number, object: Json, key: string): bigint | undefined {
  return object[key] === undefined ? undefined : int(height, object, key);
}

/** A pair of whole numbers, as `usd_to_ar_rate` is written. */
function rate(height: number, object: Json, key: string): [bigint, bigint] {
  const value = object[key];
  if (!Array.isArray(value) || value.length !== 2) {
    throw unverifiable(height, `${key} is not a pair`);
  }
  return [int(height, { v: value[0] }, 'v'), int(height, { v: value[1] }, 'v')];
}

function binList(height: number, object: Json, key: string): Buffer[] {
  const value = object[key];
  if (!Array.isArray(value)) throw unverifiable(height, `${key} is not a list`);
  return value.map((item, i) =>
    bin(height, { [`${key}[${i}]`]: item }, `${key}[${i}]`),
  );
}

/** `integer_to_binary`: decimal text. */
const ib = (n: bigint) => Buffer.from(n.toString());

/** `binary:encode_unsigned`: big-endian, no leading zero bytes, `<<0>>` for 0. */
function unsigned(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

/** `ar_serialize:encode_int(N, SizeBits)`; `undefined` encodes as a zero length. */
function encodeInt(n: bigint | undefined, bits: number): Buffer {
  const prefix = Buffer.alloc(bits / 8);
  if (n === undefined) return prefix;
  const bytes = unsigned(n);
  prefix.writeUIntBE(bytes.length, 0, bits / 8);
  return Buffer.concat([prefix, bytes]);
}

/** `ar_serialize:encode_bin(Bin, SizeBits)`; `undefined` encodes as a zero length. */
function encodeBin(value: Buffer | undefined, bits: number): Buffer {
  const prefix = Buffer.alloc(bits / 8);
  if (value === undefined) return prefix;
  prefix.writeUIntBE(value.length, 0, bits / 8);
  return Buffer.concat([prefix, value]);
}

/** `ar_serialize:encode_bin_list`: the count, then the elements REVERSED (it prepends). */
function encodeBinList(
  values: Buffer[],
  countBits: number,
  elementBits: number,
): Buffer {
  const prefix = Buffer.alloc(countBits / 8);
  prefix.writeUIntBE(values.length, 0, countBits / 8);
  return Buffer.concat([
    prefix,
    ...[...values].reverse().map((v) => encodeBin(v, elementBits)),
  ]);
}

/** A whole number in exactly `bits` bits, big-endian. */
function fixed(n: bigint, bits: number, height: number, key: string): Buffer {
  const out = Buffer.alloc(bits / 8);
  const bytes = n === 0n ? Buffer.alloc(0) : unsigned(n);
  if (bytes.length > out.length) {
    throw unverifiable(height, `${key} does not fit in ${bits} bits`);
  }
  bytes.copy(out, out.length - bytes.length);
  return out;
}

function poaList(height: number, poa: Json): Buffer[] {
  return [
    ib(int(height, poa, 'option')),
    bin(height, poa, 'tx_path'),
    bin(height, poa, 'data_path'),
    bin(height, poa, 'chunk'),
  ];
}

/** The size of a 4096-bit RSA public key, the only `reward_key` mainnet headers were tested with. */
const RSA_4096_KEY_BYTES = 512;

/**
 * A block header from `/block/height/N` (or `/block/hash/H`), with the
 * fields an index stores, once its identity hash has been recomputed.
 * Integers are `bigint`; a binary absent from the header is empty.
 */
export interface VerifiedHeader {
  height: number;
  /** The recomputed identity hash, which equals the header's own claim. */
  indepHash: Buffer;
  previousBlock: Buffer;
  nonce: Buffer;
  hash: Buffer;
  timestamp: bigint;
  diff: bigint;
  cumulativeDiff: bigint;
  lastRetarget: bigint;
  /** `null` for `unclaimed`. */
  rewardAddr: Buffer | null;
  rewardPool: bigint;
  blockSize: bigint;
  weaveSize: bigint;
  txRoot: Buffer;
  walletList: Buffer;
  hashListMerkle: Buffer;
  usdToArRate?: [bigint, bigint];
  scheduledUsdToArRate?: [bigint, bigint];
  /** Transaction ids in block order: the order `block_transaction_index` follows. */
  txs: Buffer[];
}

/**
 * Recomputes a header's identity hash, checks it against the hash the
 * header claims, and returns the fields an index stores.
 *
 * @throws HeaderUnverifiable when the header is below the 2.0 fork, has a
 *   key or a feature this cannot recompute, is malformed, or when the hash
 *   it claims is not the hash of its fields — a source that altered a field
 *   without the hash, or the hash without the fields.
 */
export function verifyHeader(json: unknown): VerifiedHeader {
  const { header, computed, claimed } = recompute(json);
  if (!computed.equals(claimed)) {
    throw unverifiable(
      header.height,
      `its fields hash to ${computed.toString('base64url')}, not the indep_hash ${claimed.toString('base64url')} it claims`,
    );
  }
  return { ...header, indepHash: computed };
}

/**
 * The identity hash a header's fields give, whatever hash it claims: for
 * building headers (a test chain), never for believing one.
 *
 * @throws HeaderUnverifiable as {@link verifyHeader} does, but for the claim.
 */
export function recomputeIndepHash(json: unknown): Buffer {
  return recompute(json).computed;
}

function recompute(json: unknown): {
  header: Omit<VerifiedHeader, 'indepHash'>;
  computed: Buffer;
  claimed: Buffer;
} {
  const top =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? (json as Json)
      : undefined;
  if (top === undefined) {
    throw new HeaderUnverifiable('the header is not a JSON object');
  }
  const rawHeight = top.height;
  if (typeof rawHeight !== 'number' || !Number.isSafeInteger(rawHeight)) {
    throw new HeaderUnverifiable('the header has no whole height');
  }
  const h = rawHeight;
  if (h < FORK_2_0) {
    throw unverifiable(
      h,
      'below the 2.0 fork a block hash is a deep hash over the full wallet list, which no header carries',
    );
  }
  const { required, optional } = keysFor(h);
  const j = checkKeys(h, 'the header', top, required, optional);

  const tags = j.tags;
  if (!Array.isArray(tags)) throw unverifiable(h, 'tags is not a list');
  if (tags.length > 0) {
    throw unverifiable(
      h,
      'non-empty block tags: no mainnet header with them has been tested',
    );
  }
  const txids = binList(h, j, 'txs');
  const rewardAddrText = j.reward_addr;
  const unclaimed = rewardAddrText === 'unclaimed';
  const rewardAddr = unclaimed ? null : bin(h, j, 'reward_addr');
  const poa = checkKeys(h, 'poa', j.poa, POA_KEYS, POA_OPTIONAL);

  const header: Omit<VerifiedHeader, 'indepHash'> = {
    height: h,
    previousBlock: bin(h, j, 'previous_block'),
    nonce: bin(h, j, 'nonce'),
    hash: bin(h, j, 'hash'),
    timestamp: int(h, j, 'timestamp'),
    diff: int(h, j, 'diff'),
    cumulativeDiff: int(h, j, 'cumulative_diff'),
    lastRetarget: int(h, j, 'last_retarget'),
    rewardAddr,
    rewardPool: int(h, j, 'reward_pool'),
    blockSize: int(h, j, 'block_size'),
    weaveSize: int(h, j, 'weave_size'),
    txRoot: bin(h, j, 'tx_root'),
    walletList: bin(h, j, 'wallet_list'),
    hashListMerkle: bin(h, j, 'hash_list_merkle'),
    txs: txids,
    ...(h >= FORK_2_5
      ? {
          usdToArRate: rate(h, j, 'usd_to_ar_rate'),
          scheduledUsdToArRate: rate(h, j, 'scheduled_usd_to_ar_rate'),
        }
      : {}),
  };

  let computed: Buffer;
  if (h < FORK_2_6) {
    // `indep_hash(BDS, B)` over the block data segment.
    const addr = unclaimed ? Buffer.from('unclaimed') : (rewardAddr as Buffer);
    let base: Buffer;
    if (h >= FORK_2_4) {
      const props: DeepHashItem[] = [
        ib(BigInt(h)),
        header.previousBlock,
        header.txRoot,
        txids,
        ib(header.blockSize),
        ib(header.weaveSize),
        addr,
        [],
      ];
      if (h >= FORK_2_5) {
        const [usdDiv, usdDivisor] = header.usdToArRate as [bigint, bigint];
        const [sUsdDiv, sUsdDivisor] = header.scheduledUsdToArRate as [
          bigint,
          bigint,
        ];
        props.unshift(
          ib(usdDiv),
          ib(usdDivisor),
          ib(sUsdDiv),
          ib(sUsdDivisor),
          ib(int(h, j, 'packing_2_5_threshold')),
          ib(int(h, j, 'strict_data_split_threshold')),
        );
      }
      base = deepHash(props);
    } else {
      base = deepHash([
        ib(BigInt(h)),
        header.previousBlock,
        header.txRoot,
        txids,
        ib(header.blockSize),
        ib(header.weaveSize),
        addr,
        [],
        poaList(h, poa),
      ]);
    }
    const bds = deepHash([
      base,
      ib(header.timestamp),
      ib(header.lastRetarget),
      ib(header.diff),
      ib(header.cumulativeDiff),
      ib(header.rewardPool),
      header.walletList,
      header.hashListMerkle,
    ]);
    computed =
      h >= FORK_2_4
        ? deepHash([bds, header.hash, header.nonce, poaList(h, poa)])
        : deepHash([bds, header.hash, header.nonce]);
  } else {
    computed = signedIndepHash(h, j, header, poa);
  }

  return { header, computed, claimed: bin(h, j, 'indep_hash') };
}

/**
 * The identity hash from the 2.6 fork: `sha384(sha256(signed segment) ‖
 * signature)` (`generate_signed_hash/1`, `indep_hash2/2`).
 */
function signedIndepHash(
  h: number,
  j: Json,
  header: Omit<VerifiedHeader, 'indepHash'>,
  poa: Json,
): Buffer {
  const rewardKey = bin(h, j, 'reward_key');
  if (rewardKey.length !== RSA_4096_KEY_BYTES) {
    throw unverifiable(
      h,
      `a ${rewardKey.length}-byte reward_key (ECDSA or a non-4096-bit RSA key): no mainnet header with one has been tested`,
    );
  }
  const dsp = j.double_signing_proof;
  if (
    dsp === null ||
    typeof dsp !== 'object' ||
    Array.isArray(dsp) ||
    Object.keys(dsp).length > 0
  ) {
    throw unverifiable(
      h,
      'a non-empty double_signing_proof: no mainnet header with one has been tested',
    );
  }
  const nl = checkKeys(
    h,
    'nonce_limiter_info',
    j.nonce_limiter_info,
    h >= FORK_2_7
      ? [...NONCE_LIMITER_KEYS, ...NONCE_LIMITER_KEYS_2_7]
      : NONCE_LIMITER_KEYS,
    [],
  );
  const poa2 = checkKeys(h, 'poa2', j.poa2, POA_KEYS, POA_OPTIONAL);
  const steps = binList(h, nl, 'checkpoints');
  const lastSteps = binList(h, nl, 'last_step_checkpoints');
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    return b;
  };
  const [usdDiv, usdDivisor] = header.usdToArRate as [bigint, bigint];
  const [sUsdDiv, sUsdDivisor] = header.scheduledUsdToArRate as [
    bigint,
    bigint,
  ];
  const parts: Buffer[] = [
    encodeBin(header.previousBlock, 8),
    encodeInt(header.timestamp, 8),
    encodeBin(header.nonce, 16),
    encodeInt(BigInt(h), 8),
    encodeInt(header.diff, 16),
    encodeInt(header.cumulativeDiff, 16),
    encodeInt(header.lastRetarget, 8),
    encodeBin(header.hash, 8),
    encodeInt(header.blockSize, 16),
    encodeInt(header.weaveSize, 16),
    encodeBin(header.rewardAddr ?? Buffer.alloc(0), 8),
    encodeBin(header.txRoot, 8),
    encodeBin(header.walletList, 8),
    encodeBin(header.hashListMerkle, 8),
    encodeInt(header.rewardPool, 8),
    encodeInt(int(h, j, 'packing_2_5_threshold'), 8),
    encodeInt(int(h, j, 'strict_data_split_threshold'), 8),
    encodeInt(usdDiv, 8),
    encodeInt(usdDivisor, 8),
    encodeInt(sUsdDiv, 8),
    encodeInt(sUsdDivisor, 8),
    encodeBinList([], 16, 16),
    encodeBinList(header.txs, 16, 8),
    encodeInt(int(h, j, 'reward'), 8),
    encodeInt(int(h, j, 'recall_byte'), 16),
    encodeBin(bin(h, j, 'hash_preimage'), 8),
    encodeInt(optInt(h, j, 'recall_byte2'), 16),
    encodeBin(rewardKey, 16),
    encodeInt(int(h, j, 'partition_number'), 8),
    bin(h, nl, 'output'),
    fixed(int(h, nl, 'global_step_number'), 64, h, 'global_step_number'),
    bin(h, nl, 'seed'),
    bin(h, nl, 'next_seed'),
    fixed(int(h, nl, 'zone_upper_bound'), 256, h, 'zone_upper_bound'),
    fixed(int(h, nl, 'next_zone_upper_bound'), 256, h, 'next_zone_upper_bound'),
    encodeBin(bin(h, nl, 'prev_output'), 8),
    u16(steps.length),
    ...steps,
    u16(lastSteps.length),
    ...lastSteps,
    encodeBin(bin(h, j, 'previous_solution_hash'), 8),
    encodeInt(int(h, j, 'price_per_gib_minute'), 8),
    encodeInt(int(h, j, 'scheduled_price_per_gib_minute'), 8),
    bin(h, j, 'reward_history_hash'),
    encodeInt(int(h, j, 'debt_supply'), 8),
    fixed(
      int(h, j, 'kryder_plus_rate_multiplier'),
      24,
      h,
      'kryder_plus_rate_multiplier',
    ),
    fixed(
      int(h, j, 'kryder_plus_rate_multiplier_latch'),
      8,
      h,
      'kryder_plus_rate_multiplier_latch',
    ),
    fixed(int(h, j, 'denomination'), 24, h, 'denomination'),
    encodeInt(int(h, j, 'redenomination_height'), 8),
    // An empty double_signing_proof (the only kind tested) is `<<0>>`.
    Buffer.from([0]),
    encodeInt(int(h, j, 'previous_cumulative_diff'), 16),
  ];
  if (h >= FORK_2_7) {
    parts.push(
      encodeInt(int(h, j, 'merkle_rebase_support_threshold'), 16),
      encodeBin(bin(h, poa, 'data_path'), 24),
      encodeBin(bin(h, poa, 'tx_path'), 24),
      encodeBin(bin(h, poa2, 'data_path'), 24),
      encodeBin(bin(h, poa2, 'tx_path'), 24),
      bin(h, j, 'chunk_hash'),
      encodeBin(optBin(h, j, 'chunk2_hash'), 8),
      bin(h, j, 'block_time_history_hash'),
      encodeInt(int(h, nl, 'vdf_difficulty'), 8),
      encodeInt(int(h, nl, 'next_vdf_difficulty'), 8),
    );
  }
  if (h >= FORK_2_8) {
    const packing = optInt(h, j, 'packing_difficulty') ?? 0n;
    if (packing > 255n) throw unverifiable(h, 'packing_difficulty over 255');
    parts.push(
      Buffer.from([Number(packing)]),
      encodeBin(optBin(h, j, 'unpacked_chunk_hash'), 8),
      encodeBin(optBin(h, j, 'unpacked_chunk2_hash'), 8),
    );
  }
  if (h >= FORK_2_9) {
    const replica = optInt(h, j, 'replica_format') ?? 0n;
    if (replica > 255n) throw unverifiable(h, 'replica_format over 255');
    parts.push(Buffer.from([Number(replica)]));
  }
  const signed = sha256(Buffer.concat(parts));
  return sha384(signed, bin(h, j, 'signature'));
}

/** The stored columns a pre-2.0 block's "2.0 hash" is taken over. */
export interface Block10Columns {
  height: number;
  previous_block: Buffer | null;
  nonce: Buffer;
  hash: Buffer;
  block_timestamp: number | bigint | string;
  last_retarget: number | bigint | string;
  diff: number | bigint | string;
  cumulative_diff: number | bigint | string | null;
  /** `null` for `unclaimed`. */
  reward_addr: Buffer | null;
  reward_pool: number | bigint | string;
  block_size: number | bigint | string;
  weave_size: number | bigint | string;
  wallet_list: Buffer | null;
  hash_list_merkle: Buffer | null;
}

/** A stored whole number, with the float text `core.db` keeps pre-1.8 difficulty as (`"28.0"`). */
function storedInt(value: number | bigint | string | null): bigint {
  if (value === null) return 0n;
  if (typeof value === 'bigint') return value;
  const text = String(value);
  const m = /^(\d+)(\.0+)?$/.exec(text);
  if (m === null) throw new Error(`not a whole number: ${text}`);
  return BigInt(m[1]);
}

/**
 * Arweave's "2.0 hash" of a pre-2.0 block (`ar_header_sync:download_block`
 * applies the 2.0–2.4 `indep_hash` rule to the 1.0 header with `tx_root`
 * set to the block's transition root and `txs` sorted), the value
 * `genesis_data/hash_list_1_0` holds for that height at index
 * `422250 - height - 1`. Block tags are empty and the proof of access is
 * the default (`option 1`, empty paths and chunk), as on every 1.0 block
 * the list was built from.
 *
 * `txRootWitness` is the block's transition `tx_root`, empty for a block
 * without transactions. It is an untrusted input: a wrong one changes the
 * hash, so it needs no source anyone trusts.
 */
export function hash20Of10Block(
  block: Block10Columns,
  txIds: Buffer[],
  txRootWitness: Buffer,
): Buffer {
  const sorted = [...txIds].sort(Buffer.compare);
  const base = deepHash([
    ib(BigInt(block.height)),
    block.previous_block ?? Buffer.alloc(0),
    txRootWitness,
    sorted,
    ib(storedInt(block.block_size)),
    ib(storedInt(block.weave_size)),
    block.reward_addr ?? Buffer.from('unclaimed'),
    [],
    [ib(1n), Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
  ]);
  const bds = deepHash([
    base,
    ib(storedInt(block.block_timestamp)),
    ib(storedInt(block.last_retarget)),
    ib(storedInt(block.diff)),
    ib(storedInt(block.cumulative_diff)),
    ib(storedInt(block.reward_pool)),
    block.wallet_list ?? Buffer.alloc(0),
    block.hash_list_merkle ?? Buffer.alloc(0),
  ]);
  return deepHash([bds, block.hash, block.nonce]);
}

/** One block-index entry: what `hash_list_merkle` folds from the 2.0 fork. */
export interface BlockIndexEntry {
  indep_hash: Buffer;
  weave_size: bigint | number | string;
  tx_root: Buffer | null;
}

/** `ar_unbalanced_merkle:hash_block_index_entry/1`. */
export function blockIndexEntryHash(entry: BlockIndexEntry): Buffer {
  return deepHash([
    entry.indep_hash,
    Buffer.from(String(entry.weave_size)),
    entry.tx_root ?? Buffer.alloc(0),
  ]);
}

/**
 * `ar_unbalanced_merkle:block_index_to_merkle_root/1` over entries in
 * height order from genesis: the `hash_list_merkle` of the block above the
 * last entry, for any block at or above the 2.0 fork (`ar_join` checks a
 * joining node's whole block index this way). At 422,250 it is the 2.0
 * seed, which binds every pre-2.0 block's hash, weave size and transition
 * `tx_root`.
 */
export function hashListMerkleSeed(entries: Iterable<BlockIndexEntry>): Buffer {
  let root: Buffer = Buffer.alloc(0);
  for (const entry of entries) root = sha384(root, blockIndexEntryHash(entry));
  return root;
}
