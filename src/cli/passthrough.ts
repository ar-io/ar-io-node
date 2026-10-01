/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Commands `ar-io-node` doesn't own run as the `ar.io` CLI of the `@ar.io/sdk`
 * the node already depends on: same arguments, same stdio, same exit code.
 * The SDK's CLI modules are never imported (they are not part of its public
 * API, and its bin parses on import), so the two never share process state.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

/** The `@ar.io/sdk` package: its version and the path of its `ar.io` bin. */
export function sdkCli(): { version: string; bin: string } {
  const require = createRequire(import.meta.url);
  // The SDK's exports map hides package.json, so walk up from its entry.
  let dir = path.dirname(require.resolve('@ar.io/sdk'));
  for (;;) {
    const manifestPath = path.join(dir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === '@ar.io/sdk') {
        const bin =
          typeof manifest.bin === 'string'
            ? manifest.bin
            : manifest.bin?.['ar.io'];
        if (typeof bin !== 'string') {
          throw new Error('@ar.io/sdk declares no ar.io bin');
        }
        return { version: manifest.version, bin: path.join(dir, bin) };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find the @ar.io/sdk package');
    dir = parent;
  }
}

/**
 * Whether argv (after the node and script paths) names a command this binary
 * doesn't own, and so belongs to the SDK. Options before the command, and
 * commander's own help and version flags, stay with `ar-io-node`.
 */
export function isPassthrough(
  args: string[],
  ownCommands: ReadonlySet<string>,
): boolean {
  const command = args[0];
  return (
    command !== undefined &&
    !command.startsWith('-') &&
    command !== 'help' &&
    !ownCommands.has(command)
  );
}

/** Runs the SDK's `ar.io` CLI with `args`, resolving to its exit code. */
export function runSdkCli(args: string[]): Promise<number> {
  const { bin } = sdkCli();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      // A child killed by a signal exits as a shell reports it: 128 + n.
      resolve(
        code ?? 128 + (signal !== null ? os.constants.signals[signal] : 0),
      ),
    );
  });
}
