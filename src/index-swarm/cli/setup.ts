/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { EnvFile } from './env-file.js';
import { planSetup, SetupOptions } from './setup-plan.js';

/**
 * The `.env` half of `tools/index-swarm-setup`. It runs inside the core image,
 * so an operator needs nothing but Docker, and prints its report to stderr.
 * Its one line of stdout tells the wrapper what to restart:
 * `core=<0|1> profiles=<a,b> services=<x,y,z>`.
 */

const HELP = `Usage: tools/index-swarm-setup [options]

Sets up index sharing in .env, idempotently. Run it again to add a
publisher or turn on torrents; it only changes what is missing.

  --subscribe <wallet>   Subscribe to a publisher's root-TX index, by its
                         registered gateway wallet. Repeatable.
  --publish              Publish this gateway's root-TX index bands.
  --torrent              Move bands over BitTorrent too (generates the
                         engine password).
  --public-host <addr>   This node's public IP, where peers reach its engine
                         (and, when publishing, its tracker).
  --engine-port <n>      The engine's peer port (default 6881).
  --max-disk-gib <n>     Disk for installed bands (default 25 GiB).
  --no-gateway           Leave CDB64_ROOT_TX_INDEX_SOURCES and
                         ROOT_TX_LOOKUP_ORDER alone.
  --dry-run              Show the changes; write nothing.
  --restart              Then restart what the changes need (wrapper only).
  --env-file <path>      Default: .env
  -h, --help
`;

function fail(message: string): never {
  process.stderr.write(`index-swarm-setup: ${message}\n`);
  process.exit(1);
}

function positive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`${flag} must be a positive number`);
  return n;
}

async function main(): Promise<void> {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        subscribe: { type: 'string', multiple: true },
        publish: { type: 'boolean' },
        torrent: { type: 'boolean' },
        'public-host': { type: 'string' },
        'engine-port': { type: 'string' },
        'max-disk-gib': { type: 'string' },
        'no-gateway': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        restart: { type: 'boolean' },
        // Not --env-file: Node 20 takes that flag for itself even after the
        // script name, and would load the file into this process.
        file: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error: any) {
    fail(`${error.message}\n\n${HELP}`);
  }
  if (values.help === true) {
    process.stderr.write(HELP);
    return;
  }

  const enginePort = positive(values['engine-port'] as string, '--engine-port');
  if (
    enginePort !== undefined &&
    (!Number.isInteger(enginePort) || enginePort > 65535)
  ) {
    fail('--engine-port must be a port number');
  }
  const options: SetupOptions = {
    subscribe: (values.subscribe as string[] | undefined) ?? [],
    publish: values.publish === true,
    torrent: values.torrent === true,
    gateway: values['no-gateway'] !== true,
    ...(values['public-host'] !== undefined
      ? { publicHost: values['public-host'] as string }
      : {}),
    ...(enginePort !== undefined ? { enginePort } : {}),
    ...(values['max-disk-gib'] !== undefined
      ? {
          maxDiskGiB: positive(
            values['max-disk-gib'] as string,
            '--max-disk-gib',
          ),
        }
      : {}),
  };
  for (const wallet of options.subscribe) {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(wallet)) {
      fail(`--subscribe ${wallet} is not a wallet address`);
    }
  }

  const envPath = path.resolve((values.file as string) ?? '.env');
  let text = '';
  try {
    text = await fs.readFile(envPath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT')
      fail(`cannot read ${envPath}: ${error.message}`);
  }
  const env = new EnvFile(text);
  const plan = planSetup(env, options, () =>
    crypto.randomBytes(24).toString('hex'),
  );

  const say = (line = '') => process.stderr.write(`${line}\n`);
  for (const warning of plan.warnings) say(`warning: ${warning}`);
  if (plan.errors.length > 0) {
    for (const error of plan.errors) say(`error: ${error}`);
    say('Nothing was written.');
    process.exit(1);
  }

  const dryRun = values['dry-run'] === true;
  if (plan.changes.length === 0) {
    say(`${path.basename(envPath)} already has everything; nothing to change.`);
  } else {
    say(dryRun ? 'Would set:' : 'Setting:');
    for (const change of plan.changes) {
      const shown = change.display ?? change.value;
      say(`  ${change.key}=${shown}`);
      say(
        `      ${change.reason}${change.before !== undefined && change.display === undefined ? ` (was ${change.before})` : change.before !== undefined ? ' (replacing the old value)' : ''}`,
      );
    }
  }

  if (!dryRun && plan.changes.length > 0) {
    const header = `index sharing, added by tools/index-swarm-setup ${new Date().toISOString().slice(0, 10)}`;
    for (const change of plan.changes)
      env.set(change.key, change.value, header);
    let mode = 0o600;
    if (text.length > 0) {
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\..*/, 'Z');
      const backup = `${envPath}.bak-index-swarm-${stamp}`;
      mode = (await fs.stat(envPath)).mode & 0o777;
      // The file holds secrets, so the backup is readable by its owner only.
      await fs.copyFile(envPath, backup);
      await fs.chmod(backup, 0o600);
      say(`Backed up the old file to ${path.basename(backup)}.`);
    }
    // Through a symlink, not over it: a rename would replace the link.
    const target = await fs.realpath(envPath).catch(() => envPath);
    const tmp = `${target}.tmp-index-swarm-${process.pid}`;
    await fs.writeFile(tmp, env.toString(), { mode });
    await fs.rename(tmp, target);
    say(`Wrote ${path.basename(envPath)}.`);
  }

  if (plan.notes.length > 0) {
    say();
    for (const note of plan.notes) say(`note: ${note}`);
  }

  process.stdout.write(
    `core=${plan.restartCore && !dryRun ? 1 : 0} profiles=${plan.profiles.join(',')} services=${plan.services.join(',')}\n`,
  );
}

main().catch((error: any) => fail(error?.stack ?? String(error)));
