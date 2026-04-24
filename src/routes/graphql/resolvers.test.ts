/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GraphQLResolveInfo, OperationDefinitionNode, parse } from 'graphql';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  extractTransactionNodeSelection,
  extractTransactionsNodeSelection,
  getPageSize,
  resolveTxData,
  resolveTxFee,
  resolveTxOwnerAddress,
  resolveTxOwnerKey,
  resolveTxQuantity,
  resolveTxRecipient,
  resolveTxSignature,
  resolvers,
} from './resolvers.js';
import { GqlTransaction } from '../../types.js';

const GQL_TX = {
  id: 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q',
  anchor: 'o0ymb8XbDEetKoMj1n02i-OBhiN_2YfGhYNRuUHpMdphCOZGCePCe26EdHbYFJ0h',
  signature:
    'TS2NVSyft8Hv-XaiozhvOb4U61cOMsdnh9FY8p4HcL3hzn533xbJv7stPyg4XXNcdZXXbb1Z-VMv94DzjtyzHc-CgGnAZbvfPBKDfYXxb46GcEo3LtDlCHmIDD-kwJUEU9h0XBK_JKdqN9n_kg9xprgq8GkTlrSSyTynVvNppwyZ1lXYLcbMovtXMOkRUQPI6SJ4T6INjVbT8D9NHwrKWzzdw0zA9IWBzn1SPzlk5jhq2kq0ZwL56tpADAQY-KiNU6U7GnVeSSd4-iHU_TE34p1XbT7noiKU27_exRgLC_-QjtiS0KjWnjR_GdvofYE_czfJUWXa-3z7dsmmLkks2qwE7B7OtB5GKTWYtKB7Ojp6V8SWCUb32Jqlt6wZHABqc0LCOO6uPws_7QK4xYWyNd-OXnBCBFacKvvz_YwQ0tX-OS5vALpQqz2j-3IrSubLfs9-CARooyD8mEXtjgzsPnzRHhhH8k9WA_bFo-KDWdWkdEIgIF7Y_OlxI2G7sMxo5ZOSdfUcQKRkmqBGWJxwss5fB2-MOjsDLLf8nd9kKtC8xiA0OkhbCit4Pt-ip-zQQW-P5ak1spjhUkxR-K3e6uVD2_i3St5jCP_JwtejjRp9brt8aLUIJiVo8GJIkChsIcxr_MA9iZvywZ2ZFNJAvY2G1PVO63lOYPjTL_JXVzo',
  recipient: '6p817XK-yIX-hBCQ0qD5wbcP05WPQgPKFmwNYC2xtwM',
  ownerAddress: 'k3hNqeW_8_WDBz6hwUAsu6DQ47sGXZUP5Q8MJP8BdsE',
  ownerKey:
    '0BUYi-XqwHu9NwKi7uvURVTcJgschq1MAliInZDXLXw300bN4usI6eUP-9RVLsocfcoXjNjyz6Xj603oD9iM7K8YxjTPfbLHzZ0MhphYD-1cn8fXta7PCXItjG9XIZZbkq7DCOgmljF1tjgtimQgUrjGZr3f9ddzIXDHdSzbLhrakxkeqFidXQctgIJyCInbMHenAfJyAfzLeGUO107vWmzEFDzO_-0FUYuLTQfNLhZw9WPSNKp3D8wSM2Z8BnQmuot827zrthR0vX7JAQQoTuAGREtalD4f1ysh2mcJJi9tmlN_9FCqZvhhQqrK2dJrtf11QXCQyCkKHiP47TyK2dAYnWl2mrQc9ntpMMC2Fqsa8Qb5z5zaaxGiM3mw-mLKpmTtywSVFYsn3kQtxG7_e04NIns6bL6PNLS5_7IX-6BNq8y1nHBARane4iHgQdHSBXCUkeagGTy6HjHc9g8zmRzi-VwWS8CD37bCadoVwZjA1oUB0vwvZ6pPeRQROS-iIQPuZgEQinGiuNbSbs3ezRPow1z7GbpbrYEy3Rgv3ozHZcGXwkHyohD5i0ST7H6VHZn27ieFiu48Hub0oA3XMJZRYJhBEopW8jjAQ_nPaQz-bioI2Jd_svwwlAcaIYfzUImoxYyQwzgnstkhIFk9tIFG4VratxdVH0HwOQY0jhE',
  fee: '477648',
  quantity: '7896935',
  dataSize: '0',
  contentType: undefined,
  blockIndepHash:
    'CT075juenGfi1wKif0Af-6Y9KJ2tR7kqPkeALB99eJUJnrWafqG8uq0kN4cpAN3I',
  blockTimestamp: 1639925391,
  height: 834713,
  blockPreviousBlock:
    '-WmnSux8p6DccMRwGh-jq3_wv_deZc0XsgpZnzt0WhPVpA5GmmBW14zhRMT3DbiT',
  parentId: null,
};

