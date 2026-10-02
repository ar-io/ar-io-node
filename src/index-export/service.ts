/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The index-export service: a run builds the bands that are due (bootstrap,
 * the weekly fold, the daily delta) and publishes them for the index-swarm
 * sidecar; the loop runs one a day at a fixed UTC time, retries a run that
 * couldn't check, and ticks a heartbeat that `/healthz` reports.
 *
 * Kind-agnostic but for the steps it runs, which root-TX supplies; a second
 * band kind brings its own planner and build step, and its own entry in the
 * state file.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import type { RootSourceFactory } from '../lib/index-band/verify.js';
import type { ExportConfig } from './config.js';
import {
  buildStepBand,
  INDEX_NAME,
  StepContext,
  StepOutcome,
} from './kinds/root-tx/kind.js';
import {
  bootstrapFrom,
  BuildStep,
  currentRecent,
  FOLD_INTERVAL_MS,
  OVERLAP_BLOCKS,
  planBootstrap,
  planDelta,
  planFold,
  PlanInput,
} from './kinds/root-tx/planner.js';
import { l1RangeOf } from '../lib/parquet-l1/layout.js';
import {
  deriveL1Bands,
  L1_INDEX,
  L1Outcome,
  L1PublishedBand,
  L1Step,
  planL1,
  runL1Step,
} from './kinds/parquet-l1/kind.js';
import { CsvOverlaySource } from './kinds/root-tx/sources/csv.js';
import type { RecordSource } from './kinds/root-tx/sources/rows.js';
import { ExportLock, LOCK_STALE_MS, LockHolder } from './lock.js';
import * as metrics from './metrics.js';
import {
  BandRole,
  deriveOwnBands,
  IndexState,
  indexState,
  loadState,
  OwnBand,
  updateIndexState,
} from './state.js';

/** How often the loop ticks; `/healthz` fails when it hasn't for 5 minutes. */
export const HEARTBEAT_MS = 30_000;
export const HEALTHY_WITHIN_MS = 5 * 60_000;
/** Retry delay after a run that couldn't check: 15 minutes, doubling to 2 hours. */
export const RETRY_FIRST_MS = 15 * 60_000;
export const RETRY_MAX_MS = 2 * 3600_000;
/** How long the loop waits after a run that was locked out or threw. */
export const BLOCKED_WAIT_MS = LOCK_STALE_MS;
/**
 * How long a run may keep starting L1 history bands: a whole-chain bootstrap
 * (about 5 to 7 hours) spreads over runs.
 */
export const L1_RUN_BUDGET_MS = 4 * 3600_000;
/** Dry-run staging this old belongs to a dry run that was killed. */
const DRY_RUN_STALE_MS = 12 * 3600_000;
/** Superseded band ids a new band also names, per role. */
const HISTORY_KEPT = 8;

const STAGING_PREFIX = '.band-build-';
const GIB = 1024 ** 3;

export interface RunOptions {
  /** Build and check, but publish nothing; no lock, no state saved. */
  dryRun?: boolean;
  /**
   * With a dry run: keep the bands, in this directory (same filesystem as
   * the publish directory), to compare them.
   */
  keepDir?: string;
  /** Read no higher than this, for comparing runs at a fixed height. */
  toHeight?: number;
  /** An operator's run: retry a fold that was rejected. */
  force?: boolean;
}

export interface RunReport {
  at: string;
  dryRun: boolean;
  /** Set when another run holds the lock. */
  locked?: { holder?: LockHolder; ageSeconds: number };
  stableTop?: number;
  /** Set when the run couldn't start (a source, the disk, foreign bands). */
  failed?: { reason: string; message: string };
  steps: StepOutcome[];
  /** The `parquet-l1` bands built, in order. */
  l1Steps: L1Outcome[];
  /** `parquet-l1` bands planned but left for the next run (the time budget). */
  l1Deferred?: Array<[number, number]>;
  gateUrl: string;
  /** Disk the run's builds needed together (each step's scratch and band). */
  peakBytes: number;
  /** Where a dry run with `keepDir` left its bands. */
  keptIn?: string;
}

export interface OpenedSource {
  source: RecordSource;
  optional: boolean;
}

export interface ServiceDeps {
  config: ExportConfig;
  log: Logger;
  /** Opens the configured sources, fresh for each run. */
  openSources: () => Promise<OpenedSource[]>;
  /** Opens roots for the header check; `close` ends its connections. */
  openRoots: () => { openRoot: RootSourceFactory; close: () => void };
  now?: () => number;
  /** Free and total bytes under a directory; overridable for tests. */
  diskSpace?: (dir: string) => Promise<{ free: number; total: number }>;
  /** Header-check read retries; overridable for tests. */
  headerCheck?: { retries?: number; retryDelayMs?: number };
}

/**
 * A report as `--once` prints it: each band's header-check sample becomes a
 * count (the entries are hundreds of lines and in the logs' place, nobody's
 * reading); everything else as is.
 */
