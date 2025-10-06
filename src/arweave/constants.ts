/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const MAX_FORK_DEPTH = 18;

/**
 * Maximum depth for nested ANS-104 bundles during traversal.
 * This limit prevents excessive recursion when following parent chains
 * in nested bundle structures.
 */
export const MAX_BUNDLE_NESTING_DEPTH = 10;
