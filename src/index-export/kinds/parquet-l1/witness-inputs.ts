/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Where the exporter takes an `l1-4` band's witnesses from
 * (`INDEX_EXPORT_L1_WITNESS_DIR`, `INDEX_EXPORT_L1_WITNESS_NODES`).
 *
 * - **v1 data roots**: lines `{"h", "id", "root"}` (base64url; other keys
 *   ignored) of every `roots-*.jsonl` file in the witness directory, then,
 *   for a transaction none has, its last chunk from an Arweave node
 *   (`GET /chunk/{end offset}`): the root its `data_path` proves, checked
 *   with `arweave-js`'s `validatePath` against the transaction's size. For
 *   a block those roots do not reproduce, a second opinion from the data
 *   itself (`GET /tx/{id}`, a format-1 header carrying its data, up to
 *   {@link MAX_DATA_BYTES}): the genesis block's transactions, whose data
 *   the weave never held, have no chunk to read.
 * - **Transition `tx_root`s** below the 2.0 fork: Arweave's 2.0 checkpoint
 *   (`fork_2_0_checkpoint` in the witness directory, refused unless its
 *   SHA-256 is {@link FORK_2_0_CHECKPOINT_SHA256}) for heights to 399,999,
 *   and nodes' `GET /block_index/{from}/{to}` with `X-Block-Format: 3` for
 *   400,000 on (nodes serve hashes only below it).
 *
 * None of it is trusted: `buildBandWitnesses` keeps a root only where its
 * block's `tx_root` recomputes with it, and a transition root only where
 * the fold reaches the chain's. A source that lies or fails costs the band
 * its witnesses for this run, never a wrong one.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { validatePath } from 'arweave/node/lib/merkle.js';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import {
  FORK_2_0,
  FORK_2_0_CHECKPOINT_SHA256,
  FORK_2_0_CHECKPOINT_TOP,
  HASH_LIST_1_0_SHA256,
  v1DataRoot,
} from '../../../lib/parquet-l1/chain.js';
import { idHeightRange } from '../../../lib/parquet-l1/layout.js';
import {
  type BlockIndexEntryIn,
  type V1Need,
  type WitnessInputs,
  WitnessRefused,
} from '../../../lib/parquet-l1/witnesses.js';

/** The checkpoint's file name in the witness directory. */
export const CHECKPOINT_FILE = 'fork_2_0_checkpoint';

/** Arweave's list of pre-2.0 "2.0 hashes", in the witness directory. */
export const HASH_LIST_1_0_FILE = 'hash_list_1_0';

/** Heights per `GET /block_index` (a node refuses more). */
export const BLOCK_INDEX_PAGE = 10_000;

/** The most data fetched whole for one transaction's root. */
export const MAX_DATA_BYTES = 16 * 1024 * 1024;

/** Concurrent chunk fetches, and the time each may take. */
export const CHUNK_CONCURRENCY = 8;
export const FETCH_TIMEOUT_MS = 30_000;

export interface L1WitnessConfig {
  /** `INDEX_EXPORT_L1_WITNESS_DIR`: `roots-*.jsonl` and `fork_2_0_checkpoint`. */
  dir?: string;
  /** `INDEX_EXPORT_L1_WITNESS_NODES`: Arweave nodes for `/chunk` and `/block_index`. */
  nodes: string[];
}

const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest();

/** The root a Merkle path proves: the id of its first node (a leaf of 64 bytes, else a branch). */
export function dataPathRoot(dataPath: Buffer): Buffer {
  if (dataPath.length === 64) {
    return sha256(
      Buffer.concat([
        sha256(dataPath.subarray(0, 32)),
        sha256(dataPath.subarray(32, 64)),
      ]),
    );
  }
  return sha256(
    Buffer.concat([
      sha256(dataPath.subarray(0, 32)),
      sha256(dataPath.subarray(32, 64)),
      sha256(dataPath.subarray(64, 96)),
    ]),
  );
}

/**
 * A transaction's v1 data root from its last chunk's `data_path`, or
 * undefined when the path does not prove a chunk ending at the
 * transaction's last byte under the root it claims.
 */
