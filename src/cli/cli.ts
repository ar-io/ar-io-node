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
 * The band commands, loaded only when one runs. The band library reaches the
 * gateway's config (through `http-agent` and `metrics`), which reads the whole
 * environment and, with no `ADMIN_API_KEY`, invents one and prints it. This
 * process serves no admin API, so it sets none; and help, version and every
 * `ar.io` command never load the gateway's config at all.
 */
const indexBandCommands = async () => {
  process.env.ADMIN_API_KEY ??= '';
  return import('./commands/indexBandCommands.js');
};

const sdk = sdkCli();

applyOptions(
  program
    .name('ar-io-node')
    .version(`@ar.io/sdk ${sdk.version}`)
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

makeCommand<IndexBandBuildCLIOptions>({
  name: 'index-band-build',
  description:
    'Build an index band from CSV records, check sampled headers, and publish it',
  options: indexBandBuildOptions,
  action: async (options) =>
    (await indexBandCommands()).indexBandBuildCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
});

makeCommand<IndexBandVerifyCLIOptions>({
  name: 'index-band-verify',
  description: "Check a band's sampled headers against their root transactions",
  options: indexBandVerifyOptions,
  action: async (options) =>
    (await indexBandCommands()).indexBandVerifyCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
});

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