describe('getPageSize', () => {
  it("should return DEFAULT_PAGE_SIZE if 'first' is not set", () => {
    assert.equal(DEFAULT_PAGE_SIZE, getPageSize({ first: undefined }));
  });

  it("should return 'first' if it is set and less than MAX_PAGE_SIZE", () => {
    const first = MAX_PAGE_SIZE - 1;
    assert.equal(first, getPageSize({ first }));
  });

  it("should return MAX_PAGE_SIZE if 'first' is greater than MAX_PAGE_SIZE", () => {
    const first = MAX_PAGE_SIZE + 1;
    assert.equal(MAX_PAGE_SIZE, getPageSize({ first }));
  });
});

describe('resolveTxRecipient', () => {
  it('should return the recipient', () => {
    const recipient = resolveTxRecipient(GQL_TX as unknown as GqlTransaction);
    assert.equal(recipient, '6p817XK-yIX-hBCQ0qD5wbcP05WPQgPKFmwNYC2xtwM');
  });

  // turbo-gateway.com compatibility
  it('should return empty string if recipient is undefined', () => {
    const tx = { ...GQL_TX, recipient: undefined };
    const recipient = resolveTxRecipient(tx as unknown as GqlTransaction);
    assert.equal(recipient, '');
  });
});

describe('resolveTxData', () => {
  it('should return dataSize and contentType', () => {
    // TODO find a tx with content type set
    const tx = { ...GQL_TX, contentType: 'text/plain' };
    const dataResult = resolveTxData(tx as unknown as GqlTransaction);
    assert.deepEqual(dataResult, { size: '0', type: 'text/plain' });
  });
});

describe('resolveTxQuantity', () => {
  it('should return quantity in AR and winstons', () => {
    const quantity = resolveTxQuantity(GQL_TX as unknown as GqlTransaction);
    assert.deepEqual(quantity, { ar: '0.000007896935', winston: '7896935' });
  });
});

describe('resolveTxFee', () => {
  it('should return quantity in AR and winstons', () => {
    const fee = resolveTxFee(GQL_TX as unknown as GqlTransaction);
    assert.deepEqual(fee, { ar: '0.000000477648', winston: '477648' });
  });
});

describe('resolveTxOwnerAddress', () => {
  it('should return the owner address from the parent tx', () => {
    const address = resolveTxOwnerAddress({
      tx: GQL_TX as unknown as GqlTransaction,
    });
    assert.equal(address, 'k3hNqeW_8_WDBz6hwUAsu6DQ47sGXZUP5Q8MJP8BdsE');
  });
});

