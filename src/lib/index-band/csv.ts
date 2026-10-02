/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';

import { fromB64Url, toB64Url } from '../encoding.js';
import type { BandRecord } from './build.js';

/** The columns of a band record CSV, in order. */
export const BAND_RECORD_CSV_COLUMNS = [
  'data_item_id',
  'root_tx_id',
  'path',
  'root_data_item_offset',
  'root_data_offset',
  'data_item_size',
  'height',
] as const;

const ID_BYTES = 32;

function parseId(value: string, column: string, line: number): Buffer {
  const id = fromB64Url(value.trim());
  if (id.length !== ID_BYTES || toB64Url(id) !== value.trim()) {
    throw new Error(
      `Line ${line}: ${column} is not a 43-character ID${line === 1 ? ' (a header line? use --skip-header)' : ''}`,
    );
  }
  return id;
}

function parseNumber(
  value: string | undefined,
  column: string,
  line: number,
): number | undefined {
  const text = (value ?? '').trim();
  if (text === '') return undefined;
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Line ${line}: ${column} is not a non-negative integer: ${text}`,
    );
  }
  return Number(text);
}

/**
 * Reads band records from CSV: the columns of
 * `tools/generate-cdb64-root-tx-index`
 * (`data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size`)
 * plus `height`. A malformed row fails the read with its line number;
 * whether a well-formed record is valid (offsets that frame a header, a size
 * that fits) is the band builder's rule, and it drops and counts the ones
 * that aren't.
 */
export async function* readBandRecordsCsv(
  source: Readable | (() => Readable),
  { skipHeader = false }: { skipHeader?: boolean } = {},
): AsyncGenerator<BandRecord> {
  // Opened here, when the band builder starts reading, so the error listener
  // is attached before the stream can fail.
  const input = typeof source === 'function' ? source() : source;
  const parser = input.pipe(
    parse({
      columns: false,
      // Each record with its own line number; the parser's running info can
      // be ahead of the record being read.
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      // A file saved with a byte-order mark reads like one without.
      bom: true,
      from_line: skipHeader ? 2 : 1,
    }),
  );
  input.on('error', (error) => parser.destroy(error));
  for await (const { record: row, info } of parser as AsyncIterable<{
    record: string[];
    info: { lines: number };
  }>) {
    const line = info.lines;
    if (row.length < 2) {
      throw new Error(`Line ${line}: needs at least data_item_id,root_tx_id`);
    }
    const record: BandRecord = {
      id: parseId(row[0], 'data_item_id', line),
      rootTxId: parseId(row[1], 'root_tx_id', line),
    };
    if ((row[2] ?? '').trim() !== '') {
      throw new Error(
        `Line ${line}: nested bundle paths are not supported in bands yet`,
      );
    }
    const rootOffset = parseNumber(row[3], 'root_data_item_offset', line);
    const rootDataOffset = parseNumber(row[4], 'root_data_offset', line);
    const size = parseNumber(row[5], 'data_item_size', line);
    const height = parseNumber(row[6], 'height', line);
    if (rootOffset !== undefined) record.rootOffset = rootOffset;
    if (rootDataOffset !== undefined) record.rootDataOffset = rootDataOffset;
    if (size !== undefined) record.size = size;
    if (height !== undefined) record.height = height;
    yield record;
  }
}

/**
 * Writes band records as CSV in the format {@link readBandRecordsCsv} reads,
 * with a header line (read it back with `skipHeader`). IDs are base64url and
 * the rest are integers, so no value needs quoting. Destroying the stream
 * (a failed destination) stops reading the records.
 */
export function writeBandRecordsCsv(
  records: AsyncIterable<BandRecord> | Iterable<BandRecord>,
): Readable {
  async function* lines(): AsyncGenerator<string> {
    yield `${BAND_RECORD_CSV_COLUMNS.join(',')}\n`;
    for await (const record of records) {
      yield `${toB64Url(record.id)},${toB64Url(record.rootTxId)},,${record.rootOffset ?? ''},${record.rootDataOffset ?? ''},${record.size ?? ''},${record.height ?? ''}\n`;
    }
  }
  return Readable.from(lines());
}
