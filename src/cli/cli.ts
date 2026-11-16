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
  indexL1AuditOptions,
  indexL1VerifyOptions,
  indexL2VerifyOptions,
  indexL2ImportOptions,
  indexBandVerifyOptions,
  indexCensusOptions,
} from './options.js';
import { passthroughArgs, runSdkCli, sdkCli } from './passthrough.js';
import type {
  IndexBandBuildCLIOptions,
  IndexBandExportCLIOptions,
  IndexL1ImportCLIOptions,
  IndexL1AuditCLIOptions,
  IndexL2VerifyCLIOptions,
  IndexL2ImportCLIOptions,
  IndexL1VerifyCLIOptions,
  IndexBandVerifyCLIOptions,
  IndexCensusCLIOptions,
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
const indexL2VerifyCommands = async () =>
  import('./commands/indexL2VerifyCommands.js');
const indexL2ImportCommands = async () =>
  import('./commands/indexL2ImportCommands.js');
const indexL1VerifyCommands = async () =>
  import('./commands/indexL1VerifyCommands.js');
const indexL1AuditCommands = async () =>
  import('./commands/indexL1AuditCommands.js');
const indexCensusCommands = async () =>
  import('./commands/indexCensusCommands.js');

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
    "Fill this gateway's core.db from installed parquet-l1 bands: with the gateway stopped, or with --fill while it runs",
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
    '',
    'With the gateway running (the gateway runs this itself when',
    'L1_BAND_IMPORT_ENABLED=true):',
    '  ar-io-node index-l1-import --fill \\',
    '    --bands-dir data/indexes/installed/parquet-l1 \\',
    '    --core-db data/sqlite/core.db',
    '',
    'Writes only the heights core.db is missing below what the gateway',
    'indexes itself, so nothing it indexed is rewritten.',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexL1VerifyCLIOptions>({
  name: 'index-l1-verify',
  description:
    'Check an L1 index (a core.db, or a directory of parquet-l1 bands) against the chain: anchored, judged block by block, and sampled; fails on what it cannot bind unless an --allow-* flag accepts it',
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
    '  ar-io-node index-l1-verify --core-db data/sqlite/core.db \\',
    '    --anchor-from https://<gateway-a>,https://<gateway-b>',
    '',
    'Read-only, so the gateway can stay up. The top block is fetched from',
    'every --anchor-from source and its hash recomputed from its fields;',
    'the hash_list_merkle recurrence then binds each post-2.0 block hash,',
    'weave size and tx_root below it, and a keyed sample of headers and',
    'signatures checks what nothing else binds. Pre-2.0 blocks and blocks',
    'holding a format-1 transaction with data are reported unbound. Exits 1',
    'if a check fails or something unbound is not accepted.',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexL2ImportCLIOptions>({
  name: 'index-l2-import',
  description:
    "Load verified parquet-l2 bands into this gateway's index: --target clickhouse queues the rows its ClickHouse lacks for clickhouse-auto-import",
  options: indexL2ImportOptions,
  action: async (options) =>
    (await indexL2ImportCommands()).indexL2ImportCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example (the gateway runs this itself when L2_BAND_IMPORT_ENABLED=true):',
    '  ar-io-node index-l2-import --target clickhouse \\',
    '    --bands-dir data/indexes/installed/ardrive-l2 \\',
    '    --publication https://<publisher>/ar-io/indexes \\',
    '    --registry-url http://core:4000',
    '',
    'Each band is verified first (bound to the signed publication, every',
    'root found in the L1 index, a sample of items read on chain); a band',
    'that fails a check is refused and nothing of it is written. Items',
    "ClickHouse already holds are left alone, and nothing above ClickHouse's",
    'top height is written. Jobs are queued newest band first and loaded by',
    'clickhouse-auto-import, one at a time.',
    '',
    'To undo an import:',
    '  ar-io-node index-l2-import --target clickhouse \\',
    '    --bands-dir data/indexes/installed/ardrive-l2 --forget <band-id>',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexL2VerifyCLIOptions>({
  name: 'index-l2-verify',
  description:
    'Check a directory of parquet-l2 bands (an L2 index such as ardrive-l2) as their holder can, and their locations against Arweave',
  options: indexL2VerifyOptions,
  action: async (options) =>
    (await indexL2VerifyCommands()).indexL2VerifyCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-l2-verify --bands-dir data/indexes/installed/ardrive-l2 \\',
    '    --publication https://turbo-gateway.com/ar-io/indexes \\',
    '    --registry-url http://core:4000',
    '',
    "Read-only, no gateway or database needed. Checks every band's id against",
    'its contents, the set for overlaps and holes, every file and table row by',
    'row, every location and parent link, tags and keys against items, the',
    'selection and the lookups; with --publication, every file against the',
    "publisher's signature; with an L1 index, every root's block; then reads",
    'a sample of items per band from Arweave nodes, proving each chunk against',
    'the chain, and checks their headers hash to their ids. Fails closed: exits',
    '1 if a check fails or a band cannot be read whole. "ok" covers only the',
    'checks that ran: read it with "skipped" and "publisherBound".',
    'See docs/index-verification.md.',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexL1AuditCLIOptions>({
  name: 'index-l1-audit',
  description:
    'Audit the blocks index-l1-verify has to skip, by fetching the data their format-1 transactions carry',
  options: indexL1AuditOptions,
  action: async (options) =>
    (await indexL1AuditCommands()).indexL1AuditCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-l1-audit --core-db data/sqlite/core.db \\',
    '    --data-from https://arweave.net --sample 200',
    '',
    "A format-1 transaction's tx_root leaf is the root of its data, which",
    'an index does not store, so 13% of post-fork blocks cannot be checked',
    'from the index alone. This fetches that data and recomputes tx_root.',
    'Read-only, and the data source need not be trusted. Exits 1 on a',
    'mismatch, or if nothing could be audited.',
    CONTRACT,
  ].join('\n'),
);

makeCommand<IndexCensusCLIOptions>({
  name: 'index-census',
  description:
    "Check that this gateway's ClickHouse holds every data item its bundle indexer indexed",
  options: indexCensusOptions,
  action: async (options) =>
    (await indexCensusCommands()).indexCensusCLICommand(options, {
      log: createCliLogger({ debug: options.debug === true }),
    }),
}).addHelpText(
  'after',
  [
    '',
    'Example:',
    '  ar-io-node index-census --bundles-db data/sqlite/bundles.db \\',
    '    --output data/indexes/census/short-roots.tsv',
    '',
    'Read-only on bundles.db and ClickHouse (CLICKHOUSE_URL, CLICKHOUSE_USER,',
    'CLICKHOUSE_PASSWORD), so the gateway can stay up. Compares each root',
    "transaction's indexed item count with what ClickHouse holds under it,",
    'then looks up every item of the roots that come up short: held under',
    'another root (a duplicate), expired (in transaction_ids, not',
    'transactions), or missing (never imported; re-queue the bundle with',
    'POST /ar-io/admin/queue-bundle). Needs the transaction_ids table',
    'backfilled. Run again with --roots on the re-queued roots to verify.',
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
