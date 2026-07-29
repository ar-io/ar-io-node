/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * chunk-seeding-report
 *
 * Reports how much of an L1 Arweave transaction's data is actually seeded
 * (retrievable as chunks) on the network. Given a txID, it resolves the
 * transaction's absolute weave byte range, probes GET /chunk/<offset> across
 * that range on one or more nodes, and coalesces the results into contiguous
 * found / missing byte ranges.
 *
 * The analysis core (`analyzeSeeding`) is deliberately decoupled from the
 * console renderer (`renderConsole`) and emits a plain JSON-serialisable
 * `SeedingReport`, so the same logic can back a future frontend visualisation.
 */

import axios from 'axios';

/** Arweave data chunk size (256 KiB). Last chunk of a tx may be smaller. */
export const CHUNK_SIZE = 262144;

export type ProbeStatus = 'found' | 'missing' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  httpCode: number | null;
  node: string | null;
}

export interface ChunkProbe {
  chunkIndex: number;
  offset: number;
  status: ProbeStatus;
  httpCode: number | null;
  node: string | null;
}

export interface SeedRange {
  startChunk: number;
  endChunk: number;
  startByte: number;
  endByte: number;
  byteLength: number;
  status: ProbeStatus;
}

export interface SeedingReport {
  txId: string;
  nodes: string[];
  size: number;
  startOffset: number;
  endOffset: number;
  chunkSize: number;
  totalChunks: number;
  sampledChunks: number;
  exhaustive: boolean;
  refined: boolean;
  resolutionBytes: number;
  summary: {
    foundSamples: number;
    missingSamples: number;
    unknownSamples: number;
    seededFraction: number;
    contiguousHeadBytes: number;
    verdict: 'FULLY_SEEDED' | 'PARTIAL' | 'NOT_SEEDED' | 'INDETERMINATE';
  };
  ranges: SeedRange[];
  probes: ChunkProbe[];
}

export interface AnalyzeOptions {
  nodes?: string[];
  infoNode?: string;
  samples?: number;
  exhaustive?: boolean;
  refine?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  /** Skip the /offset lookup by supplying the range directly. */
  size?: number;
  endOffset?: number;
  onProgress?: (done: number, total: number) => void;
}

const DEFAULTS = {
  nodes: ['https://arweave.net'],
  samples: 400,
  concurrency: 4,
  timeoutMs: 20000,
  retries: 3,
};

/** Fetch {size, offset(end)} for an L1 tx from a node's /tx/<id>/offset. */
async function fetchOffset(
  infoNode: string,
  txId: string,
  timeoutMs: number,
): Promise<{ size: number; endOffset: number }> {
  const url = `${infoNode.replace(/\/$/, '')}/tx/${txId}/offset`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  if (res.status === 404) {
    throw new Error(
      `No /offset for ${txId} at ${infoNode} (HTTP 404). ` +
        `This endpoint only exists for confirmed L1 transactions — ` +
        `if this is a data item inside a bundle it has no chunks of its own.`,
    );
  }
  if (res.status !== 200 || typeof res.data !== 'object') {
    throw new Error(
      `Unexpected /offset response from ${infoNode}: HTTP ${res.status}`,
    );
  }
  const size = Number(res.data.size);
  const endOffset = Number(res.data.offset);
  if (!Number.isFinite(size) || !Number.isFinite(endOffset)) {
    throw new Error(`Malformed /offset payload: ${JSON.stringify(res.data)}`);
  }
  if (endOffset > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `Weave offset ${endOffset} exceeds MAX_SAFE_INTEGER; needs BigInt handling.`,
    );
  }
  return { size, endOffset };
}

/**
 * Probe a single absolute offset for chunk availability across nodes.
 * found := any node returns 200; missing := at least one definitive 404 and no
 * 200; unknown := only transient failures (429/5xx/timeout) seen.
 */
