/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Verifying `parquet-l1` bands directly, with no gateway and no `core.db`:
 * the consumer's view. Someone holding a directory of bands — an analyst,
 * an agent, another gateway deciding whether to install them — checks them
 * here before importing anything, or without ever importing at all; the
 * importer runs the same check on the bands it is about to write.
 *
 * **What it establishes, and from what.**
 * - The bands are the ones listed (`bands-dir.ts`): every band read by its
 *   own files' paths, its name its identity, nothing beside it read.
 * - With `--publication`, they are the bands their publisher signed: every
 *   file of the size and SHA-256 signed (`publication-binding.ts`).
 * - Each band holds exactly its layout's files and columns, and each table
 *   the rows its `band.json` digests, in the table's order, inside the
 *   band's heights.
 * - Every block, transaction, link, tag and wallet row is judged by the
 *   same code as a `core.db` (`judge.ts`); every lookup is the one its
 *   tables give, in its key order.
 * - With `--anchor-from`, the top block is bound to the chain and a sample
 *   of headers and signatures is checked (`verify-run.ts`).
 *
 * What none of that binds is reported as `unbound` and fails unless
 * accepted; see `verify.ts` for the classes.
 */
import * as fs from 'node:fs/promises';
import type { Database } from 'duckdb-async';

import { bandPublisherTag } from '../index-band/build.js';
import { isGone } from '../index-band/read-dir.js';
import {
  boundPublication,
  checkSignedFiles,
  PublicationRefused,
  type PublicationOptions,
} from '../index-band/publication-binding.js';
import type { BandDescriptor } from '../index-publication.js';
import { checkParquetFile } from '../parquet/check.js';
import { BandsSource } from './bands-source.js';
import {
  l1IdentityProblem,
  type L1BandOnDisk,
  readL1Bands,
} from './bands-dir.js';
import { addFailure, type VerifyCheck } from './checks.js';
import {
  bandFiles,
  idHeightRange,
  lookupsOf,
  PARQUET_L1_TABLES,
} from './layout.js';
import { verifyBandLookups } from './lookups.js';
import { digestBandTable } from './read.js';
import {
  runL1Verify,
  type L1RunOptions,
  type L1VerifyReport,
} from './verify-run.js';

export { WINDOW } from './verify-run.js';

/** A set of bands that cannot be checked as one index. */
export class BandsRefused extends Error {}

export interface BandsVerifyOptions
  extends Omit<L1RunOptions, 'from' | 'to' | 'checks'> {
  from?: number;
  to?: number;
  /** Check each band's lookups (default true). */
  lookups?: boolean;
  /** The signed publication the bands must be (`--publication`). */
  publication?: PublicationOptions;
  /** The publisher whose publication it must be, when known. */
  publisher?: string;
  /** Check only these bands of the directory (by id): the importer's plan. */
  only?: string[];
}

export interface BandsVerifyResult extends L1VerifyReport {
  bandsDir: string;
  bands: Array<{ id: string; heightRange: [number, number] }>;
  /** Bands only partly inside --from/--to: not checked. */
  partial: string[];
  /** Other installed generations of a band checked once, with the same tables. */
  duplicates: string[];
  /** Entries passed over unread (retired copies, stray directories), with why. */
  ignored: Array<{ entry: string; reason: string }>;
  vanished: string[];
  publisherBound: boolean;
  publication?: {
    publisher: string;
    keyId: string;
    keyFrom: string;
    sequence: number;
    issuedAt: string;
    expiresAt: string;
    index: string;
    absent: string[];
  };
  lookupsChecked: number;
  lookupsSkipped: number;
}

/**
 * The bands ordered by height, refused if any overlap or leave a hole: a
 * set like that is not one index's.
 */
