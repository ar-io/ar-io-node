/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import { FieldNode, SelectionSetNode, print } from 'graphql';
import * as rax from 'retry-axios';
import winston from 'winston';

import * as config from '../config.js';
import { fromB64Url } from '../lib/encoding.js';
import {
  GqlBlock,
  GqlBlocksResult,
  GqlQueryable,
  GqlTransaction,
  GqlTransactionEdge,
  GqlTransactionsResult,
} from '../types.js';
import {
  decodeBlockGqlCursor,
  decodeTransactionGqlCursor,
} from './standalone-sqlite.js';

type SortOrder = 'HEIGHT_DESC' | 'HEIGHT_ASC';

type TagFilter = { name: string; values: string[] };

interface TransactionQueryArgs {
  pageSize: number;
  cursor?: string;
  sortOrder?: SortOrder;
  ids?: string[];
  recipients?: string[];
  owners?: string[];
  minHeight?: number;
  maxHeight?: number;
  bundledIn?: string[] | null;
  tags: TagFilter[];
  /**
   * Caller-provided GraphQL sub-selection for the Transaction node. When set,
   * it narrows what we ask upstreams for — avoiding both correctness bugs on
   * unrequested fields and unnecessary upstream cost. Parsed AST rather than a
   * string so the rendering logic (id injection for dedup, alias stripping,
   * fragment bail-out) stays in one place.
   */
  nodeSelection?: SelectionSetNode;
}

/**
 * Capability interface implemented by fan-out GqlQueryable instances that can
 * narrow upstream requests to the caller's selection set. Carries a nominal
 * brand so TypeScript's structural narrowing can distinguish it from plain
 * GqlQueryable — without the brand, `Exclude<GqlQueryable, ...>` collapses to
 * `never` in the else branch of the type guard.
 */
export interface SelectionAwareGqlQueryable {
  readonly __selectionAware: true;

  getGqlTransaction(args: {
    id: string;
    nodeSelection?: SelectionSetNode;
  }): Promise<GqlTransaction | null>;

  getGqlTransactions(
    args: TransactionQueryArgs,
  ): Promise<GqlTransactionsResult>;
}

export function isSelectionAwareGqlQueryable(
  db: GqlQueryable,
): db is GqlQueryable & SelectionAwareGqlQueryable {
  return (db as Partial<SelectionAwareGqlQueryable>).__selectionAware === true;
}

interface BlockQueryArgs {
  pageSize: number;
  cursor?: string;
  sortOrder?: SortOrder;
  ids?: string[];
  minHeight?: number;
  maxHeight?: number;
}

const DEFAULT_TRANSACTION_NODE_FIELDS = `
  id
  anchor
  signature
  signatureType
  recipient
  owner { address key }
  fee { winston }
  quantity { winston }
  data { size type }
  tags { name value }
  block { id timestamp height previous }
  bundledIn { id }
`;

/**
 * Render a GraphQL selection set as a plain fragment body (no surrounding
 * braces). Aliases are stripped and selections are deduped by canonical name,
 * because the mapper reads canonical keys like `node.anchor`. Non-field
 * selections (fragment spreads, inline fragments) cause a bail-out — the caller
 * falls back to the default field set.
 */
function renderSelectionSet(
  selectionSet: SelectionSetNode,
): string | undefined {
  const byName = new Map<string, string>();
  for (const sel of selectionSet.selections) {
    if (sel.kind !== 'Field') return undefined;
    const field = sel as FieldNode;
    const name = field.name.value;
    if (byName.has(name)) continue;
    if (field.selectionSet !== undefined) {
      const nested = renderSelectionSet(field.selectionSet);
      if (nested === undefined) {
        byName.set(name, print(field));
        continue;
      }
      byName.set(name, `${name} { ${nested} }`);
    } else {
      byName.set(name, name);
    }
  }
  return Array.from(byName.values()).join(' ');
}

/**
 * Render the Transaction-node sub-selection, ensuring `id` is present at the
 * top level so mergeEdges can deduplicate across sources. `id` is only injected
 * at this outer level — nested object types like Owner have no `id` field.
 */
function renderTransactionNodeSelection(
  selectionSet: SelectionSetNode,
): string | undefined {
  const rendered = renderSelectionSet(selectionSet);
  if (rendered === undefined) return undefined;
  const hasTopLevelId = selectionSet.selections.some(
    (s) => s.kind === 'Field' && s.name.value === 'id' && s.alias === undefined,
  );
  return hasTopLevelId ? rendered : `id ${rendered}`.trim();
}