async function probeOffset(
  offset: number,
  nodes: string[],
  timeoutMs: number,
  retries: number,
): Promise<ProbeResult> {
  let sawDefinite404 = false;
  let lastCode: number | null = null;
  for (const node of nodes) {
    const base = node.replace(/\/$/, '');
    for (let attempt = 0; attempt <= retries; attempt++) {
      let code: number | null = null;
      try {
        // Stream + immediate destroy so we don't buffer the ~256 KiB body.
        const res = await axios.get(`${base}/chunk/${offset}`, {
          timeout: timeoutMs,
          responseType: 'stream',
          validateStatus: () => true,
        });
        code = res.status;
        res.data.destroy();
      } catch {
        code = null; // network error / timeout
      }
      lastCode = code;
      if (code === 200) return { status: 'found', httpCode: 200, node: base };
      if (code === 404) {
        sawDefinite404 = true;
        break; // definitive for this node; move on
      }
      // 429 / 5xx / network → back off and retry the same node
      if (attempt < retries) {
        await sleep(Math.min(2000 * 2 ** attempt, 8000));
      }
    }
  }
  return {
    status: sawDefinite404 ? 'missing' : 'unknown',
    httpCode: lastCode,
    node: null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Absolute offset of a byte within chunk index k (clamped to the tx end). */
function chunkOffset(
  startOffset: number,
  endOffset: number,
  k: number,
): number {
  return Math.min(startOffset + k * CHUNK_SIZE, endOffset);
}

/** Evenly pick `count` chunk indices across [0, total-1], always incl. ends. */
function pickChunkIndices(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < count; i++) {
    out.add(Math.round((i * (total - 1)) / (count - 1)));
  }
  return [...out].sort((a, b) => a - b);
}

/** Bounded-concurrency map. */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      done++;
      onProgress?.(done);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Binary-search the chunk-index boundary between two probed indices with
 * differing found/missing status. Returns the last index that keeps `loStatus`.
 * Adds probes to the provided map.
 */
async function refineBoundary(
  loIdx: number,
  hiIdx: number,
  loStatus: ProbeStatus,
  startOffset: number,
  endOffset: number,
  nodes: string[],
  timeoutMs: number,
  retries: number,
  probeCache: Map<number, ProbeResult>,
): Promise<void> {
  let lo = loIdx;
  let hi = hiIdx;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    let res = probeCache.get(mid);
    if (!res) {
      res = await probeOffset(
        chunkOffset(startOffset, endOffset, mid),
        nodes,
        timeoutMs,
        retries,
      );
      probeCache.set(mid, res);
    }
    if (res.status === loStatus) lo = mid;
    else hi = mid;
  }
}

/** Coalesce ordered per-chunk probes into contiguous same-status ranges. */
function coalesce(
  probes: Array<{ chunkIndex: number; status: ProbeStatus }>,
  startOffset: number,
  endOffset: number,
  totalChunks: number,
): SeedRange[] {
  const ranges: SeedRange[] = [];
  for (const p of probes) {
    const last = ranges[ranges.length - 1];
    if (
      last &&
      last.status === p.status &&
      p.chunkIndex === last.endChunk + 1
    ) {
      last.endChunk = p.chunkIndex;
    } else if (last && last.status === p.status) {
      // gap between samples of same status — extend across the unsampled span
      last.endChunk = p.chunkIndex;
    } else {
      ranges.push({
        startChunk: p.chunkIndex,
        endChunk: p.chunkIndex,
        startByte: 0,
        endByte: 0,
        byteLength: 0,
        status: p.status,
      });
    }
  }
  for (const r of ranges) {
    r.startByte = chunkOffset(startOffset, endOffset, r.startChunk);
    r.endByte =
      r.endChunk >= totalChunks - 1
        ? endOffset
        : chunkOffset(startOffset, endOffset, r.endChunk + 1) - 1;
    r.byteLength = r.endByte - r.startByte + 1;
  }
  return ranges;
}