export function reportForOutput(report: RunReport): unknown {
  return {
    ...report,
    steps: report.steps.map((step) => {
      if (step.band === undefined) return step;
      const { sample, ...band } = step.band;
      return { ...step, band: { ...band, sampled: sample.length } };
    }),
  };
}

/** The overall result of a run: the worst of its steps. */
export function runResult(report: RunReport): string {
  if (report.locked !== undefined) return 'locked';
  if (report.failed !== undefined) {
    return report.failed.reason === 'foreign_bands'
      ? 'rejected'
      : 'couldnt_check';
  }
  const order = [
    'rejected',
    'couldnt_check',
    'published',
    'dry_run',
    'unchanged',
    'skipped',
  ];
  const all = [...report.steps, ...(report.l1Steps ?? [])];
  for (const result of order) {
    if (all.some((step) => step.result === result)) return result;
  }
  return 'nothing_due';
}

const bandBytes = (band: OwnBand) =>
  band.manifest.partitions.reduce((sum, partition) => sum + partition.size, 0);

const ok = (outcome: StepOutcome) =>
  outcome.result === 'published' ||
  outcome.result === 'unchanged' ||
  outcome.result === 'skipped' ||
  outcome.result === 'dry_run';

/** The top of this publisher's live L1 bands: `h` the whole ranges, `d` the tip band. */
function recordL1Bands(bands: L1PublishedBand[]): void {
  const whole = bands.filter((b) => b.to === l1RangeOf(b.from)[1]);
  const tip = bands.filter((b) => b.to !== l1RangeOf(b.from)[1]);
  for (const [kind, set] of [
    ['h', whole],
    ['d', tip],
  ] as const) {
    if (set.length > 0) {
      metrics.bandTop.set(
        { index: L1_INDEX, kind },
        Math.max(...set.map((b) => b.to)),
      );
    }
  }
}

/** The state names of the indexes a run builds. */
function indexNames(kinds: readonly string[]): string[] {
  return [
    ...(kinds.includes('root-tx-index') ? [INDEX_NAME] : []),
    ...(kinds.includes('parquet-l1') ? [L1_INDEX] : []),
  ];
}

/** The L1 part's outcome alone. */
export function l1Result(report: RunReport): string {
  return report.l1Steps.length === 0
    ? 'nothing_due'
    : runResult({ ...report, steps: [], failed: undefined, locked: undefined });
}

/** Bands are renamed from the work directory into place. */
async function assertSameFilesystem(
  workDir: string,
  publishDir: string,
): Promise<void> {
  const [work, publish] = await Promise.all([
    fs.stat(workDir),
    fs.stat(publishDir),
  ]);
  if (work.dev !== publish.dev) {
    throw new RunFailure(
      'disk',
      `${workDir} and ${publishDir} are on different filesystems; bands are renamed into place`,
    );
  }
}

