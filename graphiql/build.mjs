/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Bundles the GraphiQL page (`graphiql/index.jsx`) and the Monaco editor
// workers it needs into `dist/graphiql/`, which the gateway serves under
// `/graphql/graphiql/`. Run by `yarn build`, or alone as `yarn build:graphiql`.
//
// Every output file name carries a content hash, so the files can be cached
// forever. `manifest.json` names the entry files for the landing page.

import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const outdir = path.resolve('dist/graphiql');

// Script-loading CDNs the stock GraphiQL setups reach for. The page must load
// nothing from a third party, so a bundle that mentions one fails the build.
const FORBIDDEN = [
  'esm.sh',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'apollographql.com',
];

const production = { 'process.env.NODE_ENV': '"production"' };

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// The workers are resolved the way `@graphiql/react` resolves them, so the
// editor and its workers come from the same Monaco versions.
const fromGraphiqlReact = createRequire(import.meta.resolve('@graphiql/react'));
const workers = await build({
  entryPoints: {
    'editor.worker': fromGraphiqlReact.resolve(
      'monaco-editor/esm/vs/editor/editor.worker.js',
    ),
    'json.worker': fromGraphiqlReact.resolve(
      'monaco-editor/esm/vs/language/json/json.worker.js',
    ),
    'graphql.worker': fromGraphiqlReact.resolve(
      'monaco-graphql/esm/graphql.worker.js',
    ),
  },
  bundle: true,
  format: 'iife',
  minify: true,
  define: production,
  outdir,
  entryNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'warning',
});

const workerFile = (name) =>
  path.basename(
    Object.keys(workers.metafile.outputs).find((out) =>
      path.basename(out).startsWith(`${name}-`),
    ),
  );

const page = await build({
  entryPoints: { index: 'graphiql/index.jsx' },
  bundle: true,
  format: 'esm',
  minify: true,
  jsx: 'automatic',
  loader: { '.ttf': 'file' },
  define: {
    ...production,
    __GRAPHIQL_EDITOR_WORKER__: JSON.stringify(
      `./${workerFile('editor.worker')}`,
    ),
    __GRAPHIQL_JSON_WORKER__: JSON.stringify(`./${workerFile('json.worker')}`),
    __GRAPHIQL_GRAPHQL_WORKER__: JSON.stringify(
      `./${workerFile('graphql.worker')}`,
    ),
  },
  outdir,
  entryNames: '[name]-[hash]',
  assetNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'warning',
});

const entryOutput = (ext) =>
  path.basename(
    Object.entries(page.metafile.outputs).find(
      ([out, meta]) =>
        out.endsWith(ext) && (meta.entryPoint !== undefined || ext === '.css'),
    )[0],
  );

for (const file of await readdir(outdir)) {
  if (!/\.(js|css)$/.test(file)) continue;
  const text = await readFile(path.join(outdir, file), 'utf8');
  const hit = FORBIDDEN.find((host) => text.includes(host));
  if (hit !== undefined) {
    throw new Error(`${file} references ${hit}; the page must be self-hosted`);
  }
}

await writeFile(
  path.join(outdir, 'manifest.json'),
  JSON.stringify({ js: entryOutput('.js'), css: entryOutput('.css') }, null, 2),
);

console.log(`GraphiQL bundled into ${path.relative(process.cwd(), outdir)}/`);
