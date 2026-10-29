/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// Field resolvers that read only the flat GqlTransaction. They live apart from
// resolvers.ts, which imports system.js: importing them from there starts the
// whole node (database workers, background workers) in whatever process does
// the import, a test process included.
import { winstonToAr } from '../../lib/encoding.js';
import { GqlTransaction } from '../../types.js';

export function resolveTxQuantity(tx: GqlTransaction) {
  return {
    ar: winstonToAr(tx.quantity || '0'),
    winston: tx.quantity || '0',
  };
}

export function resolveTxFee(tx: GqlTransaction) {
  return {
    ar: winstonToAr(tx.fee || '0'),
    winston: tx.fee || '0',
  };
}

export function resolveTxParent(tx: GqlTransaction) {
  if (tx.parentId === null) {
    return null;
  }
  return {
    id: tx.parentId,
  };
}
