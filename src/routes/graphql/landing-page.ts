/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { ApolloServerPlugin } from '@apollo/server';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';

/**
 * The page `GET /graphql` serves to browsers: the embedded Apollo Sandbox,
 * with its browser-side telemetry turned off.
 *
 * Named explicitly rather than left to the default, because Apollo Server 5
 * picks the landing page from NODE_ENV and would otherwise serve a Studio
 * splash page in production instead of a usable query UI.
 *
 * `runTelemetry` defaults to true in the Sandbox embed, which has each
 * visitor's browser report Sandbox usage to Apollo. The usage- and
 * schema-reporting plugins in `graphql/index.ts` already stop the server from
 * sending query data to Apollo; leaving the embed's telemetry on would reopen
 * the same channel from the browser, so it is pinned off here.
 *
 * Lives in its own module so it can be tested without booting the gateway —
 * `graphql/index.ts` pulls in `resolvers.ts`, which imports `system.ts`.
 */
export const graphqlLandingPage = (): ApolloServerPlugin =>
  ApolloServerPluginLandingPageLocalDefault({
    embed: { runTelemetry: false },
  });
