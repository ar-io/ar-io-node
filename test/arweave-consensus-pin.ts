/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The Arweave source our chain rules were read from, pinned.
 *
 * `src/lib/parquet-l1/chain.ts` is a second implementation of part of
 * Arweave's consensus hashing, in a different language. That is worth
 * owning — it is what lets an index be checked against the chain without
 * running a node — but the cost of owning it is that upstream can change
 * a rule and we would never know. A verifier that is quietly wrong is
 * worse than none, because it manufactures either false confidence or
 * false alarms, and both get believed.
 *
 * So each rule records the function it came from and a digest of that
 * function's text. The check reports a change; it does not judge one. An
 * upstream edit may be a comment, a refactor, or a fork that changes what
 * a block hash is, and only a human reading the diff can tell which.
 *
 * Verified against `ArweaveTeam/arweave` at the commit below on
 * 2026-10-07. Refresh the clone with `mr update` (see `.mrconfig`).
 */
export const ARWEAVE_COMMIT = '18d402c7';

export interface ConsensusPin {
  /** Path inside the arweave checkout. */
  file: string;
  /** The first line of the clause, used to find it. */
  startsWith: string;
  /** Lines of the definition this pin covers. */
  lines: number;
  /** What we mirrored from it, and where. */
  mirrors: string;
  sha256: string;
}

export const CONSENSUS_PINS: ConsensusPin[] = [
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'generate_size_tagged_list_from_txs(TXs, Height) ->',
    lines: 28,
    mirrors:
      'computeTxRoot: the sort by format then id, the per-transaction leaf, and the fork-2.5 padding node',
    sha256: '5eb8fbacd4b28d177e077787e66b975b8f3f4f5e07b50ec408c90b9f04dc8ebe',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'generate_tx_tree(B) ->',
    lines: 4,
    mirrors:
      'computeTxRoot: that the transaction id is dropped before the tree, so tx_root does not bind ids',
    sha256: '1556bdfa934217cc6b76469d8c8b8c7a841a0a828e4e8745b104cc1705d8256f',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith:
      'chunk_binary(ChunkSize, Bin) when byte_size(Bin) < ChunkSize ->',
    lines: 5,
    mirrors:
      'v1DataRoot: fixed-size chunks with the remainder last and NO rebalancing, unlike arweave-js',
    sha256: '93917998084d94b91291c11e800b3a7ef62384823bd3c4847f9cf28d4dba2686',
  },
  {
    file: 'apps/arweave/src/ar_merkle.erl',
    startsWith: 'get_leaf_id(Data, EndOffset) ->',
    lines: 2,
    mirrors: 'the leaf hash both tx_root and v1DataRoot build on',
    sha256: '9ec55b0ebed51ae138cdb892011bfc9947384ee00b9ea1a8669e3cb6a5b9f398',
  },
  {
    file: 'apps/arweave/src/ar_unbalanced_merkle.erl',
    startsWith: 'root(OldRoot, Data, Fun) -> root(OldRoot, Fun(Data)).',
    lines: 4,
    mirrors:
      'nextHashListMerkle: the running commitment to every block hash below',
    sha256: '61f4d401c591cf439fca8caf8973325e8a1890232c0e5f4d2e37dc0bc1b7229d',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_1_6() ->',
    lines: 3,
    mirrors: 'FORK_1_6',
    sha256: '8ad86b2273e1f96cc0e09ff251699141f135f4ae694182d7c18429b591e85844',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_0() ->',
    lines: 3,
    mirrors: 'FORK_2_0',
    sha256: '67b203b8a525dde45ded822b8d3e98a1417cba3c44f81d9bf4fcec1c93176884',
  },
  {
    file: 'apps/arweave/include/ar_consensus.hrl',
    startsWith: '-define(STRICT_DATA_SPLIT_THRESHOLD,',
    lines: 1,
    mirrors:
      'STRICT_DATA_SPLIT_THRESHOLD, where the weave accounting stops holding',
    sha256: 'd68bffeb1b88b4f99f262b17c474172571be8bd8be8999211662fe0797e8bf40',
  },
];
