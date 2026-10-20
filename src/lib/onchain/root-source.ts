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
 *    of the signature, and the signature must verify (the transaction signs
 *    its `data_root` and `data_size`). arweave-js fails to verify some valid
 *    transactions, so when it does, at least `minAgreement` nodes must serve
 *    the same `data_root` and `data_size` instead; the report says which.
 * 2. The root's place in the weave comes from `/tx/{id}/offset`, whose size
 *    must be the signed `data_size`.
 * 3. Every chunk read is proven: its `data_path` must validate against the
 *    signed `data_root` under the consensus rules for its weave offset, the
 *    chunk must hash to the path's leaf, and it is placed by the bounds the
 *    proof gives, never by assuming 256 KiB chunks. A node whose chunk fails
 *    is passed over for the next.
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
import type { RootSourceFactory } from '../index-band/verify.js';
import { getRulesetForOffset, parseDataPath } from '../merkle-path-parser.js';
import {
  ArweaveNodePool,
  NodeChunk,
  NotOnNodesError,
} from './arweave-nodes.js';

/** A root whose id can't be bound to its data: no check can be made. */
export class RootUnboundError extends Error {}

/** How a root's id was bound to its `data_root` (see the module doc). */
export type RootBinding = 'signature' | 'agreement';

export interface BoundRoot {
  id: string;
  dataRoot: Buffer;
  dataSize: number;
  /** Absolute weave offset of the root's first byte. */
  start: bigint;
  binding: RootBinding;
}

export interface OnChainRootSourceStats {
  roots: number;
  bySignature: number;
  byAgreement: number;
  chunksProven: number;
  /** Nodes that answered any request. */
  reachableNodes: number;
}

export interface OnChainRootSourceOptions {
  pool: ArweaveNodePool;
  /** Nodes that must agree on a root's data when its signature won't verify. */
  minAgreement?: number;
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
  verifyHeader = arweaveVerify,
}: OnChainRootSourceOptions): {
  openRoot: RootSourceFactory;
  bind: (rootTxId: string) => Promise<BoundRoot>;
  stats: () => OnChainRootSourceStats;
} {
  const bound = new Map<string, Promise<BoundRoot>>();
  const counts = { bySignature: 0, byAgreement: 0, chunksProven: 0 };
  /** The node that last proved a chunk of each root, asked first next time. */
  const lastNode = new Map<string, string>();

  const bindRoot = async (id: string): Promise<BoundRoot> => {
    const header = await pool.txHeader(id);
    const signature = Buffer.from(field(header, 'signature'), 'base64url');
    const hashed = crypto
      .createHash('sha256')
      .update(signature)
      .digest()
      .toString('base64url');
    if (hashed !== id) {
      throw new RootUnboundError(
        `the header served for ${id} is another transaction's (${hashed})`,
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
    } else {
      const headers = await pool.txHeaders(id, minAgreement + 2);
      const agreeing = headers.filter(
        ({ header: h }) =>
          h.data_root === dataRootText &&
          String(h.data_size) === String(dataSize),
      );
      if (agreeing.length < minAgreement) {
        throw new RootUnboundError(
          `${id}: its signature doesn't verify and ${agreeing.length} of ${headers.length} nodes agree on its data (need ${minAgreement})`,
        );
      }
      binding = 'agreement';
    }

    const where = await pool.txOffset(id);
    if (where.size !== dataSize) {
      throw new RootUnboundError(
        `${id}: the weave holds ${where.size} bytes, its header signs ${dataSize}`,
      );
    }
    if (binding === 'signature') counts.bySignature += 1;
    else counts.byAgreement += 1;
    return {
      id,
      dataRoot,
      dataSize,
      start: where.offset - BigInt(dataSize) + 1n,
      binding,
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
          ruleset: getRulesetForOffset(Number(absolute)),
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

  const openRoot: RootSourceFactory = (rootTxId: string): ByteRangeSource => ({
    getSize: async () => (await bind(rootTxId)).dataSize,
    // Nothing held per source: the pool's requests are each their own.
    close: async () => undefined,
    isOpen: () => true,
    read: async (offset: number, size: number): Promise<Buffer> => {
      const root = await bind(rootTxId);
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
      reachableNodes: pool.reachable.size,
    }),
  };
}
