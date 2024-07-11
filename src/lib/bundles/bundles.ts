/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  MIN_BINARY_SIZE,
  byteArrayToLong,
  deepHash,
  indexToType,
} from 'arbundles';
import { deserializeTags } from './tags.js';

export interface SignatureMeta {
  sigLength: number;
  pubLength: number;
  sigName: string;
}

export enum SignatureConfig {
  ARWEAVE = 1,
  ED25519,
  ETHEREUM,
  SOLANA,
  INJECTEDAPTOS = 5,
  MULTIAPTOS = 6,
  TYPEDETHEREUM = 7,
}

export const SIG_CONFIG: Record<SignatureConfig, SignatureMeta> = {
  [SignatureConfig.ARWEAVE]: {
    sigLength: 512,
    pubLength: 512,
    sigName: 'arweave',
  },
  [SignatureConfig.ED25519]: {
    sigLength: 64,
    pubLength: 32,
    sigName: 'ed25519',
  },
  [SignatureConfig.ETHEREUM]: {
    sigLength: 65,
    pubLength: 65,
    sigName: 'ethereum',
  },
  [SignatureConfig.SOLANA]: {
    sigLength: 64,
    pubLength: 32,
    sigName: 'solana',
  },
  [SignatureConfig.INJECTEDAPTOS]: {
    sigLength: 64,
    pubLength: 32,
    sigName: 'injectedAptos',
  },
  [SignatureConfig.MULTIAPTOS]: {
    sigLength: 64 * 32 + 4, // max 32 64 byte signatures, +4 for 32-bit bitmap
    pubLength: 32 * 32 + 1, // max 64 32 byte keys, +1 for 8-bit threshold value
    sigName: 'multiAptos',
  },
  [SignatureConfig.TYPEDETHEREUM]: {
    sigLength: 65,
    pubLength: 42,
    sigName: 'typedEthereum',
  },
};

const isValidSignatureConfig = (value: number): value is SignatureConfig => {
  return Object.values(SignatureConfig).includes(value);
};

const getSignatureMeta = (signatureType: number): SignatureMeta => {
  if (isValidSignatureConfig(signatureType)) {
    return SIG_CONFIG[signatureType];
  } else {
    throw new Error('Invalid signature type');
  }
};

export interface DataItemInfo {
  anchor: string;
  dataOffset: number;
  dataSize: number;
  id: string;
  offset: number;
  owner: string;
  ownerOffset: number;
  ownerSize: number;
  sigName: string;
  signature: string;
  signatureOffset: number;
  signatureSize: number;
  signatureType: number;
  size: number;
  tags: { name: string; value: string }[];
  target: string;
}

