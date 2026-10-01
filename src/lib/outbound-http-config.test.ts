/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * Imports modules in a fresh process as a tool outside the gateway would,
 * with no ADMIN_API_KEY and outside the test runner (whose context silences
 * config's notice). Loading src/config.ts prints that it generated a key, so
 * output means the gateway's configuration was loaded.
 */
function importFresh(...modules: string[]): string {
  const env = { ...process.env };
  delete env.ADMIN_API_KEY;
  delete env.NODE_TEST_CONTEXT;
  const imports = modules
    .map(
      (m) =>
        `await import(${JSON.stringify(pathToFileURL(path.join(root, m)).href)});`,
    )
    .join(' ');
  const result = spawnSync(
    process.execPath,
    ['--import', './register.js', '--input-type=module', '-e', imports],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe('outbound HTTP agents without the gateway configuration', () => {
  it('detects the gateway configuration loading (control)', () => {
    assert.match(importFresh('src/config.ts'), /ADMIN_API_KEY not provided/);
  });

  it('loads the agents and metrics without loading src/config.ts', () => {
    assert.equal(importFresh('src/lib/http-agent.ts', 'src/metrics.ts'), '');
  });

  it("loads the ar-io-node CLI's band commands without loading src/config.ts", () => {
    // They range-read roots through HttpByteRangeSource; their JSON output
    // must not be preceded by config's notice.
    assert.equal(importFresh('src/cli/commands/indexBandCommands.ts'), '');
  });
});