export async function rootFromDataPath(
  dataPath: Buffer,
  size: bigint,
): Promise<Buffer | undefined> {
  if (dataPath.length < 64 || size <= 0n) return undefined;
  // The leaf's note is the end of its chunk: for the last chunk, the size
  // of the data. A path to another transaction's chunk ends elsewhere.
  const end = BigInt(`0x${dataPath.subarray(-32).toString('hex')}`);
  if (end !== size) return undefined;
  const root = dataPathRoot(dataPath);
  const n = Number(size);
  const proved = await validatePath(root, n - 1, 0, n, dataPath);
  return proved === false ? undefined : root;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The witness inputs for one band (see the module comment). */
export function l1WitnessInputs(
  config: L1WitnessConfig,
  heightRange: [number, number],
  log: Logger,
  fetchImpl: Fetch = fetch,
): WitnessInputs {
  const [from, to] = heightRange;
  let fromDir: Promise<Map<string, { h: number; root: Buffer }>> | undefined;
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  };
  const node = (attempt: number, key: number) =>
    config.nodes[(key + attempt) % config.nodes.length].replace(/\/+$/, '');

  return {
    async v1Roots(needs: V1Need[]): Promise<Map<string, Buffer>> {
      fromDir ??= readRootsDir(config.dir, from, to, log);
      const known = await fromDir;
      const out = new Map<string, Buffer>();
      const left: V1Need[] = [];
      for (const need of needs) {
        const id = need.id.toString('base64url');
        const row = known.get(id);
        if (row !== undefined && row.h === need.height) out.set(id, row.root);
        else if (need.endOffset !== undefined) left.push(need);
      }
      if (left.length === 0 || config.nodes.length === 0) return out;
      const limit = pLimit(CHUNK_CONCURRENCY);
      let failed = 0;
      await Promise.all(
        left.map((need, i) =>
          limit(async () => {
            for (let attempt = 0; attempt < config.nodes.length; attempt++) {
              const at = `${node(attempt, i)}/chunk/${need.endOffset as bigint}`;
              try {
                const body = (await get(at)) as { data_path?: unknown };
                if (typeof body.data_path !== 'string') continue;
                const root = await rootFromDataPath(
                  Buffer.from(body.data_path, 'base64url'),
                  need.size,
                );
                if (root === undefined) continue;
                out.set(need.id.toString('base64url'), root);
                return;
              } catch {
                // The next node.
              }
            }
            failed += 1;
          }),
        ),
      );
      if (failed > 0) {
        log.warn('Some v1 data roots could not be fetched', {
          heightRange,
          asked: left.length,
          failed,
        });
      }
      return out;
    },

    async v1RootsFromData(needs: V1Need[]): Promise<Map<string, Buffer>> {
      const out = new Map<string, Buffer>();
      if (config.nodes.length === 0) return out;
      const limit = pLimit(CHUNK_CONCURRENCY);
      await Promise.all(
        needs
          .filter((need) => need.size <= BigInt(MAX_DATA_BYTES))
          .map((need, i) =>
            limit(async () => {
              const id = need.id.toString('base64url');
              for (let attempt = 0; attempt < config.nodes.length; attempt++) {
                try {
                  const body = (await get(`${node(attempt, i)}/tx/${id}`)) as {
                    data?: unknown;
                  };
                  if (typeof body.data !== 'string') continue;
                  const data = Buffer.from(body.data, 'base64url');
                  if (BigInt(data.length) !== need.size) continue;
                  out.set(id, await v1DataRoot(data));
                  return;
                } catch {
                  // The next node.
                }
              }
            }),
          ),
      );
      return out;
    },

    async hashList10(): Promise<Buffer[] | undefined> {
      return readHashList10(config.dir);
    },

    async blockIndex(
      lo: number,
      hi: number,
    ): Promise<Map<number, BlockIndexEntryIn>> {
      const out = new Map<number, BlockIndexEntryIn>();
      const top = Math.min(hi, FORK_2_0 - 1);
      if (lo <= Math.min(top, FORK_2_0_CHECKPOINT_TOP)) {
        for (const [h, entry] of await readCheckpoint(config.dir, lo, top)) {
          out.set(h, entry);
        }
      }
      for (
        let start = Math.max(lo, FORK_2_0_CHECKPOINT_TOP + 1);
        start <= top;
        start += BLOCK_INDEX_PAGE
      ) {
        const end = Math.min(top, start + BLOCK_INDEX_PAGE - 1);
        for (let attempt = 0; attempt < config.nodes.length; attempt++) {
          try {
            const body = await get(
              `${node(attempt, start)}/block_index/${start}/${end}`,
              { 'X-Block-Format': '3' },
            );
            const entries = parseBlockIndex(body, start, end);
            for (const [h, entry] of entries) out.set(h, entry);
            break;
          } catch (error) {
            log.debug('A block index page could not be read', {
              start,
              end,
              error: (error as Error).message,
            });
          }
        }
      }
      return out;
    },
  };
}

/**
 * A `GET /block_index/{start}/{end}` answer in format 3: newest first, one
 * `{tx_root, weave_size, hash}` per height. Anything else is refused.
 */
export function parseBlockIndex(
  body: unknown,
  start: number,
  end: number,
): Map<number, BlockIndexEntryIn> {
  if (!Array.isArray(body) || body.length !== end - start + 1) {
    throw new Error(`not ${end - start + 1} block-index entries`);
  }
  const out = new Map<number, BlockIndexEntryIn>();
  body.forEach((entry, i) => out.set(end - i, parseEntry(entry)));
  return out;
}