function resolveNodeFields(
  nodeSelection: SelectionSetNode | undefined,
): string {
  if (nodeSelection === undefined) return DEFAULT_TRANSACTION_NODE_FIELDS;
  const rendered = renderTransactionNodeSelection(nodeSelection);
  return rendered ?? DEFAULT_TRANSACTION_NODE_FIELDS;
}

// Exposed for tests. Do not use outside this module.
export const __test = {
  renderTransactionNodeSelection,
  resolveNodeFields,
  DEFAULT_TRANSACTION_NODE_FIELDS,
};

function buildTransactionsQuery(nodeFields: string): string {
  return `
    query TransactionsQuery(
      $ids: [ID!]
      $owners: [String!]
      $recipients: [String!]
      $tags: [TagFilter!]
      $bundledIn: [ID!]
      $block: BlockFilter
      $first: Int
      $after: String
      $sort: SortOrder
    ) {
      transactions(
        ids: $ids
        owners: $owners
        recipients: $recipients
        tags: $tags
        bundledIn: $bundledIn
        block: $block
        first: $first
        after: $after
        sort: $sort
      ) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {${nodeFields}}
        }
      }
    }
  `;
}

function buildTransactionQuery(nodeFields: string): string {
  return `
    query TransactionQuery($id: ID!) {
      transaction(id: $id) {${nodeFields}}
    }
  `;
}

const BLOCKS_QUERY = `
  query BlocksQuery(
    $ids: [ID!]
    $height: BlockFilter
    $first: Int
    $after: String
    $sort: SortOrder
  ) {
    blocks(
      ids: $ids
      height: $height
      first: $first
      after: $after
      sort: $sort
    ) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node { id timestamp height previous }
      }
    }
  }
`;

const BLOCK_QUERY = `
  query BlockQuery($id: String!) {
    block(id: $id) { id timestamp height previous }
  }
`;

/**
 * Adapts a single remote GraphQL endpoint to the GqlQueryable interface.
 */
class RemoteGqlQueryable implements GqlQueryable {
  constructor(
    private readonly url: string,
    private readonly axiosInstance: AxiosInstance,
  ) {}

  private async post<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.axiosInstance.post(`${this.url}/graphql`, {
      query,
      variables,
    });
    const body = response.data;
    if (body?.errors && Array.isArray(body.errors) && body.errors.length > 0) {
      throw new Error(
        `Upstream GraphQL errors from ${this.url}: ${JSON.stringify(body.errors)}`,
      );
    }
    if (!body?.data) {
      throw new Error(`Missing data in GraphQL response from ${this.url}`);
    }
    return body.data as T;
  }

  async getGqlTransaction({
    id,
    nodeSelection,
  }: {
    id: string;
    nodeSelection?: SelectionSetNode;
  }): Promise<GqlTransaction | null> {
    const nodeFields = resolveNodeFields(nodeSelection);
    const data = await this.post<{ transaction: RemoteTxNode | null }>(
      buildTransactionQuery(nodeFields),
      { id },
    );
    if (data.transaction == null) return null;
    // Single-record queries don't come with a cursor; decode from null.
    return mapRemoteTransaction(data.transaction, undefined);
  }

  async getGqlTransactions(
    args: TransactionQueryArgs,
  ): Promise<GqlTransactionsResult> {
    const variables = {
      ids: args.ids && args.ids.length > 0 ? args.ids : undefined,
      owners: args.owners && args.owners.length > 0 ? args.owners : undefined,
      recipients:
        args.recipients && args.recipients.length > 0
          ? args.recipients
          : undefined,
      tags: args.tags.length > 0 ? args.tags : undefined,
      bundledIn:
        args.bundledIn != null && args.bundledIn.length > 0
          ? args.bundledIn
          : undefined,
      block:
        args.minHeight !== undefined || args.maxHeight !== undefined
          ? {
              min:
                args.minHeight !== undefined && args.minHeight >= 0
                  ? args.minHeight
                  : undefined,
              max:
                args.maxHeight !== undefined && args.maxHeight >= 0
                  ? args.maxHeight
                  : undefined,
            }
          : undefined,
      first: args.pageSize,
      after: args.cursor,
      sort: args.sortOrder ?? 'HEIGHT_DESC',
    };

    const nodeFields = resolveNodeFields(args.nodeSelection);
    const data = await this.post<{
      transactions: {
        pageInfo: { hasNextPage: boolean };
        edges: { cursor: string; node: RemoteTxNode }[];
      };
    }>(buildTransactionsQuery(nodeFields), variables);

    return {
      pageInfo: { hasNextPage: data.transactions.pageInfo.hasNextPage },
      edges: data.transactions.edges.map((edge) => ({
        cursor: edge.cursor,
        node: mapRemoteTransaction(edge.node, edge.cursor),
      })),
    };
  }

  async getGqlBlock({ id }: { id: string }): Promise<GqlBlock | undefined> {
    const data = await this.post<{ block: GqlBlock | null }>(BLOCK_QUERY, {
      id,
    });
    return data.block ?? undefined;
  }

  async getGqlBlocks(args: BlockQueryArgs): Promise<GqlBlocksResult> {
    const variables = {
      ids: args.ids && args.ids.length > 0 ? args.ids : undefined,
      height:
        args.minHeight !== undefined || args.maxHeight !== undefined
          ? {
              min:
                args.minHeight !== undefined && args.minHeight >= 0
                  ? args.minHeight
                  : undefined,
              max:
                args.maxHeight !== undefined && args.maxHeight >= 0
                  ? args.maxHeight
                  : undefined,
            }
          : undefined,
      first: args.pageSize,
      after: args.cursor,
      sort: args.sortOrder ?? 'HEIGHT_DESC',
    };

    const data = await this.post<{
      blocks: {
        pageInfo: { hasNextPage: boolean };
        edges: { cursor: string; node: GqlBlock }[];
      };
    }>(BLOCKS_QUERY, variables);

    return {
      pageInfo: { hasNextPage: data.blocks.pageInfo.hasNextPage },
      edges: data.blocks.edges,
    };
  }
}

