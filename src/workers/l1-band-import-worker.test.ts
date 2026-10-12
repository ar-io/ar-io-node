/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import {
  cliInvocation,
  FillRunner,
  finishedRangeRows,
  L1BandImportWorker,
  parseTrailingJson,
  spawnFill,
} from './l1-band-import-worker.js';

const log = createTestLogger({ suite: 'L1BandImportWorker' });

const worker = (runFill: FillRunner, firstRunDelayMs = 0) =>
  new L1BandImportWorker({
    log,
    coreDbPath: 'data/sqlite/core.db',
    bandsDir: 'data/indexes/installed/parquet-l1',
    intervalMs: 60_000,
    cacheMib: 256,
    firstRunDelayMs,
    runFill,
    invocation: ['cli.js'],
  });

describe('cliInvocation', () => {
  it('runs the built CLI beside this module in the image', () => {
    assert.deepEqual(
      cliInvocation('file:///app/dist/workers/l1-band-import-worker.js'),
      ['/app/dist/cli/cli.js'],
    );
  });

  it('runs the TypeScript source through the loader under yarn start', () => {
    assert.deepEqual(
      cliInvocation('file:///repo/src/workers/l1-band-import-worker.ts'),
      ['--import', './register.js', '/repo/src/cli/cli.ts'],
    );
  });
});

describe('finishedRangeRows', () => {
  it('reads the rows of a range the fill imported', () => {
    assert.equal(
      finishedRangeRows(
        'Range finished {"heights":[0,99],"result":"imported","rows":125179,"seconds":12,"service":"ar-io-node-cli"}',
      ),
      125179,
    );
  });

  it('ignores refused ranges and every other line', () => {
    assert.equal(
      finishedRangeRows(
        'Range finished {"heights":[0,99],"result":"refused","seconds":1}',
      ),
      undefined,
    );
    assert.equal(finishedRangeRows('Planned a fill {"ceiling":9}'), undefined);
    assert.equal(finishedRangeRows('Range finished not-json'), undefined);
  });
});

describe('parseTrailingJson', () => {
  it('finds the result a failed run prints after its log lines', () => {
    const stderr = [
      'info: Filling {"coreDb":"x"}',
      'error: Fill stopped {"id":"l1-h0-99999"}',
      '{',
      '  "filled": 1,',
      '  "refused": "disk"',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(parseTrailingJson(stderr), {
      filled: 1,
      refused: 'disk',
    });
  });

  it('finds nothing when a run died without one', () => {
    assert.equal(
      parseTrailingJson('info: Filling\nSegmentation fault\n'),
      undefined,
    );
  });
});

describe('L1BandImportWorker', () => {
  it('runs the fill command with the bands, the database and the cache', async () => {
    let seen: string[] = [];
    const subject = worker(async (args) => {
      seen = args;
      return {
        code: 0,
        summary: { filled: 0, rows: 0, uncovered: [] },
        tail: '',
      };
    });
    await subject.runOnce();
    assert.deepEqual(seen, [
      'cli.js',
      'index-l1-import',
      '--fill',
      '--bands-dir',
      'data/indexes/installed/parquet-l1',
      '--core-db',
      'data/sqlite/core.db',
      '--cache-mib',
      '256',
    ]);
  });

  it('reports what a run filled', async () => {
    const summary = await worker(async () => ({
      code: 0,
      summary: { filled: 2, rows: 1234, uncovered: [[10, 19]] },
      tail: '',
    })).runOnce();
    assert.deepEqual(summary, { filled: 2, rows: 1234, uncovered: [[10, 19]] });
  });

  it('survives a failed run, keeping the result it printed', async () => {
    const summary = await worker(async () => ({
      code: 1,
      summary: { filled: 0, refused: 'no room' },
      tail: '',
    })).runOnce();
    assert.equal(summary?.refused, 'no room');
  });

  it('reports a failed run as failed, with its reason, when no stop interrupted it', async () => {
    // A worker run directly, never started, is stopped too: its failure is
    // still a failure, not a shutdown.
    const seen: Array<{ level: string; message: string; reason?: string }> = [];
    const record = (info: (typeof seen)[number]) => seen.push(info);
    log.on('data', record);
    try {
      await worker(async () => ({
        code: 1,
        tail: 'info: Filling {}\ndatabase is locked\n',
      })).runOnce();
    } finally {
      log.off('data', record);
    }
    assert.ok(
      seen.some(
        (info) =>
          info.message.startsWith('Fill failed') &&
          info.reason === 'database is locked',
      ),
      JSON.stringify(seen),
    );
    assert.ok(!seen.some((info) => info.message.includes('shutdown')));
  });

  it('survives a command that could not start', async () => {
    const summary = await worker(async () => {
      throw new Error('spawn ENOENT');
    }).runOnce();
    assert.equal(summary, undefined);
  });

  it('runs on its schedule, and stopping ends the run in flight', async () => {
    const child = new EventEmitter() as ChildProcess;
    let killed: string | undefined;
    child.kill = ((signal: string) => {
      killed = signal;
      child.emit('close', null);
      return true;
    }) as ChildProcess['kill'];
    let runs = 0;
    let startedRun = () => {};
    const started = new Promise<void>((resolve) => {
      startedRun = resolve;
    });
    const subject = worker((_args, _onLog, register) => {
      runs += 1;
      register(child);
      startedRun();
      return new Promise((resolve) =>
        child.once('close', (code: number | null) =>
          resolve({ code, tail: '' }),
        ),
      );
    });
    const seen: Array<{ message: string }> = [];
    const record = (info: (typeof seen)[number]) => seen.push(info);
    log.on('data', record);
    try {
      subject.start();
      await started;
      await subject.stop();
    } finally {
      log.off('data', record);
    }
    assert.equal(killed, 'SIGTERM');
    assert.equal(runs, 1);
    // A run the stop cut short is a shutdown, not a failure.
    assert.ok(
      seen.some((info) => info.message.startsWith('Fill interrupted')),
      JSON.stringify(seen),
    );
    assert.ok(!seen.some((info) => info.message.startsWith('Fill failed')));
  });
});

describe('spawnFill', () => {
  it("forwards the command's log lines and reads its result", async () => {
    const logged: Array<[string, string]> = [];
    const result = await spawnFill(
      [
        '-e',
        "console.error('info: Planned a fill {\"ceiling\":9}'); console.error('debug: detail'); console.log(JSON.stringify({ filled: 1, rows: 5 }));",
      ],
      (level, line) => logged.push([level, line]),
      () => undefined,
    );
    assert.equal(result.code, 0);
    assert.deepEqual(result.summary, { filled: 1, rows: 5 });
    assert.deepEqual(logged, [
      ['info', 'Planned a fill {"ceiling":9}'],
      ['debug', 'detail'],
    ]);
  });

  it('reads the result a failing command prints on stderr', async () => {
    const result = await spawnFill(
      [
        '-e',
        "console.error('error: Fill stopped {}'); console.error(JSON.stringify({ filled: 0, refused: 'bad band' }, null, 2)); process.exit(1);",
      ],
      () => undefined,
      () => undefined,
    );
    assert.equal(result.code, 1);
    assert.deepEqual(result.summary, { filled: 0, refused: 'bad band' });
  });
});
