/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DATA_PATH_REGEX, RAW_DATA_PATH_REGEX } from '../constants.js';

/**
 * Whether a request to an ArNS root host that serves an apex (`APEX_TX_ID` or
 * an apex ArNS name) should skip the apex and reach the gateway's own routes.
 * Every other path on such a host is resolved inside the apex content.
 *
 * `/graphql` passes with everything under it: the GraphiQL page loads its
 * bundle from `/graphql/graphiql/`, and Apollo answers nested paths too. An
 * exact match on `/graphql` alone left the page on an apex host with no
 * scripts, because the apex claimed their paths.
 *
 * Lives in its own module so it can be tested without booting the gateway —
 * `middleware/arns.ts` imports `system.ts`.
 */
export const isApexPassthroughPath = (method: string, path: string): boolean =>
  DATA_PATH_REGEX.test(path) ||
  RAW_DATA_PATH_REGEX.test(path) ||
  /^\/local\//.test(path) ||
  /^\/ar-io\//.test(path) ||
  /^\/chunk\//.test(path) ||
  /^\/api-docs(?:\/|$)/.test(path) ||
  path === '/openapi.json' ||
  /^\/graphql(?:\/|$)/.test(path) ||
  // Allow POST /tx and POST /chunk for transaction/chunk submission
  (method === 'POST' && (path === '/tx' || path === '/chunk'));
