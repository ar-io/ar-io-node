/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What binds each column of an `l1-4` band that the importer writes to
 * `core.db`, by era: one declared table, so that a column nothing checks
 * cannot be added, or left, without anyone saying so.
 *
 * Three bugs were columns no check covered (a rounded `reward_pool`, a
 * format-1 `data_root` beside its witness, the pre-2.0 header fields).
 * `column-bindings.test.ts` fails when a column the importer writes
 * (`IMPORT_SQL`) or a band carries (`PARQUET_L1_TABLES`) has no entry, when
 * an entry names a column that is gone, and when a column declared bound
 * (`chain`, `checkpoint`, `canonical`) can be changed in a witnessed band
 * without `index-l1-verify --bands-dir` failing. The table is rendered into
 * `docs/cli.md` ({@link renderBindingsTable}), and the test keeps the two
 * the same. The verifier's result names the `sample` and `none` columns in
 * its `assurance` ({@link bindingsAssurance}).
 *
 * The bindings:
 * - `chain`: covered by a hash or root the chain commits to and the
 *   verifier recomputes (the anchor and the `hash_list_merkle` recurrence,
 *   the 2.0 seed fold to its pins, `tx_root`, the links and the weave).
 * - `checkpoint`: covered by a pre-2.0 block's 2.0 hash, whose fold is
 *   pinned to Arweave's `genesis_data/hash_list_1_0`: Arweave's checkpoint,
 *   not the chain's own hashes.
 * - `signature`: covered by the transaction's signature, which the verifier
 *   checks only on the sample.
 * - `sample`: compared with the chain only on sampled headers or
 *   transactions.
 * - `canonical`: one value a band writes (NULL, false, empty), and the
 *   verifier fails anything else.
 * - `none`: nothing checks it; it is what the publisher wrote.
 * - `unbound:<class>`: reported in that unbound class, and accepted only by
 *   its flag.
 */
import { FORK_1_6, FORK_2_0, FORK_2_5 } from './chain.js';

export type Binding =
  | 'chain'
  | 'checkpoint'
  | 'signature'
  | 'sample'
  | 'canonical'
  | 'none'
  | `unbound:${'pre20' | 'txRootFormat1' | 'incomplete'}`;

/** The eras a binding can differ across, by the forks that changed what binds what. */
export const ERAS = ['pre-1.6', '1.6–2.0', '2.0–2.5', '2.5+'] as const;
export type Era = (typeof ERAS)[number];

/** The first height of each era. */
export const ERA_FROM: Record<Era, number> = {
  'pre-1.6': 0,
  '1.6–2.0': FORK_1_6,
  '2.0–2.5': FORK_2_0,
  '2.5+': FORK_2_5,
};

export interface ColumnBinding {
  /** The band table and column (`PARQUET_L1_TABLES`). */
  table: string;
  column: string;
  /** Narrows the entry to some rows (`format 1`, `format 2`). */
  when?: string;
  /** The `core.db` columns the importer writes it to, as `table.column`. */
  core: string[];
  /** One binding per era. */
  bindings: Record<Era, Binding>;
  /** Why, and the code that enforces it. */
  reason: string;
  /**
   * The one spelling a band stores, where a value could be spelt more
   * than one way (a number as text, an absent value), enforced by the
   * judge's `canonical` check (judge.ts checkCanonicalBlock).
   */
  representation?: string;
}

const all = (b: Binding): Record<Era, Binding> => ({
  'pre-1.6': b,
  '1.6–2.0': b,
  '2.0–2.5': b,
  '2.5+': b,
});
const pre20 = (before: Binding, after: Binding): Record<Era, Binding> => ({
  'pre-1.6': before,
  '1.6–2.0': before,
  '2.0–2.5': after,
  '2.5+': after,
});

/** A pre-2.0 header field the 2.0 hash covers, compared on sampled headers after. */
const header = (column: string, representation?: string): ColumnBinding => ({
  table: 'blocks',
  column,
  core: [`stable_blocks.${column}`],
  ...(representation !== undefined ? { representation } : {}),
  bindings: pre20('checkpoint', 'sample'),
  reason:
    "below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock)",
});

