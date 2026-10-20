/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Arweave nodes asked directly, for checks that must not take a gateway's
 * word: a transaction's header, where its data sits in the weave, and the
 * chunks of that data with their proofs. Nothing here trusts an answer; the
 * callers check every one (see `root-source.ts`).
 *
 * The pool is asked in order, each node once per request, until one
 * answers. "Reachable" (it gave any HTTP answer) is kept apart from
 * "answered" (it gave this answer), so a run that could not reach the
 * network is never mistaken for one that found the data missing.
 */
import { lookup } from 'node:dns/promises';

/**
 * The nodes asked when none are given: the `tip` and `data` nodes ar-io-node
 * reads chunks from by default (`PREFERRED_CHUNK_GET_NODE_URLS`). `data`
 * nodes hold partitions of the weave, so most answer 404 for most offsets.
 */
export const DEFAULT_ARWEAVE_NODE_URLS = [
  ...[1, 2, 3, 4].map((n) => `http://tip-${n}.arweave.xyz:1984`),
  ...Array.from(
    { length: 17 },
    (_, i) => `http://data-${i + 1}.arweave.xyz:1984`,
  ),
];

/** What a node says about a transaction's place in the weave. */
export interface TxOffset {
  /** The absolute weave offset of the transaction's last byte. */
  offset: bigint;
  size: number;
}

/** A chunk as a node serves it, decoded. */
export interface NodeChunk {
  chunk: Buffer;
  dataPath: Buffer;
  /** The node that served it, for reports. */
  node: string;
}

/** No reachable node had it (each answered 404, or nothing usable). */
export class NotOnNodesError extends Error {
  /** Read as a 404 by checks that sort a 404 from other failures. */
  readonly response = { status: 404 };
  constructor(
    message: string,
    readonly asked: number,
  ) {
    super(message);
  }
}

/** No node could be reached at all: the network, not the data. */
export class NodesUnreachableError extends Error {}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export interface ArweaveNodePoolOptions {
  urls?: string[];
  timeoutMs?: number;
  /** Injected in tests; the global `fetch` otherwise. */
  fetch?: FetchLike;
  /**
   * Drop nodes that resolve to an address already in the pool (several
   * `data-N` names are the same machines as listed IPs), so agreement among
   * nodes is agreement among machines. Off in tests.
   */
  dedupeByAddress?: boolean;
}

const b64urlDecode = (value: unknown, what: string): Buffer => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`no ${what} in the node's answer`);
  }
  return Buffer.from(value, 'base64url');
};

/**
 * A pool of Arweave nodes, asked directly over HTTP.
 */
export class ArweaveNodePool {
  readonly urls: string[];
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly dedupe: boolean;
  private ready: Promise<void> | undefined;
  /** Nodes that gave any HTTP answer during this run. */
  readonly reachable = new Set<string>();

  constructor({
    urls = DEFAULT_ARWEAVE_NODE_URLS,
    timeoutMs = 20_000,
    fetch: fetchFn = fetch as unknown as FetchLike,
    dedupeByAddress = true,
  }: ArweaveNodePoolOptions = {}) {
    this.urls = [
      ...new Set(
        urls.map((u) => u.trim().replace(/\/+$/, '')).filter((u) => u !== ''),
      ),
    ];
    if (this.urls.length === 0) throw new Error('No Arweave node URLs given');
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.dedupe = dedupeByAddress;
  }

