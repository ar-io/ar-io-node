/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What a gateway's ClickHouse already holds of a band's data items, for the
 * L2 import's ClickHouse target (`import-clickhouse.ts`).
 *
 * `transactions` is a `ReplacingMergeTree(inserted_at)` keyed by
 * `(height, block_transaction_index, is_data_item, id)`: a row inserted at a
 * key the gateway already holds replaces the gateway's row when the parts
 * merge. So an import must find every id ClickHouse holds at the keys it is
 * about to write, or it would overwrite the gateway's own rows. That is the
 * import's "first writer wins" (DL-22), and why these reads are not optional.
 *
 * Ids are sent with the query as ClickHouse external data (a temporary
 * table built from the request body), so one query per height window answers
 * for every id in it. The query reads `transactions` by its primary key's
 * height prefix only. `transaction_ids`, sorted by id, would find an id at
 * any height, but reads about one granule per id: for the hundreds of
 * thousands of ids in a window that is most of the table, every window.
 *
 * Read-only: every query runs with `readonly = 2`.
 */
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

/** Bounds every query, as the census and the band export bound theirs. */
export const HELD_CLICKHOUSE_SETTINGS = {
  readonly: '2',
  max_threads: '2',
  max_memory_usage: '4000000000',
  max_execution_time: '600',
  priority: '10',
  cancel_http_readonly_queries_on_client_close: '1',
} as const;

/**
 * The columns {@link ClickHouseHeld.heldIn} writes, in order, tab-separated
 * with `\N` for NULL: ids as upper-case hex, numbers in decimal.
 */
export const HELD_COLUMNS = [
  { name: 'id', type: 'BLOB' },
  { name: 'height', type: 'UBIGINT' },
  { name: 'block_transaction_index', type: 'USMALLINT' },
  { name: 'root_transaction_id', type: 'BLOB' },
  { name: 'parent_id', type: 'BLOB' },
  { name: 'owner_address', type: 'BLOB' },
  { name: 'data_size', type: 'UBIGINT' },
  { name: 'offset', type: 'UBIGINT' },
  { name: 'size', type: 'UBIGINT' },
  { name: 'data_offset', type: 'UBIGINT' },
  { name: 'owner_offset', type: 'UBIGINT' },
  { name: 'owner_size', type: 'UBIGINT' },
  { name: 'signature_offset', type: 'UBIGINT' },
  { name: 'signature_size', type: 'UBIGINT' },
  { name: 'root_parent_offset', type: 'UBIGINT' },
] as const;

const BLOB_COLUMNS = new Set<string>(
  HELD_COLUMNS.filter((c) => c.type === 'BLOB').map((c) => c.name),
);

/**
 * Rows of `transactions` for the ids in the external table `ids` (one hex id
 * per line), data items only, between two heights. Every stored version of a
 * key is returned (no `FINAL`): the reader keeps one per key.
 */
export const HELD_QUERY = `
  SELECT ${HELD_COLUMNS.map((c) =>
    BLOB_COLUMNS.has(c.name) ? `hex(${c.name})` : `"${c.name}"`,
  ).join(', ')}
  FROM transactions
  WHERE height >= {from:UInt32} AND height <= {to:UInt32}
    AND is_data_item
    AND id IN (SELECT unhex(id_hex) FROM ids)
  FORMAT TSV`;

/** The top height ClickHouse holds, data items and L1 rows alike. */
export const TOP_HEIGHT_QUERY =
  'SELECT max(height) FROM transactions FORMAT TSV';