export const COLUMN_BINDINGS: ColumnBinding[] = [
  // blocks
  {
    table: 'blocks',
    column: 'indep_hash',
    core: ['stable_blocks.indep_hash'],
    bindings: all('chain'),
    reason:
      'below 2.0: in the 2.0 seed fold to FORK_2_0_FOLD_PINS (judge.ts stepFork20); from 2.0: in the hash_list_merkle recurrence to the anchored top (judge.ts, anchor.ts)',
  },
  {
    table: 'blocks',
    column: 'height',
    core: ['stable_blocks.height'],
    bindings: all('chain'),
    reason:
      'each block is judged at its height against the one below (contiguous); the folds and recurrence are positional',
  },
  {
    table: 'blocks',
    column: 'previous_block',
    core: ['stable_blocks.previous_block'],
    representation: 'empty bytes at genesis, never NULL',
    bindings: all('chain'),
    reason:
      "equal to the chain-bound indep_hash of the block below (judge.ts 'linked')",
  },
  header('nonce'),
  header('hash'),
  header('block_timestamp'),
  header('last_retarget'),
  header(
    'diff',
    'decimal text: N.0 below the 1.8 fork (a float, as gateways stored it), N from it; no leading zero',
  ),
  header(
    'cumulative_diff',
    'NULL below the 1.6 fork; N.0 below 1.8; N from it; no leading zero',
  ),
  header(
    'reward_addr',
    'the address, or empty bytes for unclaimed: never NULL nor the word',
  ),
  header('reward_pool', 'decimal text N, no leading zero'),
  header('wallet_list', 'the digest, never NULL'),
  {
    table: 'blocks',
    column: 'tx_count',
    core: ['stable_blocks.tx_count'],
    bindings: all('chain'),
    reason:
      "the number of links (judge.ts 'tx_count'), each a leaf of the recomputed (transition) tx_root",
  },
  {
    table: 'blocks',
    column: 'block_size',
    core: ['stable_blocks.block_size'],
    bindings: all('chain'),
    reason: "the growth of the chain-bound weave_size (judge.ts 'block_size')",
  },
  {
    table: 'blocks',
    column: 'weave_size',
    core: ['stable_blocks.weave_size'],
    bindings: all('chain'),
    reason:
      'below 2.0: in the 2.0 seed fold; from 2.0: in the hash_list_merkle recurrence',
  },
  ...[
    'usd_to_ar_rate_dividend',
    'usd_to_ar_rate_divisor',
    'scheduled_usd_to_ar_rate_dividend',
    'scheduled_usd_to_ar_rate_divisor',
  ].map(
    (column): ColumnBinding => ({
      table: 'blocks',
      column,
      core: [`stable_blocks.${column}`],
      bindings: {
        'pre-1.6': 'canonical',
        '1.6–2.0': 'canonical',
        '2.0–2.5': 'canonical',
        '2.5+': 'sample',
      },
      reason:
        "below 2.5: NULL, no header carried it (judge.ts checkCanonicalBlock, 'canonical'); from 2.5: compared on the anchor block and sampled headers",
    }),
  ),
  {
    table: 'blocks',
    column: 'hash_list_merkle',
    core: ['stable_blocks.hash_list_merkle'],
    representation: 'NULL below the 1.6 fork, never empty bytes',
    bindings: {
      'pre-1.6': 'canonical',
      '1.6–2.0': 'chain',
      '2.0–2.5': 'chain',
      '2.5+': 'chain',
    },
    reason:
      "below 1.6: empty (judge.ts 'hash_list_merkle'); from 1.6: the recurrence over the chain-bound hashes below (the 1.6 seed, then SHA-384 of the one below and its hash; from 2.0 the block-index fold)",
  },
  {
    table: 'blocks',
    column: 'tx_root',
    core: ['stable_blocks.tx_root'],
    bindings: pre20('canonical', 'chain'),
    reason:
      "below 2.0: NULL in the band, the protocol had none; the import writes the witnessed transition root instead (fork_2_0.tx_root); from 2.0: recomputed from the block's transactions and in the recurrence",
    representation:
      'NULL below the 2.0 fork; empty bytes for a block without transactions from it',
  },
  // transactions
  {
    table: 'transactions',
    column: 'id',
    core: ['stable_transactions.id'],
    bindings: pre20('checkpoint', 'sample'),
    reason:
      "equal to its link (judge.ts 'position'); below 2.0 the links' ids are in the 2.0 hash; from 2.0 tx_root drops ids, so they are compared on sampled headers and by sampled signatures",
  },
  {
    table: 'transactions',
    column: 'block_transaction_index',
    core: ['stable_transactions.block_transaction_index'],
    bindings: all('sample'),
    reason:
      "the link's position (judge.ts 'position'); no hash binds the order below 2.0 (the 2.0 hash sorts the ids), so on every era it is compared with sampled headers' txs (sample.ts; below 2.0 attested: the header --anchor-min machines agree on)",
  },
  {
    table: 'transactions',
    column: 'is_data_item',
    core: [],
    bindings: all('canonical'),
    reason: "false (verify-bands.ts 'canonical'); not written to core.db",
  },
  ...['target', 'quantity', 'reward', 'owner_address'].map(
    (column): ColumnBinding => ({
      table: 'transactions',
      column,
      core: [`stable_transactions.${column}`],
      bindings: all('signature'),
      reason:
        'signed by the transaction, checked on the transaction sample (sample.ts judgeTx)',
    }),
  ),
  {
    table: 'transactions',
    column: 'anchor',
    core: ['stable_transactions.last_tx'],
    bindings: all('signature'),
    reason:
      'last_tx, signed by the transaction, checked on the transaction sample',
  },
  {
    table: 'transactions',
    column: 'tag_count',
    core: ['stable_transactions.tag_count'],
    bindings: all('signature'),
    reason:
      "the number of its tag rows (judge.ts 'tag_count'), which are signed",
  },
  {
    table: 'transactions',
    column: 'data_size',
    core: ['stable_transactions.data_size'],
    bindings: all('chain'),
    reason:
      'a leaf of the recomputed (transition) tx_root, and the weave accounting',
  },
  {
    table: 'transactions',
    column: 'data_root',
    when: 'format 2',
    core: ['stable_transactions.data_root'],
    bindings: pre20('canonical', 'chain'),
    reason:
      "its leaf in the recomputed tx_root; no format 2 below 2.0 (judge.ts 'nulls')",
  },
  {
    table: 'transactions',
    column: 'data_root',
    when: 'format 1',
    core: ['stable_transactions.data_root'],
    bindings: all('canonical'),
    reason:
      "NULL under l1-4: the root is witness_v1_data_roots', which tx_root checks (judge.ts checkCanonicalFormat1, 'witnesses')",
  },
  {
    table: 'transactions',
    column: 'format',
    core: ['stable_transactions.format'],
    bindings: pre20('canonical', 'sample'),
    reason:
      "below 2.0: 1 (judge.ts 'nulls'); from 2.0 only the format-1 draw shows a format-1 transaction is one (--sample-format1, refused at 0 without --allow-unsampled)",
  },
  {
    table: 'transactions',
    column: 'height',
    core: ['stable_transactions.height'],
    bindings: all('chain'),
    reason: "the height of its link (judge.ts 'position')",
  },
  ...['content_type', 'content_encoding'].map(
    (column): ColumnBinding => ({
      table: 'transactions',
      column,
      core: [`stable_transactions.${column}`],
      bindings: all('canonical'),
      reason:
        "derived from tags: the first such tag by position, names compared without case, NULL without one (layout.ts firstTagValue), recomputed from the band's tags (judge.ts checkDerivedColumns, 'canonical'); the tags themselves are bound as their transaction is (signature, sampled)",
    }),
  ),
  {
    table: 'transactions',
    column: 'offset',
    core: ['stable_transactions.offset'],
    bindings: all('chain'),
    reason:
      "NULL, or the weave offset its data ends at, recomputed from the chain-bound weave_size, block_size and the block's sizes in tx_root order with the 2.5 padding (judge.ts checkDerivedColumns, 'canonical'); NULL with no data and in the genesis block",
  },
  {
    table: 'transactions',
    column: 'signature',
    core: ['stable_transactions.signature'],
    bindings: pre20('checkpoint', 'sample'),
    reason:
      "NULL, or one whose SHA-256 is the id (verify-bands.ts 'canonical'), so bound as the id is",
  },
  // block_transactions
  {
    table: 'block_transactions',
    column: 'height',
    core: [
      'stable_block_transactions.block_indep_hash',
      'missing_transactions.block_indep_hash',
      'missing_transactions.height',
    ],
    bindings: all('chain'),
    reason:
      "the link's block, by height, its indep_hash chain-bound (judge.ts 'rows')",
  },
  {
    table: 'block_transactions',
    column: 'block_transaction_index',
    core: ['stable_block_transactions.block_transaction_index'],
    bindings: all('sample'),
    reason:
      "as transactions.block_transaction_index: compared with sampled headers' txs, below 2.0 attested",
  },
  {
    table: 'block_transactions',
    column: 'transaction_id',
    core: [
      'stable_block_transactions.transaction_id',
      'missing_transactions.transaction_id',
    ],
    bindings: pre20('checkpoint', 'sample'),
    reason:
      "below 2.0: in the block's 2.0 hash (sorted); from 2.0 compared on sampled headers",
  },
  // tags
  {
    table: 'tags',
    column: 'height',
    core: [
      'stable_transaction_tags.height',
      'stable_transaction_tags.block_transaction_index',
    ],
    bindings: all('chain'),
    reason:
      "a transaction at that height (verify-bands.ts 'tags'), whose position it takes",
  },
  {
    table: 'tags',
    column: 'id',
    core: ['stable_transaction_tags.transaction_id'],
    bindings: pre20('checkpoint', 'sample'),
    reason: 'a transaction at that height, bound as its id is',
  },
  ...['tag_index', 'tag_name', 'tag_value'].map(
    (column): ColumnBinding => ({
      table: 'tags',
      column,
      core:
        column === 'tag_index'
          ? ['stable_transaction_tags.transaction_tag_index']
          : column === 'tag_name'
            ? [
                'stable_transaction_tags.tag_name_hash',
                'tag_names.hash',
                'tag_names.name',
              ]
            : [
                'stable_transaction_tags.tag_value_hash',
                'tag_values.hash',
                'tag_values.value',
              ],
      bindings: all('signature'),
      reason:
        'signed by the transaction, checked on the transaction sample; indexed 0 to n-1 (judge.ts tag_count)',
    }),
  ),
  {
    table: 'tags',
    column: 'is_data_item',
    core: [],
    bindings: all('canonical'),
    reason: "false (verify-bands.ts 'canonical'); not written to core.db",
  },
  // wallets
  // witnesses (l1-4)
  {
    table: 'v1_data_roots',
    column: 'height',
    core: [],
    bindings: all('chain'),
    reason:
      'a format-1 transaction with data at that height (witnesses.ts checkBandWitnesses)',
  },
  {
    table: 'v1_data_roots',
    column: 'id',
    core: [],
    bindings: pre20('checkpoint', 'sample'),
    reason:
      "that transaction, bound as its id is; every one of the band's has a row",
  },
  {
    table: 'v1_data_roots',
    column: 'data_root',
    core: ['stable_transactions.data_root'],
    bindings: all('chain'),
    reason:
      'its leaf in the recomputed (transition) tx_root (judge.ts checkTxRoot); the import writes it over any root the gateway kept (import.ts IMPORT_SQL.witnessDataRoot)',
  },
  {
    table: 'fork_2_0',
    column: 'height',
    core: [],
    bindings: pre20('chain', 'canonical'),
    reason:
      'one row per pre-2.0 height of the band, none from 2.0 (witnesses.ts checkBandWitnesses)',
  },
  {
    table: 'fork_2_0',
    column: 'tx_root',
    core: ['stable_blocks.tx_root'],
    bindings: pre20('chain', 'canonical'),
    reason:
      "the transition tx_root, recomputed from the block's transactions and in the 2.0 seed fold to its pins (judge.ts stepFork20); the import writes it as the block's tx_root (import.ts IMPORT_SQL.witnessTxRoot)",
  },
  {
    table: 'fork_2_0',
    column: 'fold',
    core: [],
    bindings: pre20('chain', 'canonical'),
    reason:
      'recomputed from the fold below and the block, to the pins (judge.ts stepFork20)',
  },
  {
    table: 'fork_2_0',
    column: 'h2',
    core: [],
    bindings: pre20('checkpoint', 'canonical'),
    reason:
      "recomputed from the block's fields, and folded to hash_list_1_0's pins (judge.ts recomputeH2)",
  },
  {
    table: 'wallets',
    column: 'address',
    core: ['wallets.address'],
    bindings: all('signature'),
    reason:
      "the SHA-256 of the key (verify-bands.ts 'wallets'); the key is checked by sampled signatures",
  },
  {
    table: 'wallets',
    column: 'public_modulus',
    core: ['wallets.public_modulus'],
    bindings: all('signature'),
    reason: 'verifies the signatures of the transactions sampled',
  },
];

