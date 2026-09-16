/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Runs tools/scan-bundle-offsets as a subprocess against an in-memory gateway,
 * covering what only the CLI does: writing and resuming output files, retries,
 * rate limiting, and refusing roots that aren't L1 transactions.
 */

import {
  ArweaveSigner,
  DataItem,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
import Arweave from 'arweave';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TOOL = path.join(process.cwd(), 'tools', 'scan-bundle-offsets');

const CDB_HEADER =
  'data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size';

/** How the fake gateway answers for one ID. */
interface FakeRoot {
  bytes: Buffer;
  /** Extra response headers */
  headers?: Record<string, string>;
  /** Answer this many requests with 429 before serving any */
  rateLimitFirst?: number;
  /** Answer this exact Range header with 429 once */
  rateLimitRangeOnce?: string;
}

interface LoggedRequest {
  id: string;
  range?: string;
  status: number;
  at: number;
}

/** Serves /raw/<id> byte ranges from memory and logs every request. */
class FakeGateway {
  readonly roots = new Map<string, FakeRoot>();
  readonly requests: LoggedRequest[] = [];
  private readonly server = http.createServer((req, res) =>
    this.handle(req, res),
  );

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const at = Date.now();
    const match = /^\/raw\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? '');
    const id = match?.[1] ?? '';
    const range = req.headers.range;
    const reply = (status: number, headers: Record<string, string> = {}) => {
      this.requests.push({ id, range, status, at });
      res.writeHead(status, headers);
    };

    const root = this.roots.get(id);
    if (root === undefined) {
      reply(404);
      res.end();
      return;
    }
    if ((root.rateLimitFirst ?? 0) > 0) {
      root.rateLimitFirst = (root.rateLimitFirst ?? 0) - 1;
      reply(429, { 'Retry-After': '0' });
      res.end();
      return;
    }
    if (range !== undefined && range === root.rateLimitRangeOnce) {
      root.rateLimitRangeOnce = undefined;
      reply(429, { 'Retry-After': '0' });
      res.end();
      return;
    }

    const bounds = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    const total = root.bytes.length;
    const start = Number(bounds?.[1]);
    const end = Number(bounds?.[2]);
    if (bounds === null || end < start || end >= total) {
      reply(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    reply(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      ...root.headers,
    });
    res.end(root.bytes.subarray(start, end + 1));
  }
}

/** A root bundle and the IDs of the items it holds, in order. */
interface TestRoot {
  id: string;
  items: DataItem[];
  raw: Buffer;
}

