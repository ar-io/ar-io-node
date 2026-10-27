/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ChildProcess } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import winston from 'winston';

import * as metrics from '../metrics.js';
import { cliInvocation, spawnFill } from './l1-band-import-worker.js';

/** What one run reported, as `index-l2-import` prints it. */
export interface L2ImportSummary {
  imported?: number;
  pending?: number;
  waiting?: number;
  jobs?: Array<{
    band?: string;
    job?: string | null;
    counts?: { written?: number; conflicting?: number };
  }>;
  loaded?: string[];
  failed?: Array<{ job: string; reason: string }>;
  refused?: string;
  /** `unreadable`: only the on-chain sample could not be read (an outage). */
  refusal?: 'refused' | 'unreadable';
}

/** Runs the import command once and reports how it ended. */
export type L2ImportRunner = (
  args: string[],
  onLog: (level: string, line: string) => void,
  register: (child: ChildProcess) => void,
) => Promise<{ code: number | null; summary?: L2ImportSummary; tail: string }>;

/** The longest an import whose sample could not be read waits before it is tried again. */
export const UNREADABLE_MAX_BACKOFF_MS = 2 * 3600 * 1000;

/**
 * Imports installed `parquet-l2` bands into this gateway's ClickHouse by
 * running `ar-io-node index-l2-import --target clickhouse` on a schedule,
 * once per index named in `L2_BAND_IMPORT_INDEXES`.
 *
 * Each run verifies the bands it takes and queues jobs for
 * `clickhouse-auto-import` to load; a run with nothing to do reads the bands
 * directory, the ledger and ClickHouse's top height, and writes nothing. It
 * keeps running so the publisher's next tip band, and heights the gateway's
 * own export reaches later, are imported too.
 *
 * A child process, as the L1 import is (`L1BandImportWorker`): DuckDB's
 * native code and memory stay out of the gateway. A band refused is not
 * verified again every interval: its index waits, twice as long each time,
 * until its directory changes.
 */
export class L2BandImportWorker {
  private log: winston.Logger;
  private readonly runs: Array<{ index: string; dir: string; args: string[] }>;
  private intervalMs: number;
  private firstRunDelayMs: number;
  private runImport: L2ImportRunner;
  private listDir: (dir: string) => Promise<string[]>;
  private now: () => number;
  private maxBackoffMs: number;
  private refused = new Map<
    string,
    {
      kind: 'refused' | 'unreadable';
      entries: string;
      until: number;
      backoffMs: number;
    }
  >();
  private timer: NodeJS.Timeout | undefined;
  private child: ChildProcess | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;

