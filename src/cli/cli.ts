/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `ar-io-node`: the gateway's command-line tool, in the style of the `ar.io`
 * CLI from `@ar.io/sdk`. It owns the node's commands; any other command runs
 * as `ar.io` with the same arguments (see `passthrough.ts`). In the core
 * image, `tools/ar-io-node` runs it with only Docker on the host.
 */
import { program } from 'commander';

import { createCliLogger } from './log.js';
import {
  globalOptions,
  indexBandBuildOptions,
  indexBandExportOptions,
  indexL1ImportOptions,
  indexL1VerifyOptions,
  indexBandVerifyOptions,
} from './options.js';
import { passthroughArgs, runSdkCli, sdkCli } from './passthrough.js';
import type {
  IndexBandBuildCLIOptions,
  IndexBandExportCLIOptions,
  IndexL1ImportCLIOptions,
  IndexL1VerifyCLIOptions,
  IndexBandVerifyCLIOptions,
} from './types.js';
import { applyOptions, makeCommand } from './utils.js';

/**
 * The band commands, loaded only when one runs, so help, version and every
 * `ar.io` command start without the band library.
 */
const indexBandCommands = async () => import('./commands/indexBandCommands.js');
const indexExportCommands = async () =>
  import('./commands/indexExportCommands.js');
const indexL1ImportCommands = async () =>
  import('./commands/indexL1ImportCommands.js');
const indexL1VerifyCommands = async () =>
  import('./commands/indexL1VerifyCommands.js');

const sdk = sdkCli();

applyOptions(
  program
    .name('ar-io-node')
    .version(
      `@ar.io/sdk ${sdk.version}`,
      '-V, --version',
      'Print the @ar.io/sdk version the ar.io commands run',
    )
    .description('AR.IO gateway CLI')
    .helpCommand(true)
    .addHelpText(
      'after',
      `\nEvery other command is a command of the ar.io CLI (@ar.io/sdk ${sdk.version}),\n` +
        'run with the same arguments, e.g. ar-io-node get-gateway --address <wallet>.\n' +
        'List them with: ar-io-node network-help',
    ),
  globalOptions,
);

/** The output contract every node command keeps, at the end of its help. */
const CONTRACT = [
  '',
  'Output: the result as JSON on stdout, exit 0. On failure stdout is empty and',
  'the error (or, for a refused band, the full result as JSON) is on stderr,',
  'exit 1. Logs go to stderr. Safe to rerun. See docs/cli.md.',
].join('\n');

makeCommand<IndexBandBuildCLIOptions>({
  name: 'index-band-build',
  description:
    'Build an index band from CSV records, check sampled headers, and publish it',
  options: indexBandBuildOptions,
  action: async (options) =>
    (await indexBandCommands()).indexBandBuildCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-band-build --input - --skip-header --publisher <wallet> \\',
    '    --kind d --height-range 2010500,tip \\',
    '    --gateway-url https://turbo-gateway.com < records.csv',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexBandVerifyCLIOptions>({
  name: 'index-band-verify',
  description: "Check a band's sampled headers against their root transactions",
  options: indexBandVerifyOptions,
  action: async (options) =>
    (await indexBandCommands()).indexBandVerifyCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-band-verify \\',
    '    --band-dir data/indexes/published/root-tx-index/<band> \\',
    '    --gateway-url https://turbo-gateway.com',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexBandExportCLIOptions>({
  name: 'index-band-export',
  description:
    "Export one record source's records for a height range, as CSV for index-band-build",
  options: indexBandExportOptions,
  action: async (options) =>
    (await indexExportCommands()).indexBandExportCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-band-export --source \'{"type":"clickhouse"}\' \\',
    '    --from 2010000 --to 2011000 --output data/indexes/export/records.csv',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexL1ImportCLIOptions>({
  name: 'index-l1-import',
  description:
    "Fill this gateway's core.db from installed parquet-l1 bands (the gateway must be stopped)",
  options: indexL1ImportOptions,
  action: async (options) =>
    (await indexL1ImportCommands()).indexL1ImportCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-l1-import \\',
    '    --bands-dir data/indexes/installed/parquet-l1 \\',
    '    --core-db data/sqlite/core.db',
    '',
    'Bands are imported in height order, lowest first, and the run stops at',
    'the first that fails. What it imported is kept, so running it again',
    'carries on from there.',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexL1VerifyCLIOptions>({
  name: 'index-l1-verify',
  description:
    "Check this gateway's L1 index against the weave size the chain commits to",
  options: indexL1VerifyOptions,
  action: async (options) =>
    (await indexL1VerifyCommands()).indexL1VerifyCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-l1-verify --core-db data/sqlite/core.db',
    '',
    'Read-only, so the gateway can stay up. Below the 2.0 fork a block',
    'grew the weave by exactly its transactions, and the first post-2.0',
    'block commits the running total, so one trusted block hash pins the',
    'size of every transaction beneath it. Exits 1 if a check fails.',
    CONTRACT,
  ].join('\n'),
);

program
  .command('network-help')
  .description('List the ar.io CLI commands this tool runs for you')
  .action(async () => process.exit(await runSdkCli(['--help'])));

const own = new Set(program.commands.map((command) => command.name()));
const sdkArgs = passthroughArgs(process.argv.slice(2), own);
if (sdkArgs !== undefined) {
  process.exit(await runSdkCli(sdkArgs));
} else {
  program.parse(process.argv);
}
