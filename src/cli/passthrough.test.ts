/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { describe, it } from 'node:test';

import { passthroughArgs, runSdkCli, sdkCli } from './passthrough.js';

describe('passthrough to the ar.io CLI', () => {
  const own = new Set([
    'index-band-build',
    'index-band-export',
    'index-band-verify',
    'network-help',
  ]);

  it('sends only commands this tool does not own, with their arguments', () => {
    const args = ['get-gateway', '--address', 'x'];
    assert.deepEqual(passthroughArgs(args, own), args);
    assert.equal(
      passthroughArgs(['index-band-build', '--input', '-'], own),
      undefined,
    );
    assert.equal(passthroughArgs(['--help'], own), undefined);
    assert.equal(passthroughArgs(['--version'], own), undefined);
    assert.equal(passthroughArgs([], own), undefined);
  });

  it('finds the command after global flags, as ar.io does', () => {
    const args = ['--debug', 'get-gateway', '--address', 'x'];
    assert.deepEqual(passthroughArgs(args, own), args);
    assert.equal(
      passthroughArgs(['--debug', 'index-band-verify'], own),
      undefined,
    );
  });

  it('turns help for an ar.io command into that command asking for its help', () => {
    assert.deepEqual(passthroughArgs(['help', 'get-gateway'], own), [
      'get-gateway',
      '--help',
    ]);
    assert.deepEqual(passthroughArgs(['--debug', 'help', 'get-gateway'], own), [
      '--debug',
      'get-gateway',
      '--help',
    ]);
    assert.equal(passthroughArgs(['help', 'index-band-build'], own), undefined);
    assert.equal(passthroughArgs(['help'], own), undefined);
  });

  it('finds the ar.io bin of the SDK the node depends on', () => {
    const { version, bin } = sdkCli();
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.ok(fs.existsSync(bin), bin);
    // The same bin the SDK declares, answering for its own version.
    const out = spawnSync(process.execPath, [bin, '--version'], {
      encoding: 'utf8',
    });
    assert.equal(out.status, 0);
    assert.equal(out.stdout.trim(), version);
  });

  it("returns the ar.io CLI's exit code", async () => {
    assert.equal(await runSdkCli(['--version']), 0);
    assert.notEqual(await runSdkCli(['no-such-command-anywhere']), 0);
  });
});