interface RemoteTxNode {
  id: string;
  // All other fields are optional: the caller may have pruned the sub-selection
  // via `nodeFieldSelection`, so the upstream response can omit them entirely.
  anchor?: string | null;
  signature?: string | null;
  signatureType?: number | null;
  recipient?: string;
  owner?: { address?: string; key?: string | null };
  fee?: { winston?: string };
  quantity?: { winston?: string };
  data?: { size?: string; type?: string | null };
  tags?: { name: string; value: string }[];
  block?: {
    id?: string;
    timestamp?: number;
    height?: number;
    previous?: string;
  } | null;
  bundledIn?: { id: string } | null;
}

/**
 * Map a GraphQL response node into our internal flat GqlTransaction shape.
 * The cursor (when available) carries fields not present in the response:
 * blockTransactionIndex, isDataItem, indexedAt.
 */
function mapRemoteTransaction(
  node: RemoteTxNode,
  cursor: string | undefined,
): GqlTransaction {
  const decoded = decodeTransactionGqlCursor(cursor);
  // Single-record transaction(id) responses have no cursor. Infer data-item
  // status from bundledIn so the shape matches cursor-derived results.
  const dataItemId =
    decoded.dataItemId ?? (node.bundledIn != null ? node.id : 'AA');
  const isDataItem = dataItemId !== 'AA';
  return {
    id: node.id,
    anchor: node.anchor ?? null,
    signature: node.signature ?? null,
    signatureType: node.signatureType ?? null,
    signatureSize: null,
    signatureOffset: null,
    recipient:
      node.recipient === '' || node.recipient === undefined
        ? null
        : node.recipient,
    ownerAddress: node.owner?.address ?? '',
    ownerKey: node.owner?.key ?? null,
    ownerSize: null,
    ownerOffset: null,
    fee: node.fee?.winston ?? '0',
    quantity: node.quantity?.winston ?? '0',
    dataSize: node.data?.size ?? '0',
    contentType: node.data?.type ?? null,
    blockIndepHash: node.block?.id ?? null,
    blockTimestamp: node.block?.timestamp ?? null,
    height: node.block?.height ?? decoded.height ?? null,
    blockPreviousBlock: node.block?.previous ?? null,
    parentId: node.bundledIn?.id ?? null,
    blockTransactionIndex: decoded.blockTransactionIndex ?? 0,
    dataItemId,
    tags: node.tags ?? [],
    indexedAt: decoded.indexedAt ?? 0,
    isDataItem,
  };
}

