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
 * Three kinds of pin: a clause of HEAD's source ({@link CONSENSUS_PINS}:
 * the `chain.ts` rules, the per-era `indep_hash` recompute in
 * `block-hash.ts`, the merkle folds, the signature preimages), a whole file
 * ({@link FILE_PINS}: `hash_list_1_0`, the pre-2.0 trust root), and source
 * that is gone from HEAD, by commit and blob ({@link HISTORICAL_PINS}).
 *
 * Verified against `ArweaveTeam/arweave` at the commit below on
 * 2026-10-07, and the added pins on 2026-10-22. Refresh the clone with
 * `mr update` (see `.mrconfig`).
 */
export const ARWEAVE_COMMIT = '18d402c7';

export interface ConsensusPin {
  /** Path inside the arweave checkout. */
  file: string;
  /** The first line of the clause, used to find it. */
  startsWith: string;
  /**
   * Which line starting with `startsWith` (1-based, default 1). `ar_fork`
   * defines each height under `-ifdef(FORKS_RESET)` (every fork at 0, for
   * tests) and sometimes `-ifdef(FORK_x_HEIGHT)` (an override) before the
   * mainnet clause, so the mainnet clause is a later occurrence. Pinning
   * the first one pinned the test build's `0.` and left the mainnet height
   * unchecked.
   */
  occurrence?: number;
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
    file: 'apps/arweave/include/ar_consensus.hrl',
    startsWith: '-define(STRICT_DATA_SPLIT_THRESHOLD,',
    lines: 1,
    mirrors:
      'STRICT_DATA_SPLIT_THRESHOLD, where the weave accounting stops holding',
    sha256: 'd68bffeb1b88b4f99f262b17c474172571be8bd8be8999211662fe0797e8bf40',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_1_6() ->',
    occurrence: 2,
    lines: 2,
    mirrors: 'FORK_1_6 (95,000): the 1.6 hash_list_merkle seed',
    sha256: 'c418aebff40e2a055a41e8c6b71be2f6441ba414206c3629a14c1a0bf5aa60df',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_0() ->',
    occurrence: 2,
    lines: 2,
    mirrors:
      'FORK_2_0 (422,250): the 2.0 seed, the first recomputable indep_hash, and the pre-2.0 boundary',
    sha256: '887b4dd2b22c388d9fec9eeba9b1a4a79a84a77e7317324c6ea65631a4f56e39',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_4() ->',
    occurrence: 2,
    lines: 2,
    mirrors:
      'FORK_2_4 (633,720): block-hash.ts era switch (poa leaves the base segment)',
    sha256: 'd5c2026e7b8afb08c1b1d5a9008aa0fc7ac9bd9ce87d88f01904def01bd3cb03',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_5() ->',
    occurrence: 2,
    lines: 2,
    mirrors:
      'FORK_2_5 (812,970): computeTxRoot padding, and block-hash.ts era switch (usd rates, binary tags)',
    sha256: '60396602d09401777280e26706ff4463f40e551738207cc20634a2682b171550',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_6() ->',
    occurrence: 3,
    lines: 2,
    mirrors: 'FORK_2_6 (1,132,210): block-hash.ts signed-hash era',
    sha256: '382d54d10bb4062a6619059273d3f13bc5050b99dc96381fd363d72119a302fa',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_7() ->',
    occurrence: 3,
    lines: 2,
    mirrors:
      'FORK_2_7 (1,275,480): block-hash.ts era switch (poa paths, chunk hashes, vdf difficulty)',
    sha256: 'd84a1daa58dc893d00b26fc0dc8a051f9b6b4b4d324e23625103f3c8ce95e250',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_8() ->',
    occurrence: 3,
    lines: 2,
    mirrors:
      'FORK_2_8 (1,547,120): block-hash.ts era switch (packing difficulty, unpacked chunk hashes)',
    sha256: '2566f391346710d64b49a9627acb526ab8f9d29f5bcb7685bb4d87ed5a71a5a8',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_9() ->',
    occurrence: 3,
    lines: 2,
    mirrors:
      'FORK_2_9 (1,602,350): block-hash.ts era switch (replica_format, double_signing_proof encoding)',
    sha256: '8a3ec20e78ccf3202c4ab0c2153337f93c54a05f098b1bf87b11a4b9a411da85',
  },
  {
    file: 'apps/arweave/src/ar_fork.erl',
    startsWith: 'height_2_9_6() ->',
    occurrence: 3,
    lines: 2,
    mirrors: 'FORK_2_9_6 (2,000,000): block-hash.ts, the last era it knows',
    sha256: 'e966841cebb29fa490ba3ccc616088f3b35bef467231999695b5d39b78c2ae71',
  },
  {
    file: 'apps/arweave/src/ar_unbalanced_merkle.erl',
    startsWith: 'hash_block_index_entry({BH, WeaveSize, TXRoot}) ->',
    lines: 2,
    mirrors:
      'nextHashListMerkle / hashListMerkleSeed: each entry is deepHash([indep_hash, decimal weave_size, tx_root])',
    sha256: 'ba57bd07c8c84e14659a90aaa23faf7715e0e79eeb29484445f1b43785114679',
  },
  {
    file: 'apps/arweave/src/ar_unbalanced_merkle.erl',
    startsWith: 'hash_list_to_merkle_root(HL) ->',
    lines: 6,
    mirrors: 'foldSeed: the 1.6 seed folds indep_hash genesis-first from <<>>',
    sha256: '392c322c8a001a6408e78dbc240503b753670d73e42cad536a24a546acda8608',
  },
  {
    file: 'apps/arweave/src/ar_unbalanced_merkle.erl',
    startsWith: 'block_index_to_merkle_root(HL) ->',
    lines: 6,
    mirrors:
      'hashListMerkleSeed (P2): the 2.0 seed folds block-index entries genesis-first from <<>>',
    sha256: '29a5308d1d5f99583b55b6fdeb2be1921b4641ef4bcebc170a4b1da19b1869d5',
  },
  {
    file: 'apps/arweave/src/ar_join.erl',
    startsWith:
      '    ExpectedBIMerkleH = ar_unbalanced_merkle:block_index_to_merkle_root(tl(BI)),',
    lines: 3,
    mirrors:
      "the fact that a tip's hash_list_merkle folds the whole block index from genesis (why one anchor binds every post-2.0 block)",
    sha256: '3604887d11ab5257e48a5636379cb8b66934c7c99ad203a14b3110aa6490af4f',
  },
  {
    file: 'apps/arweave/src/ar_deep_hash.erl',
    startsWith: 'hash(List) when is_list(List) -> hash_bin_or_list(List).',
    lines: 20,
    mirrors: 'deepHash in block-hash.ts: blob/list tags, SHA-384 fold',
    sha256: '092515b896eb7f7367dd20497cc778aa78fc2f38a4ab949210fbe9c74da4c54e',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(DEEP_HASH_ALG,',
    lines: 1,
    mirrors: 'deepHash uses SHA-384',
    sha256: '27bccfc4cf9fbdf3542ab349b89f41570b33ef75eb674dc2e72843ff69fe23db',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(MERKLE_HASH_ALG,',
    lines: 1,
    mirrors: 'hash_list_merkle and the 1.6/2.0 seed folds use SHA-384',
    sha256: '2245046b7cbdc3844a179f44e5ab6404e5ff01b4f7d7a1c3bfee79ff87e7e8ac',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(HASH_ALG,',
    lines: 1,
    mirrors:
      'SHA-256 for tx ids (sha256(signature)), wallet addresses and the 2.6+ signed block segment',
    sha256: 'b078b986bfcb1215f2350244a04f2183365ca1f828b07ae6d0bb75dfe593079a',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(NOTE_SIZE,',
    lines: 1,
    mirrors: 'computeTxRoot / v1DataRoot: 32-byte offset notes in merkle nodes',
    sha256: 'f3b33bc12e198bfb1a46a1a75fb258d3067703f3bb257bb8a5eee8c61910efcb',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(DATA_CHUNK_SIZE,',
    lines: 1,
    mirrors: 'CHUNK (256 KiB) in chain.ts: v1 chunking and the 2.5 padding',
    sha256: '60f4478ff836cf9123fb95a5c91d60e75e9c72d9ddd84ec708efb0efe589b982',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(PADDING_NODE_DATA_ROOT,',
    lines: 1,
    mirrors: "computeTxRoot: the 2.5 padding leaf's empty data root",
    sha256: 'fc636dcf046fc643affe4386517c1b0a8fbe972b3fbb64e2ee6da2a7a46d3a25',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'indep_hash(B) ->',
    lines: 9,
    mirrors: 'indepHashFromHeader in block-hash.ts: which rule each era uses',
    sha256: '91708b4dd75c20208b01fabeedbba6a4b379bc74e4ba35b929feb8fa0d778473',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'generate_signed_hash(#block{',
    lines: 116,
    mirrors: 'indepHashFromHeader, 2.6+: the signed segment field by field',
    sha256: '51754cafa59d9a738c377751c3404d2e3c7a40405faff8a5738953ba77538f48',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'indep_hash2(SignedH, Signature) ->',
    lines: 2,
    mirrors: 'indepHashFromHeader, 2.6+: sha384(signed hash ++ signature)',
    sha256: 'b037918305c67653b66126e1d87cf7604520baf07e10793b34bfee8b5dd62b73',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'indep_hash(BDS, B) ->',
    lines: 8,
    mirrors:
      'indepHashFromHeader, 2.0-2.6 (and hash20Of10Block): deepHash([BDS, hash, nonce(, poa)])',
    sha256: '7fef30e3f85a736afb5b60b07494fb795fd76ecd46f54be1d87428bf652ca7ff',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'generate_block_data_segment(BDSBase, B) ->',
    lines: 12,
    mirrors: 'indepHashFromHeader, 2.0-2.6: the block data segment',
    sha256: '350b2f4ae751b66957f9c6b205c5f62f0e42503d86fba6e9bf8b96582bf97a9c',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'generate_block_data_segment_base(B) ->',
    lines: 56,
    mirrors: 'indepHashFromHeader, 2.0-2.6: the segment base per era',
    sha256: '06e31f5bfa4128386233a4c432405400f11f8b901580b05278da5e6dc13f91a0',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'encode_tags(B) ->',
    lines: 7,
    mirrors:
      'indepHashFromHeader: block tags as name/value pairs before 2.5, binaries after',
    sha256: '2e9ad82a1ea19bcbd236945d396acfd79f71b74b61f2fa9c2c44161c61c959b9',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'poa_to_list(POA) ->',
    lines: 7,
    mirrors:
      'indepHashFromHeader, 2.0-2.6: [option, tx_path, data_path, chunk]',
    sha256: 'c39e58b3e6b53d4b155cb978c47ab50f568cb80211e717480fed9cf050e4e821',
  },
  {
    file: 'apps/arweave/src/ar_block.erl',
    startsWith: 'verify_block_hash_list_merkle(NewB, CurrentB) ->',
    lines: 5,
    mirrors: 'nextHashListMerkle: the recurrence per era',
    sha256: '7fa0e3deb3e47343fc4f044daf3c425bf4019ce634450d26e70956a7cb8e9c40',
  },
  {
    file: 'apps/arweave/src/ar_serialize.erl',
    startsWith: 'encode_int(undefined, SizeBits) ->',
    lines: 5,
    mirrors:
      'block-hash.ts encInt: length-prefixed big-endian unsigned, absent = zero length',
    sha256: '2175250ca785545bfeb9a32876be2c4a652f65178f085b19a5be964b2055ba55',
  },
  {
    file: 'apps/arweave/src/ar_serialize.erl',
    startsWith: 'encode_bin(undefined, SizeBits) ->',
    lines: 4,
    mirrors:
      'block-hash.ts encBin: length-prefixed binary, absent = zero length',
    sha256: '10e18bec4264239bd2284d3dd3d4479afd0fe683a01b72703b6430b638eb0305',
  },
  {
    file: 'apps/arweave/src/ar_serialize.erl',
    startsWith: 'encode_bin_list(Bins, LenBits, ElemSizeBits) ->',
    lines: 8,
    mirrors: 'block-hash.ts encBinList: elements emitted in REVERSE order',
    sha256: '31408b51cad6ee1e207f90e55cf57cfd1f529458ecc97f6550d3850e5e434092',
  },
  {
    file: 'apps/arweave/src/ar_serialize.erl',
    startsWith: 'encode_double_signing_proof(undefined, _Height) ->',
    lines: 21,
    mirrors:
      'block-hash.ts: double_signing_proof encodings (empty = <<0>>, the 2.9 change)',
    sha256: 'c8ed6c6e48cbb95fb24f5dc4b65ea1bdeaf587ec1ddbffe447b131290b2183cb',
  },
  {
    file: 'apps/arweave/src/ar_serialize.erl',
    startsWith: 'block_to_json_struct(',
    lines: 202,
    mirrors:
      'block-hash.ts: the /block JSON field names and encodings the recompute reads, and the keys it knows',
    sha256: '4fbea0939e75f4a6476be1a35d3928b5fb4a87a954cde2dd62c7743f5c663807',
  },
  {
    file: 'apps/arweave/src/ar_serialize.erl',
    startsWith: 'nonce_limiter_info_to_json_struct(Height,',
    lines: 24,
    mirrors:
      'block-hash.ts: nonce_limiter_info JSON names (zone_upper_bound, checkpoints)',
    sha256: '5cfb0c62ece9aa8e925e8fa98f4e424025089e1238eaf8f2db23b294f4473e2b',
  },
  {
    file: 'apps/arweave/src/ar_header_sync.erl',
    startsWith: 'download_block(Peers, H, H2, TXRoot) ->',
    lines: 38,
    mirrors:
      "hash20Of10Block (P1): a pre-2.0 header hashed by the 2.0 rule with tx_root := the block index's and txs sorted",
    sha256: 'abdd61c000f01b1b9fee2da914d8bf85a3f4b6e6109f7f27153d0d4107c1c8ac',
  },
  {
    file: 'apps/arweave/src/ar_node.erl',
    startsWith: 'get_2_0_hash_of_1_0_block(Height) ->',
    lines: 9,
    mirrors: 'P1 indexing: entry nth(422250 - Height), 1-based',
    sha256: 'b67278cf01d1da73250738a12cf60410c58b7d5f3b260051efeb8ddb93fa2cef',
  },
  {
    file: 'apps/arweave/src/ar_node_worker.erl',
    startsWith: 'read_hash_list_2_0_for_1_0_blocks() ->',
    lines: 12,
    mirrors: 'P1: the list comes from genesis_data/hash_list_1_0',
    sha256: '76bcc4a99baf55131482dd43a84329f118aab7601b3217c072028e2e3d39f77b',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'generate_signature_data_segment(#tx{ format = 2 } = TX) ->',
    lines: 9,
    mirrors:
      'the sampled signature check: which preimage each format and key type signs',
    sha256: '77a5dfa3eb2468e1acd54394610466923acc31ba1855d0dc3e1d7ecf46537b49',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith:
      'get_weave_size_increase(#tx{ data_size = DataSize }, Height) ->',
    lines: 13,
    mirrors:
      'weave accounting: growth is data_size below the padding threshold, padded above',
    sha256: '30361d5bb9016e19f36c682e48597abbf47e2038ce26e9c34ad4c72a7ba074f9',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'do_verify(#tx{ format = 1 } = TX, Args, VerifySignature) ->',
    lines: 15,
    mirrors:
      'judge.ts and tx-signature.ts: no format-1 transaction at or above the 2.9.6 fork (2,000,000)',
    sha256: 'f9c31df9d422f7da072130b8897f667dfe47fcd423b8db7b30b4ff0c702a3727',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'verify_malleability2(Args) ->',
    lines: 30,
    mirrors:
      'tx-signature.ts consensusProblem: a format-1 target is 32 bytes with a quantity and empty without, from block 2.4',
    sha256: '1f8ce48f88513ff7304b77a9418fcfebe1ad419b685cefadf474feb8b40a6905',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'verify_target_length(TX, Height) ->',
    lines: 9,
    mirrors:
      'tx-signature.ts consensusProblem: target length by quantity, in blocks above 2.4 (Height = H - 1)',
    sha256: '7702bb39c9cf138b0a31289ce46a359c412f781d70be114c2f18c49c9ef6c3dd',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'tx_field_size_limit_v1(TX, Height, Denomination) ->',
    lines: 24,
    mirrors:
      'tx-signature.ts consensusProblem: a format-1 anchor is at most 48 bytes in blocks above 1.8 (Height = H - 1), 32 before; data at most TX_DATA_SIZE_LIMIT',
    sha256: 'ef0cb1247f8f067e466e0ef0049cf0dd17c33b1c3862fd5f4c24434afa50baa4',
  },
  {
    file: 'apps/arweave/src/ar_node_utils.erl',
    startsWith:
      'validate_block(txs, {NewB = #block{ timestamp = Timestamp, height = Height, txs = TXs },',
    lines: 9,
    mirrors:
      "tx-signature.ts consensusProblem and the ECDSA gate: block H's transactions are validated with Height = H - 1, so `Height >= Fork` rules start at block Fork + 1",
    sha256: '44235898ed3a47822790e55789abc4e4a2bd13b92f99cfa5e81c11c05688705f',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'verify_malleability(Args) ->',
    lines: 14,
    mirrors:
      'tx-signature.ts consensusProblem: the malleability rule from block 2.4 (`Height + 1`), format 1 with no denomination only',
    sha256: 'bb09f5d3f7fa4b1c0545b87f7bb914cc0cb73de5305ad5a54fd123f04c165b29',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'verify_signature_type(#tx{ format = 2 } = TX, Height) ->',
    lines: 9,
    mirrors:
      'tx-signature.ts verifyIndexedTx: an ECDSA owner only on format 2, in blocks above the 2.9 fork',
    sha256: '49b1369544b757be954b608cc8c7963b8b77db68e93ffe8f1cef21c9e8ba7f11',
  },
  {
    file: 'apps/arweave/include/ar.hrl',
    startsWith: '-define(TX_DATA_SIZE_LIMIT,',
    lines: 1,
    mirrors:
      'tx-signature.ts V1_DATA_SIZE_LIMIT: no format-1 transaction carries more than 10 MiB',
    sha256: 'e07c0045b4e96c6f89c915dbbaef98d8bea94c309b321d72ed2ddd38e88d321b',
  },
  {
    file: 'apps/arweave/src/ar_http_iface_middleware.erl',
    startsWith: 'is_hidden_v1_denomination0_tx(TX) ->',
    lines: 12,
    mirrors:
      'sample.ts judgeTx: GET /tx hides some real format-1 transactions without a denomination (be18c1be), so a 404 never refutes a format-1 draw',
    sha256: 'bd9cc0a62578a93015d1f3b7b0729cde01408a0772544925cab9cf92268701f1',
  },
  {
    file: 'apps/arweave/src/ar_storage.erl',
    startsWith: 'is_v1_denomination0_local_tx(TX) ->',
    lines: 17,
    mirrors:
      'sample.ts judgeTx: the second way a node hides a format-1 transaction without a denomination',
    sha256: '431033be3bca35516a96aa15add2dd1da39c75812f819d9cd8e8595419095e21',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith:
      "verify({digest, Digest}, DigestType, Signature, PublicKey=#'RSAPublicKey'{modulus=N}) ->",
    lines: 44,
    mirrors:
      'rsa-pss.ts arweaveRsaPssVerify: the RSA-PSS rule every transaction from block 2.4 + 1 is checked by (masked top bits, any salt length)',
    sha256: 'e936260db344a90c7976f7bd38c5600626f879e4c49ca1d3dbe3ff73027837bc',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith:
      "verify_legacy({digest, Digest}, DigestType, Signature, PublicKey=#'RSAPublicKey'{modulus=N}) ->",
    lines: 44,
    mirrors:
      'rsa-pss.ts arweaveRsaPssVerify legacy: the rule below 2.4 (encoded message sized by bits div 8)',
    sha256: 'cf6308d31cb2bc76cf2680ab7a90d898d4398d31dad5c4ecf591bac750f97552',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith: 'mgf1(DigestType, Seed, Len, T, Counter) ->',
    lines: 4,
    mirrors: 'rsa-pss.ts mgf1',
    sha256: '0c63e52a37dcc19771ab9300c4cd82ea5cdb6254dd59f7f462e3cc1bc56551a9',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith: 'normalize_to_key_size(Bits, _A = << C, Rest/binary >>) ->',
    lines: 10,
    mirrors:
      'rsa-pss.ts normalizeToKeySize: bits above the modulus length masked, not checked',
    sha256: 'c860e13f467b248b6243785e0dae74249f8ec6d7b40cf74754998df6a19a743b',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith: 'pad_to_key_size(Bytes, Data) when byte_size(Data) < Bytes ->',
    lines: 4,
    mirrors: 'rsa-pss.ts padToKeySize',
    sha256: '42240689d60c6d7ee324f097b6fcece8f466d1847a3d634ab5984a3fb3a54e2c',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'verify_signature_v1(TX, verify_signature, Height) ->',
    lines: 10,
    mirrors:
      'tx-signature.ts: verify_pre_fork_2_4 below Height 2.4 (block 2.4 itself included), verify after',
    sha256: '70fe70133a3f5cc0500a8fe609ee47292ade359e5ba4a02e70408cc6b7add187',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'verify_signature_v2(TX, verify_signature, Height) ->',
    lines: 16,
    mirrors: 'tx-signature.ts: the same gate for format 2',
    sha256: '9b967fd20d6b7ef72cd3cfaa2392092c662c5cdc722fcbd08c50365ae47ed976',
  },
  {
    file: 'apps/arweave/src/ar_wallet.erl',
    startsWith: 'verify({{KeyAlg, PublicExpnt}, Pub}, Data, Sig)',
    lines: 24,
    mirrors:
      'rsa-pss.ts: ar_wallet:verify is rsa_pss:verify over SHA-256, e = 65537, false on any exception',
    sha256: '5ca03b3bd08acd43340f79335ed902834df14a3707280fcd44c61efb1e816109',
  },
  {
    file: 'apps/arweave/src/ar_wallet.erl',
    startsWith: 'verify_pre_fork_2_4({{KeyAlg, PublicExpnt}, Pub}, Data, Sig)',
    lines: 24,
    mirrors: 'rsa-pss.ts: verify_pre_fork_2_4 is rsa_pss:verify_legacy',
    sha256: 'ea3537624b5454875303b244dd7bbea6427f0c79a5d65cf39df71d030245e9f5',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'signature_data_segment_v2(TX) ->',
    lines: 20,
    mirrors:
      'the sampled signature check: v2 preimage (denomination prefix when > 0)',
    sha256: '93a34926f07f46700663dcb3f58b2b9ed5c4c76715cb9fd3c634900bbb9f3258',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'signature_data_segment_v2_no_public_key(TX) ->',
    lines: 19,
    mirrors: 'the sampled signature check: v2 ECDSA preimage, no owner',
    sha256: '664786279ae5e14eaea4c0557aee2050ad75e4c2ebfb8b1a53e578e3fe814d84',
  },
  {
    file: 'apps/arweave/src/ar_tx.erl',
    startsWith: 'signature_data_segment_v1(TX) ->',
    lines: 24,
    mirrors:
      'the sampled signature check: v1 preimage is a plain concatenation covering the data',
    sha256: '614700ede779ee9acd86000675e1d18e1595a8b7316facb665c7f22652112ec7',
  },
  {
    file: 'apps/arweave/src/ar_poa.erl',
    startsWith: 'get_padded_offset(Offset) ->',
    lines: 8,
    mirrors: 'computeTxRoot / weave accounting: chunk padding of offsets',
    sha256: '7899aeeb952d556571c03a6d55e1adfeb526cea3d99e9c5106900ea7bd30cab7',
  },
  {
    file: 'apps/arweave/src/ar_merkle.erl',
    startsWith: 'get_branch_id(LeftID, RightID, TreeMidpointOffset) ->',
    lines: 2,
    mirrors:
      'computeTxRoot / v1DataRoot (arweave-js buildLayers): a branch hashes both children and the midpoint note',
    sha256: '4e975699b1c17d5deff39115e9d9189243c86acf5eeb908d1dc85eeefdbbb1dd',
  },
  {
    file: 'apps/arweave/src/ar_merkle.erl',
    startsWith: 'generate_tree([], Stack, Tree) ->',
    lines: 7,
    mirrors: "computeTxRoot: an empty block's tx_root is <<>>",
    sha256: '08abb4d82ad63c27c32f8bcc645a052d3f58a0cc2e5b765a39c03fd228dcc28f',
  },
  {
    file: 'apps/arweave/src/ar_wallet.erl',
    startsWith: 'verify({{KeyAlg, PublicExpnt}, Pub}, Data, Sig)',
    lines: 46,
    mirrors:
      'the sampled signature check: RSA-PSS SHA-256 (and ECDSA) verification per key type',
    sha256: 'f6f2abc5d7756a6943955cb217945312a8258b6f3ac9a9c212dd5735ee777e46',
  },
  {
    file: 'apps/arweave/src/ar_wallet.erl',
    startsWith: 'verify_pre_fork_2_4({{KeyAlg, PublicExpnt}, Pub}, Data, Sig)',
    lines: 24,
    mirrors: 'the sampled signature check: legacy PSS verification before 2.4',
    sha256: 'ea3537624b5454875303b244dd7bbea6427f0c79a5d65cf39df71d030245e9f5',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith:
      'verify(Message, DigestType, Signature, PublicKey) when is_binary(Message) ->',
    lines: 46,
    mirrors:
      "the sampled signature check: salt length recovered from the encoding (Node's RSA_PSS_SALTLEN_AUTO)",
    sha256: '2f5ac6e8cf3c65a76452113d3fb8ad55d4c859c951f436c12b30ab70ecc4d430',
  },
  {
    file: 'apps/arweave/src/rsa_pss.erl',
    startsWith:
      'verify_legacy(Message, DigestType, Signature, PublicKey) when is_binary(Message) ->',
    lines: 46,
    mirrors: 'the sampled signature check: pre-2.4 legacy PSS byte-size rule',
    sha256: '49db641f419ddb2b10f4877f312b9d8c458d2d25b1640e43246dd7d1d4b8571d',
  },
];

/**
 * SHA-256 of `genesis_data/hash_list_1_0`, the whole file: the 422,250
 * "2.0 hashes" of the pre-2.0 blocks that every syncing Arweave node checks
 * pre-2.0 headers against (`ar_node_worker:read_hash_list_2_0_for_1_0_blocks`,
 * `ar_header_sync:download_block`). It is exactly the compact JSON list
 * `["<b64url>",...]`, so a verifier holding every pre-2.0 block can rebuild
 * it and compare one digest (route P1), with this as the trust root — the
 * same one an Arweave node places in the file it ships with.
 */
export const HASH_LIST_1_0_SHA256 =
  'd161502a13e64fa49bcb2425420bcdcd6a4407e488aca3e14ba254f16418ca6f';

/** A whole file of the checkout, pinned by the SHA-256 of its bytes. */
export interface FilePin {
  file: string;
  mirrors: string;
  sha256: string;
}

export const FILE_PINS: FilePin[] = [
  {
    file: 'genesis_data/hash_list_1_0',
    mirrors:
      'HASH_LIST_1_0_SHA256: the trust root for pre-2.0 block hashes (P1)',
    sha256: HASH_LIST_1_0_SHA256,
  },
];

/**
 * Source that no longer exists at HEAD, pinned by commit and git blob id. A
 * blob's content never changes, so this cannot drift; what it guards is the
 * citation. Checked only where the checkout has the history (a shallow
 * clone skips it).
 */
export interface HistoricalPin {
  /** A commit, as `git rev-parse` accepts it (`28df6bd5^` included). */
  commit: string;
  path: string;
  /** The full git blob id of `path` at `commit`. */
  blob: string;
  mirrors: string;
}

export const HISTORICAL_PINS: HistoricalPin[] = [
  {
    // "Introduce Arweave 2.0", 28df6bd54339d26f5e7839120ec63d96a9c2470d.
    commit: '28df6bd5',
    path: 'apps/arweave/src/ar_block.erl',
    blob: '06a309570917819c75868195c5d3b7c528b528e7',
    mirrors:
      'compute_hash_list_merkle with the Fork_2_0 seed (block_index_to_merkle_root over pre-2.0 entries) and hash_wallet_list_pre_2_0',
  },
  {
    commit: '28df6bd5',
    path: 'apps/arweave/src/ar_transition.erl',
    blob: 'b9c326a3a7ef6684e9ca6b56f62e52bca063acba',
    mirrors:
      'transition_block: the pre-2.0 tx_root the 2.0 seed and hash_list_1_0 use (generate_size_tagged_list_from_txs over v1 data)',
  },
  {
    // The parent of "Remove the 2.0 transition artifacts" (d43ba2b9),
    // 1730adf0acbba1208583d172dedcb38ca75df33e.
    commit: 'd43ba2b9^',
    path: 'apps/arweave/priv/fork_2_0_checkpoint',
    blob: 'b1de1ed686b6a9c52c163de33f35e9246e2ac292',
    mirrors:
      'FORK_2_0_FOLD_PINS and FORK_2_0_CHECKPOINT_SHA256: the per-height transition entries the 2.0 seed folds, heights 0 to 399,999 (fork-2-0-pins.test.ts recomputes the pins from it)',
  },
  {
    // The parent of 28df6bd5, f107262d50bef5cdbd88f4dbfe049c069eeacb5c.
    commit: '28df6bd5^',
    path: 'apps/arweave/src/ar_weave.erl',
    blob: 'e22f60b18bdae25e43670b1edd84f32b63d7da5a',
    mirrors:
      'the 1.0 indep_hash, which we do NOT recompute: it hashes the full wallet list (and before 1.6 the full hash list), which no header carries',
  },
];