export function bandCoverage(
  bands: ReadonlyArray<{ id: string; band: { heightRange: [number, number] } }>,
): {
  ordered: Array<{ id: string; from: number; to: number }>;
  span: [number, number];
} {
  if (bands.length === 0) {
    throw new BandsRefused('no readable band in this directory');
  }
  const ordered = bands
    .map(({ id, band }) => ({
      id,
      from: band.heightRange[0],
      to: band.heightRange[1],
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const next = ordered[i];
    if (next.from === previous.to + 1) continue;
    throw new BandsRefused(
      next.from <= previous.to
        ? `bands ${previous.id} and ${next.id} overlap at height ${next.from}`
        : `nothing covers height ${previous.to + 1}: ${previous.id} ends there and ${next.id} starts at ${next.from}`,
    );
  }
  return {
    ordered,
    span: [ordered[0].from, ordered[ordered.length - 1].to],
  };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Checks a directory of bands (see the module comment).
 *
 * @throws BandsRefused when the directory holds no band, its bands overlap
 *   or leave a hole, or a publication given does not bind.
 */
export async function verifyBands(
  duck: Database,
  bandsDir: string,
  options: BandsVerifyOptions = {},
): Promise<BandsVerifyResult> {
  const started = Date.now();
  if (
    options.from !== undefined &&
    options.to !== undefined &&
    options.to <= options.from
  ) {
    throw new BandsRefused(
      `nothing to check between ${options.from} and ${options.to}: this compares each block with the one below it`,
    );
  }
  const listing = await readL1Bands(bandsDir);
  if (options.only !== undefined) {
    const only = new Set(options.only);
    listing.bands = listing.bands.filter((b) => only.has(b.id));
  }
  const inside = (from: number, to: number) =>
    (options.from === undefined || from >= options.from) &&
    (options.to === undefined || to <= options.to);
  const overlaps = (from: number, to: number) =>
    (options.from === undefined || to >= options.from) &&
    (options.to === undefined || from <= options.to);
  const inRange = listing.bands.filter((b) => inside(...b.band.heightRange));
  const partial = listing.bands
    .filter(
      (b) => !inside(...b.band.heightRange) && overlaps(...b.band.heightRange),
    )
    .map((b) => b.id)
    .sort();
  let coverage;
  try {
    coverage = bandCoverage(inRange);
  } catch (error) {
    const problems = listing.problems.map((p) => `${p.entry}: ${p.problem}`);
    throw new BandsRefused(
      `${messageOf(error)}${problems.length > 0 ? ` (unreadable entries: ${problems.join('; ')})` : ''}`,
    );
  }
  const { span } = coverage;
  const byId = new Map(inRange.map((b) => [b.id, b]));
  const ordered = coverage.ordered.map(
    ({ id }) => byId.get(id) as L1BandOnDisk,
  );
  const low = options.from ?? span[0];
  const high = options.to ?? span[1];
  if (high <= low) {
    throw new BandsRefused(
      `nothing to check between ${low} and ${high}: this compares each block with the one below it`,
    );
  }

  const check = (name: string, detail: string): VerifyCheck => ({
    name,
    ok: true,
    detail,
  });
  const identity = check(
    'identity',
    "every band's name is its id: its heights, in canonical decimals, are its band.json's, and its digest is its tables'",
  );
  const coverageCheck = check(
    'coverage',
    'the bands cover every height asked for, each band whole',
  );
  const publicationCheck = check(
    'publication',
    'every band is listed in the publication its publisher signed, every file with the size and SHA-256 signed',
  );
  const files = check(
    'files',
    'every entry is a readable band holding exactly the files its layout requires; nothing else is read',
  );
  const schema = check(
    'schema',
    "every Parquet file has exactly its layout's columns, in order, with its types",
  );
  const tables = check(
    'tables',
    "each table's rows are in the table's order, inside the band's heights, and digest to what band.json says",
  );
  const lookups = check('lookups', '');
  const fail = (
    c: VerifyCheck,
    height: number,
    found: string,
    expected: string,
  ) => addFailure(c, { height, found, expected });

  if (options.from !== undefined && options.from < span[0]) {
    fail(
      coverageCheck,
      options.from,
      `heights ${options.from}-${span[0] - 1} in no band checked`,
      'a band over every height asked for',
    );
  }
  if (options.to !== undefined && options.to > span[1]) {
    fail(
      coverageCheck,
      span[1],
      `heights ${span[1] + 1}-${options.to} in no band checked`,
      'a band over every height asked for',
    );
  }
  for (const id of partial) {
    fail(
      coverageCheck,
      idHeightRange(id)?.[0] ?? low,
      `${id} is only partly inside ${low}-${high}, so it is not checked`,
      '--from and --to on band boundaries',
    );
  }
  for (const { entry, problem } of listing.problems) {
    const c = /^names |^not an l1 band id|canonical/.test(problem)
      ? identity
      : files;
    fail(
      c,
      span[0],
      `${entry}: ${problem}`,
      'a band directory that reads whole and is what it is named',
    );
  }
  for (const entry of listing.vanished) {
    fail(
      files,
      span[0],
      `${entry}: vanished while the directory was read`,
      'every band there to the end of the run',
    );
  }

  // The publication, verified before any band is read.
  let bound: ReturnType<typeof boundPublication> | undefined;
  let listed: Map<string, BandDescriptor> | undefined;
  const absent: string[] = [];
  if (options.publication !== undefined) {
    try {
      bound = boundPublication(
        options.publication,
        'parquet-l1',
        ordered.map((b) => b.id),
        options.publisher,
      );
    } catch (error) {
      if (error instanceof PublicationRefused) {
        throw new BandsRefused(error.message);
      }
      throw error;
    }
    listed = new Map(bound.entry.bands.map((b) => [b.id, b]));
    const here = new Set(listing.bands.map((b) => b.id));
    for (const band of bound.entry.bands) {
      if (here.has(band.id)) continue;
      const heights = idHeightRange(band.id) ?? [0, Number.MAX_SAFE_INTEGER];
      if (!overlaps(heights[0], heights[1])) continue;
      absent.push(band.id);
      fail(
        publicationCheck,
        heights[0],
        `${band.id}: listed in the publication, not in ${bandsDir}`,
        'every band it lists in the range checked',
      );
    }
  }
  const publisher = options.publisher ?? bound?.publication.publisher;
  const tag = publisher !== undefined ? bandPublisherTag(publisher) : undefined;

  // Each band's files, alone: a failure in one is reported and the rest
  // are still checked.
  let lookupsChecked = 0;
  let lookupsSkipped = 0;
  const judgeFailures: NonNullable<L1RunOptions['judgeFailures']> = [];
  for (const onDisk of ordered) {
    const { id, dir, band } = onDisk;
    const [from] = band.heightRange;
    const at = (c: VerifyCheck, found: string, expected: string) =>
      fail(c, from, `${id}: ${found}`, expected);
    try {
      if (tag !== undefined) {
        const problem = l1IdentityProblem(id, band, tag);
        if (problem !== undefined && /publisher tag/.test(problem)) {
          at(identity, problem, "the publisher's tag");
        }
      }
      const present = (await fs.readdir(dir))
        .filter((n) => !n.startsWith('.'))
        .sort();
      if (listed !== undefined) {
        const descriptor = listed.get(id);
        if (descriptor === undefined) {
          at(
            publicationCheck,
            'not listed in the publication',
            'every band listed',
          );
        } else {
          for (const p of await checkSignedFiles(dir, descriptor, present)) {
            at(publicationCheck, p.found, p.expected);
          }
        }
      }
      const wanted = bandFiles(band.schema);
      if (present.join(',') !== wanted.join(',')) {
        at(files, `holds ${present.join(', ')}`, wanted.join(', '));
        continue;
      }
      let shapeOk = true;
      for (const spec of [...PARQUET_L1_TABLES, ...lookupsOf(band.schema)]) {
        try {
          await checkParquetFile(duck, `${dir}/${spec.file}`, {
            columns: spec.columns,
          });
        } catch (error) {
          shapeOk = false;
          at(schema, messageOf(error).replace(`${dir}/`, ''), 'the layout');
        }
      }
      if (!shapeOk) continue;
      const [lo, hi] = band.heightRange;
      for (const spec of PARQUET_L1_TABLES) {
        const described = band.tables[spec.name];
        if (spec.orderBy[0] === 'height') {
          const [stray] = (await duck.all(
            `SELECT COUNT(*) AS n FROM read_parquet('${`${dir}/${spec.file}`.replace(/'/g, "''")}') WHERE height < ${lo} OR height > ${hi} OR height IS NULL`,
          )) as Array<{ n: number | bigint }>;
          if (Number(stray.n) > 0) {
            at(
              tables,
              `${spec.name} holds ${Number(stray.n)} rows outside heights ${lo}-${hi}`,
              "every row inside its band's heights",
            );
          }
        }
        let digest;
        try {
          digest = await digestBandTable(duck, dir, spec);
        } catch (error) {
          at(tables, messageOf(error), "rows in the table's order");
          continue;
        }
        if (
          described === undefined ||
          digest.rows !== described.rows ||
          digest.rowDigest !== described.rowDigest
        ) {
          at(
            tables,
            `${spec.name}: ${digest.rows} rows with digest ${digest.rowDigest}`,
            described === undefined
              ? 'a table band.json describes'
              : `${described.rows} rows with digest ${described.rowDigest}, as band.json says`,
          );
        }
      }
      // Wallets: every key hashes to its address, by the one rule for RSA
      // and ECDSA keys alike; tags: every one belongs to a transaction at
      // its height.
      const walletsFile = `${dir}/wallets.parquet`.replace(/'/g, "''");
      const [badWallets] = (await duck.all(
        `SELECT COUNT(*) AS n FROM read_parquet('${walletsFile}')
         WHERE public_modulus IS NULL OR address IS NULL
            OR sha256(public_modulus) <> lower(hex(address))`,
      )) as Array<{ n: number | bigint }>;
      if (Number(badWallets.n) > 0) {
        judgeFailures.push({
          check: 'wallets',
          height: from,
          found: `${id}: ${Number(badWallets.n)} wallet rows whose key is missing or hashes elsewhere`,
          expected: 'address = SHA-256(key)',
        });
      }
      const tagsFile = `${dir}/tags.parquet`.replace(/'/g, "''");
      const txFile = `${dir}/transactions.parquet`.replace(/'/g, "''");
      const [orphanTags] = (await duck.all(
        `SELECT COUNT(*) AS n FROM read_parquet('${tagsFile}') g
         WHERE NOT EXISTS (SELECT 1 FROM read_parquet('${txFile}') t
                           WHERE t.height = g.height AND t.id = g.id)`,
      )) as Array<{ n: number | bigint }>;
      if (Number(orphanTags.n) > 0) {
        judgeFailures.push({
          check: 'tags',
          height: from,
          found: `${id}: ${Number(orphanTags.n)} tag rows of no transaction at their height`,
          expected: 'every tag belongs to a transaction at its height',
        });
      }
      if (options.lookups !== false) {
        if (lookupsOf(band.schema).length === 0) {
          lookupsSkipped += 1;
        } else {
          lookupsChecked += 1;
          for (const problem of await verifyBandLookups(duck, dir, band)) {
            at(
              lookups,
              problem,
              "lookups derived from the band's own tables, in key order, as its band.json describes them",
            );
          }
        }
      }
    } catch (error) {
      const gone = await isGone(dir);
      at(
        files,
        gone ? 'vanished during the run' : `stopped: ${messageOf(error)}`,
        'a band that reads to the end of the run',
      );
    }
  }
  lookups.detail =
    lookupsChecked === 0
      ? 'no band in this range carries lookups'
      : `${lookupsChecked} bands' lookups hold exactly the rows their tables give, in key order, and their band.json describes` +
        (lookupsSkipped > 0
          ? `; ${lookupsSkipped} bands are of a layout without lookups`
          : '');

  const ownChecks = [identity, coverageCheck];
  if (options.publication !== undefined) ownChecks.push(publicationCheck);
  ownChecks.push(files, schema, tables);
  if (options.lookups !== false) ownChecks.push(lookups);
  const skipped = [...(options.skipped ?? [])];
  const accepted = [...(options.accepted ?? [])];
  if (options.lookups === false) {
    skipped.push('lookups');
    accepted.push('--skip-lookups');
  }
  if (options.publication === undefined) skipped.push('publication');
  const keyFrom = options.publication?.keyFrom ?? 'operator';
  const assurance = [
    bound !== undefined
      ? `bound to the publication of ${bound.publication.publisher} (sequence ${bound.publication.sequence}, issued ${bound.publication.issuedAt}, expires ${bound.publication.expiresAt}), signed by ${bound.publication.signature?.keyId ?? ''}, ${keyFrom === 'operator' ? 'the key the operator gave' : `a key trusted to ${keyFrom}`}`
      : 'not bound to any signature: no publication was given, so nothing says these are the bands their publisher published',
    ...(options.assurance ?? []),
  ];

  const report = await runL1Verify(new BandsSource(duck, ordered), {
    ...options,
    from: low,
    to: high,
    checks: ownChecks,
    skipped,
    accepted,
    assurance,
    judgeFailures,
  });
  return {
    ...report,
    bandsDir,
    bands: ordered.map((b) => ({ id: b.id, heightRange: b.band.heightRange })),
    partial,
    duplicates: listing.duplicates,
    ignored: listing.ignored,
    vanished: listing.vanished,
    publisherBound: bound !== undefined,
    ...(bound !== undefined
      ? {
          publication: {
            publisher: bound.publication.publisher,
            keyId: bound.publication.signature?.keyId ?? '',
            keyFrom,
            sequence: bound.publication.sequence,
            issuedAt: bound.publication.issuedAt,
            expiresAt: bound.publication.expiresAt,
            index: bound.entry.name,
            absent,
          },
        }
      : {}),
    lookupsChecked,
    lookupsSkipped,
    seconds: (Date.now() - started) / 1000,
  };
}
