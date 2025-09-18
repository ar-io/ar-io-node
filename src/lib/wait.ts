/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export default function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