async function runScan(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(TOOL, args, {
      cwd: process.cwd(),
      timeout: 90_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    if (typeof error?.code !== 'number') {
      throw error;
    }
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

/** Data rows of a CSV written by the tool (header checked, then dropped). */
async function readRows(filePath: string): Promise<string[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }
  const lines = (await fs.readFile(filePath, 'utf-8')).split('\n');
  assert.equal(lines.pop(), '', `${filePath} must end with a newline`);
  const [header, ...rows] = lines;
  assert.equal(header, CDB_HEADER);
  return rows;
}

/** Latest status and message recorded for each root. */
async function readProgress(
  filePath: string,
): Promise<Map<string, { status: string; items: string; message: string }>> {
  const progress = new Map<
    string,
    { status: string; items: string; message: string }
  >();
  for (const line of (await fs.readFile(filePath, 'utf-8')).split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const [root, status, items, , , message] = line.split('\t');
    progress.set(root, { status, items, message });
  }
  return progress;
}

/**
 * The CDB64 rows a scan must produce for a flat root, derived from the
 * ANS-104 layout and checked against the bundle's bytes.
 */
function expectedRows(root: TestRoot, skip: string[] = []): string[] {
  const rows: string[] = [];
  let offset = 32 + 64 * root.items.length;
  for (const item of root.items) {
    const itemRaw = item.getRaw();
    assert.deepEqual(
      root.raw.subarray(offset, offset + itemRaw.length),
      itemRaw,
    );
    const dataOffset = offset + itemRaw.length - item.rawData.length;
    if (!skip.includes(item.id)) {
      rows.push(
        `${item.id},${root.id},,${offset},${dataOffset},${itemRaw.length}`,
      );
    }
    offset += itemRaw.length;
  }
  return rows;
}

const sorted = (values: string[]): string[] => [...values].sort();

describe('scan-bundle-offsets CLI', () => {
  const gateway = new FakeGateway();
  let gatewayUrl: string;
  let signer: ArweaveSigner;
  let tempDir: string;
  let output: string;

  before(async () => {
    signer = new ArweaveSigner(await Arweave.init({}).wallets.generate());
    gatewayUrl = await gateway.start();
  });

  after(async () => {
    await gateway.stop();
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-bundle-cli-'));
    output = path.join(tempDir, 'offsets.csv');
    gateway.roots.clear();
    gateway.requests.length = 0;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const buildRoot = async (): Promise<TestRoot> => {
    const items = [
      createData(JSON.stringify({ name: 'nft #1' }), signer, {
        tags: [{ name: 'Content-Type', value: 'application/json' }],
      }),
      createData(Buffer.alloc(5000, 7), signer, {
        tags: [{ name: 'Content-Type', value: 'image/png' }],
      }),
      createData('', signer),
    ];
    const bundle = await bundleAndSignData(items, signer);
    return {
      id: randomBytes(32).toString('base64url'),
      items,
      raw: bundle.getRaw(),
    };
  };

  const serve = (root: TestRoot, extra: Partial<FakeRoot> = {}): void => {
    gateway.roots.set(root.id, { bytes: root.raw, ...extra });
  };

  /** Arguments every run shares; unlimited rate keeps the tests fast. */
  const baseArgs = (): string[] => [
    '--gateway',
    gatewayUrl,
    '--output',
    output,
    '--requests-per-second',
    '0',
  ];

  it('writes verified rows, details and an ok record for each root', async () => {
    const [a, b] = [await buildRoot(), await buildRoot()];
    serve(a);
    serve(b);
    const details = path.join(tempDir, 'details.csv');

    const run = await runScan([
      ...baseArgs(),
      '--details',
      details,
      '--bundle',
      a.id,
      '--bundle',
      b.id,
    ]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      sorted(await readRows(output)),
      sorted([...expectedRows(a), ...expectedRows(b)]),
    );

    const detailLines = (await fs.readFile(details, 'utf-8'))
      .trim()
      .split('\n');
    assert.equal(
      detailLines[0],
      'root_tx_id,data_item_id,depth,signature_type,content_type,is_bundle,data_item_size',
    );
    assert.ok(
      detailLines.includes(
        `${a.id},${a.items[0].id},0,1,application/json,0,${a.items[0].getRaw().length}`,
      ),
    );
    assert.equal(detailLines.length, 7);

    const progress = await readProgress(`${output}.progress`);
    assert.equal(progress.get(a.id)?.status, 'ok');
    assert.equal(progress.get(a.id)?.items, '3');
    assert.equal(progress.get(b.id)?.status, 'ok');

    const leftovers = (await fs.readdir(tempDir)).filter((name) =>
      name.endsWith('.part'),
    );
    assert.deepEqual(leftovers, []);
  });

  it('skips roots already recorded as ok when run again', async () => {
    const [a, b] = [await buildRoot(), await buildRoot()];
    serve(a);
    serve(b);

    assert.equal((await runScan([...baseArgs(), '--bundle', a.id])).code, 0);
    gateway.requests.length = 0;

    const run = await runScan([
      ...baseArgs(),
      '--bundle',
      a.id,
      '--bundle',
      b.id,
    ]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(await readRows(output), [
      ...expectedRows(a),
      ...expectedRows(b),
    ]);
    assert.deepEqual(
      gateway.requests.filter((request) => request.id === a.id),
      [],
    );
  });

  it('drops rows a stopped run left behind and rescans that root', async () => {
    const [a, b] = [await buildRoot(), await buildRoot()];
    serve(a);
    serve(b);
    assert.equal((await runScan([...baseArgs(), '--bundle', a.id])).code, 0);

    // Simulate a run stopped while writing b: its `writing` record carries
    // the output size from before b, then part of b's rows reached the output.
    const recordedSize = (await fs.stat(output)).size;
    await fs.appendFile(
      `${output}.progress`,
      `${b.id}\twriting\t0\t${recordedSize}\t\t\n`,
    );
    await fs.appendFile(output, 'partial,row,from,a,stopped');
    await fs.writeFile(`${output}.${b.id}.part`, 'stale part file\n');

    const run = await runScan([
      ...baseArgs(),
      '--bundle',
      a.id,
      '--bundle',
      b.id,
    ]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /Discarded \d+ unrecorded bytes/);
    assert.deepEqual(await readRows(output), [
      ...expectedRows(a),
      ...expectedRows(b),
    ]);
    const progress = await readProgress(`${output}.progress`);
    assert.equal(progress.get(b.id)?.status, 'ok');
    assert.equal(await fileExists(`${output}.${b.id}.part`), false);
  });

  it('refuses to resume against different output files', async () => {
    const a = await buildRoot();
    serve(a);
    const progressPath = path.join(tempDir, 'shared.progress');
    assert.equal(
      (
        await runScan([
          ...baseArgs(),
          '--progress',
          progressPath,
          '--bundle',
          a.id,
        ])
      ).code,
      0,
    );

    const otherOutput = path.join(tempDir, 'other.csv');
    const run = await runScan([
      '--gateway',
      gatewayUrl,
      '--output',
      otherOutput,
      '--progress',
      progressPath,
      '--bundle',
      a.id,
    ]);

    assert.equal(run.code, 1);
    assert.match(run.stderr, /refusing to resume/);
    assert.equal(await fileExists(otherOutput), false);
  });

  it('skips an item with an unsupported signature type and keeps the rest', async () => {
    const a = await buildRoot();
    const secondItemOffset =
      32 + 64 * a.items.length + a.items[0].getRaw().length;
    const patched = Buffer.from(a.raw);
    patched.writeUInt16LE(999, secondItemOffset);
    gateway.roots.set(a.id, { bytes: patched });

    const run = await runScan([...baseArgs(), '--bundle', a.id]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(await readRows(output), expectedRows(a, [a.items[1].id]));
    assert.match(run.stderr, /unsupported=1/);
    assert.match(run.stderr, /Unsupported: +1/);
    const progress = await readProgress(`${output}.progress`);
    assert.equal(progress.get(a.id)?.status, 'ok');
    assert.match(
      progress.get(a.id)?.message ?? '',
      new RegExp(
        `unsupported item ${a.items[1].id} \\(signature type 999\\) at offset ${secondItemOffset}`,
      ),
    );
  });

  it('refuses IDs the gateway reports as data items', async () => {
    const [a, b] = [await buildRoot(), await buildRoot()];
    // No root header, but an offset header only data items get.
    serve(a, { headers: { 'X-AR-IO-Data-Item-Offset': '100' } });
    // A root header naming a different transaction.
    serve(b, { headers: { 'X-AR-IO-Root-Transaction-Id': a.id } });

    const run = await runScan([
      ...baseArgs(),
      '--bundle',
      a.id,
      '--bundle',
      b.id,
    ]);

    assert.equal(run.code, 2);
    assert.deepEqual(await readRows(output), []);
    const progress = await readProgress(`${output}.progress`);
    assert.equal(progress.get(a.id)?.status, 'failed');
    assert.match(
      progress.get(a.id)?.message ?? '',
      /Not an L1 transaction: gateway sent data item header x-ar-io-data-item-offset/,
    );
    assert.equal(progress.get(b.id)?.status, 'failed');
    assert.match(
      progress.get(b.id)?.message ?? '',
      new RegExp(`Not an L1 transaction: gateway reports root ${a.id}`),
    );
  });

  it('accepts a root the gateway names as its own root', async () => {
    const a = await buildRoot();
    serve(a, {
      headers: {
        'X-AR-IO-Root-Transaction-Id': a.id,
        'X-AR-IO-Data-Item-Offset': '0',
      },
    });

    const run = await runScan([...baseArgs(), '--bundle', a.id]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(await readRows(output), expectedRows(a));
  });

  it('retries rate-limited requests', async () => {
    const a = await buildRoot();
    serve(a, {
      // The size probe is refused twice, then the index read once.
      rateLimitFirst: 2,
      rateLimitRangeOnce: `bytes=32-${32 + 64 * a.items.length - 1}`,
    });

    const run = await runScan([...baseArgs(), '--bundle', a.id]);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(await readRows(output), expectedRows(a));
    assert.equal(
      gateway.requests.filter((request) => request.status === 429).length,
      3,
    );
  });

  it('keeps to the requested rate across roots', async () => {
    const [a, b] = [await buildRoot(), await buildRoot()];
    serve(a);
    serve(b);
    const requestsPerSecond = 10;

    const run = await runScan([
      '--gateway',
      gatewayUrl,
      '--output',
      output,
      '--requests-per-second',
      String(requestsPerSecond),
      '--concurrency',
      '2',
      '--bundle',
      a.id,
      '--bundle',
      b.id,
    ]);

    assert.equal(run.code, 0, run.stderr);
    const times = gateway.requests.map((request) => request.at);
    assert.ok(
      times.length >= 6,
      `expected several requests, saw ${times.length}`,
    );
    // Requests are spaced 100 ms apart; allow a little scheduling jitter.
    const span = Math.max(...times) - Math.min(...times);
    const minimum = ((times.length - 1) * 1000) / requestsPerSecond - 50;
    assert.ok(
      span >= minimum,
      `${times.length} requests took ${span} ms, expected at least ${minimum} ms`,
    );
  });

  it('enforces --max-index-items', async () => {
    const a = await buildRoot();
    serve(a);

    const run = await runScan([
      ...baseArgs(),
      '--max-index-items',
      '2',
      '--bundle',
      a.id,
    ]);

    assert.equal(run.code, 2);
    const progress = await readProgress(`${output}.progress`);
    assert.equal(progress.get(a.id)?.status, 'failed');
    assert.match(
      progress.get(a.id)?.message ?? '',
      /Index lists 3 items, more than the limit of 2/,
    );
  });
});