/**
 * Compare two transaction cursors per the ar-io-node sort key.
 *
 * Returns negative if a sorts before b (for ASC), positive if after, 0 if
 * equivalent. Callers flip the sign for DESC.
 *
 * Tuple matches the SQL/ClickHouse ORDER BY on
 * (height, blockTransactionIndex, data_item_id, indexed_at, id). Both
 * backends sort the id and data_item_id columns as raw bytes (BLOB), so
 * this comparator decodes the base64url values back to Buffers before
 * comparison — ASCII ordering over base64url does not match binary byte
 * ordering in general and would desynchronize the merge from either
 * upstream's own ordering.
 */
function compareTxCursorsAsc(aCursor: string, bCursor: string): number {
  const a = decodeTransactionGqlCursor(aCursor);
  const b = decodeTransactionGqlCursor(bCursor);

  const ah = a.height;
  const bh = b.height;
  if (ah !== bh) {
    // Nulls (pending) sort last in ASC, matching the SQLite query behavior.
    if (ah == null) return 1;
    if (bh == null) return -1;
    return ah - bh;
  }

  const abti = a.blockTransactionIndex ?? 0;
  const bbti = b.blockTransactionIndex ?? 0;
  if (abti !== bbti) return abti - bbti;

  const diCmp = compareIdBytes(a.dataItemId, b.dataItemId);
  if (diCmp !== 0) return diCmp;

  const aia = a.indexedAt ?? 0;
  const bia = b.indexedAt ?? 0;
  if (aia !== bia) return aia - bia;

  return compareIdBytes(a.id, b.id);
}

function compareIdBytes(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return Buffer.compare(fromB64Url(a), fromB64Url(b));
}

function compareBlockCursorsAsc(aCursor: string, bCursor: string): number {
  const a = decodeBlockGqlCursor(aCursor);
  const b = decodeBlockGqlCursor(bCursor);
  const ah = a.height;
  const bh = b.height;
  if (ah == null && bh == null) return 0;
  if (ah == null) return 1;
  if (bh == null) return -1;
  return ah - bh;
}

/**
 * Pure k-way merge of sorted edge streams. Deduplicates by node id and stops
 * after `pageSize` emissions.
 *
 * Returns the merged edges plus a flag indicating whether any source still had
 * unconsumed edges after we stopped — used alongside per-source `hasNextPage`
 * to decide the merged pageInfo.
 */
function mergeEdges<T extends { cursor: string; node: { id: string } }>(
  streams: T[][],
  pageSize: number,
  sortOrder: SortOrder,
  compareAsc: (a: string, b: string) => number,
): { edges: T[]; hasUnconsumed: boolean } {
  const cursors = streams.map(() => 0);
  const sign = sortOrder === 'HEIGHT_ASC' ? 1 : -1;
  const emitted: T[] = [];
  const emittedIds = new Set<string>();
  let hasUnconsumed = false;

  const pickNext = (): T | undefined => {
    let bestStream = -1;
    for (let i = 0; i < streams.length; i++) {
      if (cursors[i] >= streams[i].length) continue;
      if (bestStream === -1) {
        bestStream = i;
        continue;
      }
      const cmp =
        sign *
        compareAsc(
          streams[i][cursors[i]].cursor,
          streams[bestStream][cursors[bestStream]].cursor,
        );
      if (cmp < 0) bestStream = i;
    }
    if (bestStream === -1) return undefined;
    const edge = streams[bestStream][cursors[bestStream]];
    cursors[bestStream]++;
    return edge;
  };

  while (emitted.length < pageSize) {
    const edge = pickNext();
    if (edge === undefined) break;
    if (emittedIds.has(edge.node.id)) continue;
    emittedIds.add(edge.node.id);
    emitted.push(edge);
  }

  // We have to keep peeking past pageSize until we either find the next
  // distinct (not-yet-emitted) id or exhaust every stream. Otherwise
  // cross-source duplicates inflate hasNextPage and send clients to an
  // empty next page.
  while (true) {
    const edge = pickNext();
    if (edge === undefined) break;
    if (!emittedIds.has(edge.node.id)) {
      hasUnconsumed = true;
      break;
    }
  }

  return { edges: emitted, hasUnconsumed };
}

