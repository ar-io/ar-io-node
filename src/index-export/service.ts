/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The index-export service: a run builds the bands that are due (bootstrap,
 * the weekly fold, the daily delta; or, in the grid layout, freezes, rolls,
 * the tip and re-settles) and publishes them for the index-swarm sidecar;
 * the loop runs one a day at a fixed UTC time, retries a run that couldn't
 * check, and ticks a heartbeat that `/healthz` reports.
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
import {
  DEFAULT_L2_MAX_READS,
  DEFAULT_L2_RECHECK_UNREADABLE_EVERY,
  DEFAULT_RESETTLE_INTERVAL_HOURS,
  DEFAULT_RESETTLE_MAX_CHANGED,
  DEFAULT_SETTLE_BLOCKS,
  ExportConfig,
} from './config.js';
import {
  BandFingerprint,
  combineFingerprints,
  compareFingerprints,
  fingerprintBand,
  GateVerdict,
  withoutSources,
} from './kinds/root-tx/fingerprint.js';
import { frozenLookup, RootHeights } from './kinds/root-tx/grid.js';
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
import {
  classifyGridBands,
  describeGridStep,
  frozenTop,
  GridLayoutError,
  GridPlanEntry,
  planFreezes,
  planResettle,
  planRolls,
  planTip,
  tipStart,
} from './kinds/root-tx/planner-grid.js';
import {
  L1_SUB_SPAN,
  l1RangeOf,
  PARQUET_L1_TABLE_RULES,
} from '../lib/parquet-l1/layout.js';
import {
  deriveL1Bands,
  L1_INDEX,
  L1DeriveOutcome,
  L1NormalizeOutcome,
  L1Outcome,
  L1PublishedBand,
  L1Step,
  planL1,
  planL1Derive,
  planL1Normalize,
  runL1Derive,
  runL1Normalize,
  runL1Step,
} from './kinds/parquet-l1/kind.js';
import { deriveL2Bands, L2LiveBand } from './kinds/parquet-l2/bands.js';
import {
  L2Outcome,
  runL2Step,
  L2StepContext,
} from './kinds/parquet-l2/kind.js';
import {
  classifyL2Bands,
  describeL2Step,
  L2PlanEntry,
  L2Step,
  planL2Freezes,
  planL2Pin,
  planL2Resettle,
  planL2Rolls,
  planL2Tip,
} from './kinds/parquet-l2/planner.js';
import type { L2ItemSource } from './kinds/parquet-l2/source.js';
import { fingerprintL2Band } from './kinds/parquet-l2/fingerprint.js';
import { openWalletsDb } from './kinds/parquet-l2/wallets.js';
import { idHeightRange as l2IdHeightRange } from '../lib/parquet-l2/layout.js';
import { CsvOverlaySource } from './kinds/root-tx/sources/csv.js';
import type { RecordSource } from './kinds/root-tx/sources/rows.js';
import { ExportLock, LOCK_STALE_MS, LockHolder } from './lock.js';
import * as metrics from './metrics.js';
import {
  Adoption,
  BandRole,
  deriveOwnBands,
  GRID_ROLES,
  IndexState,
  indexState,
  loadState,
  LEGACY_ROLES,
  OwnBand,
  ownBandRole,
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
 * How long a run may keep starting L1 history bands, unless
 * `INDEX_EXPORT_L1_RUN_BUDGET_MINUTES` says otherwise: a whole-chain
 * bootstrap (about 5 to 7 hours) spreads over runs.
 */
export const L1_RUN_BUDGET_MS = 4 * 3600_000;
/**
 * How long a run may keep starting frozen `parquet-l2` bands, unless
 * `INDEX_EXPORT_L2_RUN_BUDGET_MINUTES` says otherwise; a bootstrap spreads
 * over runs.
 */
export const L2_RUN_BUDGET_MS = 4 * 3600_000;
/**
 * The most tip bands a run builds: those a settle lag spans, one more for a
 * freeze that failed, and the top one. More means freezes are behind.
 */
export const maxTipBands = (settleBlocks: number) =>
  Math.ceil((settleBlocks + L1_SUB_SPAN) / L1_SUB_SPAN) + 2;
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
  /**
   * Grid layout: re-settle every frozen band this run, due or not; `gate`
   * rebuilds only those whose sources changed, `full` rebuilds them all.
   */
  resettle?: 'gate' | 'full';
  /**
   * Heights an operator's run is held to (`--range`). With `resettle`:
   * re-settle only the frozen bands inside them (root-TX grid and every L2
   * index), and build nothing else (no freeze, roll, tip or L1 band).
   * Without, in a dry run: build only this band (on the grid) of each L2
   * index, and nothing of the other indexes.
   */
  range?: [number, number];
}

/** One `parquet-l2` index's part of a run. */
export interface L2IndexReport {
  index: string;
  /** The source's stable top, capped by `--to` and this publisher's L1 bands. */
  stableTop?: number;
  /** The steps planned, in order, built or not. */
  plan: L2PlanEntry[];
  steps: L2Outcome[];
  /** Frozen bands left for the next run by the time budget. */
  deferred?: Array<[number, number]>;
  /** Set when the index's part couldn't start (the source, the disk, its bands). */
  failed?: { reason: string; message: string };
  /** The index's live band ids after the run. */
  liveIds?: string[];
  /** What bands built from the source this run settled against, by id (for the state). */
  fingerprints?: Record<string, BandFingerprint>;
  /** Gated re-settles passed by bands with unreadable reads, by id (for the state). */
  rechecks?: Record<string, number>;
}

