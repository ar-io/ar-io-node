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
  indexBandVerifyOptions,
} from './options.js';
import { passthroughArgs, runSdkCli, sdkCli } from './passthrough.js';
import type {
  IndexBandBuildCLIOptions,
  IndexBandVerifyCLIOptions,
} from './types.js';
import { applyOptions, makeCommand } from './utils.js';

/**
 * The band commands, loaded only when one runs, so help, version and every
 * `ar.io` command start without the band library.
 */
const indexBandCommands = async () => import('./commands/indexBandCommands.js');

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