export class GatewaysGqlQueryable
  implements GqlQueryable, SelectionAwareGqlQueryable
{
  readonly __selectionAware = true as const;
  private readonly log: winston.Logger;
  private readonly sources: GqlQueryable[];
  private readonly sourceLabels: string[];

  constructor({
    log,
    urls,
    localGqlQueryable,
    requestTimeoutMs = config.GATEWAYS_GQL_REQUEST_TIMEOUT_MS,
    requestRetryCount = config.GATEWAYS_GQL_REQUEST_RETRY_COUNT,
    axiosInstance,
  }: {
    log: winston.Logger;
    urls: string[];
    localGqlQueryable?: GqlQueryable;
    requestTimeoutMs?: number;
    requestRetryCount?: number;
    axiosInstance?: AxiosInstance;
  }) {
    this.log = log.child({ class: 'GatewaysGqlQueryable' });

    if (urls.length === 0 && localGqlQueryable === undefined) {
      throw new Error(
        'GatewaysGqlQueryable requires at least one upstream URL or a local GqlQueryable',
      );
    }

    const http =
      axiosInstance ??
      createRetryingAxios(requestTimeoutMs, requestRetryCount, this.log);

    const remoteSources = urls.map((url) => new RemoteGqlQueryable(url, http));
    const labels = urls.slice();

    if (localGqlQueryable !== undefined) {
      this.sources = [localGqlQueryable, ...remoteSources];
      this.sourceLabels = ['<local>', ...labels];
    } else {
      this.sources = remoteSources;
      this.sourceLabels = labels;
    }
  }

  /**
   * Test helper: construct directly from pre-built GqlQueryable sources,
   * skipping URL/axios setup. Not intended for production use.
   */
  static forTesting(params: {
    log: winston.Logger;
    sources: GqlQueryable[];
    labels?: string[];
  }): GatewaysGqlQueryable {
    if (params.sources.length === 0) {
      throw new Error('forTesting requires at least one source');
    }
    const merger = new GatewaysGqlQueryable({
      log: params.log,
      urls: [],
      localGqlQueryable: params.sources[0],
    });

    (merger as any).sources = params.sources;

    (merger as any).sourceLabels =
      params.labels ?? params.sources.map((_, i) => `source-${i}`);
    return merger;
  }

  /**
   * Issues a minimal probe query against every remote upstream and verifies
   * the cursor format is decodable as an ar-io-node transaction cursor.
   * Throws on any incompatible upstream so misconfiguration surfaces at
   * startup rather than silently corrupting merges.
   */
  async probe(): Promise<void> {
    await Promise.all(
      this.sources.map(async (source, i) => {
        const label = this.sourceLabels[i];
        if (source === this.sources[0] && label === '<local>') return;
        try {
          const result = await source.getGqlTransactions({
            pageSize: 1,
            tags: [],
          });
          if (result.edges.length === 0) return; // empty index — nothing to verify
          const cursor = result.edges[0].cursor;
          const decoded = decodeTransactionGqlCursor(cursor);
          if (decoded.id === null && decoded.height === null) {
            throw new Error('cursor decoded to all-null values');
          }
        } catch (err: any) {
          throw new Error(
            `GatewaysGqlQueryable probe failed for ${label}: ${err?.message ?? err}`,
          );
        }
      }),
    );
  }

  async getGqlTransaction({
    id,
  }: {
    id: string;
  }): Promise<GqlTransaction | null> {
    const promises = this.sources.map((source) =>
      source.getGqlTransaction({ id }),
    );

    return (
      (await this.raceFirstNonNull(promises, 'getGqlTransaction', { id })) ??
      null
    );
  }

  async getGqlBlock({ id }: { id: string }): Promise<GqlBlock | undefined> {
    const promises = this.sources.map((source) => source.getGqlBlock({ id }));

    return this.raceFirstNonNull(promises, 'getGqlBlock', { id });
  }

  async getGqlTransactions(
    args: TransactionQueryArgs,
  ): Promise<GqlTransactionsResult> {
    const sortOrder = args.sortOrder ?? 'HEIGHT_DESC';
    const results = await Promise.allSettled(
      this.sources.map((source) => source.getGqlTransactions(args)),
    );
    this.handleSourceFailures(results, 'getGqlTransactions', args);

    const streams: GqlTransactionEdge[][] = [];
    let anyUpstreamHasMore = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        streams.push(r.value.edges);
        if (r.value.pageInfo.hasNextPage) anyUpstreamHasMore = true;
      }
    }

    const { edges, hasUnconsumed } = mergeEdges(
      streams,
      args.pageSize,
      sortOrder,
      compareTxCursorsAsc,
    );

    return {
      pageInfo: { hasNextPage: anyUpstreamHasMore || hasUnconsumed },
      edges,
    };
  }

  async getGqlBlocks(args: BlockQueryArgs): Promise<GqlBlocksResult> {
    const sortOrder = args.sortOrder ?? 'HEIGHT_DESC';
    const results = await Promise.allSettled(
      this.sources.map((source) => source.getGqlBlocks(args)),
    );
    this.handleSourceFailures(results, 'getGqlBlocks', args);

    const streams: { cursor: string; node: GqlBlock }[][] = [];
    let anyUpstreamHasMore = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        streams.push(
          r.value.edges.map((e) => ({ cursor: e.cursor, node: e.node })),
        );
        if (r.value.pageInfo.hasNextPage) anyUpstreamHasMore = true;
      }
    }

    const { edges, hasUnconsumed } = mergeEdges(
      streams,
      args.pageSize,
      sortOrder,
      compareBlockCursorsAsc,
    );

    return {
      pageInfo: { hasNextPage: anyUpstreamHasMore || hasUnconsumed },
      edges,
    };
  }

  /**
   * Best-effort single-record fan-out: resolves as soon as any source
   * returns a non-null value. Failing sources are logged but do not block
   * a faster peer's response. Throws only when every source rejects.
   */
  private raceFirstNonNull<T>(
    promises: Promise<T | null | undefined>[],
    method: string,
    args: unknown,
  ): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      let remaining = promises.length;
      let rejectedCount = 0;
      let firstError: unknown;

      const maybeFinish = () => {
        if (--remaining > 0) return;
        if (rejectedCount === promises.length) {
          const msg =
            (firstError as Error)?.message ?? String(firstError ?? 'unknown');
          reject(
            new Error(
              `All ${promises.length} GatewaysGqlQueryable source(s) failed for ${method}: ${msg}`,
            ),
          );
        } else {
          resolve(undefined);
        }
      };

      promises.forEach((p, i) => {
        p.then((value) => {
          if (value != null) {
            resolve(value);
          } else {
            maybeFinish();
          }
        }).catch((err) => {
          this.log.warn('Upstream source failed', {
            method,
            args,
            source: this.sourceLabels[i],
            error: err?.message ?? String(err),
          });
          rejectedCount++;
          if (firstError === undefined) firstError = err;
          maybeFinish();
        });
      });
    });
  }

  private handleSourceFailures(
    results: PromiseSettledResult<unknown>[],
    method: string,
    args: unknown,
  ): void {
    const failures = results
      .map((r, i) => ({ r, label: this.sourceLabels[i] }))
      .filter((x) => x.r.status === 'rejected') as {
      r: PromiseRejectedResult;
      label: string;
    }[];

    if (failures.length === 0) return;

    for (const f of failures) {
      this.log.warn('Upstream source failed', {
        method,
        args,
        source: f.label,
        error: f.r.reason?.message ?? String(f.r.reason),
      });
    }

    if (failures.length === results.length) {
      throw new Error(
        `All ${results.length} GatewaysGqlQueryable source(s) failed for ${method}: ${failures[0].r.reason?.message ?? failures[0].r.reason}`,
      );
    }
  }
}

function createRetryingAxios(
  timeoutMs: number,
  retryCount: number,
  log: winston.Logger,
): AxiosInstance {
  const instance = axios.create({
    timeout: timeoutMs,
    headers: {
      'Content-Type': 'application/json',
      'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
    },
  });
  instance.defaults.raxConfig = {
    retry: retryCount,
    instance,
    statusCodesToRetry: [
      [100, 199],
      [429, 429],
      [500, 599],
    ],
    onRetryAttempt: (error: any) => {
      const cfg = rax.getConfig(error);
      const attempt = cfg?.currentRetryAttempt ?? 1;
      log.debug('Retrying upstream GraphQL request', {
        attempt,
        maxRetries: retryCount,
        status: error?.response?.status,
        url: error?.config?.url,
      });
    },
  };
  rax.attach(instance);
  return instance;
}
