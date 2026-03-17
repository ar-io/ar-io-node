/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