export async function analyzeSeeding(
  txId: string,
  options: AnalyzeOptions = {},
): Promise<SeedingReport> {
  const nodes = options.nodes ?? DEFAULTS.nodes;
  const infoNode = options.infoNode ?? nodes[0];
  const samples = options.samples ?? DEFAULTS.samples;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = options.retries ?? DEFAULTS.retries;

  let size = options.size;
  let endOffset = options.endOffset;
  if (size === undefined || endOffset === undefined) {
    ({ size, endOffset } = await fetchOffset(infoNode, txId, timeoutMs));
  }
  const startOffset = endOffset - size + 1;
  const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));

  const exhaustive = options.exhaustive === true || totalChunks <= samples;
  const indices = exhaustive
    ? Array.from({ length: totalChunks }, (_, i) => i)
    : pickChunkIndices(totalChunks, samples);

  const probeCache = new Map<number, ProbeResult>();
  await pool(
    indices,
    concurrency,
    async (idx) => {
      const res = await probeOffset(
        chunkOffset(startOffset, endOffset, idx),
        nodes,
        timeoutMs,
        retries,
      );
      probeCache.set(idx, res);
      return res;
    },
    (done) => options.onProgress?.(done, indices.length),
  );

  // Optional boundary refinement between adjacent differing samples.
  const refine = options.refine === true && !exhaustive;
  if (refine) {
    for (let i = 0; i < indices.length - 1; i++) {
      const a = probeCache.get(indices[i])!;
      const b = probeCache.get(indices[i + 1])!;
      const aDef = a.status !== 'unknown';
      const bDef = b.status !== 'unknown';
      if (
        aDef &&
        bDef &&
        a.status !== b.status &&
        indices[i + 1] - indices[i] > 1
      ) {
        await refineBoundary(
          indices[i],
          indices[i + 1],
          a.status,
          startOffset,
          endOffset,
          nodes,
          timeoutMs,
          retries,
          probeCache,
        );
      }
    }
  }

  const orderedIdx = [...probeCache.keys()].sort((a, b) => a - b);
  const probes: ChunkProbe[] = orderedIdx.map((idx) => {
    const r = probeCache.get(idx)!;
    return {
      chunkIndex: idx,
      offset: chunkOffset(startOffset, endOffset, idx),
      status: r.status,
      httpCode: r.httpCode,
      node: r.node,
    };
  });

  const ranges = coalesce(probes, startOffset, endOffset, totalChunks);

  const foundSamples = probes.filter((p) => p.status === 'found').length;
  const missingSamples = probes.filter((p) => p.status === 'missing').length;
  const unknownSamples = probes.filter((p) => p.status === 'unknown').length;
  const decided = foundSamples + missingSamples;

  // Byte-weighted seeded fraction from coalesced ranges (more honest than a raw
  // sample-count ratio, which --refine skews by clustering probes at boundaries).
  const foundBytes = ranges
    .filter((r) => r.status === 'found')
    .reduce((sum, r) => sum + r.byteLength, 0);
  const decidedBytes = ranges
    .filter((r) => r.status !== 'unknown')
    .reduce((sum, r) => sum + r.byteLength, 0);
  const seededFraction = decidedBytes > 0 ? foundBytes / decidedBytes : 0;

  // Contiguous head = leading found range starting at chunk 0.
  let contiguousHeadBytes = 0;
  if (ranges[0]?.status === 'found' && ranges[0].startChunk === 0) {
    contiguousHeadBytes = ranges[0].byteLength;
  }

  let verdict: SeedingReport['summary']['verdict'];
  if (decided === 0) verdict = 'INDETERMINATE';
  else if (missingSamples === 0) verdict = 'FULLY_SEEDED';
  else if (foundSamples === 0) verdict = 'NOT_SEEDED';
  else verdict = 'PARTIAL';

  return {
    txId,
    nodes,
    size,
    startOffset,
    endOffset,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    sampledChunks: probes.length,
    exhaustive,
    refined: refine,
    resolutionBytes: exhaustive ? CHUNK_SIZE : Math.round(size / probes.length),
    summary: {
      foundSamples,
      missingSamples,
      unknownSamples,
      seededFraction,
      contiguousHeadBytes,
      verdict,
    },
    ranges,
    probes,
  };
}

