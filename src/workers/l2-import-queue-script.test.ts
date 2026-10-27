/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `scripts/lib/l2-import-queue.sh`, the part of `clickhouse-auto-import` that
 * loads L2 import jobs, run in bash with a stand-in for `clickhouse-import`
 * that records its arguments and fails when told to. Skipped where bash or
 * jq is missing (the auto-import image has both).
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/lib/l2-import-queue.sh', import.meta.url),
);
const hasTools = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe(
  'l2-import-queue.sh',
  { skip: !hasTools && 'needs bash and jq' },
  () => {
    let root: string;
    let staging: string;
    let fake: string;
    let calls: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-queue-'));
      staging = path.join(root, 'staging');
      calls = path.join(root, 'calls.log');
      fake = path.join(root, 'fake-clickhouse-import');
      // Records each call with the keep-existing setting it saw; fails on a
      // partition named in FAIL_PARTITION.
      await fs.writeFile(
        fake,
        `#!/usr/bin/env bash
echo "KEEP=\${CLICKHOUSE_IMPORT_KEEP_EXISTING:-unset} $*" >> "${calls}"
[ -n "\${FAIL_PARTITION:-}" ] && [[ "$*" == *"--partition \${FAIL_PARTITION}"* ]] && exit 1
exit 0
`,
        { mode: 0o755 },
      );
    });
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    const job = async (name: string, partitions: string[] | 'broken') => {
      const dir = path.join(staging, 'l2-import', 'queue', name);
      for (const t of ['blocks', 'transactions', 'tags']) {
        await fs.mkdir(path.join(dir, t, 'data'), { recursive: true });
      }
      await fs.writeFile(path.join(dir, 'written.parquet'), 'ids');
      await fs.writeFile(
        path.join(dir, 'job.json'),
        partitions === 'broken' ? '{' : JSON.stringify({ partitions }),
      );
      return dir;
    };

    const runQueue = (env: Record<string, string> = {}) => {
      const result = spawnSync(
        'bash',
        ['-c', `source "${SCRIPT}" && process_l2_import_queue`],
        {
          env: {
            PATH: process.env.PATH,
            ETL_STAGING_PATH: staging,
            L2_IMPORT_CLICKHOUSE_IMPORT: fake,
            ...env,
          },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };

    const ls = (dir: string) =>
      fs.readdir(path.join(staging, 'l2-import', dir)).catch(() => []);

    it('does nothing without a queue', () => {
      assert.equal(runQueue(), '');
    });

    it('loads every partition keeping existing rows, then moves the job to done/ with only what --forget needs', async () => {
      await job('band-a.1', ['height=100-199', 'height=200-299']);
      const out = runQueue();
      assert.match(out, /METRIC l2_import_job result=loaded job=band-a.1/);
      const recorded = (await fs.readFile(calls, 'utf8')).trim().split('\n');
      assert.equal(recorded.length, 2);
      for (const [i, p] of ['height=100-199', 'height=200-299'].entries()) {
        assert.match(recorded[i], /^KEEP=true --input-dir /);
        assert.match(recorded[i], new RegExp(`--partition ${p}$`));
      }
      assert.deepEqual(await ls('queue'), []);
      assert.deepEqual((await ls('done/band-a.1')).sort(), [
        'job.json',
        'loaded.json',
        'written.parquet',
      ]);
    });

    it('retries a failing job, then moves it to failed/ without its data', async () => {
      await job('band-b.1', ['height=100-199']);
      for (const attempt of [1, 2]) {
        const out = runQueue({ FAIL_PARTITION: 'height=100-199' });
        assert.match(
          out,
          new RegExp(`result=retry job=band-b.1 .*attempt=${attempt}`),
        );
        assert.deepEqual(await ls('queue'), ['band-b.1']);
      }
      const out = runQueue({ FAIL_PARTITION: 'height=100-199' });
      assert.match(out, /result=failed job=band-b.1/);
      assert.deepEqual(await ls('queue'), []);
      assert.deepEqual((await ls('failed/band-b.1')).sort(), [
        'attempts',
        'failed.txt',
        'job.json',
        'written.parquet',
      ]);
    });

    it('leaves the rest of the queue for later when a job fails', async () => {
      await job('band-c.1', ['height=100-199']);
      await job('band-d.1', ['height=200-299']);
      runQueue({ FAIL_PARTITION: 'height=100-199' });
      assert.deepEqual((await ls('queue')).sort(), ['band-c.1', 'band-d.1']);
    });

    it('moves a job whose job.json cannot be read to failed/', async () => {
      await job('band-e.1', 'broken');
      const out = runQueue();
      assert.match(out, /result=failed job=band-e.1/);
      assert.deepEqual(await ls('failed'), ['band-e.1']);
    });

    it('refuses a poll interval that is not a whole number', () => {
      const result = spawnSync('bash', ['-c', `source "${SCRIPT}"`], {
        env: {
          PATH: process.env.PATH,
          CLICKHOUSE_AUTO_IMPORT_L2_POLL_INTERVAL: 'soon',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /CLICKHOUSE_AUTO_IMPORT_L2_POLL_INTERVAL/);
    });
  },
);
