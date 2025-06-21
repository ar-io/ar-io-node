/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function currentUnixTimestamp() {
  return +(Date.now() / 1000).toFixed(0);
}
