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
import { Router } from 'express';
import { CID } from 'multiformats/cid';
import { ContiguousDataAttributes } from '../types';
import { contiguousDataIndex, heliaFs, helia } from '../system.js';

import { car } from '@helia/car';
import mime from 'mime';

export const ipfsRouter = Router();

// Fetch IPFS data via CID
ipfsRouter.get('/ipfs/:cid', async (req, res) => {
  try {
    const { cid } = req.params;
    let cidObject: CID;

    try {
      cidObject = CID.parse(cid);
      // Convert Base58 CID to Base32 if needed
      if (cidObject.version === 0 || cid.startsWith('Qm')) {
        cidObject = cidObject.toV1();
        console.log(`Converted Base58 CID to Base32: ${cidObject.toString()}`);
      }
    } catch (error) {
      console.error(`Invalid CID: ${cid}`);
      res.status(400).send(`Invalid CID: ${cid}`);
      return;
    }

    const txId = await contiguousDataIndex.getCidTxId(cidObject.toString());

    // Retrieve data attributes and set the response header
    let dataAttributes: ContiguousDataAttributes | undefined;
    if (txId !== undefined) {
      res.setHeader('X-Arweave-Id', txId);
      dataAttributes = await contiguousDataIndex.getDataAttributes(txId);
    }

    const contentType =
      dataAttributes?.contentType ?? 'application/octet-stream';
    const fileExtension = mime.extension(contentType);

    let filename = cid;
    if (typeof fileExtension === 'string' && fileExtension !== '') {
      filename += `.${fileExtension}`;
    } else if (contentType === 'application/vnd.ipld.car') {
      filename += `.car`;
    }

    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
    res.header('etag', `"${cidObject.toString()}"`);
    res.header('Cache-Control', 'public, max-age=29030400, immutable');

    if (contentType === 'application/vnd.ipld.car') {
      return await streamCarFile(helia, cidObject, res);
    }

    const { fileSize } = await heliaFs.stat(cidObject);

    const rangeHeader = req.headers.range;
    if (rangeHeader !== undefined) {
      return await handleRangeRequest(
        heliaFs,
        cidObject,
        rangeHeader,
        fileSize,
        res,
      );
    }

    // Stream the entire file
    const fileStream = heliaFs.cat(cidObject);
    res.header('Content-Length', fileSize.toString());

    for await (const chunk of fileStream) {
      res.write(chunk);
    }

    res.end();
    console.log(`Finished writing data for CID: ${cidObject.toString()}`);
  } catch (error) {
    console.error(`Error retrieving IPFS data: ${(error as Error).message}`);
    res
      .status(500)
      .send(`Error retrieving IPFS data: ${(error as Error).message}`);
  }
});

async function handleRangeRequest(
  heliaFs: any,
  cidObject: CID,
  rangeHeader: string,
  fileSize: bigint,
  res: any,
) {
  const ranges = rangeHeader.match(/bytes=(\d*)-(\d*)/);

  if (!ranges) {
    res.status(416).send('Invalid range header');
    return;
  }

  const start = ranges[1] ? BigInt(parseInt(ranges[1], 10)) : 0n;
  const end = ranges[2] ? BigInt(parseInt(ranges[2], 10)) : fileSize - 1n;

  if (start >= fileSize || end >= fileSize) {
    res.status(416).header('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  res.status(206).header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.header('Accept-Ranges', 'bytes');
  res.header('Content-Length', (end - start + 1n).toString());

  const fileStream = heliaFs.cat(cidObject, {
    offset: Number(start),
    length: Number(end - start + 1n),
  });

  for await (const chunk of fileStream) {
    res.write(chunk);
  }

  res.end();
}

async function streamCarFile(helia: any, cidObject: CID, res: any) {
  try {
    const c = car(helia);
    const carStream = c.stream(cidObject);

    for await (const chunk of carStream) {
      res.write(chunk);
    }

    res.end();
    console.log(`Finished writing CAR data for CID: ${cidObject.toString()}`);
  } catch (error) {
    console.error(
      `Error streaming CAR file from IPFS: ${(error as Error).message}`,
    );
    res
      .status(500)
      .send(`Error streaming CAR file from IPFS: ${(error as Error).message}`);
  }
}

export default ipfsRouter;
