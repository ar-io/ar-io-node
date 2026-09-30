/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { ApolloServerPlugin } from '@apollo/server';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Where `yarn build` (`graphiql/build.mjs`) writes the bundled GraphiQL page.
 * Relative to the working directory, like the gateway's other data paths:
 * the repo root under `yarn start`, `/app` in the image.
 */
export const GRAPHIQL_ASSETS_DIR = path.join('dist', 'graphiql');

/** URL path, under `/graphql`, that the bundled files are served from. */
export const GRAPHIQL_ASSETS_ROUTE = '/graphiql';

/**
 * Content-Security-Policy for the landing page. Everything the page loads,
 * including the editor's workers, comes from this gateway, and it talks only
 * to this gateway's `/graphql`, so every source is `'self'`. Inline styles are
 * allowed because the Monaco editor sets them at runtime; inline scripts are
 * not, and the page has none.
 */
export const GRAPHIQL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

type GraphiqlManifest = { js: string; css: string };

const readManifest = (assetsDir: string): GraphiqlManifest | undefined => {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8'),
    );
    return typeof manifest?.js === 'string' && typeof manifest?.css === 'string'
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
};

const page = (head: string, body: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GraphQL · AR.IO Gateway</title>
    <style>html, body, #graphiql { height: 100%; margin: 0; }</style>
    ${head}
  </head>
  <body>
    ${body}
  </body>
</html>
`;

/**
 * Render the HTML `GET /graphql` serves to browsers.
 *
 * The page is GraphiQL, bundled with its Explorer plugin at build time and
 * served by the gateway itself: no third-party scripts, no vendor account and
 * no telemetry. It replaced the embedded Apollo Sandbox, which loaded from
 * Apollo's CDN, reported usage to Apollo by default and carried an Apollo
 * account login.
 *
 * Without a build (`yarn start` before `yarn build:graphiql`), the page says
 * how to build it; GraphQL itself is unaffected.
 */
export const renderGraphiqlPage = (
  assetsDir: string = GRAPHIQL_ASSETS_DIR,
): string => {
  const manifest = readManifest(assetsDir);
  if (manifest === undefined) {
    return page(
      '',
      '<p style="font-family: sans-serif; margin: 2em">' +
        'GraphiQL has not been built. Run <code>yarn build:graphiql</code>, ' +
        'or query this endpoint with <code>POST /graphql</code>.</p>',
    );
  }
  const base = `/graphql${GRAPHIQL_ASSETS_ROUTE}`;
  return page(
    `<link rel="stylesheet" href="${base}/${manifest.css}" />`,
    `<div id="graphiql"></div>\n    ` +
      `<script type="module" src="${base}/${manifest.js}"></script>`,
  );
};

/**
 * Apollo plugin that serves the GraphiQL page as the landing page. Named
 * explicitly because Apollo Server 5 otherwise picks a landing page from
 * NODE_ENV, and in production that is a Studio splash page.
 *
 * The page is rendered once, at server start, so a rebuild needs a restart.
 *
 * Lives in its own module so it can be tested without booting the gateway —
 * `graphql/index.ts` pulls in `resolvers.ts`, which imports `system.ts`.
 */
export const graphqlLandingPage = (
  assetsDir: string = GRAPHIQL_ASSETS_DIR,
): ApolloServerPlugin => ({
  async serverWillStart() {
    const html = renderGraphiqlPage(assetsDir);
    return {
      async renderLandingPage() {
        return { html };
      },
    };
  },
});

/**
 * Serves the bundled files under `/graphql/graphiql/`. Mount it first in the
 * `/graphql` chain so asset requests never reach the body parser, the batch
 * metrics or Apollo. Every file name carries a content hash, so the files are
 * cacheable forever.
 *
 * An unknown path is answered here with a plain 404, never Apollo's landing
 * page. It is not left to `fallthrough: false`: `send` reports a missing file
 * as an error with `expose: false`, which the gateway's terminal handler turns
 * into a logged 500, so a probe or a browser holding a previous build's page
 * would fill the logs with stack traces.
 */
export const graphiqlAssets = (
  assetsDir: string = GRAPHIQL_ASSETS_DIR,
): RequestHandler => {
  const router = express.Router();
  router.use(
    GRAPHIQL_ASSETS_ROUTE,
    express.static(assetsDir, {
      immutable: true,
      maxAge: '1y',
      index: false,
    }),
    (_req: Request, res: Response) => {
      res.status(404).end();
    },
  );
  return router;
};

/**
 * Sets the landing page's Content-Security-Policy on browser `GET`s under
 * `/graphql`. Not just `/graphql` itself: Apollo answers every path under its
 * mount, so `/graphql/anything` gets the page too. Apollo decides whether a
 * request gets the page or a GraphQL response; the header is harmless on the
 * latter, since CSP applies only to documents. Requests for the bundled files
 * never get here, because `graphiqlAssets` runs first and ends them.
 */
export const graphiqlCsp = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (
    req.method === 'GET' &&
    req.accepts(['application/json', 'text/html']) === 'text/html'
  ) {
    res.setHeader('Content-Security-Policy', GRAPHIQL_CSP);
  }
  next();
};
