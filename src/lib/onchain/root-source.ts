/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A root transaction's bytes, read from Arweave nodes and proven, for checks
 * that must not trust a gateway (`index-band-verify --arweave-nodes`,
 * `index-l2-verify`). It is a {@link ByteRangeSource}, so the index header
 * check reads from it exactly as from a gateway.
 *
 * Nothing a node says is taken on its word:
 *
 * 1. The root's header binds its id to its data: the id must be the SHA-256
 *    of the signature, the header must be format 2 (only a format-2
 *    signature covers `data_root`; a format-1 header carrying one carries
 *    it unsigned), and the signature must verify. arweave-js fails to verify
 *    some valid transactions; when it does, the root is refused unless
 *    `allowAgreement` is set, and then at least `minAgreement` other nodes,
 *    on machines other than the one that served the header and each other,
 *    must serve a header for the same id, itself format 2 and hashing to
 *    the id, with the same `data_root` and `data_size`. The report says
 *    which roots were bound which way.
 * 2. The root is mined: unless the caller has checked that itself
 *    (`requireMined: false`, for a root found in a checked L1 index), at
 *    least `minAgreement` nodes on distinct machines (by address) must
 *    place it in one block, with a confirmation (`/tx/{id}/status`), at the
 *    height the band gives (`expect.height`; the position in the block
 *    can't be read from the status). A signature proves who signed a
 *    transaction, not that the chain took it.
 *
 * Whatever refutes a root is a {@link RootUnboundError} (`refutes`), which
 * a header check counts wrong.
 * 3. The root's place in the weave comes from `/tx/{id}/offset`, whose size
 *    must be the signed `data_size`.
 * 4. Every chunk read is proven: its `data_path` must validate against the
 *    signed `data_root` under the consensus rules for the root's place in
 *    the weave, the chunk must hash to the path's leaf, and it is placed by
 *    the bounds the proof gives, never by assuming 256 KiB chunks. A node
 *    whose chunk fails is passed over for the next.
 *
 * What a read comes to, as the header check sorts it: bytes; a range past the
 * root's end is a {@link ShortRangeReadError} (the offsets are wrong); a
 * root or chunk every answering node says 404 to is a 404 (`NotOnNodesError`:
 * data gone network-wide; `wholeRoot` says whether the root itself is gone
 * or one chunk of it); anything else (busy or failing nodes, a chunk no node
 * can prove, no node reachable, a root that can't be bound) is an error, to
 * be retried or reported, never read as missing data.
 */
import crypto from 'node:crypto';
import { default as Arweave } from 'arweave';

import type { ByteRangeSource } from '../byte-range-source.js';
import { ShortRangeReadError } from '../http-byte-range-source.js';
import type {
  RootExpectation,
  RootSourceFactory,
} from '../index-band/verify.js';
import {
  getRulesetForOffset,
  parseDataPath,
  ValidationRuleset,
} from '../merkle-path-parser.js';
import {
  ArweaveNodePool,
  NodeChunk,
  NotOnNodesError,
  TooFewMinedError,
} from './arweave-nodes.js';

/**
 * A root the chain refutes: its id can't be bound to data it signs (no
 * data_root, format 1, another transaction's header, a signature that
 * doesn't verify), or it is not mined (nodes say it is in no block, or too
 * few place it in one), or it is in another block than its band says. A
 * header check counts it wrong (`refutes`), never as a failure to read.
 */
export class RootUnboundError extends Error {
  readonly refutes = true;
}

/** How a root's id was bound to its `data_root` (see the module doc). */
export type RootBinding = 'signature' | 'agreement';

export interface BoundRoot {
  id: string;
  dataRoot: Buffer;
  dataSize: number;
  /** Absolute weave offset of the root's first byte. */
  start: bigint;
  binding: RootBinding;
  /** The block nodes place it in, when this source checked that. */
  block?: { indepHash: string; height: number };
}

export interface OnChainRootSourceStats {
  roots: number;
  bySignature: number;
  byAgreement: number;
  /** Roots found in a block by nodes' status answers. */
  minedByNodes: number;
  /** How a root is known to be mined: by nodes here, or by the caller. */
  minedVia: 'node-status' | 'caller';
  chunksProven: number;
  /** Nodes that answered any request. */
  reachableNodes: number;
}

export interface OnChainRootSourceOptions {
  pool: ArweaveNodePool;
  /**
   * Machines that must agree: on a root's data when its signature won't
   * verify, and on the block that holds it (default 2).
   */
  minAgreement?: number;
  /**
   * Bind a root whose signature arweave-js won't verify by nodes' agreement
   * on its data (default false: such a root is refused).
   */
  allowAgreement?: boolean;
  /**
   * Require nodes to place each root in a block (default true). False only
   * where the caller has found every root in a checked L1 index.
   */
  requireMined?: boolean;
  /** Injected in tests: whether arweave-js verifies a header. */
  verifyHeader?: (header: Record<string, unknown>) => Promise<boolean>;
}

const arweave = Arweave.init({});

async function arweaveVerify(
  header: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await arweave.transactions.verify(
      arweave.transactions.fromRaw(header as never),
    );
  } catch {
    return false;
  }
}

/** Whether a header is a format-2 transaction's, the only kind whose signature covers `data_root`. */
const isFormat2 = (header: Record<string, unknown>) =>
  header.format === 2 || header.format === '2';

/** The SHA-256 of a header's signature, base64url: the id it is the header of. */
const signatureId = (header: Record<string, unknown>): string | undefined =>
  typeof header.signature === 'string' && header.signature.length > 0
    ? crypto
        .createHash('sha256')
        .update(Buffer.from(header.signature, 'base64url'))
        .digest()
        .toString('base64url')
    : undefined;

const field = (header: Record<string, unknown>, name: string): string => {
  const value = header[name];
  if (typeof value !== 'string') {
    throw new RootUnboundError(`the root's header has no ${name}`);
  }
  return value;
};

/**
 * Root transactions read from Arweave nodes, proven. Roots are bound once
 * and remembered for the run.
 */
export function onChainRootSource({
  pool,
  minAgreement = 2,
  allowAgreement = false,
  requireMined = true,
  verifyHeader = arweaveVerify,
}: OnChainRootSourceOptions): {
  openRoot: RootSourceFactory;
  bind: (rootTxId: string) => Promise<BoundRoot>;
  stats: () => OnChainRootSourceStats;
} {
  const bound = new Map<string, Promise<BoundRoot>>();
  const counts = {
    bySignature: 0,
    byAgreement: 0,
    minedByNodes: 0,
    chunksProven: 0,
  };
  /** The node that last proved a chunk of each root, asked first next time. */
  const lastNode = new Map<string, string>();

  const bindRoot = async (id: string): Promise<BoundRoot> => {
    let servedBy = '';
    const header = await pool.ask(
      `/tx/${id}`,
      (body, node) => {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('not a transaction header');
        }
        servedBy = node;
        return body as Record<string, unknown>;
      },
      undefined,
      undefined,
      true,
    );
    field(header, 'signature');
    const hashed = signatureId(header);
    if (hashed !== id) {
      throw new RootUnboundError(
        `the header served for ${id} is another transaction's (${hashed})`,
      );
    }
    // Only a format-2 signature covers data_root and data_size: a format-1
    // header that carries them carries them unsigned.
    if (!isFormat2(header)) {
      throw new RootUnboundError(
        `${id} is not a format-2 transaction (format ${JSON.stringify(header.format)}): its signature does not cover a data_root`,
      );
    }
    const dataRootText = field(header, 'data_root');
    if (dataRootText.length === 0) {
      throw new RootUnboundError(
        `${id} has no data_root (a format-1 transaction): its data has no chunk proofs to check`,
      );
    }
    const dataRoot = Buffer.from(dataRootText, 'base64url');
    const dataSize = Number(field(header, 'data_size'));
    if (!Number.isSafeInteger(dataSize) || dataSize <= 0) {
      throw new RootUnboundError(`${id} has no data to read`);
    }

    let binding: RootBinding;
    if (await verifyHeader(header)) {
      binding = 'signature';
    } else if (!allowAgreement) {
      throw new RootUnboundError(
        `${id}: its signature doesn't verify, and binding by nodes' agreement is not allowed (--allow-agreement)`,
      );
    } else {
      // Other machines than the one that served it, each serving a header of
      // this id (its signature hashing to it), format 2, with the same data.
      const agreeing = await pool.txHeaders(
        id,
        minAgreement,
        (h) =>
          signatureId(h) === id &&
          isFormat2(h) &&
          h.data_root === dataRootText &&
          String(h.data_size) === String(dataSize),
        [servedBy],
      );
      if (agreeing.length < minAgreement) {
        throw new RootUnboundError(
          `${id}: its signature doesn't verify and ${agreeing.length} other machines agree on its data (need ${minAgreement})`,
        );
      }
      binding = 'agreement';
    }

    // Signed is not mined: nodes on distinct machines must place it in a
    // block, unless the caller found it in a checked L1 index.
    let block: BoundRoot['block'];
    if (requireMined) {
      let status;
      try {
        status = await pool.txStatus(id, minAgreement);
      } catch (error) {
        // Nodes that say it is in no block, beside too few that place it
        // in one: not mined, as far as the chain says.
        if (error instanceof TooFewMinedError && error.notFound > 0) {
          throw new RootUnboundError(`${id} is not mined: ${error.message}`);
        }
        throw error;
      }
      block = { indepHash: status.blockIndepHash, height: status.blockHeight };
    }

    const where = await pool.txOffset(id);
    if (where.size !== dataSize) {
      throw new RootUnboundError(
        `${id}: the weave holds ${where.size} bytes, its header signs ${dataSize}`,
      );
    }
    if (binding === 'signature') counts.bySignature += 1;
    else counts.byAgreement += 1;
    if (block !== undefined) counts.minedByNodes += 1;
    return {
      id,
      dataRoot,
      dataSize,
      start: where.offset - BigInt(dataSize) + 1n,
      binding,
      ...(block !== undefined ? { block } : {}),
    };
  };

  const bind = (id: string): Promise<BoundRoot> => {
    let pending = bound.get(id);
    if (pending === undefined) {
      pending = bindRoot(id);
      // A definitive failure to bind is remembered for the run: asking again
      // would only ask the same nodes the same question. Anything else (no
      // node reachable, nodes busy) is asked again next time.
      bound.set(id, pending);
      pending.catch((error) => {
        if (
          !(error instanceof RootUnboundError) &&
          !(error instanceof NotOnNodesError)
        ) {
          bound.delete(id);
        }
      });
    }
    return pending;
  };

  /** One proven chunk holding root byte `rel`, and its bounds in the root. */
  const provenChunk = async (root: BoundRoot, rel: number) => {
    const absolute = root.start + BigInt(rel);
    return pool.chunk(
      absolute,
      async (served: NodeChunk) => {
        const parsed = await parseDataPath({
          dataRoot: root.dataRoot,
          dataSize: root.dataSize,
          dataPath: served.dataPath,
          offset: rel,
          ruleset: rulesetForRoot(root.start),
        });
        const { startOffset, endOffset } = parsed.boundaries;
        if (!parsed.validated) throw new Error('its proof does not validate');
        if (
          !crypto
            .createHash('sha256')
            .update(served.chunk)
            .digest()
            .equals(parsed.chunkData)
        ) {
          throw new Error('the chunk does not hash to its proof');
        }
        if (served.chunk.length !== endOffset - startOffset) {
          throw new Error('the chunk is not the length its proof gives');
        }
        if (rel < startOffset || rel >= endOffset) {
          throw new Error('the proof is for another chunk');
        }
        counts.chunksProven += 1;
        lastNode.set(root.id, served.node);
        return { chunk: served.chunk, start: startOffset, end: endOffset };
      },
      lastNode.get(root.id),
    );
  };

  /** A bound root, refused if nodes place it in another block than expected. */
  const boundAs = async (rootTxId: string, expect?: RootExpectation) => {
    const root = await bind(rootTxId);
    if (
      expect?.height !== undefined &&
      root.block !== undefined &&
      root.block.height !== expect.height
    ) {
      throw new RootUnboundError(
        `nodes place ${rootTxId} in block ${root.block.height}, its band at height ${expect.height}`,
      );
    }
    return root;
  };

  const openRoot: RootSourceFactory = (
    rootTxId: string,
    expect?: RootExpectation,
  ): ByteRangeSource => ({
    getSize: async () => (await boundAs(rootTxId, expect)).dataSize,
    // Nothing held per source: the pool's requests are each their own.
    close: async () => undefined,
    isOpen: () => true,
    read: async (offset: number, size: number): Promise<Buffer> => {
      const root = await boundAs(rootTxId, expect);
      if (offset < 0 || size < 0) throw new Error('negative range');
      if (offset + size > root.dataSize) {
        throw new ShortRangeReadError(
          size,
          Math.max(0, root.dataSize - offset),
        );
      }
      const out = Buffer.alloc(size);
      let at = offset;
      while (at < offset + size) {
        const { chunk, start, end } = await provenChunk(root, at);
        const take = Math.min(end, offset + size) - at;
        chunk.copy(out, at - offset, at - start, at - start + take);
        at += take;
      }
      return out;
    },
  });

  return {
    openRoot,
    bind,
    stats: () => ({
      roots: bound.size,
      ...counts,
      minedVia: requireMined ? 'node-status' : 'caller',
      reachableNodes: pool.reachable.size,
    }),
  };
}

/**
 * The consensus rules a root's chunk proofs are checked under. Arweave picks
 * them by the start offset of the block holding the transaction
 * (`ar_poa:get_data_path_validation_ruleset/3`), so every chunk of one
 * transaction is checked under one ruleset, and never one laxer than strict
 * borders: below the strict data-split threshold it is
 * `strict_borders_ruleset`, not the basic one. The root's own start is the
 * nearest offset this source knows to its block's; it can differ from it
 * only for a transaction in one of the two blocks that straddle a
 * threshold, where it may ask for the later rules: a valid proof refused
 * there is an error, never a pass.
 */
export function rulesetForRoot(start: bigint): ValidationRuleset {
  const ruleset = getRulesetForOffset(Number(start));
  return ruleset === ValidationRuleset.BASIC
    ? ValidationRuleset.STRICT_BORDERS
    : ruleset;
}
