/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ChildProcess, spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import winston from 'winston';

import { ArweaveNodePool } from '../lib/onchain/arweave-nodes.js';
import * as metrics from '../metrics.js';

/** Distinct machines a list of sources resolves to, as the sample counts them. */
async function distinctMachines(urls: string[]): Promise<number> {
  const pool = new ArweaveNodePool({ urls });
  await pool.ready();
  return new Set(pool.urls.map((u) => pool.addressOf(u))).size;
}

/** What one fill run reported, as `index-l1-import --fill` prints it. */
export interface FillSummary {
  ceiling?: number;
  filled?: number;
  rows?: number;
  uncovered?: Array<[number, number]>;
  refused?: string;
  /** `unreadable`: only the sample could not be read (an outage); `refused`: anything else. */
  refusal?: 'refused' | 'unreadable';
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

/**
 * The rows a `Range finished` log line reports for an imported range, or
 * undefined for any other line.
 */
export function finishedRangeRows(line: string): number | undefined {
  if (!line.startsWith('Range finished ')) return undefined;
  try {
    const meta = JSON.parse(line.slice('Range finished '.length)) as {
      result?: unknown;
      rows?: unknown;
    };
    return meta.result === 'imported' &&
      typeof meta.rows === 'number' &&
      meta.rows > 0
      ? meta.rows
      : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Spawns the CLI as a child of this process, with this process's
 * environment, or `env` when given.
 */
export const spawnFill = (
  args: string[],
  onLog: (level: string, line: string) => void,
  register: (child: ChildProcess) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FillProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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
 * Every range is verified before a row of it is written
 * (`verifyBeforeImport`): the band checked whole, and bound to the chain by
 * the block this gateway holds above it. Blocks that cannot be bound — below
 * the 2.0 fork, or holding a format-1 transaction with data, in a band
 * without `l1-4` witnesses (every `l1-3` band below height 2,000,000) — are
 * refused unless `allowUnverified` (`L1_BAND_IMPORT_ALLOW_UNVERIFIED`)
 * accepts them. An `l1-4` band's witnesses bind them, so it needs no flag. A run that fails or is
 * refused counts as `failed`, never `idle`. The one quiet case is a bands
 * directory that was never created (nothing installed yet, on a new
 * gateway): `idle`, with the reason logged.
 *
 * A child process rather than a call. The import reads Parquet through
 * DuckDB, whose native code has crashed before, and a crash there must cost
 * one run, not the gateway. It also keeps the import's SQLite page cache
 * and DuckDB's memory out of the gateway's heap, and its synchronous
 * SQLite writes off the gateway's event loop.
 */
/** Runs without a bands directory before the worker says so as a warning. */
export const MISSING_RUNS_BEFORE_WARNING = 6;

/** The longest a fill whose sources could not be read waits before it is tried again. */
export const UNREADABLE_MAX_BACKOFF_MS = 2 * 3600 * 1000;

export class L1BandImportWorker {
  private log: winston.Logger;
  private args: string[];
  private intervalMs: number;
  private firstRunDelayMs: number;
  private runFill: FillRunner;
  private bandsDir: string;
  private statDir: (dir: string) => Promise<unknown>;
  private listDir: (dir: string) => Promise<string[]>;
  private now: () => number;
  private maxBackoffMs: number;
  /**
   * The last refusal: the directory's entries then (band ids carry their
   * digest), and when to try again. A fill refused for the same bands is
   * not re-verified every interval: it waits, twice as long each time,
   * until the directory changes.
   */
  private readonly sampleFrom: string[];
  private readonly countMachines: (urls: string[]) => Promise<number>;
  private sourcesChecked = false;
  private refused:
    | {
        kind: 'refused' | 'unreadable';
        entries: string;
        until: number;
        backoffMs: number;
      }
    | undefined;
  /** Runs in a row that found no bands directory. */
  private missingRuns = 0;
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
    allowUnverified = false,
    statDir = (dir: string) => fsp.stat(dir),
    sampleFrom = [],
    allowUnsampled = false,
    listDir = (dir: string) => fsp.readdir(dir),
    now = Date.now,
    maxBackoffMs = 24 * 3600 * 1000,
    countMachines = distinctMachines,
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
    /**
     * Fill from blocks the checks cannot bind (`--allow-unbound
     * --allow-unverified-format1`): `L1_BAND_IMPORT_ALLOW_UNVERIFIED`.
     * Needed only for bands without witnesses (`l1-3` and older); an
     * `l1-4` band's witnesses bind those blocks.
     */
    allowUnverified?: boolean;
    /** Injected in tests: how the bands directory is looked at. */
    statDir?: (dir: string) => Promise<unknown>;
    /**
     * Sources the fill anchors and samples against (`--anchor-from`):
     * `L1_BAND_IMPORT_SAMPLE_FROM`. Without any, every fill is refused
     * unless `allowUnsampled`.
     */
    sampleFrom?: string[];
    /** Fill with no sample (`--allow-unsampled`): `L1_BAND_IMPORT_ALLOW_UNSAMPLED`. */
    allowUnsampled?: boolean;
    /** Injected in tests: the bands directory's entries. */
    listDir?: (dir: string) => Promise<string[]>;
    now?: () => number;
    /** The longest a refused fill waits before it is tried again unchanged. */
    maxBackoffMs?: number;
    /** Injected in tests: how many distinct machines the sample sources are. */
    countMachines?: (urls: string[]) => Promise<number>;
  }) {
    this.sampleFrom = sampleFrom;
    this.countMachines = countMachines;
    this.log = log.child({ class: 'L1BandImportWorker' });
    this.intervalMs = intervalMs;
    this.firstRunDelayMs = firstRunDelayMs;
    this.runFill = runFill;
    this.bandsDir = bandsDir;
    this.statDir = statDir;
    this.listDir = listDir;
    this.now = now;
    this.maxBackoffMs = maxBackoffMs;
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
      ...(allowUnverified
        ? ['--allow-unbound', '--allow-unverified-format1']
        : []),
      ...(sampleFrom.length > 0 ? ['--anchor-from', sampleFrom.join(',')] : []),
      ...(allowUnsampled ? ['--allow-unsampled'] : []),
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

  /**
   * Once, at the first run: whether the sample sources are at least the
   * two distinct machines a refutation or an attestation needs. With fewer
   * the sample can prove draws, never refute or attest them, so it reads
   * as unreadable rather than as a check.
   */
  private async checkSources(): Promise<void> {
    if (this.sourcesChecked) return;
    this.sourcesChecked = true;
    if (this.sampleFrom.length === 0) {
      this.log.warn(
        'No sample sources (L1_BAND_IMPORT_SAMPLE_FROM): every fill is refused unless L1_BAND_IMPORT_ALLOW_UNSAMPLED=true',
      );
      return;
    }
    try {
      const machines = await this.countMachines(this.sampleFrom);
      if (machines < 2) {
        this.log.warn(
          'The L1 band import sample sources are fewer than two distinct machines: the sample cannot refute or attest anything, so fills will wait as unreadable. Add a source to L1_BAND_IMPORT_SAMPLE_FROM',
          { sources: this.sampleFrom, machines },
        );
      }
    } catch (error) {
      this.log.warn('Could not resolve the L1 band import sample sources', {
        sources: this.sampleFrom,
        error: (error as Error).message,
      });
    }
  }

  /** Runs the fill once; never throws. */
  async runOnce(): Promise<FillSummary | undefined> {
    const started = Date.now();
    await this.checkSources();
    // A worker that was never started is stopped too; only one stopped
    // while this run was going was shut down under it.
    const wasRunning = !this.stopped;
    // A bands directory never created is a gateway with nothing installed
    // yet: idle, said once a run. Any other error reading it is the fill's
    // to report, and fails the run.
    try {
      await this.statDir(this.bandsDir);
      this.missingRuns = 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.missingRuns += 1;
        metrics.l1BandImportRunsTotal.inc({ result: 'idle' });
        // Nothing installed yet is normal on a new gateway; a missing
        // installed/ directory too, or a directory missing run after run,
        // is more likely a misconfigured path.
        const parentMissing = await this.statDir(path.dirname(this.bandsDir))
          .then(() => false)
          .catch(() => true);
        const level =
          parentMissing || this.missingRuns >= MISSING_RUNS_BEFORE_WARNING
            ? 'warn'
            : 'info';
        this.log[level](
          'No bands installed yet: the bands directory does not exist',
          {
            bandsDir: this.bandsDir,
            parentMissing,
            runs: this.missingRuns,
          },
        );
        return undefined;
      }
    }
    let entries = '';
    try {
      entries = (await this.listDir(this.bandsDir)).sort().join('\n');
    } catch {
      entries = '';
    }
    if (
      this.refused !== undefined &&
      this.refused.entries === entries &&
      this.now() < this.refused.until
    ) {
      metrics.l1BandImportRunsTotal.inc({ result: 'deferred' });
      this.log.debug(
        'Fill deferred: the same bands were refused, or their sources unreadable, last time',
        {
          retryAt: new Date(this.refused.until).toISOString(),
        },
      );
      return undefined;
    }

    try {
      const result = await this.runFill(
        this.args,
        (level, line) => {
          // Counted as each range lands, not when the run ends: a first
          // fill runs for hours, and the metric would read 0 throughout.
          const rows = finishedRangeRows(line);
          if (rows !== undefined) metrics.l1BandImportRowsTotal.inc(rows);
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
      if (result.code !== 0 && summary?.refusal === 'unreadable') {
        // The sources could not be read: an outage, not evidence against
        // the bands. Tried again after an interval, doubling while it
        // lasts up to UNREADABLE_MAX_BACKOFF_MS, and at once when the
        // bands change.
        metrics.l1BandImportRunsTotal.inc({ result: 'unreadable' });
        const same =
          this.refused?.kind === 'unreadable' &&
          this.refused.entries === entries;
        const backoffMs = same
          ? Math.min(
              UNREADABLE_MAX_BACKOFF_MS,
              (this.refused?.backoffMs ?? 0) * 2,
            )
          : this.intervalMs;
        this.refused = {
          kind: 'unreadable',
          entries,
          backoffMs,
          until: this.now() + backoffMs,
        };
        this.log.warn(
          'Fill waits: its sources could not be read; it is tried again later',
          {
            reason: summary.refused,
            retryAt: new Date(this.refused.until).toISOString(),
            seconds: Math.round((Date.now() - started) / 1000),
          },
        );
        return summary;
      }
      if (result.code !== 0) {
        metrics.l1BandImportRunsTotal.inc({ result: 'failed' });
        if (summary?.refused !== undefined) {
          const same =
            this.refused?.kind === 'refused' &&
            this.refused.entries === entries;
          const backoffMs = same
            ? Math.min(this.maxBackoffMs, (this.refused?.backoffMs ?? 0) * 2)
            : this.intervalMs;
          this.refused = {
            kind: 'refused',
            entries,
            backoffMs,
            until: this.now() + backoffMs,
          };
        }
        if (wasRunning && this.stopped) {
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
      this.refused = undefined;
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
