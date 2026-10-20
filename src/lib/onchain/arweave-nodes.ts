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
 * The pool is asked one node after another, each once per request, until
 * one answers; each request starts at the next node in turn, so no one node
 * answers everything. "Reachable" (it gave any HTTP answer) is kept apart
 * from "answered" (it gave this answer), so a run that could not reach the
 * network is never mistaken for one that found the data missing. A node
 * that times out or refuses a connection is rested for a while (a circuit
 * breaker) and not asked; while it rests it counts as it did when it was
 * rested: one that timed out as busy (it may hold the data), one that could
 * not be reached as saying nothing.
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

/**
 * An `--arweave-nodes` value: `default` for {@link DEFAULT_ARWEAVE_NODE_URLS},
 * else comma-separated URLs, trimmed, without trailing slashes,
 * de-duplicated.
 *
 * @throws Error when it names no URL.
 */
export function parseNodeUrls(value: string): string[] {
  if (value.trim() === 'default') return DEFAULT_ARWEAVE_NODE_URLS;
  const urls = [
    ...new Set(
      value
        .split(',')
        .map((u) => u.trim().replace(/\/+$/, ''))
        .filter((u) => u.length > 0),
    ),
  ];
  if (urls.length === 0) throw new Error('--arweave-nodes lists no URL');
  return urls;
}

/** What a node says about a transaction's place in the weave. */
export interface TxOffset {
  /** The absolute weave offset of the transaction's last byte. */
  offset: bigint;
  size: number;
}

/** What nodes say of a transaction's block (`/tx/{id}/status`). */
export interface TxStatus {
  blockIndepHash: string;
  blockHeight: number;
  /** The fewest confirmations any agreeing node reported. */
  confirmations: number;
  /** The nodes that agreed, one per address. */
  nodes: string[];
}

/** A chunk as a node serves it, decoded. */
export interface NodeChunk {
  chunk: Buffer;
  dataPath: Buffer;
  /** The node that served it, for reports. */
  node: string;
}

/**
 * Every node that answered said 404 (or had it only packed): the data is not
 * on the network as far as these nodes know. `wholeRoot` is set when what is
 * missing is the transaction itself (its header or its place in the weave),
 * not one chunk of it.
 */
export class NotOnNodesError extends Error {
  /** Read as a 404 by checks that sort a 404 from other failures. */
  readonly response = { status: 404 };
  constructor(
    message: string,
    readonly asked: number,
    readonly wholeRoot: boolean,
  ) {
    super(message);
  }
}

/**
 * Nodes answered, but none usefully, and not every one said 404: some were
 * busy or failing (429, 5xx), or served an answer that was refused (`refused`:
 * a chunk whose proof doesn't validate, a header that isn't one). Never read
 * as missing data: a busy node may hold it, and an unprovable chunk is a
 * fault of the node, not an absence.
 */
export class NodesRefusedError extends Error {
  constructor(
    message: string,
    readonly notFound: number,
    readonly busy: number,
    readonly refused: number,
  ) {
    super(message);
  }
}

/** No node could be reached at all: the network, not the data. */
export class NodesUnreachableError extends Error {}

/**
 * Thrown by a parse to say the node lacks the thing in a usable form (a
 * packed chunk): counted as its 404, not as a refused answer.
 */