describe('resolveTxOwnerKey', () => {
  it('should return the inline owner key when present', async () => {
    const key = await resolveTxOwnerKey({
      tx: GQL_TX as unknown as GqlTransaction,
    });
    assert.equal(
      key,
      '0BUYi-XqwHu9NwKi7uvURVTcJgschq1MAliInZDXLXw300bN4usI6eUP-9RVLsocfcoXjNjyz6Xj603oD9iM7K8YxjTPfbLHzZ0MhphYD-1cn8fXta7PCXItjG9XIZZbkq7DCOgmljF1tjgtimQgUrjGZr3f9ddzIXDHdSzbLhrakxkeqFidXQctgIJyCInbMHenAfJyAfzLeGUO107vWmzEFDzO_-0FUYuLTQfNLhZw9WPSNKp3D8wSM2Z8BnQmuot827zrthR0vX7JAQQoTuAGREtalD4f1ysh2mcJJi9tmlN_9FCqZvhhQqrK2dJrtf11QXCQyCkKHiP47TyK2dAYnWl2mrQc9ntpMMC2Fqsa8Qb5z5zaaxGiM3mw-mLKpmTtywSVFYsn3kQtxG7_e04NIns6bL6PNLS5_7IX-6BNq8y1nHBARane4iHgQdHSBXCUkeagGTy6HjHc9g8zmRzi-VwWS8CD37bCadoVwZjA1oUB0vwvZ6pPeRQROS-iIQPuZgEQinGiuNbSbs3ezRPow1z7GbpbrYEy3Rgv3ozHZcGXwkHyohD5i0ST7H6VHZn27ieFiu48Hub0oA3XMJZRYJhBEopW8jjAQ_nPaQz-bioI2Jd_svwwlAcaIYfzUImoxYyQwzgnstkhIFk9tIFG4VratxdVH0HwOQY0jhE',
    );
  });

  it('should memoize the key promise on the parent across repeated calls', async () => {
    const parent = { tx: GQL_TX as unknown as GqlTransaction };
    const first = resolveTxOwnerKey(parent);
    const second = resolveTxOwnerKey(parent);
    assert.strictEqual(
      first,
      second,
      'repeated resolveTxOwnerKey calls on the same parent must share a Promise',
    );
    await first;
  });
});

function infoForTopLevelField(
  query: string,
  topLevelFieldName: string,
): GraphQLResolveInfo {
  const doc = parse(query);
  const op = doc.definitions[0] as OperationDefinitionNode;
  const field = op.selectionSet.selections.find(
    (s) => s.kind === 'Field' && s.name.value === topLevelFieldName,
  );
  if (field === undefined) {
    throw new Error(`missing top-level field ${topLevelFieldName}`);
  }
  return { fieldNodes: [field] } as unknown as GraphQLResolveInfo;
}

function topLevelFieldNames(info: GraphQLResolveInfo | undefined): string[] {
  const names: string[] = [];
  for (const sel of info?.fieldNodes[0]?.selectionSet?.selections ?? []) {
    if (sel.kind === 'Field') names.push(sel.name.value);
  }
  return names;
}

describe('extractTransactionsNodeSelection', () => {
  it('returns the node sub-selection from a transactions query', () => {
    const info = infoForTopLevelField(
      `{ transactions { edges { node { id anchor } } } }`,
      'transactions',
    );
    const node = extractTransactionsNodeSelection(info);
    assert.notEqual(node, undefined);
    const names = (node?.selections ?? [])
      .filter((s) => s.kind === 'Field')
      .map((s) => (s as { name: { value: string } }).name.value);
    assert.deepEqual(names, ['id', 'anchor']);
  });

  it('returns undefined when node selection is absent', () => {
    const info = infoForTopLevelField(
      `{ transactions { pageInfo { hasNextPage } } }`,
      'transactions',
    );
    assert.equal(extractTransactionsNodeSelection(info), undefined);
  });
});

describe('extractTransactionNodeSelection', () => {
  it('returns the top-level selection for transaction(id: ...)', () => {
    const info = infoForTopLevelField(
      `{ transaction(id: "x") { id anchor } }`,
      'transaction',
    );
    const sel = extractTransactionNodeSelection(info);
    assert.notEqual(sel, undefined);
    const names = (sel?.selections ?? [])
      .filter((s) => s.kind === 'Field')
      .map((s) => (s as { name: { value: string } }).name.value);
    assert.deepEqual(names, ['id', 'anchor']);
  });
});

