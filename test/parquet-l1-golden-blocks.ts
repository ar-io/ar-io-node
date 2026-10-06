/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Blocks recorded from Arweave mainnet on 2026-10-06, with the `data_root`
 * of each format-1 transaction derived from the data the chain holds.
 *
 * These exist so the audit's arithmetic is tested against the real chain
 * without a test needing the network. `txRoot` is what the block commits;
 * feeding `derivedDataRoot` into `computeTxRoot` must reproduce it.
 *
 * 453548 is the simplest case there is: one v1 transaction carrying one
 * byte. 1028547 is the awkward one: a v1 transaction with data beside
 * four format-2 transactions, above fork 2.5, so chunk padding applies.
 */
export interface GoldenBlock {
  height: number;
  txRoot: string;
  txs: Array<{
    id: string;
    format: number;
    dataSize: number;
    dataRoot: string | null;
    derivedDataRoot?: string;
  }>;
}

export const GOLDEN_BLOCKS: GoldenBlock[] = [
  {
    height: 453548,
    txRoot: '0CxWWKmHJ_HhH3SAXewY_XiPE2YPKWEWOPp3TDEXNZI',
    txs: [
      {
        id: 'i1L2yBOj3GGEGHdPjbSFdXu5NmBpXRS6jiLKXBVshfg',
        format: 1,
        dataSize: 1,
        dataRoot: null,
        derivedDataRoot: 'RxppVo10XPgW2Ni7tRxN5XzUuGVVHERp_OqfyrzWi44',
      },
    ],
  },
  {
    height: 1028547,
    txRoot: 'JNQXDVNa-rxJeW65Odefe-voiR2Fp9yI7nVNPD-qtuI',
    txs: [
      {
        id: 'D4fxStkoap5H1aZaZJOn2WAtuuweFIUJ9fmSNB92f8g',
        format: 1,
        dataSize: 1614,
        dataRoot: null,
        derivedDataRoot: 'NJxYD0E1IhdP69fXNvbwfzRU1dzWIMjVLwwQdw1UFas',
      },
      {
        id: '64DEu7YUZahZSEZtiy0xt46qjN4aPwVzmUGoPul8sbE',
        format: 2,
        dataSize: 202238,
        dataRoot: 'gV6i6-zQrEb2Ny--9q4Arlfnfxlx1WF0mDD-9edJd60',
      },
      {
        id: 'fh8J-PwQgqqB6oX_JXD4qe741tnH9lJLy9xxbbpQlw4',
        format: 2,
        dataSize: 19643,
        dataRoot: '3fcRxaSexoUyIjgPcMAZnIh0ugs1Qk9Ri7oVRD9w_3E',
      },
      {
        id: 'EM_6eNSwmQ7RwQvdaxctyYjMAnAIpRtXFPr9OWPcrlA',
        format: 2,
        dataSize: 33016,
        dataRoot: '7Rwg6U2qmEowCsvzf087b2OKxwBStcz1ZBp-Ea2PULc',
      },
      {
        id: 'piPFceXya9pjr9zg75Me7vPYF2NZEQtnO7-bu85fMNQ',
        format: 2,
        dataSize: 0,
        dataRoot: null,
      },
    ],
  },
];