export class NodeLacksError extends Error {}

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
   * nodes is agreement among machines. Off in tests, where each node's
   * host:port stands for its address.
   */
  dedupeByAddress?: boolean;
  /** How long a node that timed out or refused a connection rests (default 5 minutes). */
  restMs?: number;
  /** Injected in tests; the clock the breaker reads. */
  now?: () => number;
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
  private readonly restMs: number;
  private readonly now: () => number;
  private ready: Promise<void> | undefined;
  /** Each node's address (resolved IP and port; host and port unresolved). */
  private readonly addresses = new Map<string, string>();
  /**
   * Nodes resting after a timeout (`busy`) or a refused connection, until
   * when.
   */
  private readonly resting = new Map<
    string,
    { until: number; busy: boolean }
  >();
  /** Where the next request starts in the pool. */
  private turn = 0;
  /** Nodes that gave any HTTP answer during this run. */
  readonly reachable = new Set<string>();

  constructor({
    urls = DEFAULT_ARWEAVE_NODE_URLS,
    timeoutMs = 20_000,
    fetch: fetchFn = fetch as unknown as FetchLike,
    dedupeByAddress = true,
    restMs = 5 * 60_000,
    now = Date.now,
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
    this.restMs = restMs;
    this.now = now;
  }

  /**
   * Resolves the pool once, each name with a timeout, dropping nodes that
   * share an address. Without dedupe (tests), a node's host and port is its
   * address.
   */
  private async prepare(): Promise<void> {
    const hostKey = (url: string) => {
      try {
        const u = new URL(url);
        return `${u.hostname}:${u.port}`;
      } catch {
        return url;
      }
    };
    if (!this.dedupe) {
      for (const url of this.urls) this.addresses.set(url, hostKey(url));
      return;
    }
    this.ready ??= (async () => {
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const url of this.urls) {
        // Unresolved names keep a key of their own: they are never taken
        // for another node's machine, and simply won't answer.
        let key = `unresolved:${hostKey(url)}`;
        let timer: NodeJS.Timeout | undefined;
        try {
          const u = new URL(url);
          const { address } = await Promise.race([
            lookup(u.hostname),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('DNS lookup timed out')),
                this.timeoutMs,
              );
            }),
          ]);
          key = `${address}:${u.port}`;
        } catch {
          // Unresolvable now: keep it, it simply won't answer.
        } finally {
          clearTimeout(timer);
        }
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(url);
        this.addresses.set(url, key);
      }
      this.urls.splice(0, this.urls.length, ...kept);
    })();
    await this.ready;
  }

  /** A node's machine, for counting agreement among machines, not names. */
  addressOf(node: string): string {
    return this.addresses.get(node) ?? node;
  }

  /**
   * The pool in the order to ask it: `prefer` first, then from the next
   * node in turn. Resting nodes are left out (`resting` counts those that
   * rest after a timeout, as busy), unless every node rests, when all are
   * asked.
   */
  private order(prefer?: string): { nodes: string[]; resting: number } {
    const start = this.turn % this.urls.length;
    this.turn += 1;
    const rotated = [...this.urls.slice(start), ...this.urls.slice(0, start)];
    const ordered =
      prefer !== undefined && this.urls.includes(prefer)
        ? [prefer, ...rotated.filter((u) => u !== prefer)]
        : rotated;
    const now = this.now();
    const asleep = (u: string) => (this.resting.get(u)?.until ?? 0) > now;
    const awake = ordered.filter((u) => !asleep(u));
    if (awake.length === 0) return { nodes: ordered, resting: 0 };
    return {
      nodes: awake,
      resting: ordered.filter((u) => asleep(u) && this.resting.get(u)!.busy)
        .length,
    };
  }

  /** Rests a node that timed out (busy) or could not be reached. */
  private rest(node: string, error: unknown): void {
    const name = (error as { name?: unknown }).name;
    this.resting.set(node, {
      until: this.now() + this.restMs,
      busy: name === 'TimeoutError' || name === 'AbortError',
    });
  }

  /**
   * Asks each node in turn (`prefer` first, when given: the node that last
   * served this root usually holds the next chunk) until one returns 200
   * with a body `parse` accepts. Any other answer moves on to the next node.
   *
   * @throws NotOnNodesError when every node that answered said 404.
   * @throws NodesRefusedError when some answered otherwise (busy, failing,
   *   or with an answer `parse` refused).
   * @throws NodesUnreachableError when no node answered at all.
   */
  async ask<T>(
    path: string,
    parse: (body: unknown, node: string) => T | Promise<T>,
    headers?: Record<string, string>,
    prefer?: string,
  ): Promise<T> {
    await this.prepare();
    const { nodes: order, resting } = this.order(prefer);
    let notFound = 0;
    // A resting node may well hold it: it counts as busy, so its silence is
    // never read as the data missing.
    let busy = resting;
    let refused = 0;
    let lastProblem = resting > 0 ? `${resting} nodes resting` : '';
    for (const node of order) {
      let response;
      try {
        response = await this.fetchFn(`${node}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(headers !== undefined ? { headers } : {}),
        });
      } catch (error) {
        // A node that ran out of time may well hold it: slow, not absent.
        // Only a node that could not be reached at all says nothing.
        const name = (error as { name?: unknown }).name;
        if (name === 'TimeoutError' || name === 'AbortError') busy += 1;
        lastProblem = `${node}: ${(error as Error).message}`;
        this.rest(node, error);
        continue;
      }
      this.reachable.add(node);
      if (!response.ok) {
        if (response.status === 404) notFound += 1;
        else busy += 1;
        lastProblem = `${node}: HTTP ${response.status}`;
        continue;
      }
      try {
        return await parse(await response.json(), node);
      } catch (error) {
        if (error instanceof NodeLacksError) notFound += 1;
        else refused += 1;
        lastProblem = `${node}: ${(error as Error).message}`;
      }
    }
    const answered = notFound + busy + refused;
    if (answered === 0) {
      throw new NodesUnreachableError(
        `no Arweave node answered ${path} (${lastProblem})`,
      );
    }
    if (notFound === answered) {
      throw new NotOnNodesError(
        `none of ${answered} nodes had ${path} (last: ${lastProblem})`,
        answered,
        !path.startsWith('/chunk/'),
      );
    }
    throw new NodesRefusedError(
      `no usable answer for ${path}: ${notFound} said 404, ${busy} busy or failing, ${refused} refused (last: ${lastProblem})`,
      notFound,
      busy,
      refused,
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

  /**
   * Headers for a transaction from nodes on distinct machines, none of them
   * on `exclude`'s machines, for agreement checks: at most `max`, each
   * passing `accept`. A node whose header `accept` refuses is passed over.
   */
  async txHeaders(
    txId: string,
    max: number,
    accept: (header: Record<string, unknown>) => boolean = () => true,
    exclude: string[] = [],
  ): Promise<Array<{ node: string; header: Record<string, unknown> }>> {
    await this.prepare();
    const found: Array<{ node: string; header: Record<string, unknown> }> = [];
    const machines = new Set(exclude.map((n) => this.addressOf(n)));
    for (const node of this.order().nodes) {
      if (found.length >= max) break;
      if (machines.has(this.addressOf(node))) continue;
      try {
        const response = await this.fetchFn(`${node}/tx/${txId}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this.reachable.add(node);
        if (!response.ok) continue;
        const body = await response.json();
        if (
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          accept(body as Record<string, unknown>)
        ) {
          machines.add(this.addressOf(node));
          found.push({ node, header: body as Record<string, unknown> });
        }
      } catch (error) {
        const name = (error as { name?: unknown }).name;
        if (name !== 'SyntaxError') this.rest(node, error);
        // Not reachable or no usable answer: ask the next.
      }
    }
    return found;
  }

  /**
   * The block holding a transaction, as at least `min` nodes on distinct
   * machines say it (`/tx/{id}/status`, with at least one confirmation).
   * Every node that names a block must name the same one.
   *
   * @throws NotOnNodesError when every node that answered said it is in no
   *   block (404, or pending): the transaction is not on chain.
   * @throws NodesRefusedError when fewer than `min` machines say so, or
   *   nodes name different blocks (a fork, or a node lying).
   * @throws NodesUnreachableError when no node answered.
   */
  async txStatus(txId: string, min: number): Promise<TxStatus> {
    await this.prepare();
    const agreeing = new Map<string, string>(); // machine -> node
    const blocks = new Set<string>();
    let height = -1;
    let confirmations = Number.POSITIVE_INFINITY;
    let notFound = 0;
    let busy = 0;
    let refused = 0;
    let answered = 0;
    const { nodes, resting } = this.order();
    busy += resting;
    for (const node of nodes) {
      if (agreeing.size >= min && blocks.size === 1) break;
      if (agreeing.has(this.addressOf(node))) continue;
      let response;
      try {
        response = await this.fetchFn(`${node}/tx/${txId}/status`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // As in `ask`: one that ran out of time may hold it; one that could
        // not be reached says nothing.
        const name = (error as { name?: unknown }).name;
        if (name === 'TimeoutError' || name === 'AbortError') busy += 1;
        this.rest(node, error);
        continue;
      }
      this.reachable.add(node);
      answered += 1;
      // 202 is "pending": not in a block, as good as absent for a root.
      if (response.status === 404 || response.status === 202) {
        notFound += 1;
        continue;
      }
      if (!response.ok) {
        busy += 1;
        continue;
      }
      try {
        const body = (await response.json()) as Record<string, unknown>;
        const hash = body?.block_indep_hash;
        const at = Number(body?.block_height);
        const confirmed = Number(body?.number_of_confirmations);
        if (
          typeof hash !== 'string' ||
          hash.length === 0 ||
          !Number.isSafeInteger(at) ||
          !Number.isSafeInteger(confirmed) ||
          confirmed < 1
        ) {
          throw new Error('not a block status');
        }
        blocks.add(hash);
        height = at;
        confirmations = Math.min(confirmations, confirmed);
        agreeing.set(this.addressOf(node), node);
      } catch {
        refused += 1;
      }
    }
    if (answered === 0 && agreeing.size === 0) {
      throw new NodesUnreachableError(
        `no Arweave node answered /tx/${txId}/status`,
      );
    }
    if (blocks.size > 1) {
      throw new NodesRefusedError(
        `nodes place ${txId} in ${blocks.size} different blocks`,
        notFound,
        busy,
        refused,
      );
    }
    if (agreeing.size === 0 && notFound > 0 && busy === 0 && refused === 0) {
      throw new NotOnNodesError(
        `none of ${notFound} nodes has ${txId} in a block`,
        notFound,
        true,
      );
    }
    if (agreeing.size < min) {
      throw new NodesRefusedError(
        `${agreeing.size} machines place ${txId} in a block, fewer than ${min} (${notFound} said it is in none, ${busy} busy or failing, ${refused} refused)`,
        notFound,
        busy,
        refused,
      );
    }
    return {
      blockIndepHash: [...blocks][0],
      blockHeight: height,
      confirmations,
      nodes: [...agreeing.values()],
    };
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
    prefer?: string,
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
          throw new NodeLacksError(`a ${String(packing)} chunk, not unpacked`);
        }
        return accept({
          chunk: b64urlDecode(chunk, 'chunk'),
          dataPath: b64urlDecode(dataPath, 'data_path'),
          node,
        });
      },
      { 'x-packing': 'unpacked' },
      prefer,
    );
  }
}
