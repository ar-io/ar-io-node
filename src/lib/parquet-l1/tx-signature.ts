/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checking a transaction an index holds against its signature, which no
 * index stores.
 *
 * A transaction's id is the SHA-256 of its signature, and the signature is
 * over a segment built from its fields (`ar_tx:signature_data_segment_*`).
 * A signature fetched from anyone, untrusted, settles whether the id is real
 * and, for an RSA format-2 transaction (and a format-1 one with a
 * denomination), whether the index's copy of every signed field is: owner,
 * target, quantity, reward, anchor, tags in order, data size and data
 * root, each separately (the segment is a deep hash).
 *
 * Two kinds of transaction it does not settle on its own:
 * - **ECDSA (secp256k1).** The owner is not in the segment and is
 *   recovered from the signature (`ar_wallet.erl`), so for any fields some
 *   key verifies: the signature binds nothing until the fields are fixed.
 *   The owner is checked to be the key recovered with the signature's own
 *   recovery id, and the fields must be attested ({@link attestedFields}).
 * - **Format 1 with no denomination.** The segment is a plain
 *   concatenation, so the boundaries between adjacent fields (quantity and
 *   reward digits, anchor and tag bytes, tag names and values) are not
 *   signed. The consensus rules that fix some of them are checked
 *   ({@link consensusProblem}); the fields must be attested as well.
 *
 * Attested means: the same fields from the `/tx/{id}` answers of at least
 * two distinct machines, agreeing with each other and with the index. That
 * is the sources' word, not a proof, and the sample reports such draws as
 * `source-attested`.
 *
 * The segments, from `apps/arweave/src/ar_tx.erl` at 18d402c7:
 * - format 2: `deep_hash(["2", owner, target, quantity, reward, last_tx,
 *   tags, data_size, data_root])`, with the owner left out for an ECDSA
 *   (secp256k1) key, accepted from the 2.9 fork, and `denomination`
 *   prepended when above 0;
 * - format 1: `owner ‖ target ‖ data ‖ quantity ‖ reward ‖ last_tx ‖
 *   name1 ‖ value1 ‖ …`, or with a denomination above 0
 *   `deep_hash([denomination, owner, target, data, quantity, reward,
 *   last_tx, tags])`.
 *
 * RSA signatures are PSS over SHA-256, checked exactly as Arweave checks
 * them (`rsa-pss.ts`: a port of `rsa_pss:verify/4`, more lenient than
 * OpenSSL's); ECDSA ones are 65 bytes, `r ‖ s ‖ recovery id`,
 * over the SHA-256 of the segment. Verified against 2,899 mainnet
 * transactions (v2 RSA, v2 ECDSA, v1 with and without data, pre-2.4 v1)
 * rebuilt from band columns alone (2026-10-22).
 */
import crypto from 'node:crypto';
import secp256k1 from 'secp256k1';

import { arweaveRsaPssVerify } from './rsa-pss.js';
import {
  deepHash,
  type DeepHashItem,
  FORK_2_4,
  FORK_2_9,
} from './block-hash.js';

/** Arweave's 1.8 fork: the anchor (`last_tx`) of a format-1 transaction may be 48 bytes from here. */
export const FORK_1_8 = 269_510;
/** Arweave's 2.9.6 fork (`ar_fork:height_2_9_6`): no format-1 transaction at or above it. */
export const FORK_2_9_6 = 2_000_000;
/**
 * The most data a format-1 transaction may carry (`?TX_DATA_SIZE_LIMIT`,
 * `tx_field_size_limit_v1`): 10 MiB since 2019-05, 6,000,000 bytes before,
 * so a larger one was never valid at any height.
 */
export const V1_DATA_SIZE_LIMIT = 10 * 1024 * 1024;

/** A transaction as an index holds it, with its owner's key and its tags in order. */
export interface IndexedTx {
  id: Buffer;
  height: number;
  format: number;
  /** The owner's public key: an RSA modulus, or a 33-byte compressed secp256k1 key. */
  owner: Buffer;
  target: Buffer | null;
  quantity: string;
  reward: string;
  /** `last_tx`. */
  anchor: Buffer;
  tags: Array<[Buffer, Buffer]>;
  data_size: string;
  data_root: Buffer | null;
}

/** The parts of a fetched `/tx/{id}` answer that are used. */
export interface FetchedTx {
  signature: Buffer;
  format: number;
  /** Absent or "0" for every transaction seen so far. */
  denomination: bigint;
  /** A format-1 transaction's data, when the answer carried it. */
  data?: Buffer;
  /** The owner key the answer states (empty for an ECDSA transaction). */
  owner?: Buffer;
  /** The fields the answer states, for attestation ({@link attestedFields}). */
  fields?: AttestedFields;
}

/** The fields of a transaction a source states, in one canonical form. */
export interface AttestedFields {
  format: number;
  target: string;
  quantity: string;
  reward: string;
  anchor: string;
  /** Tag names and values, base64url, in order. */
  tags: Array<[string, string]>;
  data_size: string;
  /** Format 2 only: a format-1 root comes from its data. */
  data_root: string;
}

const b64u = (b: Buffer | null) => (b ?? Buffer.alloc(0)).toString('base64url');

/** The index's copy of the attested fields. */
export function indexedFields(tx: IndexedTx): AttestedFields {
  return {
    format: tx.format,
    target: b64u(tx.target),
    quantity: tx.quantity,
    reward: tx.reward,
    anchor: b64u(tx.anchor),
    tags: tx.tags.map(([n, v]) => [b64u(n), b64u(v)]),
    data_size: tx.data_size,
    data_root: tx.format === 2 ? b64u(tx.data_root) : '',
  };
}

/** Whether two statements of a transaction's fields are the same. */
export const sameFields = (a: AttestedFields, b: AttestedFields): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a transaction's signature alone does not bind its fields, so
 * they must be attested: an ECDSA owner, or format 1 with no denomination.
 */
export function needsAttestation(tx: IndexedTx, fetched: FetchedTx): boolean {
  return (
    tx.owner.length === ECDSA_KEY_BYTES ||
    (tx.format === 1 && fetched.denomination === 0n)
  );
}

/**
 * The first consensus rule the index's copy of a transaction breaks, or
 * undefined (`ar_tx.erl`: `verify_target_length`, `verify_malleability2`,
 * `tx_field_size_limit_v1`, and the 2.9.6 fork's end of format 1). These
 * fix field boundaries a format-1 signature leaves open.
 *
 * Fork gates are applied as the chain applies them. A block's
 * transactions are validated with the height of the block below it
 * (`ar_node_utils:validate_block(txs, …)` passes `Height - 1`), so a rule
 * gated `Height >= Fork` starts at block `Fork + 1`, and one gated
 * `Height + 1 >= Fork` at block `Fork`. `denomination` is the signed one,
 * where known: a format-1 transaction with a denomination is exempt from
 * the malleability rule.
 */
export function consensusProblem(
  tx: IndexedTx,
  { denomination = 0n }: { denomination?: bigint } = {},
): string | undefined {
  const decimal = /^(0|[1-9]\d*)$/;
  if (!decimal.test(tx.quantity))
    return `quantity ${tx.quantity} is not canonical decimal`;
  if (!decimal.test(tx.reward))
    return `reward ${tx.reward} is not canonical decimal`;
  if (!/^(0|[1-9]\d*)$/.test(tx.data_size))
    return `data_size ${tx.data_size} is not canonical decimal`;
  // `do_verify`: `Height + 1 >= height_2_9_6()`.
  if (tx.format === 1 && tx.height >= FORK_2_9_6) {
    return `a format-1 transaction at ${tx.height}, at or above the 2.9.6 fork`;
  }
  if (tx.format === 1 && BigInt(tx.data_size) > BigInt(V1_DATA_SIZE_LIMIT)) {
    return `a format-1 transaction with ${tx.data_size} bytes of data, past the ${V1_DATA_SIZE_LIMIT}-byte limit format 1 always had`;
  }
  const target = tx.target?.length ?? 0;
  const positive = BigInt(tx.quantity) > 0n;
  // `verify_target_length`: `Height >= height_2_4()`.
  if (tx.height - 1 >= FORK_2_4) {
    if (!((!positive && target <= 32) || target === 32)) {
      return `a ${target}-byte target with quantity ${tx.quantity}`;
    }
  } else if (target > 32) {
    return `a ${target}-byte target`;
  }
  // `verify_malleability`: `Height + 1 >= height_2_4()`, format 1 with no
  // denomination only.
  if (tx.format === 1 && denomination === 0n && tx.height >= FORK_2_4) {
    if (positive && target !== 32) {
      return `a format-1 transaction with quantity ${tx.quantity} and a ${target}-byte target (malleable)`;
    }
    if (!positive && target > 0) {
      return 'a format-1 transaction with a target and no quantity (malleable)';
    }
  }
  // `tx_field_size_limit_v1`: `Height >= height_1_8()`.
  if (
    tx.format === 1 &&
    tx.anchor.length > (tx.height - 1 >= FORK_1_8 ? 48 : 32)
  ) {
    return `a ${tx.anchor.length}-byte anchor`;
  }
  return undefined;
}

/** A `/tx/{id}` answer's signature, format, denomination and (format 1) data. */
export function parseFetchedTx(body: unknown): FetchedTx {
  if (body === null || typeof body !== 'object') {
    throw new Error('not a transaction');
  }
  const json = body as Record<string, unknown>;
  const text = (key: string) => {
    const value = json[key];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
      throw new Error(`no base64url ${key}`);
    }
    return Buffer.from(value, 'base64url');
  };
  const signature = text('signature');
  if (signature.length === 0) throw new Error('an empty signature');
  const format = Number(json.format ?? 1);
  if (format !== 1 && format !== 2)
    throw new Error(`format ${String(json.format)}`);
  const rawDenomination = json.denomination;
  let denomination = 0n;
  if (rawDenomination !== undefined && rawDenomination !== '') {
    const t = String(rawDenomination);
    if (!/^\d+$/.test(t)) throw new Error(`denomination ${t}`);
    denomination = BigInt(t);
  }
  const data =
    format === 1 && typeof json.data === 'string' ? text('data') : undefined;
  let fields: AttestedFields | undefined;
  const str = (key: string) =>
    typeof json[key] === 'string'
      ? (json[key] as string)
      : String(json[key] ?? '');
  if (Array.isArray(json.tags)) {
    fields = {
      format,
      target: str('target'),
      quantity: str('quantity'),
      reward: str('reward'),
      anchor: str('last_tx'),
      tags: (json.tags as Array<Record<string, unknown>>).map((t) => [
        String(t?.name ?? ''),
        String(t?.value ?? ''),
      ]),
      data_size: str('data_size'),
      data_root: format === 2 ? str('data_root') : '',
    };
  }
  const owner =
    typeof json.owner === 'string' && /^[A-Za-z0-9_-]*$/.test(json.owner)
      ? Buffer.from(json.owner, 'base64url')
      : undefined;
  return {
    signature,
    format,
    denomination,
    ...(data !== undefined ? { data } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(fields !== undefined ? { fields } : {}),
  };
}

/** A compressed secp256k1 public key: what an ECDSA owner is stored as. */
export const ECDSA_KEY_BYTES = 33;

/** DER prefix of a SubjectPublicKeyInfo for a compressed secp256k1 key. */
const SPKI_SECP256K1 = Buffer.from(
  '3036301006072a8648ce3d020106052b8104000a032200',
  'hex',
);

/** The segment a transaction's signature is over, rebuilt from the index's columns. */
export function signatureData(
  tx: IndexedTx,
  { denomination = 0n, data }: { denomination?: bigint; data?: Buffer } = {},
): Buffer {
  const target = tx.target ?? Buffer.alloc(0);
  const tags: DeepHashItem = tx.tags.map(([n, v]) => [n, v]);
  const den = denomination > 0n ? [Buffer.from(denomination.toString())] : [];
  if (tx.format === 2) {
    const ecdsa = tx.owner.length === ECDSA_KEY_BYTES;
    return deepHash([
      ...den,
      Buffer.from('2'),
      ...(ecdsa ? [] : [tx.owner]),
      target,
      Buffer.from(tx.quantity),
      Buffer.from(tx.reward),
      tx.anchor,
      tags,
      Buffer.from(tx.data_size),
      tx.data_root ?? Buffer.alloc(0),
    ]);
  }
  const body = data ?? Buffer.alloc(0);
  if (den.length > 0) {
    return deepHash([
      ...den,
      tx.owner,
      target,
      body,
      Buffer.from(tx.quantity),
      Buffer.from(tx.reward),
      tx.anchor,
      tags,
    ]);
  }
  return Buffer.concat([
    tx.owner,
    target,
    body,
    Buffer.from(tx.quantity),
    Buffer.from(tx.reward),
    tx.anchor,
    ...tx.tags.flat(),
  ]);
}

/** Why a fetched signature does not prove the index's transaction, or `ok`. */
export type TxVerdict =
  | { ok: true }
  | {
      ok: false;
      /** Whether the index is shown wrong (`mismatch`) or the draw could not be judged (`unreadable`). */
      kind: 'mismatch' | 'unreadable';
      reason: string;
    };

/**
 * Whether a signature fetched for `tx.id` proves the index's copy of the
 * transaction: the id is its SHA-256, the format agrees, and it verifies
 * over the segment rebuilt from the index's columns.
 *
 * A format-1 transaction with data is signed over its data, so it needs
 * the data, at the index's `data_size`; without it the draw is
 * `unreadable`, never a pass.
 */
export function verifyIndexedTx(tx: IndexedTx, fetched: FetchedTx): TxVerdict {
  const id = crypto.createHash('sha256').update(fetched.signature).digest();
  if (!id.equals(tx.id)) {
    return {
      ok: false,
      kind: 'unreadable',
      reason: `the source's signature hashes to ${id.toString('base64url')}, not the id`,
    };
  }
  if (fetched.format !== tx.format) {
    return {
      ok: false,
      kind: 'mismatch',
      reason: `format ${tx.format} in the index, ${fetched.format} signed`,
    };
  }
  const broken = consensusProblem(tx, {
    denomination: fetched.denomination,
  });
  if (broken !== undefined) {
    return {
      ok: false,
      kind: 'mismatch',
      reason: `breaks consensus: ${broken}`,
    };
  }
  let data: Buffer | undefined;
  if (tx.format === 1 && BigInt(tx.data_size) > 0n) {
    if (fetched.data === undefined || fetched.data.length === 0) {
      return {
        ok: false,
        kind: 'unreadable',
        reason: 'a format-1 transaction with data, served without its data',
      };
    }
    if (BigInt(fetched.data.length) !== BigInt(tx.data_size)) {
      return {
        ok: false,
        kind: 'mismatch',
        reason: `data_size ${tx.data_size} in the index, ${fetched.data.length} bytes served`,
      };
    }
    data = fetched.data;
  }
  const message = signatureData(tx, {
    denomination: fetched.denomination,
    ...(data !== undefined ? { data } : {}),
  });
  let verified: boolean;
  try {
    if (tx.owner.length === ECDSA_KEY_BYTES) {
      // `verify_signature_type`: `Height >= height_2_9()`, with the
      // height of the block below.
      if (tx.height - 1 < FORK_2_9 || tx.format !== 2) {
        return {
          ok: false,
          kind: 'mismatch',
          reason: `an ECDSA owner on a format-${tx.format} transaction at ${tx.height}, which the chain accepts only for format 2 in blocks above the 2.9 fork`,
        };
      }
      const key = crypto.createPublicKey({
        key: Buffer.concat([SPKI_SECP256K1, tx.owner]),
        format: 'der',
        type: 'spki',
      });
      verified =
        fetched.signature.length === 65 &&
        crypto.verify(
          'sha256',
          message,
          { key, dsaEncoding: 'ieee-p1363' },
          fetched.signature.subarray(0, 64),
        );
      if (verified) {
        // The owner must be the key the signature's own recovery id gives,
        // not merely one of the keys that verify.
        const recid =
          fetched.signature[64] >= 27
            ? fetched.signature[64] - 27
            : fetched.signature[64];
        const recovered = Buffer.from(
          secp256k1.ecdsaRecover(
            fetched.signature.subarray(0, 64),
            recid,
            crypto.createHash('sha256').update(message).digest(),
            true,
          ),
        );
        verified = recovered.equals(tx.owner);
      }
    } else {
      // As the chain verifies it (rsa-pss.ts): `ar_wallet:verify` for a
      // block validated at or above 2.4 (with the height of the block
      // below), `verify_pre_fork_2_4` before.
      verified = arweaveRsaPssVerify(message, fetched.signature, tx.owner, {
        legacy: tx.height - 1 < FORK_2_4,
      });
    }
  } catch (error) {
    return {
      ok: false,
      kind: 'mismatch',
      reason: `the owner key does not verify anything: ${(error as Error).message}`,
    };
  }
  return verified
    ? { ok: true }
    : {
        ok: false,
        kind: 'mismatch',
        reason:
          "the signature does not verify over the index's fields (owner, target, quantity, reward, anchor, tags, data_size or data_root differ from what was signed)",
      };
}

/**
 * The owner address a fetched answer gives a transaction: the SHA-256 of
 * the owner key it states, or, for an ECDSA transaction (no owner stated),
 * of the key recovered from its signature over `tx`'s segment. Undefined
 * when neither can be had.
 */
export function fetchedOwnerAddress(
  tx: IndexedTx,
  fetched: FetchedTx,
): Buffer | undefined {
  if (fetched.owner !== undefined && fetched.owner.length > 0) {
    return crypto.createHash('sha256').update(fetched.owner).digest();
  }
  if (fetched.signature.length !== 65 || tx.format !== 2) return undefined;
  try {
    const recid =
      fetched.signature[64] >= 27
        ? fetched.signature[64] - 27
        : fetched.signature[64];
    const message = signatureData(
      { ...tx, owner: Buffer.alloc(ECDSA_KEY_BYTES) },
      { denomination: fetched.denomination },
    );
    const key = Buffer.from(
      secp256k1.ecdsaRecover(
        fetched.signature.subarray(0, 64),
        recid,
        crypto.createHash('sha256').update(message).digest(),
        true,
      ),
    );
    return crypto.createHash('sha256').update(key).digest();
  } catch {
    return undefined;
  }
}

/**
 * Whether an owner key hashes to its address, by the rule for its kind:
 * SHA-256 of the RSA modulus, or of the 33-byte compressed ECDSA key.
 */
export function ownerMatchesAddress(owner: Buffer, address: Buffer): boolean {
  return crypto.createHash('sha256').update(owner).digest().equals(address);
}