function parseEntry(entry: unknown): BlockIndexEntryIn {
  const e = (entry ?? {}) as Record<string, unknown>;
  if (
    typeof e.hash !== 'string' ||
    typeof e.tx_root !== 'string' ||
    typeof e.weave_size !== 'string' ||
    !/^\d+$/.test(e.weave_size)
  ) {
    throw new Error('not a block-index entry');
  }
  return {
    hash: Buffer.from(e.hash, 'base64url'),
    weaveSize: BigInt(e.weave_size),
    txRoot: Buffer.from(e.tx_root, 'base64url'),
  };
}

/** The checkpoint's entries for heights `lo` to `hi`, or none without one. */
async function readCheckpoint(
  dir: string | undefined,
  lo: number,
  hi: number,
): Promise<Map<number, BlockIndexEntryIn>> {
  const out = new Map<number, BlockIndexEntryIn>();
  if (dir === undefined) return out;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(dir, CHECKPOINT_FILE));
  } catch {
    return out;
  }
  // A file that is not Arweave's refuses the band's witnesses (it is
  // built without them, as l1-3), never the run.
  const digest = sha256(bytes).toString('hex');
  if (digest !== FORK_2_0_CHECKPOINT_SHA256) {
    throw new WitnessRefused(
      `${CHECKPOINT_FILE} has SHA-256 ${digest}, not Arweave's ${FORK_2_0_CHECKPOINT_SHA256}`,
    );
  }
  let list: unknown[];
  try {
    list = JSON.parse(bytes.toString('utf8')) as unknown[];
  } catch (error) {
    throw new WitnessRefused(
      `${CHECKPOINT_FILE} is not JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(list) || list.length !== FORK_2_0_CHECKPOINT_TOP + 1) {
    throw new WitnessRefused(
      `${CHECKPOINT_FILE} is not ${FORK_2_0_CHECKPOINT_TOP + 1} entries`,
    );
  }
  for (let h = lo; h <= Math.min(hi, FORK_2_0_CHECKPOINT_TOP); h++) {
    try {
      out.set(h, parseEntry(list[FORK_2_0_CHECKPOINT_TOP - h]));
    } catch (error) {
      throw new WitnessRefused(
        `${CHECKPOINT_FILE} at ${h}: ${(error as Error).message}`,
      );
    }
  }
  return out;
}

/**
 * Every v1 root the witness directory's `roots-*.jsonl` files hold for
 * heights `from` to `to`, by base64url id. A file named for a band id
 * (`roots-l1-h<from>-<to>-…`) outside those heights is not read.
 */
async function readRootsDir(
  dir: string | undefined,
  from: number,
  to: number,
  log: Logger,
): Promise<Map<string, { h: number; root: Buffer }>> {
  const out = new Map<string, { h: number; root: Buffer }>();
  if (dir === undefined) return out;
  const names = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^roots-.*\.jsonl$/.test(name))
    .filter((name) => {
      const range = idHeightRange(
        name.slice('roots-'.length, -'.jsonl'.length),
      );
      return range === undefined || (range[1] >= from && range[0] <= to);
    })
    .sort();
  let malformed = 0;
  for (const name of names) {
    const lines = readline.createInterface({
      input: createReadStream(path.join(dir, name)),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as {
          h?: unknown;
          id?: unknown;
          root?: unknown;
        };
        if (
          typeof row.h !== 'number' ||
          typeof row.id !== 'string' ||
          typeof row.root !== 'string'
        ) {
          malformed += 1;
          continue;
        }
        if (row.h < from || row.h > to) continue;
        const root = Buffer.from(row.root, 'base64url');
        if (root.length !== 32) {
          malformed += 1;
          continue;
        }
        out.set(row.id, { h: row.h, root });
      } catch {
        malformed += 1;
      }
    }
  }
  if (malformed > 0) {
    log.warn('Witness directory lines that are not roots were passed over', {
      dir,
      malformed,
    });
  }
  return out;
}

/**
 * Arweave's `genesis_data/hash_list_1_0` from the witness directory,
 * indexed by height, or undefined without one. Refused unless its SHA-256
 * is the one Arweave ships.
 */
export async function readHashList10(
  dir: string | undefined,
): Promise<Buffer[] | undefined> {
  if (dir === undefined) return undefined;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(dir, HASH_LIST_1_0_FILE));
  } catch {
    return undefined;
  }
  const digest = sha256(bytes).toString('hex');
  if (digest !== HASH_LIST_1_0_SHA256) {
    throw new WitnessRefused(
      `${HASH_LIST_1_0_FILE} has SHA-256 ${digest}, not Arweave's ${HASH_LIST_1_0_SHA256}`,
    );
  }
  let list: string[];
  try {
    list = JSON.parse(bytes.toString('utf8')) as string[];
  } catch (error) {
    throw new WitnessRefused(
      `${HASH_LIST_1_0_FILE} is not JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(list) || list.length !== FORK_2_0) {
    throw new WitnessRefused(
      `${HASH_LIST_1_0_FILE} is not ${FORK_2_0} entries`,
    );
  }
  // Newest first: height h is at FORK_2_0 - h - 1.
  return list.map((_, h) => Buffer.from(list[FORK_2_0 - h - 1], 'base64url'));
}