export interface RunReport {
  at: string;
  dryRun: boolean;
  /** Set when another run holds the lock. */
  locked?: { holder?: LockHolder; ageSeconds: number };
  stableTop?: number;
  /** Set when the run couldn't start (a source, the disk, foreign bands). */
  failed?: { reason: string; message: string };
  /** Grid layout: the root-TX steps planned, in order, built or not. */
  plan?: GridPlanEntry[];
  steps: StepOutcome[];
  /** The `parquet-l1` bands built, in order. */
  l1Steps: L1Outcome[];
  /** `parquet-l1` bands planned but left for the next run (the time budget). */
  l1Deferred?: Array<[number, number]>;
  /** Published `parquet-l1` bands whose lookups were derived and added in place. */
  l1Derived?: L1DeriveOutcome[];
  /**
   * Published `parquet-l1` bands whose `band.json` was settled in place, as
   * every publisher of their rows writes it.
   */
  l1Normalized?: L1NormalizeOutcome[];
  gateUrl: string;
  /** Disk the run's builds needed together (each step's scratch and band). */
  peakBytes: number;
  /** Where a dry run with `keepDir` left its bands. */
  keptIn?: string;
  /** The `parquet-l2` indexes built, each with its steps. */
  l2?: L2IndexReport[];
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
  /** Opens the `parquet-l2` item source, fresh for each index's run. */
  openL2Source?: () => Promise<L2ItemSource>;
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
      const { sampled, ...rest } = step;
      // The entries the header check read, and the candidates it drew on.
      return {
        ...rest,
        band: {
          ...band,
          sampled: sampled ?? sample.length,
          poolSize: sample.length,
        },
      };
    }),
    // Fingerprints and recheck counts are the state's, not the report's.
    ...(report.l2 !== undefined
      ? {
          l2: report.l2.map(
            ({ fingerprints: _f, rechecks: _r, ...index }) => index,
          ),
        }
      : {}),
  };
}