/**
 * `core.db` columns an import writes that no band column carries: derived
 * from the rows, or the import's own.
 */
export const DERIVED_CORE_COLUMNS: Record<string, string> = {
  'stable_blocks.missing_tx_count':
    'the links whose transaction the band lacks, counted (import.ts countMissing)',
  'stable_transactions.indexed_at': 'when the import wrote the row',
  'parquet_l1_kept_data_roots.id':
    "the gateway's own format-1 roots, kept across the clear and restored for a band without witnesses; an l1-4 band's witnessed roots are written over them",
  'parquet_l1_kept_data_roots.data_root': 'as parquet_l1_kept_data_roots.id',
  ...Object.fromEntries(
    [
      'band_id',
      'height_from',
      'height_to',
      'band_digest',
      'rows_imported',
      'started_at',
      'completed_at',
      'binding',
      'accepted',
    ].map((c) => [`parquet_l1_imports.${c}`, "the import's own ledger"]),
  ),
};

/** The columns bound by `kind` in `era`, as `table.column`. */
export function columnsBoundBy(kind: Binding, era: Era): string[] {
  return COLUMN_BINDINGS.filter((b) => b.bindings[era] === kind).map(
    (b) =>
      `${b.table}.${b.column}${b.when !== undefined ? ` (${b.when})` : ''}`,
  );
}

