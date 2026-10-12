/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import winston from 'winston';

import * as metrics from '../metrics.js';

/** What one fill run reported, as `index-l1-import --fill` prints it. */
export interface FillSummary {
  ceiling?: number;
  filled?: number;
  rows?: number;
  uncovered?: Array<[number, number]>;
  refused?: string;
}

/** The outcome of running the fill command once. */
export interface FillProcessResult {
  code: number | null;
  /** The command's JSON result, from stdout on success or the end of stderr on failure. */
  summary?: FillSummary;
  /** The last of stderr, for a failure that printed no result. */
  tail: string;
}

/** Runs the fill command once and reports how it ended. */
export type FillRunner = (
  args: string[],
  onLog: (level: string, line: string) => void,
  register: (child: ChildProcess) => void,
) => Promise<FillProcessResult>;

/** Bytes of stderr kept for parsing a failure's result. */
const TAIL_BYTES = 64 * 1024;

/** A CLI log line, as `createCliLogger`'s simple format writes it. */
const LOG_LINE = /^(error|warn|info|http|verbose|debug|silly): (.*)$/;

/**
 * The command and leading arguments that run the `ar-io-node` CLI from this
 * build: `dist/cli/cli.js` beside this file in the image, or the TypeScript
 * source through the loader under `yarn start`.
 */
export function cliInvocation(moduleUrl = import.meta.url): string[] {
  const fromSource = moduleUrl.endsWith('.ts');
  const cli = fileURLToPath(
    new URL(fromSource ? '../cli/cli.ts' : '../cli/cli.js', moduleUrl),
  );
  return fromSource ? ['--import', './register.js', cli] : [cli];
}

/** The result a failed run printed last on stderr, if it printed one. */
export function parseTrailingJson(text: string): FillSummary | undefined {
  // The result is the last thing written, pretty-printed from a line that
  // opens with `{` at the margin; log lines never start that way.
  const start = text.lastIndexOf('\n{');
  const candidate = (start === -1 ? text : text.slice(start + 1)).trim();
  if (!candidate.startsWith('{')) return undefined;
  try {
    return JSON.parse(candidate) as FillSummary;
  } catch {
    return undefined;
  }
}

/** Spawns the CLI as a child of this process. */
export const spawnFill: FillRunner = (args, onLog, register) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    register(child);
    let stdout = '';
    let tail = '';
    let partial = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-TAIL_BYTES);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const match = LOG_LINE.exec(line);
        if (match !== null) onLog(match[1], match[2]);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      let summary: FillSummary | undefined;
      if (code === 0) {
        try {
          summary = JSON.parse(stdout) as FillSummary;
        } catch {
          summary = undefined;
        }
      } else {
        summary = parseTrailingJson(tail);
      }
      resolve({ code, ...(summary !== undefined ? { summary } : {}), tail });
    });
  });

/**
 * Fills the L1 history beneath this gateway from installed `parquet-l1`
 * bands, by running `ar-io-node index-l1-import --fill` on a schedule.
 *
 * The fill writes only heights `core.db` lacks below what the block
 * importer writes itself, in short transactions, so the gateway keeps
 * indexing and serving while it runs. A run with nothing to do reads the
 * band directory, each band's block file, the ledger and the block height
 * index, and writes nothing to `core.db`, so the schedule costs little
 * once history is complete; it keeps running so a
 * hole that appears later, or the publisher's next tip band, is filled.
 *
 * A child process rather than a call. The import reads Parquet through
 * DuckDB, whose native code has crashed before, and a crash there must cost
 * one run, not the gateway. It also keeps the import's SQLite page cache
 * and DuckDB's memory out of the gateway's heap, and its synchronous
 * SQLite writes off the gateway's event loop.
 */
export class L1BandImportWorker {
  private log: winston.Logger;
  private args: string[];
  private intervalMs: number;
  private firstRunDelayMs: number;
  private runFill: FillRunner;
  private timer: NodeJS.Timeout | undefined;
  private child: ChildProcess | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;

  constructor({
    log,
    coreDbPath,
    bandsDir,
    intervalMs,
    cacheMib,
    firstRunDelayMs = 60_000,
    runFill = spawnFill,
    invocation = cliInvocation(),
  }: {
    log: winston.Logger;
    coreDbPath: string;
    bandsDir: string;
    intervalMs: number;
    cacheMib: number;
    /** Lets the block importer write its first block, which sets where the fill stops. */
    firstRunDelayMs?: number;
    runFill?: FillRunner;
    invocation?: string[];
  }) {
    this.log = log.child({ class: 'L1BandImportWorker' });
    this.intervalMs = intervalMs;
    this.firstRunDelayMs = firstRunDelayMs;
    this.runFill = runFill;
    this.args = [
      ...invocation,
      'index-l1-import',
      '--fill',
      '--bands-dir',
      bandsDir,
      '--core-db',
      coreDbPath,
      '--cache-mib',
      String(cacheMib),
    ];
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log.info('Starting', { intervalMs: this.intervalMs });
    this.schedule(this.firstRunDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // An interrupted fill is safe: its open transaction rolls back, and
    // the ledger row it left unfinished is redone by the next run.
    this.child?.kill('SIGTERM');
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runOnce().finally(() => {
        this.running = undefined;
        this.schedule(this.intervalMs);
      });
    }, delayMs);
  }

  /** Runs the fill once; never throws. */
  async runOnce(): Promise<FillSummary | undefined> {
    const started = Date.now();
    try {
      const result = await this.runFill(
        this.args,
        (level, line) => {
          if (level === 'error' || level === 'warn') {
            this.log.warn(line);
          } else if (level === 'info') {
            this.log.info(line);
          } else {
            this.log.debug(line);
          }
        },
        (child) => {
          this.child = child;
        },
      );
      this.child = undefined;
      const summary = result.summary;
      if (summary?.uncovered !== undefined) {
        metrics.l1BandImportUncoveredHeights.set(
          summary.uncovered.reduce((sum, [a, b]) => sum + (b - a + 1), 0),
        );
      }
      if (summary?.rows !== undefined && summary.rows > 0) {
        metrics.l1BandImportRowsTotal.inc(summary.rows);
      }
      if (result.code !== 0) {
        metrics.l1BandImportRunsTotal.inc({ result: 'failed' });
        if (this.stopped) {
          this.log.info('Fill interrupted by shutdown; the next run redoes it');
        } else {
          this.log.error('Fill failed; the next run carries on from here', {
            code: result.code,
            reason: summary?.refused ?? result.tail.trim().split('\n').pop(),
            seconds: Math.round((Date.now() - started) / 1000),
          });
        }
        return summary;
      }
      const filled = (summary?.filled ?? 0) > 0;
      metrics.l1BandImportRunsTotal.inc({ result: filled ? 'filled' : 'idle' });
      this.log[filled ? 'info' : 'debug']('Fill finished', {
        filled: summary?.filled,
        rows: summary?.rows,
        uncovered: summary?.uncovered,
        seconds: Math.round((Date.now() - started) / 1000),
      });
      return summary;
    } catch (error) {
      this.child = undefined;
      metrics.l1BandImportRunsTotal.inc({ result: 'failed' });
      this.log.error('Could not run the fill', {
        error: (error as Error).message,
      });
      return undefined;
    }
  }
}
