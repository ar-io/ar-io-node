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
  definiteMachines,
  NodeChunk,
  NodesRefusedError,
  NodesUnreachableError,
  NotOnNodesError,
  type Survey,
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

/** An answer a node gave that didn't hold up: its fault, not its root's. */
export interface NodeFault {
  node: string;
  rootTxId: string;
  what: string;
}

/** Node faults kept for a report; the rest are counted. */
export const MAX_NODE_FAULTS = 200;

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
  /** Answers nodes gave that didn't hold up (at most {@link MAX_NODE_FAULTS}). */
  nodeFaults: () => NodeFault[];
  nodeFaultCount: () => number;
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

  /** Answers that didn't hold up, each its node's fault, not its root's. */
  const faults: NodeFault[] = [];
  const fault = (node: string, rootTxId: string, what: string) => {
    if (faults.length < MAX_NODE_FAULTS) faults.push({ node, rootTxId, what });
    faultCount += 1;
  };
  let faultCount = 0;

  const bindRoot = async (id: string): Promise<BoundRoot> => {
    // The header: a node's that isn't this transaction's is that node's
    // fault; one that is (its signature hashes to the id) but isn't format
    // 2, carries no data, or won't verify is evidence about the root, which
    // two machines must give before it refutes it.
    type Header = {
      header: Record<string, unknown>;
      verified: boolean;
      problem?: string;
    };
    const judgeHeader = async (body: unknown): Promise<Header> => {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('not a transaction header');
      }
      const header = body as Record<string, unknown>;
      const hashed = signatureId(header);
      if (hashed !== id) {
        throw new Error(`served another transaction's header (${hashed})`);
      }
      const dataSize = Number(header.data_size);
      const problem = !isFormat2(header)
        ? `not a format-2 transaction (format ${JSON.stringify(header.format)}): its signature does not cover a data_root`
        : typeof header.data_root !== 'string' || header.data_root.length === 0
          ? 'no data_root: no data whose chunks can be proven'
          : !Number.isSafeInteger(dataSize) || dataSize <= 0
            ? 'no data to read'
            : undefined;
      return {
        header,
        verified: problem === undefined && (await verifyHeader(header)),
        ...(problem !== undefined ? { problem } : {}),
      };
    };
    const headers = await pool.survey<Header>(`/tx/${id}`, judgeHeader, {
      enough: (sv) => sv.answers.some((a) => a.value.verified),
    });
    let chosen: Record<string, unknown> | undefined;
    let binding: RootBinding = 'signature';
    const verified = headers.answers.find((a) => a.value.verified);
    if (verified !== undefined) {
      chosen = verified.value.header;
    } else if (allowAgreement) {
      // Format-2 headers of this id with data, unverifiable, the same data
      // served by enough machines.
      const groups = new Map<string, Set<string>>();
      for (const a of headers.answers) {
        if (a.value.problem !== undefined) continue;
        const key = `${String(a.value.header.data_root)}:${String(a.value.header.data_size)}`;
        groups.set(key, (groups.get(key) ?? new Set()).add(a.machine));
      }
      const [best] = [...groups.entries()].sort(
        (x, y) => y[1].size - x[1].size,
      );
      if (best !== undefined && best[1].size >= minAgreement + 1) {
        chosen = headers.answers.find(
          (a) =>
            `${String(a.value.header.data_root)}:${String(a.value.header.data_size)}` ===
            best[0],
        )!.value.header;
        binding = 'agreement';
      }
    }
    if (chosen === undefined) {
      // No binding. Answers of the root itself count against it; another
      // transaction's header counts against its node only.
      for (const f of headers.faults) fault(f.node, id, f.reason);
      const against = headers.answers.length;
      const reasons = [
        ...new Set(
          headers.answers.map(
            (a) => a.value.problem ?? "its signature doesn't verify",
          ),
        ),
      ];
      const pure: Survey<Header> = { ...headers, faults: [] };
      const machines = definiteMachines(pure);
      if (machines >= 2 && against === 0) {
        // Missing only when every node was heard: an unheard node may be
        // the one holder, so the root is then unchecked, not missing.
        if (headers.unheard.length > 0) {
          throw new NodesRefusedError(
            `${machines} machines have no header for ${id}, and ${headers.unheard.length} stayed unheard (asked twice: busy, or its connection failed): unchecked`,
            headers.absent.length,
            headers.busy.length,
            0,
          );
        }
        throw new NotOnNodesError(
          `${machines} machines have no header for ${id}`,
          machines,
          true,
        );
      }
      if (machines >= 2) {
        throw new RootUnboundError(
          `${id} can't be bound: ${reasons.join('; ')}${allowAgreement ? '' : ' (agreement in place of a signature needs --allow-agreement)'}`,
        );
      }
      if (definiteMachines(headers) === 0 && headers.busy.length === 0) {
        throw new NodesUnreachableError(`no Arweave node answered /tx/${id}`);
      }
      throw new NodesRefusedError(
        `no header that binds ${id}, and fewer than two machines said anything of the root itself (${headers.absent.length} said 404, ${against} served it unbindable, ${headers.faults.length} served another transaction's header, ${headers.busy.length} busy)`,
        headers.absent.length,
        headers.busy.length,
        headers.faults.length,
      );
    }
    // Answers that disagree with the binding were their nodes' faults.
    for (const a of headers.answers) {
      if (a.value.header === chosen) continue;
      if (
        binding === 'signature' &&
        !a.value.verified &&
        a.value.header.data_root === chosen.data_root
      ) {
        fault(
          a.node,
          id,
          a.value.problem ?? "a header whose signature doesn't verify",
        );
      } else if (
        a.value.header.data_root !== chosen.data_root ||
        a.value.problem !== undefined
      ) {
        fault(a.node, id, a.value.problem ?? 'a header with other data');
      }
    }
    for (const f of headers.faults) fault(f.node, id, f.reason);
    const dataRootText = String(chosen.data_root);
    const dataRoot = Buffer.from(dataRootText, 'base64url');
    const dataSize = Number(chosen.data_size);

    // Signed is not mined: two machines must place it in one block (unless
    // the caller found it in a checked L1 index); two that say it is in
    // none refute it.
    let block: BoundRoot['block'];
    if (requireMined) {
      type Placed = { hash: string; height: number };
      // A block is its hash and its height: machines agree on both, and
      // an answer that names the agreed hash at another height is its
      // node's fault.
      const keyOf = (v: Placed) => `${v.hash}@${v.height}`;
      const agreed = (sv: Survey<Placed>) => {
        const by = new Map<string, Set<string>>();
        for (const a of sv.answers) {
          const k = keyOf(a.value);
          by.set(k, (by.get(k) ?? new Set()).add(a.machine));
        }
        return [...by.entries()].find(([, m]) => m.size >= minAgreement)?.[0];
      };
      const status = await pool.survey<Placed>(
        `/tx/${id}/status`,
        (body) => {
          const b = (body ?? {}) as Record<string, unknown>;
          const hash = b.block_indep_hash;
          const height = Number(b.block_height);
          const confirmations = Number(b.number_of_confirmations);
          if (
            typeof hash !== 'string' ||
            hash.length === 0 ||
            !Number.isSafeInteger(height) ||
            !Number.isSafeInteger(confirmations) ||
            confirmations < 1
          ) {
            throw new Error('not a block status');
          }
          return { hash, height };
        },
        // 202 is "pending": in no block yet.
        {
          enough: (sv) => agreed(sv) !== undefined,
          absentStatuses: [404, 202],
        },
      );
      const key = agreed(status);
      if (key !== undefined) {
        const at = status.answers.find((a) => keyOf(a.value) === key)!;
        block = { indepHash: at.value.hash, height: at.value.height };
        for (const a of status.answers) {
          if (keyOf(a.value) !== key) {
            fault(
              a.node,
              id,
              `places it in block ${a.value.hash} at height ${a.value.height}, not ${at.value.hash} at ${at.value.height}`,
            );
          }
        }
        for (const f of status.faults) fault(f.node, id, f.reason);
      } else {
        // A 404 for the status is a denial only from a machine that served
        // this root's header: one without the transaction at all just
        // doesn't have it. Machines not yet known to serve it are asked.
        const servedBy = new Set(headers.answers.map((a) => a.machine));
        const deniers = new Set(status.absent.map((a) => a.machine));
        if ([...deniers].some((m) => !servedBy.has(m))) {
          const all = await pool.survey<Header>(`/tx/${id}`, judgeHeader);
          for (const a of all.answers) servedBy.add(a.machine);
        }
        const absentMachines = [...deniers].filter((m) =>
          servedBy.has(m),
        ).length;
        if (absentMachines >= 2 && status.unheard.length === 0) {
          // In no block, as two machines say and no node unheard: a claim
          // otherwise is its node's fault.
          for (const a of status.answers) {
            fault(
              a.node,
              id,
              `places it in block ${a.value.hash}, which ${absentMachines} machines deny`,
            );
          }
          throw new RootUnboundError(
            `${id} is not mined: ${absentMachines} machines that serve its header say it is in no block`,
          );
        }
        throw new NodesRefusedError(
          `${id}: fewer than ${minAgreement} machines place it in one block, and fewer than two that serve its header say it is in none with every node heard (${status.answers.length} placed it, ${absentMachines} denied, ${deniers.size - absentMachines} without it, ${status.unheard.length} unheard)`,
          status.absent.length,
          status.busy.length,
          status.faults.length,
        );
      }
    }

    // Its place in the weave: an answer whose size isn't the signed one is
    // its node's fault; two machines agreeing settle it.
    type Placement = { offset: bigint };
    const agreedOffset = (sv: Survey<Placement>) => {
      const by = new Map<string, Set<string>>();
      for (const a of sv.answers) {
        const k = String(a.value.offset);
        by.set(k, (by.get(k) ?? new Set()).add(a.machine));
      }
      return [...by.entries()].sort((x, y) => y[1].size - x[1].size);
    };
    const otherSize = new Set<string>();
    const offsets = await pool.survey<Placement>(
      `/tx/${id}/offset`,
      (body, node) => {
        const { offset, size } = (body ?? {}) as {
          offset?: unknown;
          size?: unknown;
        };
        // A body that isn't an offset is its node's fault, and says
        // nothing of the root; only a size that parses and differs does.
        const offsetText = typeof offset === 'number' ? String(offset) : offset;
        const sizeText = typeof size === 'number' ? String(size) : size;
        if (
          typeof offsetText !== 'string' ||
          !/^\d+$/.test(offsetText) ||
          typeof sizeText !== 'string' ||
          !/^\d+$/.test(sizeText)
        ) {
          throw new Error('not an offset answer');
        }
        if (Number(sizeText) !== dataSize) {
          otherSize.add(pool.addressOf(node));
          throw new Error(
            `the weave holds ${sizeText} bytes, its header signs ${dataSize}`,
          );
        }
        return { offset: BigInt(offsetText) };
      },
      { enough: (sv) => (agreedOffset(sv)[0]?.[1].size ?? 0) >= 2 },
    );
    const ranked = agreedOffset(offsets);
    const top = ranked[0];
    // Two machines agreeing, or the only one that answered at all: a wrong
    // offset can't pass wrong bytes, its chunks would not prove.
    const settled =
      top !== undefined &&
      (top[1].size >= 2 ||
        (ranked.length === 1 && definiteMachines(offsets) >= 1))
        ? BigInt(top[0])
        : undefined;
    if (settled === undefined) {
      for (const f of offsets.faults) fault(f.node, id, f.reason);
      if (ranked.length > 1) {
        throw new NodesRefusedError(
          `${id}: nodes place it at ${ranked.length} offsets in the weave`,
          offsets.absent.length,
          offsets.busy.length,
          offsets.faults.length,
        );
      }
      // The root is bound and mined: a node without its place in the weave
      // holds no data for it, which says nothing against the root. Only two
      // machines giving another size refute it.
      if (otherSize.size >= 2) {
        throw new RootUnboundError(
          `${id}: two or more machines give its place in the weave another size than its header signs`,
        );
      }
      throw new NodesRefusedError(
        `${id}: no node gave its place in the weave (${offsets.absent.length} said 404, ${offsets.unheard.length} unheard, ${otherSize.size} gave another size, ${offsets.faults.length - otherSize.size} malformed): unchecked`,
        offsets.absent.length,
        offsets.busy.length,
        offsets.faults.length,
      );
    }
    for (const f of offsets.faults) fault(f.node, id, f.reason);
    for (const a of offsets.answers) {
      if (a.value.offset !== settled)
        fault(
          a.node,
          id,
          `places it at offset ${a.value.offset}, not ${settled}`,
        );
    }

    if (binding === 'signature') counts.bySignature += 1;
    else counts.byAgreement += 1;
    if (block !== undefined) counts.minedByNodes += 1;
    return {
      id,
      dataRoot,
      dataSize,
      start: settled - BigInt(dataSize) + 1n,
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
    // A node whose chunk doesn't prove is passed over; once another proves
    // it, the first was that node's fault.
    const refused: Array<{ node: string; what: string }> = [];
    const proven = await pool.chunk(
      absolute,
      async (served: NodeChunk) => {
        try {
          return await prove(served);
        } catch (error) {
          refused.push({
            node: served.node,
            what: `chunk at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
          });
          throw error;
        }
      },
      lastNode.get(root.id),
    );
    for (const r of refused) fault(r.node, root.id, r.what);
    return proven;

    async function prove(served: NodeChunk) {
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
    }
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
    nodeFaults: () => [...faults],
    nodeFaultCount: () => faultCount,
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