// Smoke test for the helper itself so tests above don't drift silently.
describe('topLevelFieldNames helper', () => {
  it('extracts names from a synthetic GraphQLResolveInfo', () => {
    const info = infoForTopLevelField(
      `{ transaction(id: "x") { id anchor } }`,
      'transaction',
    );
    assert.deepEqual(topLevelFieldNames(info), ['id', 'anchor']);
  });
});

describe('Transaction.block resolver', () => {
  // The resolver is defined inline on the exported resolvers object; cast so
  // we can call it directly with just the parent arg.
  const blockResolver = (
    resolvers.Transaction as { block: (p: GqlTransaction) => unknown }
  ).block;

  it('returns null for an unmined data item even when height is populated', () => {
    // Scenario: header enqueued via admin API before its bundle/parent tx is
    // on chain. No block row exists, so blockIndepHash/blockTimestamp/
    // blockPreviousBlock are null. `height` may still be populated (from a
    // cursor, a decoded header, or a ClickHouse row). Returning a partial
    // Block here would violate the non-nullable schema on Block.timestamp.
    const tx = {
      ...GQL_TX,
      blockIndepHash: null,
      blockTimestamp: null,
      height: 834713,
      blockPreviousBlock: null,
    };
    assert.equal(blockResolver(tx as unknown as GqlTransaction), null);
  });

  it('returns a fully populated Block when the tx is mined', () => {
    assert.deepEqual(blockResolver(GQL_TX as unknown as GqlTransaction), {
      id: 'CT075juenGfi1wKif0Af-6Y9KJ2tR7kqPkeALB99eJUJnrWafqG8uq0kN4cpAN3I',
      timestamp: 1639925391,
      height: 834713,
      previous:
        '-WmnSux8p6DccMRwGh-jq3_wv_deZc0XsgpZnzt0WhPVpA5GmmBW14zhRMT3DbiT',
    });
  });

  it('returns null when all block fields are null', () => {
    const tx = {
      ...GQL_TX,
      blockIndepHash: null,
      blockTimestamp: null,
      height: null,
      blockPreviousBlock: null,
    };
    assert.equal(blockResolver(tx as unknown as GqlTransaction), null);
  });
});

describe('resolveTxSignature', () => {
  it('should return signature', async () => {
    const signature = await resolveTxSignature(
      GQL_TX as unknown as GqlTransaction,
    );
    assert.equal(
      signature,
      'TS2NVSyft8Hv-XaiozhvOb4U61cOMsdnh9FY8p4HcL3hzn533xbJv7stPyg4XXNcdZXXbb1Z-VMv94DzjtyzHc-CgGnAZbvfPBKDfYXxb46GcEo3LtDlCHmIDD-kwJUEU9h0XBK_JKdqN9n_kg9xprgq8GkTlrSSyTynVvNppwyZ1lXYLcbMovtXMOkRUQPI6SJ4T6INjVbT8D9NHwrKWzzdw0zA9IWBzn1SPzlk5jhq2kq0ZwL56tpADAQY-KiNU6U7GnVeSSd4-iHU_TE34p1XbT7noiKU27_exRgLC_-QjtiS0KjWnjR_GdvofYE_czfJUWXa-3z7dsmmLkks2qwE7B7OtB5GKTWYtKB7Ojp6V8SWCUb32Jqlt6wZHABqc0LCOO6uPws_7QK4xYWyNd-OXnBCBFacKvvz_YwQ0tX-OS5vALpQqz2j-3IrSubLfs9-CARooyD8mEXtjgzsPnzRHhhH8k9WA_bFo-KDWdWkdEIgIF7Y_OlxI2G7sMxo5ZOSdfUcQKRkmqBGWJxwss5fB2-MOjsDLLf8nd9kKtC8xiA0OkhbCit4Pt-ip-zQQW-P5ak1spjhUkxR-K3e6uVD2_i3St5jCP_JwtejjRp9brt8aLUIJiVo8GJIkChsIcxr_MA9iZvywZ2ZFNJAvY2G1PVO63lOYPjTL_JXVzo',
    );
  });
});