/** Reads from a gateway's ClickHouse what an import must not overwrite. */
export interface ClickHouseHeld {
  /**
   * The top height in `transactions`, or undefined when it is empty. The
   * gateway exports its own data items up to here, so an import that writes
   * no higher never races the gateway's export for a key.
   */
  topHeight(): Promise<number | undefined>;
  /**
   * Writes to `outFile` the rows ({@link HELD_COLUMNS}) ClickHouse holds for
   * the ids listed in `idsFile` (upper-case hex, one per line) at heights
   * `from` to `to`.
   */
  heldIn(args: {
    from: number;
    to: number;
    idsFile: string;
    outFile: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export class ClickHouseHeldError extends Error {}

/** Reads over ClickHouse's HTTP interface, with `fetch`. */
export function httpClickHouseHeld({
  url,
  username,
  password,
  fetchImpl = fetch,
}: {
  url: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}): ClickHouseHeld {
  const endpoint = (params: Record<string, string>) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries({
      ...HELD_CLICKHOUSE_SETTINGS,
      ...params,
    })) {
      u.searchParams.set(k, v);
    }
    return u;
  };
  const headers = {
    'X-ClickHouse-User': username,
    'X-ClickHouse-Key': password,
  };
  const failed = async (response: Response) =>
    new ClickHouseHeldError(
      `ClickHouse answered ${response.status}: ${(await response.text()).trim().slice(0, 500)}`,
    );

  return {
    async topHeight() {
      const response = await fetchImpl(endpoint({ query: TOP_HEIGHT_QUERY }), {
        method: 'POST',
        headers,
      });
      if (!response.ok) throw await failed(response);
      const text = (await response.text()).trim();
      const top = Number(text);
      if (text === '' || !Number.isSafeInteger(top) || top < 0) {
        throw new ClickHouseHeldError(
          `ClickHouse gave no top height: ${JSON.stringify(text.slice(0, 100))}`,
        );
      }
      // max() over an empty table is 0, as is a table holding only the
      // genesis block: neither has anything an import could overwrite above
      // height 0, so both read as "nothing held".
      return top === 0 ? undefined : top;
    },

    async heldIn({ from, to, idsFile, outFile, signal }) {
      const form = new FormData();
      form.append(
        'ids',
        new Blob([new Uint8Array(await fsp.readFile(idsFile))]),
        'ids.tsv',
      );
      const response = await fetchImpl(
        endpoint({
          query: HELD_QUERY,
          param_from: String(from),
          param_to: String(to),
          ids_structure: 'id_hex String',
          ids_format: 'TSV',
        }),
        {
          method: 'POST',
          headers,
          body: form,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      if (!response.ok || response.body === null) throw await failed(response);
      const out = fs.createWriteStream(outFile);
      try {
        for await (const chunk of response.body) {
          if (!out.write(chunk)) await once(out, 'drain');
        }
      } finally {
        out.end();
        await once(out, 'close');
      }
      // ClickHouse reports an error met after the response began in the body
      // itself, with the status already sent as 200.
      const tail = await readTail(outFile, 4096);
      if (/Code: \d+\. DB::Exception/.test(tail)) {
        throw new ClickHouseHeldError(
          `ClickHouse failed mid-answer: ${tail.trim().split('\n').pop()}`,
        );
      }
    },
  };
}

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Removes rows an import wrote, for `index-l2-import --forget`.
 *
 * The rows are named by height range, `indexed_at` (the band's `createdAt`,
 * which the import gives every row it writes) and id, so a delete cannot
 * touch a row the gateway wrote itself unless that row has the same id,
 * height range and indexing second as one the import wrote, which first
 * writer wins rules out.
 *
 * `transactions` has a projection, which ClickHouse's lightweight `DELETE`
 * refuses, so this is a mutation (`ALTER TABLE ... DELETE`): the ids go into
 * a helper table first, and the mutation rewrites the band's partition once.
 * Heavy, and waited for; meant for undoing an import, not for routine use.
 * `transaction_ids` keeps its rows, which is harmless (see `schema.sql`).
 */
export interface ClickHouseForget {
  forget(args: ForgetArgs): Promise<{ matched: number }>;
}

export interface ForgetArgs {
  from: number;
  to: number;
  indexedAt: number;
  /** Upper-case hex ids. */
  ids: string[];
}

/** Deletes over ClickHouse's HTTP interface. */
export function httpClickHouseForget({
  url,
  username,
  password,
  fetchImpl = fetch,
  now = Date.now,
}: {
  url: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ClickHouseForget {
  const run = async (
    query: string,
    {
      body,
      settings = {},
    }: { body?: string; settings?: Record<string, string> } = {},
  ) => {
    const u = new URL(url);
    u.searchParams.set('max_execution_time', '0');
    for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, v);
    if (body !== undefined) u.searchParams.set('query', query);
    const response = await fetchImpl(u, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': username,
        'X-ClickHouse-Key': password,
      },
      body: body ?? query,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ClickHouseHeldError(
        `ClickHouse answered ${response.status}: ${text.trim().slice(0, 500)}`,
      );
    }
    return text;
  };
  return {
    async forget({ from, to, indexedAt, ids }) {
      for (const id of ids) {
        if (!/^[0-9A-F]{64}$/.test(id)) {
          throw new ClickHouseHeldError(`not a hex data item id: ${id}`);
        }
      }
      if (
        ![from, to, indexedAt].every((n) => Number.isSafeInteger(n) && n >= 0)
      ) {
        throw new ClickHouseHeldError(
          'forget: heights and indexed_at must be whole',
        );
      }
      const helper = `l2_import_forget_${now()}_${process.pid}`;
      const where = `height >= ${from} AND height <= ${to} AND is_data_item
        AND indexed_at = ${indexedAt}
        AND id IN (SELECT unhex(id_hex) FROM ${helper})`;
      await run(
        `CREATE TABLE ${helper} (id_hex String) ENGINE = MergeTree ORDER BY id_hex`,
      );
      try {
        await run(`INSERT INTO ${helper} (id_hex) FORMAT TSV`, {
          body: ids.length > 0 ? `${ids.join('\n')}\n` : '',
        });
        const matched = Number(
          (
            await run(
              `SELECT count() FROM transactions WHERE ${where} FORMAT TSV`,
            )
          ).trim(),
        );
        await run(`ALTER TABLE transactions DELETE WHERE ${where}`, {
          settings: {
            mutations_sync: '2',
            allow_nondeterministic_mutations: '1',
          },
        });
        return { matched };
      } finally {
        await run(`DROP TABLE IF EXISTS ${helper}`).catch(() => undefined);
      }
    },
  };
}
