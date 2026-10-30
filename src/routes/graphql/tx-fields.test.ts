/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { GqlTransaction } from '../../types.js';
import {
  resolveTxFee,
  resolveTxParent,
  resolveTxQuantity,
} from './tx-fields.js';

const tx = (fields: Partial<GqlTransaction>) => fields as GqlTransaction;

describe('transaction field resolvers', () => {
  it('reads an amount in winston and in AR', () => {
    assert.deepEqual(resolveTxQuantity(tx({ quantity: '2464754868051' })), {
      ar: '2.464754868051',
      winston: '2464754868051',
    });
    assert.deepEqual(resolveTxFee(tx({ fee: '42361404' })), {
      ar: '0.000042361404',
      winston: '42361404',
    });
  });

  it('reads a missing amount as zero', () => {
    for (const quantity of ['', null, undefined]) {
      assert.deepEqual(
        resolveTxQuantity(tx({ quantity } as Partial<GqlTransaction>)),
        { ar: '0.000000000000', winston: '0' },
      );
    }
    for (const fee of ['', null, undefined]) {
      assert.deepEqual(resolveTxFee(tx({ fee } as Partial<GqlTransaction>)), {
        ar: '0.000000000000',
        winston: '0',
      });
    }
  });

  it('reads the parent of a data item, and none for an L1 transaction', () => {
    assert.deepEqual(resolveTxParent(tx({ parentId: 'bundle-id' })), {
      id: 'bundle-id',
    });
    assert.equal(resolveTxParent(tx({ parentId: null })), null);
  });
});
