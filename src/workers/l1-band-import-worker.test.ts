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

const worker = (
  runFill: FillRunner,
  firstRunDelayMs = 0,
  extra: Partial<ConstructorParameters<typeof L1BandImportWorker>[0]> = {},
) =>
  new L1BandImportWorker({
    log,
    coreDbPath: 'data/sqlite/core.db',
    bandsDir: 'data/indexes/installed/parquet-l1',
    intervalMs: 60_000,
    cacheMib: 256,
    firstRunDelayMs,
    runFill,
    invocation: ['cli.js'],
    // The bands directory is there unless a test says otherwise.
    statDir: async () => ({}),
    // Never resolved over the network in a test.
    countMachines: async () => 2,
    ...extra,
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

  it('passes the allow flags only when unverified bands are accepted', async () => {
    let seen: string[] = [];
    await worker(
      async (args) => {
        seen = args;
        return { code: 0, summary: { filled: 0 }, tail: '' };
      },
      0,
      { allowUnverified: true },
    ).runOnce();
    assert.deepEqual(seen.slice(-2), [
      '--allow-unbound',
      '--allow-unverified-format1',
    ]);
  });

  it('is idle without running the fill when the bands directory was never created', async () => {
    let ran = false;
    const summary = await worker(
      async () => {
        ran = true;
        return { code: 0, tail: '' };
      },
      0,
      {
        statDir: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      },
    ).runOnce();
    assert.equal(summary, undefined);
    assert.equal(ran, false);
  });

  it('runs the fill (which then fails) when the bands directory cannot be read (C F4)', async () => {
    let ran = false;
    await worker(
      async () => {
        ran = true;
        return { code: 1, tail: 'EACCES\n' };
      },
      0,
      {
        statDir: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      },
    ).runOnce();
    assert.equal(ran, true, 'a fill run reports it, as failed');
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

describe('L1BandImportWorker after a refusal (round 2, F)', () => {
  it('F1: does not re-verify the same refused bands every interval, and retries once they change', async () => {
    let runs = 0;
    let clock = 1_000_000;
    let entries = ['l1-h0-99-aaaaaaaa-000000000000'];
    const subject = worker(
      async () => {
        runs += 1;
        return {
          code: 1,
          summary: { filled: 0, refused: 'unbound' },
          tail: '',
        };
      },
      0,
      { listDir: async () => entries, now: () => clock },
    );
    await subject.runOnce();
    await subject.runOnce();
    assert.equal(runs, 1, 'the second run waits');
    clock += 60_000 + 1;
    await subject.runOnce();
    assert.equal(runs, 2, 'after the interval it tries again');
    await subject.runOnce();
    clock += 60_000 + 1;
    await subject.runOnce();
    assert.equal(runs, 2, 'refused again: it now waits twice as long');
    entries = ['l1-h0-99-aaaaaaaa-111111111111'];
    await subject.runOnce();
    assert.equal(runs, 3, 'a changed band is tried at once');
  });

  it('F2: warns when the bands directory and its parent are both missing', async () => {
    const seen: Array<{ level: string; message: string }> = [];
    const record = (info: (typeof seen)[number]) => seen.push(info);
    log.on('data', record);
    try {
      await worker(async () => ({ code: 0, tail: '' }), 0, {
        statDir: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      }).runOnce();
    } finally {
      log.off('data', record);
    }
    assert.ok(
      seen.some(
        (i) =>
          i.level === 'warn' &&
          /bands directory does not exist/.test(i.message),
      ),
      JSON.stringify(seen),
    );
  });
});

describe('L1BandImportWorker and its sample sources (round 3)', () => {
  it('G4: a fill whose sample could not be read is retried at the next interval, not backed off', async () => {
    let runs = 0;
    let clock = 1_000_000;
    const subject = worker(
      async () => {
        runs += 1;
        return {
          code: 1,
          summary: {
            refused: 'the sample could not be read',
            refusal: 'unreadable',
          },
          tail: '',
        };
      },
      0,
      {
        listDir: async () => ['l1-h0-99-aaaaaaaa-000000000000'],
        now: () => clock,
      },
    );
    await subject.runOnce();
    clock += 1;
    await subject.runOnce();
    assert.equal(runs, 2);
  });

  it('I3: warns once when the sample sources are fewer than two machines', async () => {
    const seen: Array<{ level: string; message: string }> = [];
    const record = (info: (typeof seen)[number]) => seen.push(info);
    log.on('data', record);
    try {
      const subject = worker(async () => ({ code: 0, tail: '' }), 0, {
        sampleFrom: ['http://a.test', 'http://b.test'],
        countMachines: async () => 1,
      });
      await subject.runOnce();
      await subject.runOnce();
    } finally {
      log.off('data', record);
    }
    assert.equal(
      seen.filter(
        (i) =>
          i.level === 'warn' &&
          /fewer than two distinct machines/.test(i.message),
      ).length,
      1,
    );
  });
});