  /** Resolves the pool once, dropping nodes that share an address. */
  private async prepare(): Promise<void> {
    if (!this.dedupe) return;
    this.ready ??= (async () => {
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const url of this.urls) {
        let key = url;
        try {
          const u = new URL(url);
          const { address } = await lookup(u.hostname);
          key = `${address}:${u.port}`;
        } catch {
          // Unresolvable now: keep it, it simply won't answer.
        }
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(url);
      }
      this.urls.splice(0, this.urls.length, ...kept);
    })();
    await this.ready;
  }

  /**
   * Asks each node in turn until one returns 200 with a body `parse`
   * accepts. 404s and unusable bodies move on to the next node.
   *
   * @throws NotOnNodesError when every reachable node lacked it.
   * @throws NodesUnreachableError when no node answered at all.
   */
  async ask<T>(
    path: string,
    parse: (body: unknown, node: string) => T | Promise<T>,
    headers?: Record<string, string>,
  ): Promise<T> {
    await this.prepare();
    let answered = 0;
    let lastProblem = '';
    for (const node of this.urls) {
      let response;
      try {
        response = await this.fetchFn(`${node}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(headers !== undefined ? { headers } : {}),
        });
      } catch (error) {
        lastProblem = `${node}: ${(error as Error).message}`;
        continue;
      }
      this.reachable.add(node);
      answered += 1;
      if (!response.ok) {
        lastProblem = `${node}: HTTP ${response.status}`;
        continue;
      }
      try {
        return await parse(await response.json(), node);
      } catch (error) {
        lastProblem = `${node}: ${(error as Error).message}`;
      }
    }
    if (answered === 0) {
      throw new NodesUnreachableError(
        `no Arweave node answered ${path} (${lastProblem})`,
      );
    }
    throw new NotOnNodesError(
      `none of ${answered} nodes had ${path} (last: ${lastProblem})`,
      answered,
    );
  }

  /** The transaction's header, raw, as the node serves it. */
  txHeader(txId: string): Promise<Record<string, unknown>> {
    return this.ask(`/tx/${txId}`, (body) => {
      if (body === null || typeof body !== 'object') {
        throw new Error('not a transaction header');
      }
      return body as Record<string, unknown>;
    });
  }

  /** Every reachable node's header for a transaction, for agreement checks. */
  async txHeaders(
    txId: string,
    max: number,
  ): Promise<Array<{ node: string; header: Record<string, unknown> }>> {
    await this.prepare();
    const found: Array<{ node: string; header: Record<string, unknown> }> = [];
    for (const node of this.urls) {
      if (found.length >= max) break;
      try {
        const response = await this.fetchFn(`${node}/tx/${txId}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this.reachable.add(node);
        if (!response.ok) continue;
        const body = await response.json();
        if (body !== null && typeof body === 'object') {
          found.push({ node, header: body as Record<string, unknown> });
        }
      } catch {
        // Not reachable or no usable answer: ask the next.
      }
    }
    return found;
  }

  txOffset(txId: string): Promise<TxOffset> {
    return this.ask(`/tx/${txId}/offset`, (body) => {
      const { offset, size } = (body ?? {}) as {
        offset?: unknown;
        size?: unknown;
      };
      if (typeof offset !== 'string' && typeof offset !== 'number') {
        throw new Error('no offset in the answer');
      }
      const parsedSize = Number(size);
      if (!Number.isSafeInteger(parsedSize) || parsedSize <= 0) {
        throw new Error('no size in the answer');
      }
      return { offset: BigInt(offset), size: parsedSize };
    });
  }

  /**
   * The chunk holding the absolute weave byte `absoluteOffset`, unpacked.
   * `accept` checks it (its proof, say); a node whose chunk it rejects is
   * passed over for the next, so one bad node doesn't fail the read.
   */
  chunk<T = NodeChunk>(
    absoluteOffset: bigint,
    accept: (chunk: NodeChunk) => T | Promise<T> = (c) => c as unknown as T,
  ): Promise<T> {
    return this.ask(
      `/chunk/${absoluteOffset}`,
      (body, node) => {
        const {
          chunk,
          data_path: dataPath,
          packing,
        } = (body ?? {}) as {
          chunk?: unknown;
          data_path?: unknown;
          packing?: unknown;
        };
        if (packing !== undefined && packing !== 'unpacked') {
          throw new Error(`a ${String(packing)} chunk, not unpacked`);
        }
        return accept({
          chunk: b64urlDecode(chunk, 'chunk'),
          dataPath: b64urlDecode(dataPath, 'data_path'),
          node,
        });
      },
      { 'x-packing': 'unpacked' },
    );
  }
}