/**
 * What the verifier's result says of the columns no check binds, in its
 * `assurance`: those bound only by the sample, and those bound by nothing.
 */
export function bindingsAssurance(): string[] {
  const list = (kind: Binding) =>
    ERAS.map((era) => {
      const columns = columnsBoundBy(kind, era);
      return columns.length === 0 ? undefined : `${era}: ${columns.join(', ')}`;
    })
      .filter((x) => x !== undefined)
      .join('; ');
  const none = list('none');
  return [
    `columns bound only by the sample (column-bindings.ts; below the 2.0 fork the headers are attested by --anchor-min machines, not recomputed): ${list('sample')}`,
    `columns bound only by their signature, checked on the sample: ${list('signature')}`,
    ...(none.length > 0
      ? [`columns bound by nothing, as their publisher wrote them: ${none}`]
      : []),
  ];
}

/** The table as `docs/cli.md` shows it, between its markers. */
export function renderBindingsTable(): string {
  const lines = [
    `| Column | ${ERAS.join(' | ')} | Why |`,
    `|---|${ERAS.map(() => '---').join('|')}|---|`,
  ];
  for (const b of COLUMN_BINDINGS) {
    lines.push(
      `| \`${b.table}.${b.column}\`${b.when !== undefined ? ` (${b.when})` : ''} | ${ERAS.map((era) => `\`${b.bindings[era]}\``).join(' | ')} | ${b.reason.replace(/\|/g, '\\|')}${b.representation !== undefined ? `. Stored as: ${b.representation}` : ''} |`,
    );
  }
  return lines.join('\n');
}
