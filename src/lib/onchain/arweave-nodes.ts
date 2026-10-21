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
import { isIP } from 'node:net';

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

/** What each node of a pool said to one request ({@link ArweaveNodePool.survey}). */
export interface Survey<T> {
  answers: Array<{ node: string; machine: string; value: T }>;
  faults: Array<{ node: string; machine: string; reason: string }>;
  absent: Array<{ node: string; machine: string }>;
  /** Nodes that timed out or answered 429, 5xx or the like. */
  busy: string[];
  /**
   * Nodes that said nothing definite even when asked again (busy, or their
   * connection failed): a verdict of absence needs none.
   */
  unheard: string[];
}

/** Machines that said something definite in a survey. */
export function definiteMachines<T>(survey: Survey<T>): number {
  return new Set([
    ...survey.answers.map((a) => a.machine),
    ...survey.faults.map((f) => f.machine),
    ...survey.absent.map((a) => a.machine),
  ]).size;
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
  /** Injected in tests: every address a name resolves to. */
  lookupAll?: (host: string) => Promise<string[]>;
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
  private readying: Promise<void> | undefined;
  private readonly lookupAll: (host: string) => Promise<string[]>;
  /** Nodes whose name could not be resolved: each counted a machine of its own. */
  readonly unresolved: string[] = [];
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
    lookupAll = async (host: string) =>
      (await lookup(host, { all: true })).map((a) => a.address),
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
    this.lookupAll = lookupAll;
  }

  /**
   * Resolves the pool once, each name to all its addresses (A and AAAA)
   * with a timeout, and keeps one node per machine. Two nodes are one
   * machine when their address sets meet (ports aside); every loopback
   * address and `localhost` are one machine. A name that can't be resolved
   * is a machine of its own, and is listed in `unresolved`. Without dedupe
   * (tests), a node's host name is its machine.
   */
  private async prepare(): Promise<void> {
    const hostOf = (url: string) => {
      try {
        return new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');
      } catch {
        return url;
      }
    };
    if (!this.dedupe) {
      for (const url of this.urls) this.addresses.set(url, hostOf(url));
      return;
    }
    this.readying ??= (async () => {
      const loopback = (address: string) => {
        const a = address.toLowerCase();
        // IPv4 written in IPv6 (::ffff:a.b.c.d, or its hex form
        // ::ffff:7f00:1) is that IPv4 address.
        const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
        const v4 =
          mapped !== null
            ? [
                parseInt(mapped[1], 16) >> 8,
                parseInt(mapped[1], 16) & 255,
                parseInt(mapped[2], 16) >> 8,
                parseInt(mapped[2], 16) & 255,
              ].join('.')
            : a.startsWith('::ffff:') && isIP(a.slice(7)) === 4
              ? a.slice(7)
              : a;
        return v4 === '::1' || v4.startsWith('127.') ? 'loopback' : v4;
      };
      const resolved: Array<{ url: string; set: Set<string> }> = [];
      for (const url of this.urls) {
        const host = hostOf(url);
        let found: string[] | undefined;
        if (isIP(host) !== 0) {
          found = [host];
        } else {
          let timer: NodeJS.Timeout | undefined;
          try {
            found = await Promise.race([
              this.lookupAll(host),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('DNS lookup timed out')),
                  this.timeoutMs,
                );
              }),
            ]);
          } catch {
            found = undefined;
          } finally {
            clearTimeout(timer);
          }
        }
        if (found === undefined || found.length === 0) {
          this.unresolved.push(url);
          resolved.push({ url, set: new Set([`unresolved:${host}`]) });
        } else {
          resolved.push({ url, set: new Set(found.map(loopback)) });
        }
      }
      // Union-find over shared addresses: nodes joined by any chain of
      // shared addresses are one machine, whatever order they came in.
      const parent = resolved.map((_, i) => i);
      const find = (i: number): number => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      const owner = new Map<string, number>();
      resolved.forEach((node, i) => {
        for (const address of node.set) {
          const j = owner.get(address);
          if (j === undefined) owner.set(address, i);
          else parent[find(i)] = find(j);
        }
      });
      const groups = new Map<number, number[]>();
      resolved.forEach((_, i) => {
        const r = find(i);
        groups.set(r, [...(groups.get(r) ?? []), i]);
      });
      const kept: string[] = [];
      for (const members of groups.values()) {
        const first = Math.min(...members);
        const addresses = members.flatMap((m) => [...resolved[m].set]).sort();
        this.addresses.set(resolved[first].url, addresses[0]);
        kept.push(resolved[first].url);
      }
      const order = new Map(resolved.map((r, i) => [r.url, i]));
      kept.sort((x, y) => order.get(x)! - order.get(y)!);
      this.urls.splice(0, this.urls.length, ...kept);
    })();
    await this.readying;
  }

  /** Resolves the pool's machines, as every request does first. */
  async ready(): Promise<void> {
    await this.prepare();
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
  private order(prefer?: string): {
    nodes: string[];
    resting: number;
    restingBusy: string[];
    restingAll: string[];
  } {
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
    if (awake.length === 0) {
      return { nodes: ordered, resting: 0, restingBusy: [], restingAll: [] };
    }
    const restingBusy = ordered.filter(
      (u) => asleep(u) && this.resting.get(u)!.busy,
    );
    return {
      nodes: awake,
      resting: restingBusy.length,
      restingBusy,
      restingAll: ordered.filter(asleep),
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
   * With `settle`, when nothing usable came back and some nodes said 404
   * while others were busy or resting after a timeout, the busy ones are
   * asked once more, rest or not, before any verdict of absence. Any still
   * busy count as busy: the 404s alone never stand for the data while a
   * node that may hold it went unheard.
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
    settle = false,
  ): Promise<T> {
    await this.prepare();
    const { nodes: order, restingBusy, restingAll } = this.order(prefer);
    // Nodes whose connection failed: silent, and asked again by `settle`.
    const unreachable: string[] = [];
    let notFound = 0;
    let refused = 0;
    // A resting node may well hold it: it counts as busy, so its silence is
    // never read as the data missing (unless `settle` asks it again).
    const busyNodes: string[] = [...restingBusy];
    let lastProblem =
      restingBusy.length > 0 ? `${restingBusy.length} nodes resting` : '';
    const found: { value?: T; done: boolean } = { done: false };
    const tryNode = async (node: string) => {
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
        if (name === 'TimeoutError' || name === 'AbortError') {
          busyNodes.push(node);
        } else {
          unreachable.push(node);
        }
        lastProblem = `${node}: ${(error as Error).message}`;
        this.rest(node, error);
        return;
      }
      this.reachable.add(node);
      if (!response.ok) {
        if (response.status === 404) notFound += 1;
        else busyNodes.push(node);
        lastProblem = `${node}: HTTP ${response.status}`;
        return;
      }
      try {
        found.value = await parse(await response.json(), node);
        found.done = true;
      } catch (error) {
        if (error instanceof NodeLacksError) notFound += 1;
        else refused += 1;
        lastProblem = `${node}: ${(error as Error).message}`;
      }
    };
    for (const node of order) {
      await tryNode(node);
      if (found.done) return found.value as T;
    }
    // Before any verdict of absence, every silent node (busy, its
    // connection failed, or resting) is asked once more; any still silent
    // counts as busy, so the 404s never stand for the data.
    const silent = [...new Set([...busyNodes, ...unreachable, ...restingAll])];
    if (settle && notFound > 0 && refused === 0 && silent.length > 0) {
      busyNodes.length = 0;
      unreachable.length = 0;
      for (const node of silent) {
        await tryNode(node);
        if (found.done) return found.value as T;
      }
      busyNodes.push(...unreachable);
    }
    const busy = busyNodes.length;
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

  /**
   * Asks nodes one by one, each once, recording what each said, until
   * `enough` says the answers so far settle the question; for checks that
   * must tell a fault of one node from a fact about the data.
   *
   * Each node's answer is sorted: `answers` (200, and `judge` accepted it),
   * `faults` (200, and `judge` refused it, with why), `absent` (a status in
   * `absentStatuses`, 404 by default), or `busy` (timed out, 429, 5xx,
   * anything else). A node that couldn't be reached says nothing. Resting
   * nodes are not asked at first; unless `enough` was reached, the busy and
   * resting ones are asked once more, so a slow node is heard before any
   * verdict. Those still busy stay in `busy`.
   */
  async survey<T>(
    path: string,
    judge: (body: unknown, node: string) => T | Promise<T>,
    {
      enough = () => false,
      absentStatuses = [404],
      headers,
    }: {
      enough?: (survey: Survey<T>) => boolean;
      absentStatuses?: number[];
      headers?: Record<string, string>;
    } = {},
  ): Promise<Survey<T>> {
    await this.prepare();
    const { nodes, restingAll } = this.order();
    const survey: Survey<T> = {
      answers: [],
      faults: [],
      absent: [],
      busy: [],
      unheard: [],
    };
    const unreachable: string[] = [];
    const machine = (node: string) => this.addressOf(node);
    const askOne = async (node: string) => {
      let response;
      try {
        response = await this.fetchFn(`${node}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(headers !== undefined ? { headers } : {}),
        });
      } catch (error) {
        const name = (error as { name?: unknown }).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          survey.busy.push(node);
        } else {
          unreachable.push(node);
        }
        this.rest(node, error);
        return;
      }
      this.reachable.add(node);
      if (absentStatuses.includes(response.status)) {
        survey.absent.push({ node, machine: machine(node) });
        return;
      }
      if (!response.ok) {
        survey.busy.push(node);
        return;
      }
      try {
        const value = await judge(await response.json(), node);
        survey.answers.push({ node, machine: machine(node), value });
      } catch (error) {
        if (error instanceof NodeLacksError) {
          survey.absent.push({ node, machine: machine(node) });
        } else {
          survey.faults.push({
            node,
            machine: machine(node),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    for (const node of nodes) {
      await askOne(node);
      if (enough(survey)) return survey;
    }
    // Before any verdict of absence, every node not yet heard (busy, its
    // connection failed, or resting) is asked once more. Those still
    // silent are `unheard`: any of them may hold what the others lack.
    const silent = [
      ...new Set([...survey.busy, ...unreachable, ...restingAll]),
    ];
    survey.busy = [];
    unreachable.length = 0;
    for (const node of silent) {
      await askOne(node);
      if (enough(survey)) break;
    }
    survey.unheard = [...new Set([...survey.busy, ...unreachable])];
    return survey;
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
      true,
    );
  }
}