export const processBundleStream = async (
  stream: Readable,
): Promise<DataItemInfo[]> => {
  const reader = getReader(stream);
  let bytes = (await reader.next()).value;

  // Read header
  bytes = await readBytes(reader, bytes, 32);
  const itemCount = byteArrayToLong(bytes.subarray(0, 32));
  const headersLength = 64 * itemCount;
  bytes = await readBytes(reader, bytes.subarray(32), headersLength);

  const headers: [number, string][] = new Array(itemCount);
  for (let i = 0; i < headersLength; i += 64) {
    headers[i >> 6] = [
      byteArrayToLong(bytes.subarray(i, i + 32)),
      bytes.subarray(i + 32, i + 64).toString('base64url'),
    ];
  }

  bytes = bytes.subarray(headersLength);
  let offsetSum = 32 + headersLength;

  const items: DataItemInfo[] = [];

  for (const [length, id] of headers) {
    bytes = await readBytes(reader, bytes, MIN_BINARY_SIZE);

    const dataItemOffset = offsetSum;

    // Get sig type
    bytes = await readBytes(reader, bytes, 2);
    const signatureType = byteArrayToLong(bytes.subarray(0, 2));
    bytes = bytes.subarray(2);

    const { sigLength, pubLength, sigName } = getSignatureMeta(signatureType);

    // Get sig
    const signatureOffset = dataItemOffset + 2;
    bytes = await readBytes(reader, bytes, sigLength);
    const signature = bytes.subarray(0, sigLength);
    bytes = bytes.subarray(sigLength);

    // Get owner
    const ownerOffset = signatureOffset + sigLength;
    bytes = await readBytes(reader, bytes, pubLength);
    const owner = bytes.subarray(0, pubLength);
    bytes = bytes.subarray(pubLength);

    // Get target
    bytes = await readBytes(reader, bytes, 1);
    const targetPresent = bytes[0] === 1;
    if (targetPresent) bytes = await readBytes(reader, bytes, 33);
    const target = targetPresent
      ? bytes.subarray(1, 33)
      : Buffer.allocUnsafe(0);
    bytes = bytes.subarray(targetPresent ? 33 : 1);

    // Get anchor
    bytes = await readBytes(reader, bytes, 1);
    const anchorPresent = bytes[0] === 1;
    if (anchorPresent) bytes = await readBytes(reader, bytes, 33);
    const anchor = anchorPresent
      ? bytes.subarray(1, 33)
      : Buffer.allocUnsafe(0);
    bytes = bytes.subarray(anchorPresent ? 33 : 1);

    // Get tags
    bytes = await readBytes(reader, bytes, 16);
    const tagsLength = byteArrayToLong(bytes.subarray(0, 8));
    const tagsBytesLength = byteArrayToLong(bytes.subarray(8, 16));
    bytes = bytes.subarray(16);

    bytes = await readBytes(reader, bytes, tagsBytesLength);
    const tagsBytes = bytes.subarray(0, tagsBytesLength);
    const tags =
      tagsLength !== 0 && tagsBytesLength !== 0
        ? deserializeTags(Buffer.from(tagsBytes))
        : [];
    if (tags.length !== tagsLength) throw new Error("Tags lengths don't match");
    bytes = bytes.subarray(tagsBytesLength);

    const transform = new Transform({
      transform(chunk, _, callback) {
        this.push(chunk);
        callback();
      },
    });

    // Verify signature
    const signatureData = deepHash([
      Buffer.from('dataitem'),
      Buffer.from('1'),
      Buffer.from(signatureType.toString()),
      owner,
      target,
      anchor,
      tagsBytes,
      transform,
    ]);

    // Get offset of data start and length of data
    const dataOffset =
      2 +
      sigLength +
      pubLength +
      (targetPresent ? 33 : 1) +
      (anchorPresent ? 33 : 1) +
      16 +
      tagsBytesLength;
    const dataSize = length - dataOffset;

    // Stream the data through the transform
    if (bytes.byteLength > dataSize) {
      transform.write(bytes.subarray(0, dataSize));
      bytes = bytes.subarray(dataSize);
    } else {
      let skipped = bytes.byteLength;
      transform.write(bytes);
      while (dataSize > skipped) {
        bytes = (await reader.next()).value;
        if (bytes === undefined) {
          throw new Error(
            `Not enough data bytes  expected: ${dataSize} received: ${skipped}`,
          );
        }

        skipped += bytes.byteLength;

        if (skipped > dataSize)
          transform.write(
            bytes.subarray(0, bytes.byteLength - (skipped - dataSize)),
          );
        else transform.write(bytes);
      }
      bytes = bytes.subarray(bytes.byteLength - (skipped - dataSize));
    }

    transform.end();

    if (id !== createHash('sha256').update(signature).digest('base64url'))
      throw new Error("ID doesn't match signature");

    const Signer = indexToType[signatureType];

    if (!(await Signer.verify(owner, (await signatureData) as any, signature)))
      throw new Error('Invalid signature');

    items.push({
      anchor: Buffer.from(anchor).toString('base64url'),
      dataOffset: offsetSum + dataOffset,
      dataSize,
      id,
      offset: dataItemOffset,
      owner: Buffer.from(owner).toString('base64url'),
      ownerOffset,
      ownerSize: pubLength,
      sigName,
      signature: Buffer.from(signature).toString('base64url'),
      signatureOffset,
      signatureSize: sigLength,
      signatureType: signatureType,
      size: length,
      tags,
      target: Buffer.from(target).toString('base64url'),
    });

    offsetSum += length;
  }

  return items;
};

const readBytes = async (
  reader: AsyncGenerator<Buffer>,
  buffer: Uint8Array,
  length: number,
): Promise<Uint8Array> => {
  if (buffer.byteLength >= length) return buffer;

  const { done, value } = await reader.next();

  if (done && !value) throw new Error('Invalid buffer');

  const newBuffer = Buffer.concat([buffer, value]);

  return readBytes(reader, newBuffer, length);
};

async function* getReader(s: Readable): AsyncGenerator<Buffer> {
  for await (const chunk of s) {
    yield chunk;
  }
}
