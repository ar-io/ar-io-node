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

import { isPassthrough, runSdkCli, sdkCli } from './passthrough.js';

describe('passthrough to the ar.io CLI', () => {
  const own = new Set([
    'index-band-build',
    'index-band-verify',
    'network-help',
  ]);

  it('sends only commands this tool does not own', () => {
    assert.equal(isPassthrough(['get-gateway', '--address', 'x'], own), true);
    assert.equal(
      isPassthrough(['index-band-build', '--input', '-'], own),
      false,
    );
    assert.equal(isPassthrough(['help', 'get-gateway'], own), false);
    assert.equal(isPassthrough(['--help'], own), false);
    assert.equal(isPassthrough(['--version'], own), false);
    assert.equal(isPassthrough([], own), false);
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