/** The overall result of a run: the worst of its steps. */
export function runResult(report: RunReport): string {
  if (report.locked !== undefined) return 'locked';
  if (report.failed !== undefined) {
    return report.failed.reason === 'foreign_bands' ||
      report.failed.reason === 'grid_layout'
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
  const all = [
    ...report.steps,
    ...(report.l1Steps ?? []),
    ...(report.l1Derived ?? []),
    ...(report.l1Normalized ?? []),
    ...(report.l2 ?? []).flatMap((index) => [
      ...index.steps,
      ...(index.failed !== undefined
        ? [
            {
              result:
                index.failed.reason === 'grid_layout'
                  ? 'rejected'
                  : 'couldnt_check',
            },
          ]
        : []),
    ]),
  ];
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
function indexNames(config: ExportConfig): string[] {
  const { kinds } = config;
  return [
    ...(kinds.includes('root-tx-index') ? [INDEX_NAME] : []),
    ...(kinds.includes('parquet-l1') ? [L1_INDEX] : []),
    ...(kinds.includes('parquet-l2')
      ? (config.l2Indexes ?? []).map((index) => index.name)
      : []),
  ];
}

/** The L1 part's outcome alone. */
export function l1Result(report: RunReport): string {
  return report.l1Steps.length === 0
    ? 'nothing_due'
    : runResult({
        ...report,
        steps: [],
        l2: [],
        failed: undefined,
        locked: undefined,
      });
}

/** One L2 index's outcome alone. */
export function l2Result(index: L2IndexReport): string {
  return runResult({
    at: '',
    dryRun: false,
    steps: [],
    l1Steps: [],
    gateUrl: '',
    peakBytes: 0,
    l2: [index],
  });
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

  private get grid(): boolean {
    return this.deps.config.rootTxLayout === 'grid';
  }

  /** The roles this publisher's own bands can have in its layout. */
  private get roles() {
    return this.grid ? GRID_ROLES : LEGACY_ROLES;
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
        this.roles,
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
    if (this.deps.config.kinds.includes('parquet-l2')) {
      for (const index of this.deps.config.l2Indexes ?? []) {
        const l2 = indexState(await loadState(this.stateFile), index.name);
        for (const [role, at] of Object.entries(l2.lastSuccess)) {
          metrics.lastSuccess.set(
            { index: index.name, kind: role },
            Date.parse(at) / 1000,
          );
        }
        // Bands the grid refuses are the run's to report.
        const bands = await deriveL2Bands(
          index.publishDir,
          this.deps.config.publisher,
          index.selection,
        ).catch(() => []);
        this.recordL2Bands(index.name, bands);
      }
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
    // `--range` alone pins one L2 band; with `--resettle`, it holds every
    // index to re-settling the frozen bands inside it.
    const pinned =
      options.range !== undefined && options.resettle === undefined;
    const resettleOnly =
      options.range !== undefined && options.resettle !== undefined;
    if (config.kinds.includes('root-tx-index') && !pinned) {
      await fs.mkdir(config.publishDir, { recursive: true });
    }

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
      // A pinned L2 range is an operator's look at one band: nothing else.
      // A re-settle held to a range builds no L1 band either, and the
      // legacy root-TX layout, which has no frozen bands to pick, nothing.
      const rootTx =
        kinds.includes('root-tx-index') &&
        !pinned &&
        (options.range === undefined || this.grid);
      const l1 = kinds.includes('parquet-l1') && !pinned && !resettleOnly;
      if (!dryRun) {
        // Only the indexes this run builds: the others keep their last run.
        for (const index of indexNames(this.deps.config).filter(
          (name) =>
            (name !== INDEX_NAME || rootTx) && (name !== L1_INDEX || l1),
        )) {
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
      const result: RunMemory = rootTx
        ? await this.run(report, options, dryRun)
        : { superseded: [] };
      if (l1) {
        await this.runL1(report, options, dryRun);
      }
      if (kinds.includes('parquet-l2')) {
        await this.runL2(report, options, dryRun);
      }
      if (!dryRun) {
        // Each index keeps its own outcome and retry.
        if (rootTx) {
          await updateIndexState(this.stateFile, INDEX_NAME, (state) =>
            this.updateState(state, report, result),
          );
        }
        if (l1) {
          await updateIndexState(this.stateFile, L1_INDEX, (state) =>
            this.updateL1State(state, report),
          );
        }
        for (const index of report.l2 ?? []) {
          await updateIndexState(this.stateFile, index.index, (state) =>
            this.updateL2State(state, index, report.at),
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
        // The same clock the fold decision reads, so a band's createdAt and
        // `foldDue` can never drift apart.
        now: () => this.now(),
      };
      if (this.grid) {
        const readyNames = new Set(ready.map(({ source }) => source.name));
        await this.runGrid(
          report,
          options,
          dryRun,
          memory,
          state,
          {
            ...context,
            resettleMaxChanged:
              config.resettleMaxChanged ?? DEFAULT_RESETTLE_MAX_CHANGED,
          },
          // Configured, but down this run.
          opened
            .map(({ source }) => source.name)
            .filter((name) => !readyNames.has(name)),
        );
        if (options.keepDir !== undefined) report.keptIn = options.keepDir;
        return memory;
      }
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
      const from = bootstrapFrom(before);
      let deltaInput = before;
      if (from !== undefined) {
        // Only a bootstrap cuts bands that could overlap a stranger's. A
        // steady-state run must not scan: a band superseded moments ago is
        // still on disk until the sidecar sweeps it, and is not its own.
        await this.refuseForeignBands(state.adoptions);
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
   * The root-TX part of a run in the grid layout, in order: freeze the
   * ranges that have settled (stopping at the first that fails, since the
   * frozen top only moves up), roll each complete 100,000-height range of
   * `d` bands into its `h`, rebuild the tip, then re-settle the frozen
   * bands that are due, one at a time. Own bands that are off the grid or
   * overlap stop the run before anything is built (`grid_layout`).
   *
   * A dry run plans and builds every step it can and publishes nothing: a
   * roll waiting on `d` bands the dry run built is reported, not built; its
   * staging goes, and with it the dry-run directory once empty.
   */
  private async runGrid(
    ...args: Parameters<ExportService['runGridSteps']>
  ): Promise<void> {
    try {
      await this.runGridSteps(...args);
    } catch (error) {
      if (error instanceof GridLayoutError) {
        throw new RunFailure('grid_layout', error.message);
      }
      throw error;
    }
  }

  private async runGridSteps(
    report: RunReport,
    options: RunOptions,
    dryRun: boolean,
    memory: RunMemory,
    state: IndexState,
    context: StepContext,
    down: string[],
  ): Promise<void> {
    const { config, log } = this.deps;
    const stableTop = report.stableTop as number;
    const plan: GridPlanEntry[] = [];
    report.plan = plan;
    const live = async () =>
      deriveOwnBands(
        config.publishDir,
        config.publisher,
        state.adoptions,
        GRID_ROLES,
      );
    const run = async (
      step: BuildStep,
      bands: OwnBand[],
    ): Promise<StepOutcome> => {
      // Only a tip names the bands its predecessors replaced, since every
      // tip covers the top: a subscriber that missed one still keeps the
      // one before. A frozen band replaces the bands of its own range or
      // none, so another range's history must never ride along.
      const named: BuildStep =
        step.grid === 'tip'
          ? {
              ...step,
              supersedes: [
                ...new Set([
                  ...(state.supersededHistory?.tip ?? []),
                  ...step.supersedes,
                ]),
              ].slice(-HISTORY_KEPT * 2),
            }
          : step;
      plan.push(describeGridStep(named));
      await this.checkDisk(step, bands);
      const outcome = await buildStepBand(named, context);
      report.steps.push(outcome);
      report.peakBytes += outcome.peakBytes ?? 0;
      if (outcome.result === 'published' && step.grid === 'tip') {
        memory.superseded.push({ role: 'tip', ids: step.supersedes });
      }
      // A band left in place waits an interval before the next try; one
      // that couldn't check is tried again with the next run.
      if (
        step.grid === 'resettle' &&
        step.fold !== undefined &&
        (outcome.result === 'unchanged' || outcome.result === 'rejected')
      ) {
        memory.resettled = { ...memory.resettled, [step.fold.id]: report.at };
      }
      log.info('Band step finished', {
        grid: step.grid,
        kind: outcome.role,
        heightRange: outcome.heightRange,
        result: outcome.result,
        reason: outcome.reason,
        id: outcome.band?.id,
        records: outcome.band?.records,
        inputs: outcome.inputs,
        seeds: outcome.seeds,
        resettle: outcome.resettle,
        seconds: outcome.seconds,
        peakBytes: outcome.peakBytes,
        details: outcome.details,
      });
      return outcome;
    };

    // What each band settled against: recorded when it is built from the
    // sources (fingerprinted first, so a row that lands meanwhile is a
    // change next time, never one missed), rolled, or re-settled.
    const recorded = (id: string): BandFingerprint | undefined =>
      memory.fingerprints?.[id] ?? state.fingerprints?.[id];
    const record = (id: string, fingerprint: BandFingerprint) => {
      memory.fingerprints = { ...memory.fingerprints, [id]: fingerprint };
    };
    const splits = () =>
      new Map(context.sources.map((source) => [source, source.stats.splits]));
    /**
     * Builds a band from the sources, fingerprinting them first; records
     * the fingerprint under the band it leaves live, less the sources it
     * read otherwise (one that failed part way, or split a read).
     */
    const fingerprinted = async (
      step: BuildStep,
      bands: OwnBand[],
      gate?: (fingerprint: {
        fingerprint: BandFingerprint;
        failed: Record<string, string>;
      }) => Promise<{ outcome?: StepOutcome; gate: StepOutcome['gate'] }>,
    ): Promise<StepOutcome> => {
      const [from, to] = step.heightRange as [number, number];
      const taken = await fingerprintBand(context.sources, from, to);
      const decided = await gate?.(taken);
      if (decided?.outcome !== undefined) return decided.outcome;
      const before = splits();
      const outcome = await run(step, bands);
      if (decided?.gate !== undefined) outcome.gate = decided.gate;
      const kept =
        outcome.result === 'published'
          ? outcome.band?.id
          : outcome.result === 'unchanged'
            ? step.fold?.id
            : undefined;
      if (kept !== undefined) {
        record(
          kept,
          withoutSources(taken.fingerprint, [
            ...Object.keys(taken.failed),
            ...(outcome.failedSources ?? []),
            ...context.sources
              .filter((source) => source.stats.splits !== before.get(source))
              .map((source) => source.name),
          ]),
        );
      }
      return outcome;
    };

    const atStart = await live();
    const start = classifyGridBands(atStart);
    // Only a bootstrap cuts bands that could overlap a stranger's.
    if (start.frozen.length === 0)
      await this.refuseForeignBands(state.adoptions);
    const range = options.resettle !== undefined ? options.range : undefined;
    if (start.seeds.length > 0 && range === undefined) {
      context.rootHeights = await RootHeights.of(start.seeds);
    }

    // 1. Freeze, in height order. A dry run publishes nothing, so what it
    // built counts as frozen for the steps that follow.
    // With a range, only its re-settles.
    const built: Array<[number, number]> = [];
    const freezes =
      range !== undefined
        ? []
        : planFreezes({
            bands: atStart,
            stableTop,
            settleBlocks: config.settleBlocks ?? DEFAULT_SETTLE_BLOCKS,
            ...(config.startHeight !== undefined
              ? { startHeight: config.startHeight }
              : {}),
          });
    for (const step of freezes) {
      const outcome = await fingerprinted(step, atStart);
      if (
        dryRun &&
        (outcome.result === 'dry_run' || outcome.result === 'published')
      ) {
        built.push(step.heightRange as [number, number]);
      }
      // An empty range is skipped; anything else that failed stops the
      // freezes, since the frozen top only moves up.
      if (!ok(outcome)) break;
    }

    // 2. Roll complete 100,000-height ranges.
    let bands = await live();
    for (const { step, awaits } of range !== undefined
      ? []
      : planRolls(bands, built)) {
      if (awaits.length > 0) {
        plan.push(describeGridStep(step, { awaits }));
        report.steps.push({
          role: step.role,
          heightRange: step.heightRange,
          grid: 'roll',
          result: 'dry_run',
          reason: 'after_planned',
          details: [
            `waits for ${awaits.length} d bands this dry run built but did not publish`,
          ],
          inputs: {},
          seconds: 0,
        });
        continue;
      }
      const outcome = await run(step, bands);
      const combined = combineFingerprints(
        (step.folds ?? []).map((band) => recorded(band.id)),
      );
      if (
        outcome.result === 'published' &&
        outcome.band !== undefined &&
        combined !== undefined
      ) {
        record(outcome.band.id, combined);
      }
    }

    // 3. The tip.
    bands = await live();
    const now = classifyGridBands(bands);
    const frozenNow = [
      frozenTop(now.frozen),
      ...built.map(([, to]) => to),
    ].filter((top): top is number => top !== undefined);
    const tip =
      range !== undefined
        ? undefined
        : planTip({
            bands,
            stableTop,
            from: tipStart(
              frozenTop(start.frozen),
              frozenNow.length > 0 ? Math.max(...frozenNow) : undefined,
              config.startHeight,
            ),
          });
    if (tip !== undefined) {
      const lookup = frozenLookup(now.frozen, log);
      context.frozenHolds = lookup.holds;
      try {
        await run(tip, bands);
      } finally {
        delete context.frozenHolds;
        await lookup.close();
      }
    }

    // 4. Re-settle, when due or forced.
    const intervalMs =
      config.resettleIntervalMs ?? DEFAULT_RESETTLE_INTERVAL_HOURS * 3600_000;
    if (options.resettle !== undefined || intervalMs > 0) {
      bands = await live();
      const steps = planResettle(bands, {
        now: this.now(),
        intervalMs,
        force: options.resettle !== undefined,
        settledAt: state.resettledAt ?? {},
      }).filter(
        (step) =>
          range === undefined ||
          (step.heightRange[0] >= range[0] &&
            (step.heightRange[1] as number) <= range[1]),
      );
      if (range !== undefined && steps.length === 0) {
        log.warn('No frozen band lies inside --range', { range });
      }
      // A gateway or source that failed a build this run would fail each
      // re-settle too, after rebuilding it: wait for the retry.
      const blocked = report.steps.some((s) => s.result === 'couldnt_check');
      for (const step of steps) {
        if (blocked) {
          plan.push(
            describeGridStep(step, {
              deferred: 'a build this run could not check',
            }),
          );
          continue;
        }
        await fingerprinted(step, bands, async ({ fingerprint, failed }) =>
          this.gateResettle(step, report, plan, memory, {
            ...compareFingerprints(
              recorded(step.fold?.id as string),
              fingerprint,
              { failed, down },
            ),
            full: options.resettle === 'full',
          }),
        );
      }
    }

    bands = await live();
    memory.liveIds = bands.map((band) => band.id);
    this.recordBands(bands);
    if (dryRun && options.keepDir === undefined) {
      // Only when empty: a dry run beside this one may be staging there.
      await fs
        .rmdir(path.join(config.workDir, 'dry-run'))
        .catch(() => undefined);
    }
  }

  /**
   * The fingerprint gate's decision on a due band: an outcome when it is
   * not rebuilt (its sources unchanged, or only ones down this run
   * differ), or none, to rebuild it. `full` rebuilds whatever the
   * fingerprints say.
   */
  private async gateResettle(
    step: BuildStep,
    report: RunReport,
    plan: GridPlanEntry[],
    memory: RunMemory,
    {
      verdict,
      detail,
      full,
    }: { verdict: GateVerdict; detail?: string; full: boolean },
  ): Promise<{ outcome?: StepOutcome; gate: StepOutcome['gate'] }> {
    const band = step.fold as OwnBand;
    metrics.resettleGate.inc({ index: INDEX_NAME, kind: step.role, verdict });
    const gate = {
      verdict,
      ...(detail !== undefined || full
        ? {
            detail: [detail, full ? 'rebuilt anyway: --resettle=full' : '']
              .filter((part) => part !== undefined && part !== '')
              .join('; '),
          }
        : {}),
    };
    if (full || (verdict !== 'same_sources' && verdict !== 'source_down')) {
      this.deps.log.info('Re-settling a band', { band: band.id, ...gate });
      return { gate };
    }
    plan.push(describeGridStep(step));
    const outcome: StepOutcome = {
      role: step.role,
      heightRange: step.heightRange,
      grid: 'resettle',
      result: verdict === 'same_sources' ? 'unchanged' : 'skipped',
      reason: verdict,
      ...(gate.detail !== undefined ? { details: [gate.detail] } : {}),
      inputs: {},
      gate,
      seconds: 0,
    };
    report.steps.push(outcome);
    metrics.runs.inc({
      index: INDEX_NAME,
      kind: step.role,
      result: outcome.result,
      reason: outcome.reason,
    });
    if (verdict === 'same_sources') {
      metrics.resettles.inc({
        index: INDEX_NAME,
        kind: step.role,
        result: 'unchanged',
      });
      memory.resettled = { ...memory.resettled, [band.id]: report.at };
    }
    this.deps.log.info('Re-settle not needed', {
      band: band.id,
      verdict,
      detail,
    });
    return { outcome, gate };
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
   *
   * Called only when a bootstrap is planned, including one resumed over the
   * history it already published. Ownership is read from the band's own id
   * (its publisher tag and role) or its adoption, not from the live set: a
   * band of this publisher's that another supersedes is still its own, and
   * sits on disk until the sidecar sweeps it.
   */
  private async refuseForeignBands(
    adoptions: Record<string, Adoption>,
  ): Promise<void> {
    const { publishDir, publisher } = this.deps.config;
    const names = await fs.readdir(publishDir).catch(() => [] as string[]);
    const foreign: string[] = [];
    for (const name of names) {
      if (
        name.startsWith('.') ||
        ownBandRole(name, publisher, adoptions, this.roles) !== undefined
      ) {
        continue;
      }
      const manifest = path.join(publishDir, name, 'manifest.json');
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
        `${publishDir} holds bands this service didn't build (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}); adopt them first (--adopt <id> --as ${this.roles.join('|')}), or move them away, rather than bootstrap over them`,
      );
    }
  }

  /**
   * The `parquet-l1` part of a run: lookups for the bands that only lack
   * them, then every whole height range up to the stable top that isn't
   * published, in order, then the tip band, then lookups again for any band
   * this run confirmed. A history band isn't started once the run's budget
   * ({@link L1_RUN_BUDGET_MS} by default) has passed, so a
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
      // First, since they take seconds to minutes and read no core.db: a
      // band waiting only for its description or its lookups shouldn't
      // wait hours for builds.
      await this.normalizeL1Files(report, workDir, dryRun);
      await this.deriveL1Lookups(report, workDir, dryRun);
      // The budget is the builds': it starts after the derive.
      const started = this.now();
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
      const confirmed = new Set(
        Object.entries(state.layoutConfirmed ?? {})
          .filter(([, rules]) => rules === PARQUET_L1_TABLE_RULES)
          .map(([id]) => id),
      );
      const steps = planL1(
        bands,
        top,
        state.supersededHistory?.d ?? [],
        confirmed,
      );
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
        if (
          step.role === 'h' &&
          this.now() - started >= (config.l1RunBudgetMs ?? L1_RUN_BUDGET_MS)
        ) {
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
          ...(this.lock !== undefined
            ? { stillHeld: async () => this.lock?.held() ?? false }
            : {}),
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
    await this.deriveL1Lookups(report, workDir, dryRun);
  }

  /**
   * Settles the `band.json` of every published band written before band
   * files were made the same for every publisher: canonical, dated by its
   * top block, and with what is this publisher's own (the bands it replaces,
   * when it was built) moved beside it. In place, under the band's id, its
   * rows untouched, so subscribers fetch only the new `band.json` and
   * publishers of the same rows then share one torrent.
   */
  private async normalizeL1Files(
    report: RunReport,
    workDir: string,
    dryRun: boolean,
  ): Promise<void> {
    const { config, log } = this.deps;
    try {
      const bands = await deriveL1Bands(config.l1PublishDir, config.publisher);
      const due = await planL1Normalize(bands);
      if (due.length === 0) return;
      report.l1Normalized ??= [];
      for (const band of due) {
        report.l1Normalized.push(
          await runL1Normalize(band, {
            workDir,
            dryRun,
            log,
            ...(this.lock !== undefined
              ? { stillHeld: async () => this.lock?.held() ?? false }
              : {}),
          }),
        );
      }
      recordL1Bands(await deriveL1Bands(config.l1PublishDir, config.publisher));
    } catch (error) {
      log.error('L1 band files not settled', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Adds lookups to every published band whose tables are current but whose
   * lookups are not: derived from the band's own tables, in seconds, with no
   * read of `core.db`, so it runs whatever happened to the builds and outside
   * their time budget. Called before the builds and again after them, for
   * bands this run confirmed identical, which count as current; outcomes
   * accumulate in the report.
   */
  private async deriveL1Lookups(
    report: RunReport,
    workDir: string,
    dryRun: boolean,
  ): Promise<void> {
    const { config, log } = this.deps;
    try {
      const state = indexState(await loadState(this.stateFile), L1_INDEX);
      const confirmed = new Set([
        ...Object.entries(state.layoutConfirmed ?? {})
          .filter(([, rules]) => rules === PARQUET_L1_TABLE_RULES)
          .map(([id]) => id),
        ...report.l1Steps
          .filter((s) => s.result === 'unchanged' && s.reason === 'same_id')
          .flatMap((s) => (s.id !== undefined ? [s.id] : [])),
      ]);
      const bands = await deriveL1Bands(config.l1PublishDir, config.publisher);
      // Each band once a run: the call after the builds skips what the one
      // before them handled, whatever its result, so a dry run (which
      // changes nothing) or a failure isn't tried twice.
      const handled = new Set((report.l1Derived ?? []).map((d) => d.id));
      const due = planL1Derive(bands, confirmed).filter(
        (b) => !handled.has(b.id),
      );
      if (due.length === 0) return;
      await assertSameFilesystem(workDir, config.l1PublishDir);
      report.l1Derived ??= [];
      for (const band of due) {
        report.l1Derived.push(
          await runL1Derive(band, {
            workDir,
            dryRun,
            log,
            ...(this.lock !== undefined
              ? { stillHeld: async () => this.lock?.held() ?? false }
              : {}),
          }),
        );
      }
      recordL1Bands(await deriveL1Bands(config.l1PublishDir, config.publisher));
    } catch (error) {
      log.error('L1 lookups not derived', {
        error: error instanceof Error ? error.message : String(error),
      });
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
      // Rebuilt under this layout and identical: the band on disk is current.
      if (
        step.result === 'unchanged' &&
        step.reason === 'same_id' &&
        step.id !== undefined
      ) {
        state.layoutConfirmed = {
          ...state.layoutConfirmed,
          [step.id]: PARQUET_L1_TABLE_RULES,
        };
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

  /**
   * The `parquet-l2` part of a run, index by index, in order: freeze the
   * sub-ranges (or whole ranges) that have settled, stopping at the first
   * that fails, since the frozen top only moves up; roll each range of
   * twenty frozen `d` bands into its `h`; rebuild the tip, a band per
   * sub-range above the frozen ones; then re-settle the frozen bands that
   * are due. Freezes and re-settles stop starting once the run's time budget
   * has passed, and the tip waits while freezes are behind, since it would
   * span every height they left. With `range` alone, a dry run builds that one
   * band of each index and nothing else.
   */
  private async runL2(
    report: RunReport,
    options: RunOptions,
    dryRun: boolean,
  ): Promise<void> {
    const { config, log } = this.deps;
    report.l2 = [];
    const workDir = dryRun
      ? path.join(config.workDir, 'dry-run')
      : config.workDir;
    const settleBlocks =
      config.l2SettleBlocks ?? config.settleBlocks ?? DEFAULT_SETTLE_BLOCKS;
    for (const index of config.l2Indexes ?? []) {
      const entry: L2IndexReport = { index: index.name, plan: [], steps: [] };
      report.l2.push(entry);
      let source: L2ItemSource | undefined;
      let roots: { openRoot: RootSourceFactory; close: () => void } | undefined;
      let closeWallets: (() => void) | undefined;
      try {
        await fs.mkdir(workDir, { recursive: true });
        if (this.deps.openL2Source === undefined) {
          throw new RunFailure('source', 'no parquet-l2 source is configured');
        }
        source = await this.deps.openL2Source();
        let top: number;
        try {
          top = await source.stableHeight();
        } catch (error) {
          throw new RunFailure(
            'source',
            error instanceof Error ? error.message : String(error),
          );
        }
        const l1Bands = await deriveL1Bands(
          config.l1PublishDir,
          config.publisher,
        );
        // With L1 bands, no higher than they reach: every band's roots are
        // then placed by them, rather than the tip's by ClickHouse's rows.
        const stableTop = Math.min(
          top,
          options.toHeight ?? Number.MAX_SAFE_INTEGER,
          ...(l1Bands.length > 0
            ? [Math.max(...l1Bands.map((b) => b.to))]
            : []),
        );
        entry.stableTop = stableTop;
        const state = indexState(await loadState(this.stateFile), index.name);
        const history = state.supersededHistory?.tip ?? [];
        const live = () =>
          deriveL2Bands(index.publishDir, config.publisher, index.selection);
        roots = this.deps.openRoots();
        const keepDir = options.keepDir;
        const context: L2StepContext = {
          index,
          publisher: config.publisher,
          ...(keepDir !== undefined ? { keepDir } : {}),
          workDir,
          source,
          l1Bands,
          ...(config.l2WalletsDb !== undefined
            ? { walletsDbPath: config.l2WalletsDb }
            : {}),
          openRoot: roots.openRoot,
          maxReads: config.l2MaxReads ?? DEFAULT_L2_MAX_READS,
          resettleMaxChanged:
            config.resettleMaxChanged ?? DEFAULT_RESETTLE_MAX_CHANGED,
          dryRun,
          log,
          ...(this.lock !== undefined
            ? { stillHeld: async () => this.lock?.held() ?? false }
            : {}),
          ...(this.deps.headerCheck !== undefined
            ? { headerCheck: this.deps.headerCheck }
            : {}),
          now: () => this.now(),
          ...(config.l2Duck !== undefined ? { limits: config.l2Duck } : {}),
        };
        // The re-settle gate: what each band settled against.
        const walletsDb = openWalletsDb(config.l2WalletsDb);
        closeWallets = () => walletsDb?.close();
        const recheckEvery =
          config.l2RecheckUnreadableEvery ??
          DEFAULT_L2_RECHECK_UNREADABLE_EVERY;
        const recorded = (id: string) =>
          entry.fingerprints?.[id] ?? state.fingerprints?.[id];
        const fingerprintOf = async (step: L2Step) =>
          fingerprintL2Band({
            source: source as L2ItemSource,
            selection: index.selection,
            from: step.heightRange[0],
            to: step.heightRange[1],
            l1Bands,
            ...(config.l2WalletsDb !== undefined
              ? { walletsDbPath: config.l2WalletsDb }
              : {}),
            ...(walletsDb !== undefined ? { walletsDb } : {}),
          });
        const run = async (step: L2Step, bands: L2LiveBand[]) => {
          entry.plan.push(describeL2Step(step));
          await this.checkL2Disk(
            dryRun
              ? keepDir !== undefined
                ? path.join(keepDir, index.name)
                : undefined
              : index.publishDir,
            bands,
          );
          // Ids this index superseded before, within the step's heights: a
          // subscriber that missed a band still retires the one before.
          const named = history.filter((id) => {
            const range = l2IdHeightRange(id);
            return (
              range !== undefined &&
              range[0] >= step.heightRange[0] &&
              range[1] <= step.heightRange[1] &&
              !step.replaces.some((band) => band.id === id)
            );
          });
          const outcome = await runL2Step(step, {
            ...context,
            history: named,
          });
          entry.steps.push(outcome);
          report.peakBytes += outcome.bandBytes ?? 0;
          return outcome;
        };
        /**
         * Builds a band from the source, fingerprinting its heights first
         * (so a row that lands meanwhile is a change next time, never one
         * missed), and records the fingerprint under the band it leaves
         * live. A re-settle is gated on it: not rebuilt when the source is
         * as it was, unless forced (`--resettle=full`), or unless the band
         * was built with reads the gateway answered 404 and this is the
         * N-th re-settle since its last rebuild.
         */
        const fingerprinted = async (
          step: L2Step,
          bands: L2LiveBand[],
        ): Promise<L2Outcome> => {
          const taken = await fingerprintOf(step);
          let gate: L2Outcome['gate'] | undefined;
          if (step.step === 'resettle') {
            const band = step.replaces[0];
            const compared = compareFingerprints(
              recorded(band.id),
              taken.fingerprint,
              { failed: taken.failed },
            );
            let verdict: string = compared.verdict;
            let rebuild =
              options.resettle === 'full' ||
              (compared.verdict !== 'same_sources' &&
                compared.verdict !== 'source_down');
            const unreadable = Object.values(
              band.facts.unreadable ?? {},
            ).reduce((sum, n) => sum + n, 0);
            if (!rebuild && unreadable > 0) {
              const passes =
                (entry.rechecks?.[band.id] ??
                  state.unreadableRechecks?.[band.id] ??
                  0) + 1;
              if (passes >= recheckEvery) {
                rebuild = true;
                verdict = 'recheck_unreadable';
              } else {
                entry.rechecks = { ...entry.rechecks, [band.id]: passes };
              }
            }
            metrics.resettleGate.inc({
              index: index.name,
              kind: step.role,
              verdict,
            });
            gate = {
              verdict,
              ...(compared.detail !== undefined || options.resettle === 'full'
                ? {
                    detail: [
                      compared.detail,
                      options.resettle === 'full'
                        ? 'rebuilt anyway: --resettle=full'
                        : undefined,
                      verdict === 'recheck_unreadable'
                        ? `${unreadable} reads were 404 when built: rebuilt every ${recheckEvery} re-settles`
                        : undefined,
                    ]
                      .filter((part) => part !== undefined)
                      .join('; '),
                  }
                : {}),
            };
            if (!rebuild) {
              entry.plan.push(describeL2Step(step));
              const skipped: L2Outcome = {
                index: index.name,
                step: step.step,
                role: step.role,
                heightRange: step.heightRange,
                replaces: [band.id],
                result: 'unchanged',
                reason: verdict,
                gate,
                seconds: 0,
              };
              entry.steps.push(skipped);
              metrics.runs.inc({
                index: index.name,
                kind: step.role,
                result: skipped.result,
                reason: skipped.reason,
              });
              return skipped;
            }
          }
          const outcome = await run(step, bands);
          if (gate !== undefined) outcome.gate = gate;
          const kept =
            outcome.result === 'published' || outcome.result === 'unchanged'
              ? outcome.id
              : undefined;
          if (kept !== undefined && Object.keys(taken.failed).length === 0) {
            entry.fingerprints = {
              ...entry.fingerprints,
              [kept]: taken.fingerprint,
            };
            // Rebuilt: its 404s, if any, are counted afresh.
            entry.rechecks = { ...entry.rechecks, [kept]: 0 };
          }
          return outcome;
        };

        const range =
          options.resettle !== undefined ? options.range : undefined;
        if (options.range !== undefined && options.resettle === undefined) {
          const bands = await live();
          await run(
            planL2Pin({
              bands,
              range: options.range,
              stableTop,
              settleBlocks,
            }),
            bands,
          );
          continue;
        }

        const started = this.now();
        const overBudget = () =>
          this.now() - started >= (config.l2RunBudgetMs ?? L2_RUN_BUDGET_MS);
        const startHeight = config.startHeight;

        // 1. Freeze, in height order. A dry run publishes nothing, so what
        // it built counts as frozen for the tip.
        let bands = await live();
        // With a range, only its re-settles.
        const freezes =
          range !== undefined
            ? []
            : planL2Freezes({
                bands,
                stableTop,
                settleBlocks,
                ...(startHeight !== undefined ? { startHeight } : {}),
              });
        let builtTop: number | undefined;
        for (const [i, step] of freezes.entries()) {
          if (i > 0 && overBudget()) {
            entry.deferred = freezes.slice(i).map((s) => s.heightRange);
            for (const left of freezes.slice(i)) {
              entry.plan.push(describeL2Step(left, "the run's time budget"));
            }
            break;
          }
          const outcome = await fingerprinted(step, bands);
          if (
            outcome.result !== 'published' &&
            outcome.result !== 'unchanged' &&
            outcome.result !== 'dry_run'
          ) {
            break;
          }
          builtTop = step.heightRange[1];
        }

        // 2. Roll every range of twenty frozen d bands into its h.
        bands = await live();
        for (const step of range !== undefined ? [] : planL2Rolls(bands)) {
          await fingerprinted(step, bands);
        }

        // 3. The tip, unless freezes are behind (the time budget, or a
        // bootstrap that failed): it would span every height they left.
        bands = await live();
        const tips =
          range !== undefined
            ? []
            : planL2Tip({
                bands,
                stableTop,
                ...(startHeight !== undefined ? { startHeight } : {}),
                ...(dryRun && builtTop !== undefined
                  ? { above: builtTop }
                  : {}),
              });
        const behind = tips.length > maxTipBands(settleBlocks);
        for (const step of tips) {
          if (behind) {
            entry.plan.push(
              describeL2Step(step, 'freezes are behind; the tip waits'),
            );
            continue;
          }
          await run(step, bands);
        }

        // 4. Re-settle, when due or forced.
        const intervalMs =
          config.resettleIntervalMs ??
          DEFAULT_RESETTLE_INTERVAL_HOURS * 3600_000;
        if (options.resettle !== undefined || intervalMs > 0) {
          bands = await live();
          const steps = planL2Resettle(bands, {
            now: this.now(),
            intervalMs,
            force: options.resettle !== undefined,
            resettledAt: state.resettledAt ?? {},
          }).filter(
            (step) =>
              range === undefined ||
              (step.heightRange[0] >= range[0] &&
                step.heightRange[1] <= range[1]),
          );
          if (range !== undefined && steps.length === 0) {
            log.warn('No frozen L2 band lies inside --range', {
              index: index.name,
              range,
            });
          }
          for (const step of steps) {
            const blocked = entry.steps.some(
              (s) => s.result === 'couldnt_check',
            );
            if (blocked || overBudget()) {
              entry.plan.push(
                describeL2Step(
                  step,
                  blocked
                    ? 'a build this run could not check'
                    : "the run's time budget",
                ),
              );
              continue;
            }
            await fingerprinted(step, bands);
          }
        }
        bands = await live();
        entry.liveIds = bands.map((band) => band.id);
        this.recordL2Bands(index.name, bands);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.failed = {
          reason:
            error instanceof GridLayoutError
              ? 'grid_layout'
              : error instanceof RunFailure
                ? error.reason
                : 'source',
          message,
        };
        metrics.runs.inc({
          index: index.name,
          kind: 'run',
          result:
            entry.failed.reason === 'grid_layout'
              ? 'rejected'
              : 'couldnt_check',
          reason: entry.failed.reason,
        });
        log.error('L2 export stopped', { index: index.name, ...entry.failed });
      } finally {
        roots?.close();
        closeWallets?.();
        await source?.close().catch(() => undefined);
      }
    }
    if (options.keepDir !== undefined) report.keptIn = options.keepDir;
    if (dryRun && options.keepDir === undefined) {
      await fs
        .rmdir(path.join(config.workDir, 'dry-run'))
        .catch(() => undefined);
    }
  }

  /**
   * Room for one L2 band: four times this index's largest band (the build's
   * database, about one and a half bands, the band, the band it replaces),
   * at least 2 GiB, beyond the same margin as other bands. With `publishDir`, the scratch must be
   * on its filesystem, since a band is renamed into place.
   */
  private async checkL2Disk(
    publishDir: string | undefined,
    bands: L2LiveBand[],
  ): Promise<void> {
    const { workDir } = this.deps.config;
    if (publishDir !== undefined) {
      await fs.mkdir(publishDir, { recursive: true });
      await assertSameFilesystem(workDir, publishDir);
    }
    const { free, total } = await (this.deps.diskSpace ?? statfsSpace)(workDir);
    const margin = Math.max(0.05 * total, 10 * GIB);
    let largest = 0;
    for (const band of bands) {
      let bytes = 0;
      for (const name of await fs
        .readdir(band.dir)
        .catch(() => [] as string[])) {
        bytes +=
          (await fs.stat(path.join(band.dir, name)).catch(() => undefined))
            ?.size ?? 0;
      }
      largest = Math.max(largest, bytes);
    }
    const need = margin + Math.max(4 * largest, 2 * GIB);
    if (free < need) {
      throw new RunFailure(
        'disk',
        `${Math.round(free / GIB)} GiB free under ${workDir}, under the ${Math.round(need / GIB)} GiB an L2 band needs (with a ${Math.round(margin / GIB)} GiB margin)`,
      );
    }
  }

  /** The top of an index's live bands: frozen (h, d) and the tip. */
  private recordL2Bands(index: string, bands: L2LiveBand[]): void {
    try {
      const { frozen, tips } = classifyL2Bands(bands);
      if (frozen.length > 0) {
        metrics.bandTop.set(
          { index, kind: 'frozen' },
          Math.max(...frozen.map((b) => b.to)),
        );
      }
      if (tips.length > 0) {
        metrics.bandTop.set(
          { index, kind: 'tip' },
          Math.max(...tips.map((b) => b.to)),
        );
      }
    } catch {
      // Bands the grid refuses are reported by the run itself.
    }
  }

  private updateL2State(
    state: IndexState,
    index: L2IndexReport,
    at: string,
  ): void {
    for (const step of index.steps) {
      if (step.result === 'published' || step.result === 'unchanged') {
        state.lastSuccess[step.role] = at;
        metrics.lastSuccess.set(
          { index: index.index, kind: step.role },
          Date.parse(at) / 1000,
        );
      }
      if (step.result === 'rejected') {
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
          tip: [
            ...new Set([
              ...(state.supersededHistory?.tip ?? []),
              ...step.supersedes,
            ]),
          ].slice(-HISTORY_KEPT * 2),
        };
      }
      // A band left in place waits an interval before the next re-settle.
      if (
        step.step === 'resettle' &&
        (step.result === 'unchanged' || step.result === 'rejected')
      ) {
        const id = step.replaces?.[0];
        if (id !== undefined) {
          state.resettledAt = { ...state.resettledAt, [id]: at };
        }
      }
    }
    if (index.liveIds !== undefined) {
      const live = new Set(index.liveIds);
      const keep = <T>(all: Record<string, T> | undefined) => {
        const kept = Object.entries(all ?? {}).filter(([id]) => live.has(id));
        return kept.length > 0 ? Object.fromEntries(kept) : undefined;
      };
      const resettledAt = keep(state.resettledAt);
      if (resettledAt !== undefined) state.resettledAt = resettledAt;
      else delete state.resettledAt;
      const fingerprints = keep({
        ...state.fingerprints,
        ...index.fingerprints,
      });
      if (fingerprints !== undefined) state.fingerprints = fingerprints;
      else delete state.fingerprints;
      const rechecks = keep({
        ...state.unreadableRechecks,
        ...index.rechecks,
      });
      if (rechecks !== undefined) state.unreadableRechecks = rechecks;
      else delete state.unreadableRechecks;
    }
    if (index.failed?.reason === 'grid_layout') {
      state.lastRejection = {
        at,
        role: 'h',
        reasons: [index.failed.reason, index.failed.message],
      };
    }
    const result = l2Result(index);
    const failed =
      index.failed !== undefined
        ? { reason: index.failed.reason, details: [index.failed.message] }
        : index.steps.find(
            (s) => s.result === 'rejected' || s.result === 'couldnt_check',
          );
    if (result === 'couldnt_check') {
      const attempts = (state.retry?.attempts ?? 0) + 1;
      state.retry = {
        at: new Date(
          this.now() +
            Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
        ).toISOString(),
        attempts,
        reason: [failed?.reason, ...(failed?.details ?? [])].join('; '),
      };
    } else if (index.deferred !== undefined && result !== 'rejected') {
      state.retry = {
        at: new Date(this.now() + RETRY_FIRST_MS).toISOString(),
        attempts: 0,
        reason: `${index.deferred.length} bands left by the time budget`,
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
   * beside the scratch and the new band, about three times the band (the
   * bands folded together, for a grid roll, tip or freeze), and nothing may
   * come within the margin (5% of the filesystem, at least 10 GiB), which
   * other services on it need.
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
    const folded = [
      ...(step.fold !== undefined ? [step.fold] : []),
      ...(step.folds ?? []),
      ...(step.seeds ?? []),
    ];
    const need =
      margin +
      3 *
        (folded.length > 0
          ? folded.reduce((sum, band) => sum + bandBytes(band), 0)
          : largest);
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
    if (memory.liveIds !== undefined) {
      // Kept for live bands only: a rebuilt band has a new id.
      const live = new Set(memory.liveIds);
      const settled = Object.entries({
        ...state.resettledAt,
        ...memory.resettled,
      }).filter(([id]) => live.has(id));
      if (settled.length > 0) {
        state.resettledAt = Object.fromEntries(settled);
      } else {
        delete state.resettledAt;
      }
      const fingerprints = Object.entries({
        ...state.fingerprints,
        ...memory.fingerprints,
      }).filter(([id]) => live.has(id));
      if (fingerprints.length > 0) {
        state.fingerprints = Object.fromEntries(fingerprints);
      } else {
        delete state.fingerprints;
      }
    }
    if (
      report.failed?.reason === 'foreign_bands' ||
      report.failed?.reason === 'grid_layout'
    ) {
      // A refusal needs an operator: show it as a rejection.
      state.lastRejection = {
        at,
        role: 'h',
        reasons: [report.failed.reason, report.failed.message],
      };
    }
    const result = runResult({
      ...report,
      l1Steps: [],
      l1Derived: [],
      l1Normalized: [],
      l2: [],
    });
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
    const states = indexNames(this.deps.config).map((index) =>
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
  /** Grid layout: bands re-settled and left in place (unchanged or rejected), by id. */
  resettled?: Record<string, string>;
  /** Grid layout: this publisher's live band ids after the run. */
  liveIds?: string[];
  /** Grid layout: what bands settled against this run, by id. */
  fingerprints?: Record<string, BandFingerprint>;
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
