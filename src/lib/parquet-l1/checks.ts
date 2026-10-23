/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The shape every index verifier reports a check in, shared by the L1 and
 * L2 verifiers so a reader of one result can read the other.
 */

/** Failing heights kept per check, so a broken index reports rather than floods. */
export const MAX_FAILURES_REPORTED = 20;

export interface VerifyFailure {
  height: number;
  found: string;
  expected: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
  failures?: VerifyFailure[];
  /** Failing heights beyond the ones listed. */
  more?: number;
}

/** Marks a check failed, keeping the first {@link MAX_FAILURES_REPORTED} failures. */
export const addFailure = (
  check: VerifyCheck,
  failure: VerifyFailure,
): void => {
  check.ok = false;
  check.failures ??= [];
  if (check.failures.length < MAX_FAILURES_REPORTED) {
    check.failures.push(failure);
  } else {
    check.more = (check.more ?? 0) + 1;
  }
};

/** A run that cannot start: the request, not the index, is at fault. */
export class VerifyRefused extends Error {}