  constructor({
    log,
    indexes,
    indexesDir = 'data/indexes/installed',
    publication,
    registryUrl,
    arweaveNodes,
    maxQueued,
    maxUnchecked = 0,
    intervalMs,
    firstRunDelayMs = 120_000,
    runImport = spawnFill as L2ImportRunner,
    invocation = cliInvocation(),
    listDir = (dir: string) => fsp.readdir(dir),
    now = Date.now,
    maxBackoffMs = 24 * 3600 * 1000,
  }: {
    log: winston.Logger;
    /** Installed index names, e.g. `ardrive-l2`. */
    indexes: string[];
    indexesDir?: string;
    /** The publisher's signed publication (`--publication`). */
    publication: string;
    /** Where the publication's key is read (`--registry-url`). */
    registryUrl: string;
    /** Arweave nodes the on-chain sample reads (`--arweave-nodes`). */
    arweaveNodes?: string[];
    maxQueued?: number;
    /** Sample items per band that may go unread (`--max-unchecked`). */
    maxUnchecked?: number;
    intervalMs: number;
    firstRunDelayMs?: number;
    runImport?: L2ImportRunner;
    invocation?: string[];
    listDir?: (dir: string) => Promise<string[]>;
    now?: () => number;
    maxBackoffMs?: number;
  }) {
    this.log = log.child({ class: 'L2BandImportWorker' });
    this.intervalMs = intervalMs;
    this.firstRunDelayMs = firstRunDelayMs;
    this.runImport = runImport;
    this.listDir = listDir;
    this.now = now;
    this.maxBackoffMs = maxBackoffMs;
    this.runs = indexes.map((index) => {
      const dir = path.join(indexesDir, index);
      return {
        index,
        dir,
        args: [
          ...invocation,
          'index-l2-import',
          '--target',
          'clickhouse',
          '--bands-dir',
          dir,
          '--publication',
          publication,
          '--registry-url',
          registryUrl,
          ...(arweaveNodes !== undefined && arweaveNodes.length > 0
            ? ['--arweave-nodes', arweaveNodes.join(',')]
            : []),
          ...(maxQueued !== undefined
            ? ['--max-queued', String(maxQueued)]
            : []),
          ...(maxUnchecked > 0
            ? ['--max-unchecked', String(maxUnchecked)]
            : []),
        ],
      };
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log.info('Starting', {
      intervalMs: this.intervalMs,
      indexes: this.runs.map((r) => r.index),
    });
    this.schedule(this.firstRunDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // An interrupted run is safe: a job is queued only once whole, and the
    // ledger records it only after.
    this.child?.kill('SIGTERM');
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runAll().finally(() => {
        this.running = undefined;
        this.schedule(this.intervalMs);
      });
    }, delayMs);
  }

  /** Runs every index once, one after another. */
  async runAll(): Promise<void> {
    for (const run of this.runs) {
      if (this.stopped) return;
      await this.runOnce(run.index);
    }
  }

  /** Runs one index's import once; never throws. */
  async runOnce(index: string): Promise<L2ImportSummary | undefined> {
    const run = this.runs.find((r) => r.index === index);
    if (run === undefined) return undefined;
    const started = Date.now();
    let entries: string;
    try {
      entries = (await this.listDir(run.dir)).sort().join('\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        metrics.l2BandImportRunsTotal.inc({ result: 'idle' });
        this.log.info('No bands installed yet for this index', {
          index,
          bandsDir: run.dir,
        });
        return undefined;
      }
      entries = '';
    }
    const last = this.refused.get(index);
    if (
      last !== undefined &&
      last.entries === entries &&
      this.now() < last.until
    ) {
      metrics.l2BandImportRunsTotal.inc({ result: 'deferred' });
      this.log.debug('Import deferred: the same bands were refused last time', {
        index,
        retryAt: new Date(last.until).toISOString(),
      });
      return undefined;
    }

    const wasRunning = !this.stopped;
    try {
      const result = await this.runImport(
        run.args,
        (level, line) => {
          if (level === 'error' || level === 'warn') {
            this.log.warn(line, { index });
          } else if (level === 'info') {
            this.log.info(line, { index });
          } else {
            this.log.debug(line, { index });
          }
        },
        (child) => {
          this.child = child;
        },
      );
      this.child = undefined;
      const summary = result.summary;
      // Jobs a run queued count whether or not it refused another band.
      for (const job of summary?.jobs ?? []) {
        metrics.l2BandImportRowsTotal.inc(job.counts?.written ?? 0);
        metrics.l2BandImportConflictsTotal.inc(job.counts?.conflicting ?? 0);
      }
      const imported = (summary?.imported ?? 0) > 0;
      if (result.code !== 0 && imported) {
        // Some bands queued, another refused: no wait, so the bands that
        // pass keep moving; the refused one is tried again next run.
        this.refused.delete(index);
        metrics.l2BandImportRunsTotal.inc({ result: 'queued' });
        this.log.warn('Import queued bands and refused others', {
          index,
          imported: summary?.imported,
          refused: summary?.refused,
          seconds: Math.round((Date.now() - started) / 1000),
        });
        return summary;
      }
      if (result.code !== 0) {
        const unreadable = summary?.refusal === 'unreadable';
        metrics.l2BandImportRunsTotal.inc({
          result: unreadable ? 'unreadable' : 'failed',
        });
        if (summary?.refused !== undefined) {
          const kind = unreadable ? 'unreadable' : 'refused';
          const same = last?.kind === kind && last.entries === entries;
          const cap = unreadable
            ? UNREADABLE_MAX_BACKOFF_MS
            : this.maxBackoffMs;
          const backoffMs = same
            ? Math.min(cap, (last?.backoffMs ?? 0) * 2)
            : this.intervalMs;
          this.refused.set(index, {
            kind,
            entries,
            backoffMs,
            until: this.now() + backoffMs,
          });
        }
        if (wasRunning && this.stopped) {
          this.log.info(
            'Import interrupted by shutdown; the next run redoes it',
            {
              index,
            },
          );
        } else {
          this.log.error('Import failed; the next run carries on from here', {
            index,
            code: result.code,
            reason: summary?.refused ?? result.tail.trim().split('\n').pop(),
            seconds: Math.round((Date.now() - started) / 1000),
          });
        }
        return summary;
      }
      this.refused.delete(index);
      metrics.l2BandImportRunsTotal.inc({
        result: imported ? 'queued' : 'idle',
      });
      this.log[imported ? 'info' : 'debug']('Import finished', {
        index,
        imported: summary?.imported,
        pending: summary?.pending,
        waiting: summary?.waiting,
        loaded: summary?.loaded?.length,
        seconds: Math.round((Date.now() - started) / 1000),
      });
      return summary;
    } catch (error) {
      this.child = undefined;
      metrics.l2BandImportRunsTotal.inc({ result: 'failed' });
      this.log.error('Could not run the import', {
        index,
        error: (error as Error).message,
      });
      return undefined;
    }
  }
}