// ---------------------------------------------------------------------------
// Console rendering (kept separate from analysis so a frontend can reuse core)
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function colorize(
  s: string,
  color: keyof typeof ANSI,
  enabled: boolean,
): string {
  return enabled ? `${ANSI[color]}${s}${ANSI.reset}` : s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(2)} ${units[u]}`;
}

const STATUS_GLYPH: Record<ProbeStatus, string> = {
  found: '█',
  missing: '░',
  unknown: '▒',
};
const STATUS_COLOR: Record<ProbeStatus, keyof typeof ANSI> = {
  found: 'green',
  missing: 'red',
  unknown: 'yellow',
};

/**
 * Render an ANSI bar of `width` cells. Each cell aggregates the samples that
 * fall in its span; a cell shows missing if ANY sample under it is missing
 * (so gaps are never hidden), else unknown if any unknown, else found.
 */
function renderBar(
  report: SeedingReport,
  width: number,
  color: boolean,
): string {
  const cells: ProbeStatus[] = [];
  const n = report.probes.length;
  for (let c = 0; c < width; c++) {
    const lo = Math.floor((c * n) / width);
    const hi = Math.max(lo + 1, Math.floor(((c + 1) * n) / width));
    const slice = report.probes.slice(lo, hi);
    let cell: ProbeStatus = 'found';
    if (slice.some((p) => p.status === 'missing')) cell = 'missing';
    else if (slice.some((p) => p.status === 'unknown')) cell = 'unknown';
    cells.push(cell);
  }
  return cells
    .map((s) => colorize(STATUS_GLYPH[s], STATUS_COLOR[s], color))
    .join('');
}

export function renderConsole(report: SeedingReport, color = true): string {
  const out: string[] = [];
  const b = (s: string) => colorize(s, 'bold', color);
  const dim = (s: string) => colorize(s, 'dim', color);

  out.push('');
  out.push(b(`Chunk seeding report — ${report.txId}`));
  out.push(
    dim(
      `  nodes: ${report.nodes.join(', ')}   size: ${formatBytes(report.size)} ` +
        `(${report.size.toLocaleString()} B)`,
    ),
  );
  out.push(
    dim(
      `  weave offsets: ${report.startOffset.toLocaleString()} – ${report.endOffset.toLocaleString()}   ` +
        `chunks: ${report.totalChunks.toLocaleString()}`,
    ),
  );
  out.push(
    dim(
      `  probed: ${report.sampledChunks.toLocaleString()} ${
        report.exhaustive
          ? '(exhaustive)'
          : `samples @ ~${formatBytes(report.resolutionBytes)} resolution`
      }${report.refined ? ' + refined boundaries' : ''}`,
    ),
  );

  // Verdict line
  const v = report.summary.verdict;
  const vColor: keyof typeof ANSI =
    v === 'FULLY_SEEDED'
      ? 'green'
      : v === 'NOT_SEEDED'
        ? 'red'
        : v === 'PARTIAL'
          ? 'yellow'
          : 'yellow';
  const pct = (report.summary.seededFraction * 100).toFixed(1);
  out.push('');
  out.push(
    `  ${b('verdict:')} ${colorize(v, vColor, color)}   ` +
      `${b('seeded:')} ${pct}%   ` +
      `${b('contiguous head:')} ${formatBytes(report.summary.contiguousHeadBytes)}`,
  );
  if (report.summary.unknownSamples > 0) {
    out.push(
      colorize(
        `  ⚠ ${report.summary.unknownSamples} sample(s) indeterminate (429/timeout) — rerun or add --nodes`,
        'yellow',
        color,
      ),
    );
  }

  // Bar
  const termWidth = Math.max(
    20,
    Math.min(process.stdout.columns || 80, 100) - 4,
  );
  out.push('');
  out.push('  ' + renderBar(report, termWidth, color));
  out.push(
    '  ' +
      dim(
        `${colorize('█', 'green', color)} found  ` +
          `${colorize('░', 'red', color)} missing  ` +
          `${colorize('▒', 'yellow', color)} unknown`,
      ),
  );

  // Range table
  out.push('');
  out.push(b('  Ranges'));
  const header = `  ${'#'.padStart(3)}  ${'status'.padEnd(8)}  ${'chunks'.padStart(15)}  ${'byte range'.padStart(33)}  ${'size'.padStart(11)}`;
  out.push(dim(header));
  report.ranges.forEach((r, i) => {
    const status = colorize(r.status.padEnd(8), STATUS_COLOR[r.status], color);
    const chunks =
      r.startChunk === r.endChunk
        ? `${r.startChunk}`
        : `${r.startChunk}–${r.endChunk}`;
    const bytes = `${r.startByte.toLocaleString()}–${r.endByte.toLocaleString()}`;
    out.push(
      `  ${String(i + 1).padStart(3)}  ${status}  ${chunks.padStart(15)}  ${bytes.padStart(33)}  ${formatBytes(r.byteLength).padStart(11)}`,
    );
  });

  // Tail hint
  const missing = report.ranges.filter((r) => r.status === 'missing');
  if (missing.length > 0) {
    out.push('');
    out.push(
      dim(
        `  Note: "missing" means not served by ${report.nodes.join('/')}. To deep-search the peer\n` +
          `  graph for a specific gap, try:  ./tools/find-chunk-peer.sh ${missing[0].startByte}`,
      ),
    );
  }
  out.push('');
  return out.join('\n');
}