/** The lowest and highest stable heights in `core.db`; -1 when it holds none. */
function coreHeights(coreDbPath: string): { lowest: number; top: number } {
  let db: Sqlite.Database;
  try {
    db = new Sqlite(coreDbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new RunFailure(
      'source',
      `Cannot open ${coreDbPath} read-only: ${(error as Error).message} (it needs the gateway's -wal and -shm files, so the gateway running)`,
    );
  }
  try {
    // Separate statements: each is a single index probe.
    const at = (sql: string) =>
      (db.prepare(sql).pluck().get() as number | null) ?? -1;
    return {
      lowest: at('SELECT MIN(height) FROM stable_blocks'),
      top: at('SELECT MAX(height) FROM stable_blocks'),
    };
  } finally {
    db.close();
  }
}

async function statfsSpace(
  dir: string,
): Promise<{ free: number; total: number }> {
  const { bavail, blocks, bsize } = await fs.statfs(dir);
  return { free: bavail * bsize, total: blocks * bsize };
}

export class ExportService {
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private beat?: NodeJS.Timeout;
  private lastBeat = 0;
  private running?: Promise<RunReport>;
  private lock?: ExportLock;
  private stopped = false;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get stateFile() {
    return path.join(this.deps.config.workDir, 'state.json');
  }

  private get lockFile() {
    return path.join(this.deps.config.workDir, 'lock');
  }

  /** Whether the loop has ticked recently: what `/healthz` reports. */
  alive(): boolean {
    return this.now() - this.lastBeat < HEALTHY_WITHIN_MS;
  }

  /** Starts the heartbeat alone, for a `--once` run that serves `/healthz`. */
  startHeartbeat(): void {
    const tick = () => {
      this.lastBeat = this.now();
      metrics.heartbeat.set(this.lastBeat / 1000);
    };
    tick();
    this.beat = setInterval(tick, HEARTBEAT_MS);
  }

  /** Sets the gauges a restart would otherwise leave absent until the next success. */
  async seedMetrics(): Promise<void> {
    const state = indexState(await loadState(this.stateFile), INDEX_NAME);
    for (const [role, at] of Object.entries(state.lastSuccess)) {
      metrics.lastSuccess.set(
        { index: INDEX_NAME, kind: role },
        Date.parse(at) / 1000,
      );
    }
    this.recordBands(
      await deriveOwnBands(
        this.deps.config.publishDir,
        this.deps.config.publisher,
        state.adoptions,
      ),
    );
    if (this.deps.config.kinds.includes('parquet-l1')) {
      const l1 = indexState(await loadState(this.stateFile), L1_INDEX);
      for (const [role, at] of Object.entries(l1.lastSuccess)) {
        metrics.lastSuccess.set(
          { index: L1_INDEX, kind: role },
          Date.parse(at) / 1000,
        );
      }
      recordL1Bands(
        await deriveL1Bands(
          this.deps.config.l1PublishDir,
          this.deps.config.publisher,
        ),
      );
    }
  }

  /**
   * One run: the bands due now. A dry run builds and checks them but
   * publishes nothing (or, with `keepDir`, publishes there), takes no lock
   * and saves no state.
   */
  async runOnce(options: RunOptions = {}): Promise<RunReport> {
    const { config, log } = this.deps;
    const dryRun = options.dryRun === true || options.keepDir !== undefined;
    const report: RunReport = {
      at: new Date(this.now()).toISOString(),
      dryRun,
      steps: [],
      l1Steps: [],
      gateUrl: config.headerCheckUrl,
      peakBytes: 0,
    };
    await fs.mkdir(config.workDir, { recursive: true });
    await fs.mkdir(config.publishDir, { recursive: true });

    if (!dryRun) {
      // The real clock: a lock's age is measured against file times.
      const acquired = await ExportLock.acquire(this.lockFile);
      if (!acquired.acquired) {
        report.locked = {
          ...(acquired.holder !== undefined ? { holder: acquired.holder } : {}),
          ageSeconds: Math.round(acquired.ageMs / 1000),
        };
        metrics.runs.inc({
          index: INDEX_NAME,
          kind: 'run',
          result: 'locked',
          reason: 'locked',
        });
        log.warn('Another run holds the lock; not running', report.locked);
        return report;
      }
      this.lock = acquired.lock;
    }
    try {
      const { kinds } = this.deps.config;
      if (!dryRun) {
        for (const index of indexNames(kinds)) {
          await updateIndexState(this.stateFile, index, (state) => {
            state.lastRun = { at: report.at, outcome: 'running' };
          });
        }
      }
      metrics.runInProgress.set(1);
      metrics.runStarted.set(this.now() / 1000);
      // Staging only a run killed before its cleanup can have left: the lock
      // is this run's.
      if (!dryRun) await this.clearStaging();
      const result: RunMemory = kinds.includes('root-tx-index')
        ? await this.run(report, options, dryRun)
        : { superseded: [] };
      if (kinds.includes('parquet-l1')) {
        await this.runL1(report, options, dryRun);
      }
      if (!dryRun) {
        // Each index keeps its own outcome and retry.
        if (kinds.includes('root-tx-index')) {
          await updateIndexState(this.stateFile, INDEX_NAME, (state) =>
            this.updateState(state, report, result),
          );
        }
        if (kinds.includes('parquet-l1')) {
          await updateIndexState(this.stateFile, L1_INDEX, (state) =>
            this.updateL1State(state, report),
          );
        }
      }
    } finally {
      metrics.runInProgress.set(0);
      await this.lock?.release();
      this.lock = undefined;
    }
    return report;
  }

  /** The run itself; what it learns about folds and history comes back for the state. */
  private async run(
    report: RunReport,
    options: RunOptions,
    dryRun: boolean,
  ): Promise<RunMemory> {
    const { config, log } = this.deps;
    const memory: RunMemory = { superseded: [] };
    const state = indexState(await loadState(this.stateFile), INDEX_NAME);
    let opened: OpenedSource[] = [];
    let roots: { openRoot: RootSourceFactory; close: () => void } | undefined;
    // Dry runs stage apart, so a service run's start can't clear them.
    const workDir = dryRun
      ? path.join(config.workDir, 'dry-run')
      : config.workDir;
    const publishDir = options.keepDir ?? config.publishDir;
    try {
      await fs.mkdir(workDir, { recursive: true });
      await fs.mkdir(publishDir, { recursive: true });

      opened = await this.deps.openSources();
      const ready = await this.reachableSources(opened);
      const peers = ready.filter(({ source }) => source.rank === 0);
      if (peers.length === 0) {
        throw new RunFailure('source', 'no peer source is available');
      }
      const tops = await Promise.all(
        peers.map(async ({ source }) => source.stableHeight()),
      );
      const stableTop = Math.min(
        ...tops,
        ...(options.toHeight !== undefined ? [options.toHeight] : []),
      );
      report.stableTop = stableTop;
      await this.recordOverlays(ready, memory);

      roots = this.deps.openRoots();
      const context: StepContext = {
        log,
        publisher: config.publisher,
        publishDir,
        workDir,
        sources: ready.map(({ source }) => source),
        optional: new Set(
          ready.filter((s) => s.optional).map(({ source }) => source.name),
        ),
        openRoot: roots.openRoot,
        dryRun: dryRun && options.keepDir === undefined,
        ...(this.deps.headerCheck !== undefined
          ? { headerCheck: this.deps.headerCheck }
          : {}),
        ...(this.lock !== undefined
          ? { stillHeld: async () => this.lock?.held() ?? false }
          : {}),
      };
      const plan = async (): Promise<PlanInput> => ({
        bands: await deriveOwnBands(
          config.publishDir,
          config.publisher,
          state.adoptions,
        ),
        stableTop,
        ...(config.startHeight !== undefined
          ? { startHeight: config.startHeight }
          : {}),
        recentMaxBlocks: config.recentMaxBlocks,
      });
      const history = (role: BandRole) => state.supersededHistory?.[role] ?? [];
      const run = async (step: BuildStep, bands: OwnBand[]) => {
        // Name the bands a subscriber may still hold from before, too. Not
        // for a new r above a frozen one: it covers other heights, and a
        // subscriber retiring the old chain for it before the frozen band
        // arrives would lose them.
        const inherits = step.role !== 'r' || step.fold !== undefined;
        const withHistory: BuildStep = {
          ...step,
          supersedes: [
            ...new Set([
              ...(inherits ? history(step.role) : []),
              ...step.supersedes,
            ]),
          ].slice(-HISTORY_KEPT * 2),
        };
        await this.checkDisk(step, bands);
        const outcome = await buildStepBand(withHistory, context);
        report.steps.push(outcome);
        report.peakBytes += outcome.peakBytes ?? 0;
        if (outcome.result === 'published') {
          memory.superseded.push({ role: step.role, ids: step.supersedes });
          // A frozen r ends its chain: the next r starts a new one.
          if (step.role === 'r' && step.freezes === true) {
            memory.chainEnded = [...(memory.chainEnded ?? []), 'r'];
          }
        }
        log.info('Band step finished', {
          kind: outcome.role,
          heightRange: outcome.heightRange,
          result: outcome.result,
          reason: outcome.reason,
          id: outcome.band?.id,
          records: outcome.band?.records,
          inputs: outcome.inputs,
          seconds: outcome.seconds,
          peakBytes: outcome.peakBytes,
          details: outcome.details,
        });
        return outcome;
      };

      const before = await plan();
      await this.refuseForeignBands(before.bands);
      const from = bootstrapFrom(before);
      let deltaInput = before;
      if (from !== undefined) {
        // Bootstrap, in order: each band published before the next is cut.
        let input = before;
        for (const step of planBootstrap(before, from)) {
          const outcome = await run(step, input.bands);
          if (!ok(outcome)) break;
          if (step.role === 'r' && outcome.result === 'published') {
            memory.foldedAt = report.at;
          }
          input = await plan();
        }
        deltaInput = await plan();
      } else if (this.foldDue(state, before, options)) {
        const step = planFold(before);
        if (step === undefined) {
          memory.foldedAt = report.at;
        } else {
          const outcome = await run(step, before.bands);
          if (outcome.result === 'rejected') memory.foldRejected = true;
          if (ok(outcome)) memory.foldedAt = report.at;
          // The delta keeps its start on a fold day, so a subscriber that
          // installs it before the new r still holds every height; it moves
          // up with the next daily run.
        }
      }
      const delta = planDelta(deltaInput);
      if (delta !== undefined) {
        // A delta planned over the bands before a fold must still replace
        // every delta live now.
        const live = (await plan()).bands.filter((b) => b.role === 'd');
        await run(
          {
            ...delta,
            supersedes: [
              ...new Set([...delta.supersedes, ...live.map((b) => b.id)]),
            ],
          },
          deltaInput.bands,
        );
      }
      if (!dryRun) await this.pruneOverlays(before.bands, ready);
      this.recordBands((await plan()).bands);
      if (options.keepDir !== undefined) report.keptIn = options.keepDir;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed = {
        reason: error instanceof RunFailure ? error.reason : 'error',
        message,
      };
      metrics.runs.inc({
        index: INDEX_NAME,
        kind: 'run',
        result: runResult(report),
        reason: report.failed.reason,
      });
      log.error('Run stopped before its bands were built', report.failed);
    } finally {
      roots?.close();
      await Promise.all(
        opened.map(({ source }) => source.close().catch(() => undefined)),
      );
    }
    return memory;
  }

  /**
   * Whether the weekly fold is due: a week after the last, by the state or
   * by the current r's own creation (a crash after a fold published left the
   * state behind). A rejected fold waits for an operator's run.
   */
  private foldDue(
    state: IndexState,
    input: PlanInput,
    options: RunOptions,
  ): boolean {
    const recent = currentRecent(input.bands, input.recentMaxBlocks);
    const times = [state.lastFoldAt, recent?.manifest.createdAt]
      .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
      .filter((at) => !Number.isNaN(at));
    const last = times.length > 0 ? Math.max(...times) : undefined;
    const rejected =
      state.foldRejectedAt === undefined
        ? undefined
        : Date.parse(state.foldRejectedAt);
    if (
      options.force !== true &&
      rejected !== undefined &&
      (last === undefined || rejected > last)
    ) {
      this.deps.log.warn(
        'The last fold was rejected; folds wait for an operator (run index-export --once)',
        { at: state.foldRejectedAt },
      );
      return false;
    }
    return last === undefined || this.now() - last >= FOLD_INTERVAL_MS;
  }

  /**
   * Refuses to bootstrap over bands in the publish directory that are
   * neither this service's nor adopted (a publisher's bands built another
   * way): new bands would overlap them. Adopt them first.
   */
  private async refuseForeignBands(own: OwnBand[]): Promise<void> {
    if (own.length > 0) return;
    const ownIds = new Set(own.map((band) => band.id));
    const names = await fs
      .readdir(this.deps.config.publishDir)
      .catch(() => [] as string[]);
    const foreign: string[] = [];
    for (const name of names) {
      if (name.startsWith('.') || ownIds.has(name)) continue;
      const manifest = path.join(
        this.deps.config.publishDir,
        name,
        'manifest.json',
      );
      if (
        await fs.stat(manifest).then(
          () => true,
          () => false,
        )
      ) {
        foreign.push(name);
      }
    }
    if (foreign.length > 0) {
      throw new RunFailure(
        'foreign_bands',
        `${this.deps.config.publishDir} holds bands this service didn't build (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}); adopt them first (--adopt <id> --as h|r|d), or move them away, rather than bootstrap over them`,
      );
    }
  }

  /**
   * The `parquet-l1` part of a run: every whole height range up to the
   * stable top that isn't published, in order, then the tip band. A history
   * band isn't started once {@link L1_RUN_BUDGET_MS} has passed, so a
   * bootstrap of the whole chain spreads over runs; the rest is reported as
   * deferred. A failed band stops the run's L1 part: bands are imported as a
   * contiguous run, so later ones wait.
   */
  private async runL1(
    report: RunReport,
    options: RunOptions,
    dryRun: boolean,
  ): Promise<void> {
    const { config, log } = this.deps;
    const started = this.now();
    const workDir = dryRun
      ? path.join(config.workDir, 'dry-run')
      : config.workDir;
    const publishDir =
      options.keepDir !== undefined
        ? path.join(options.keepDir, L1_INDEX)
        : config.l1PublishDir;
    let current: L1Step | undefined;
    try {
      await fs.mkdir(workDir, { recursive: true });
      await fs.mkdir(publishDir, { recursive: true });
      const heights = coreHeights(config.coreDbPath);
      if (heights.lowest > 0) {
        throw new RunFailure(
          'incomplete',
          `core.db starts at height ${heights.lowest}: L1 bands need the chain from height 0, so a gateway that started above it (START_HEIGHT) can't build them`,
        );
      }
      // One below the stable top: the block above anchors a band's last.
      const top = Math.min(
        heights.top - 1,
        options.toHeight ?? Number.MAX_SAFE_INTEGER,
      );
      const state = indexState(await loadState(this.stateFile), L1_INDEX);
      const bands = await deriveL1Bands(config.l1PublishDir, config.publisher);
      const steps = planL1(bands, top, state.supersededHistory?.d ?? []);
      const held = state.lastRejection;
      for (const [i, step] of steps.entries()) {
        // A rejected band waits for an operator's run, rather than being
        // rebuilt and rejected every day. By its range's start: a tip band's
        // end moves with the top, and the rows that failed are still there.
        if (
          options.force !== true &&
          held?.heightRange !== undefined &&
          held.heightRange[0] === step.heightRange[0]
        ) {
          report.l1Steps.push({
            index: L1_INDEX,
            role: step.role,
            heightRange: step.heightRange,
            result: 'rejected',
            reason: 'held',
            details: [
              `Rejected ${held.at} and waiting for an operator: ${held.reasons.slice(1, 2).join('')}. Repair those blocks in core.db, then run index-export --once`,
            ],
            seconds: 0,
          });
          break;
        }
        if (step.role === 'h' && this.now() - started >= L1_RUN_BUDGET_MS) {
          report.l1Deferred = steps.slice(i).map((s) => s.heightRange);
          log.info('L1 bands left for the next run', {
            count: report.l1Deferred.length,
          });
          break;
        }
        current = step;
        await this.checkL1Disk(bands, publishDir);
        const outcome = await runL1Step(step, {
          coreDbPath: config.coreDbPath,
          workDir,
          publishDir,
          publisher: config.publisher,
          dryRun: dryRun && options.keepDir === undefined,
          log,
        });
        report.l1Steps.push(outcome);
        report.peakBytes +=
          (outcome.scratchBytes ?? 0) + (outcome.bandBytes ?? 0);
        if (
          outcome.result === 'rejected' ||
          outcome.result === 'couldnt_check'
        ) {
          break;
        }
      }
      recordL1Bands(await deriveL1Bands(config.l1PublishDir, config.publisher));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = error instanceof RunFailure ? error.reason : 'source';
      report.l1Steps.push({
        index: L1_INDEX,
        role: current?.role ?? 'h',
        heightRange: current?.heightRange ?? [0, 0],
        result: 'couldnt_check',
        reason,
        details: [message],
        seconds: 0,
      });
      metrics.runs.inc({
        index: L1_INDEX,
        kind: current?.role ?? 'run',
        result: 'couldnt_check',
        reason,
      });
      log.error('L1 export stopped', { error: message });
    }
  }

  /**
   * Room for one L1 band: its scratch (hex text, about twice the rows' size)
   * and the band, so about eight times the largest band published, at least
   * 10 GiB, beyond the same margin as root-TX bands.
   */
  private async checkL1Disk(
    bands: L1PublishedBand[],
    publishDir: string,
  ): Promise<void> {
    const { workDir } = this.deps.config;
    await assertSameFilesystem(workDir, publishDir);
    const { free, total } = await (this.deps.diskSpace ?? statfsSpace)(workDir);
    const margin = Math.max(0.05 * total, 10 * GIB);
    const largest = await Promise.all(
      bands.map(async (b) => {
        let bytes = 0;
        for (const name of await fs
          .readdir(b.dir)
          .catch(() => [] as string[])) {
          bytes +=
            (await fs.stat(path.join(b.dir, name)).catch(() => undefined))
              ?.size ?? 0;
        }
        return bytes;
      }),
    ).then((sizes) => Math.max(0, ...sizes));
    const need = margin + Math.max(8 * largest, 10 * GIB);
    if (free < need) {
      throw new RunFailure(
        'disk',
        `${Math.round(free / GIB)} GiB free under ${workDir}, under the ${Math.round(need / GIB)} GiB an L1 band needs (with a ${Math.round(margin / GIB)} GiB margin)`,
      );
    }
  }

  private updateL1State(state: IndexState, report: RunReport): void {
    const at = report.at;
    for (const step of report.l1Steps) {
      if (step.result === 'published' || step.result === 'unchanged') {
        state.lastSuccess[step.role] = at;
        metrics.lastSuccess.set(
          { index: L1_INDEX, kind: step.role },
          Date.parse(at) / 1000,
        );
        if (state.lastRejection?.heightRange?.[0] === step.heightRange[0]) {
          delete state.lastRejection;
        }
      }
      if (step.result === 'rejected' && step.reason !== 'held') {
        state.lastRejection = {
          at,
          role: step.role,
          reasons: [step.reason, ...(step.details ?? [])].slice(0, 25),
          heightRange: step.heightRange,
        };
      }
      if (step.result === 'published' && step.supersedes !== undefined) {
        state.supersededHistory = {
          ...state.supersededHistory,
          d: [
            ...new Set([
              ...(state.supersededHistory?.d ?? []),
              ...step.supersedes,
            ]),
          ].slice(-HISTORY_KEPT),
        };
      }
    }
    const result = l1Result(report);
    const failed = report.l1Steps.find(
      (s) => s.result === 'rejected' || s.result === 'couldnt_check',
    );
    // A core.db that lacks heights won't gain them by retrying, nor does a
    // band held for an operator; bands left by the time budget follow soon.
    const transient = report.l1Steps.some(
      (s) => s.result === 'couldnt_check' && s.reason !== 'incomplete',
    );
    if (transient) {
      const attempts = (state.retry?.attempts ?? 0) + 1;
      state.retry = {
        at: new Date(
          this.now() +
            Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
        ).toISOString(),
        attempts,
        reason: [failed?.reason, ...(failed?.details ?? [])].join('; '),
      };
    } else if (report.l1Deferred !== undefined && failed === undefined) {
      state.retry = {
        at: new Date(this.now() + RETRY_FIRST_MS).toISOString(),
        attempts: 0,
        reason: `${report.l1Deferred.length} bands left by the time budget`,
      };
    } else {
      delete state.retry;
    }
    state.lastRun = {
      at,
      outcome: result,
      ...(failed !== undefined
        ? { detail: [failed.reason, ...(failed.details ?? [])].join('; ') }
        : {}),
    };
  }

  /** Opens the sources that answer; an optional one that doesn't is left out. */
  private async reachableSources(
    opened: OpenedSource[],
  ): Promise<OpenedSource[]> {
    const ready: OpenedSource[] = [];
    for (const entry of opened) {
      try {
        await entry.source.stableHeight();
        ready.push(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!entry.optional) throw new RunFailure('source', message);
        this.deps.log.warn('Optional source unavailable; running without it', {
          source: entry.source.name,
          error: message,
        });
        await entry.source.close().catch(() => undefined);
      }
    }
    return ready;
  }

  private async recordOverlays(
    ready: OpenedSource[],
    memory: RunMemory,
  ): Promise<void> {
    for (const { source } of ready) {
      // Overlays only: a peer's files are kept and aged by whoever writes them.
      if (!(source instanceof CsvOverlaySource) || source.rank !== 1) continue;
      const age = await source.ageSeconds(this.now());
      if (age === undefined) continue;
      metrics.overlayAge.set({ index: INDEX_NAME, source: source.name }, age);
      memory.overlayNewest = {
        ...memory.overlayNewest,
        [source.name]: new Date(this.now() - age * 1000).toISOString(),
      };
    }
  }

  /** Removes staging that runs killed before their cleanup left. */
  private async clearStaging(): Promise<void> {
    const { workDir } = this.deps.config;
    for (const name of await fs.readdir(workDir)) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      this.deps.log.warn('Removing staging an interrupted run left', { name });
      await fs.rm(path.join(workDir, name), { recursive: true, force: true });
    }
    // A dry run takes no lock, so one may be running beside this run: only
    // staging older than any dry run's band is a killed one's.
    const dryRuns = path.join(workDir, 'dry-run');
    for (const name of await fs.readdir(dryRuns).catch(() => [] as string[])) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const dir = path.join(dryRuns, name);
      const stat = await fs.stat(dir).catch(() => undefined);
      // The real clock: measured against file times.
      if (stat === undefined || Date.now() - stat.mtimeMs < DRY_RUN_STALE_MS) {
        continue;
      }
      this.deps.log.warn('Removing staging a killed dry run left', { name });
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Refuses a step when the scratch and publish directories are on
   * different filesystems (a band is renamed into place), or when free
   * space doesn't cover it: a fold keeps the old band through the grace
   * beside the scratch and the new band, about three times the band, and
   * nothing may come within the margin (5% of the filesystem, at least
   * 10 GiB), which other services on it need.
   */
  private async checkDisk(step: BuildStep, bands: OwnBand[]): Promise<void> {
    const { workDir, publishDir } = this.deps.config;
    await assertSameFilesystem(workDir, publishDir);
    const { free, total } = await (this.deps.diskSpace ?? statfsSpace)(workDir);
    const margin = Math.max(0.05 * total, 10 * GIB);
    const largest = bands.reduce(
      (max, band) => Math.max(max, bandBytes(band)),
      0,
    );
    const need =
      margin + 3 * (step.fold !== undefined ? bandBytes(step.fold) : largest);
    if (free < need) {
      throw new RunFailure(
        'disk',
        `${Math.round(free / GIB)} GiB free under ${workDir}, under the ${Math.round(need / GIB)} GiB building a ${step.role} band needs (with a ${Math.round(margin / GIB)} GiB margin)`,
      );
    }
  }

  /**
   * Deletes overlay files a frozen band has held for at least a fold: those
   * wholly below its top less the overlap (a delta above may still read the
   * rest). Only bands frozen before this run count, so nothing goes before a
   * subscriber has had a week with the band.
   */
  private async pruneOverlays(
    bandsBefore: OwnBand[],
    ready: OpenedSource[],
  ): Promise<void> {
    // Frozen, and published at least a fold ago.
    const frozen = bandsBefore.filter(
      (band) =>
        band.role === 'r' &&
        band.to !== null &&
        band.top - band.from + 1 >= this.deps.config.recentMaxBlocks &&
        this.now() - Date.parse(band.manifest.createdAt) >= FOLD_INTERVAL_MS,
    );
    for (const { source } of ready) {
      // Overlays only: a peer's files are kept and aged by whoever writes them.
      if (!(source instanceof CsvOverlaySource) || source.rank !== 1) continue;
      for (const band of frozen) {
        const pruned = await source.prune(
          band.from,
          band.top - OVERLAP_BLOCKS,
          Date.parse(band.manifest.createdAt),
        );
        if (pruned.length > 0) {
          this.deps.log.info('Pruned overlay files a frozen band holds', {
            source: source.name,
            band: band.id,
            files: pruned,
          });
        }
      }
    }
  }

  private recordBands(bands: OwnBand[]): void {
    for (const role of ['h', 'r', 'd'] as const) {
      const tops = bands.filter((b) => b.role === role).map((b) => b.top);
      if (tops.length > 0) {
        metrics.bandTop.set(
          { index: INDEX_NAME, kind: role },
          Math.max(...tops),
        );
      }
    }
  }

  private updateState(
    state: IndexState,
    report: RunReport,
    memory: RunMemory,
  ): void {
    const at = report.at;
    for (const step of report.steps) {
      if (
        step.result === 'published' ||
        step.result === 'unchanged' ||
        step.result === 'skipped'
      ) {
        state.lastSuccess[step.role] = at;
        metrics.lastSuccess.set(
          { index: INDEX_NAME, kind: step.role },
          Date.parse(at) / 1000,
        );
      }
      if (step.result === 'rejected') {
        state.lastRejection = {
          at,
          role: step.role,
          reasons: [step.reason, ...(step.details ?? [])].slice(0, 25),
        };
      }
    }
    if (memory.foldedAt !== undefined) {
      state.lastFoldAt = memory.foldedAt;
      delete state.foldRejectedAt;
    }
    if (memory.foldRejected === true) state.foldRejectedAt = at;
    if (memory.overlayNewest !== undefined) {
      state.overlayNewest = { ...state.overlayNewest, ...memory.overlayNewest };
    }
    for (const { role, ids } of memory.superseded) {
      const kept = state.supersededHistory?.[role] ?? [];
      state.supersededHistory = {
        ...state.supersededHistory,
        [role]: [...new Set([...kept, ...ids])].slice(-HISTORY_KEPT),
      };
    }
    for (const role of memory.chainEnded ?? []) {
      state.supersededHistory = { ...state.supersededHistory, [role]: [] };
    }
    if (report.failed?.reason === 'foreign_bands') {
      // A refusal needs an operator: show it as a rejection.
      state.lastRejection = {
        at,
        role: 'h',
        reasons: [report.failed.reason, report.failed.message],
      };
    }
    const result = runResult({ ...report, l1Steps: [] });
    if (result === 'couldnt_check') {
      const attempts = (state.retry?.attempts ?? 0) + 1;
      const delay = Math.min(
        RETRY_FIRST_MS * 2 ** (attempts - 1),
        RETRY_MAX_MS,
      );
      state.retry = {
        at: new Date(this.now() + delay).toISOString(),
        attempts,
        reason:
          report.failed?.message ??
          report.steps
            .filter((s) => s.result === 'couldnt_check')
            .map(
              (s) =>
                `${s.role}: ${[s.reason, ...(s.details ?? [])].join('; ')}`,
            )
            .join(' | '),
      };
    } else {
      delete state.retry;
    }
    state.lastRun = { at, outcome: result };
  }

  /**
   * When the next run is due: the daily time, a pending retry if sooner, or
   * soon after a day was missed or a run died part way.
   */
  async nextRunAt(): Promise<number> {
    const file = await loadState(this.stateFile);
    const states = indexNames(this.deps.config.kinds).map((index) =>
      indexState(file, index),
    );
    const now = this.now();
    const day = new Date(now);
    day.setUTCHours(0, this.deps.config.runAtMinute, 0, 0);
    let daily = day.getTime();
    if (daily <= now) daily += 24 * 3600_000;
    for (const state of states) {
      const lastRun =
        state.lastRun === undefined ? undefined : Date.parse(state.lastRun.at);
      const died =
        state.lastRun?.outcome === 'running' && this.running === undefined;
      if (lastRun === undefined || died || now - lastRun > 25 * 3600_000) {
        daily = Math.min(daily, now + 5 * 60_000);
      }
      const retry =
        state.retry === undefined ? undefined : Date.parse(state.retry.at);
      if (retry !== undefined && retry < daily) daily = Math.max(retry, now);
    }
    return daily;
  }

  /** Starts the heartbeat and the daily loop. */
  start(): void {
    this.startHeartbeat();
    void this.seedMetrics().catch((error: Error) =>
      this.deps.log.warn('Could not seed metrics from state', {
        error: error.message,
      }),
    );
    void this.schedule();
  }

  private async schedule(notBefore = 0): Promise<void> {
    if (this.stopped) return;
    const at = Math.max(await this.nextRunAt(), notBefore);
    // Stopped while that was read: set no timer.
    if (this.stopped) return;
    const wait = Math.max(0, at - this.now());
    this.deps.log.info('Next run', { at: new Date(at).toISOString() });
    // Re-checked at least hourly, so a changed state or clock is picked up.
    this.timer = setTimeout(
      () => {
        if (this.now() < at) {
          void this.schedule(notBefore);
          return;
        }
        this.running = this.runOnce().catch((error: Error) => {
          this.deps.log.error('Run threw', { error: error.message });
          return undefined as unknown as RunReport;
        });
        void this.running.then((report) => {
          this.running = undefined;
          // Locked out, or thrown: don't come straight back.
          const blocked = report === undefined || report.locked !== undefined;
          void this.schedule(blocked ? this.now() + BLOCKED_WAIT_MS : 0);
        });
      },
      Math.min(wait, 3600_000),
    );
  }

  /**
   * Stops scheduling, waits up to `graceMs` for a run in progress, then
   * releases the lock (the process is going: nothing else of it writes).
   */
  async stop(graceMs = 50_000): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.beat);
    if (this.running !== undefined) {
      await Promise.race([
        this.running,
        new Promise((resolve) => setTimeout(resolve, graceMs).unref()),
      ]);
    }
    await this.lock?.release();
  }
}

/** What a run learned that the state keeps. */
interface RunMemory {
  foldedAt?: string;
  foldRejected?: boolean;
  overlayNewest?: Record<string, string>;
  superseded: Array<{ role: BandRole; ids: string[] }>;
  /** Roles whose supersede history ends: a frozen r. */
  chainEnded?: BandRole[];
}

/** A run that couldn't start, with the reason counted in metrics. */
class RunFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
