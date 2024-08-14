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
import {
  contiguousDataIndex,
  getTxIdByCid,
  heliaFs,
  helia,
} from '../system.js';
import { car } from '@helia/car';
import mime from 'mime';

export const ipfsRouter = Router();

// Fetch IPFS data via CID
ipfsRouter.get('/ipfs/:cid', async (req, res) => {
  try {
    const { cid } = req.params;
    console.log(`Received request for CID: ${cid}`);

    const cidObject = CID.parse(cid);
    console.log(`Parsed CID: ${cidObject.toString()}`);

    const txId = getTxIdByCid(cidObject.toString());

    // Retrieve authoritative data attributes if they're available
    let dataAttributes: ContiguousDataAttributes | undefined;
    try {
      if (txId !== undefined) {
        dataAttributes = await contiguousDataIndex.getDataAttributes(txId);
      }
    } catch (error: any) {
      console.log('Error retrieving data attributes for CID:', {
        cid: cidObject.toString(),
        dataId: txId,
        message: error.message,
        stack: error.stack,
      });
    }

    // Check if the file is cached and has not been modified
    const etag = `"${cidObject.toString()}"`;
    res.header('etag', etag);
    res.header('Cache-Control', 'public, max-age=29030400, immutable');

    const contentType =
      dataAttributes?.contentType ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    const fileExtension = mime.extension(contentType);

    let filename = cid;
    if (typeof fileExtension === 'string' && fileExtension !== '') {
      filename += `.${fileExtension}`;
    }

    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    // If the content type is CAR, handle it differently
    if (contentType === 'application/vnd.ipld.car') {
      const c = car(helia);

      try {
        const carStream = c.stream(cidObject);

        for await (const chunk of carStream) {
          console.log(`Writing CAR chunk for CID: ${cidObject.toString()}`);
          res.write(chunk);
        }

        console.log(
          `Finished writing CAR data for CID: ${cidObject.toString()}`,
        );
        res.end();
      } catch (error) {
        console.error(
          `Error streaming CAR file from IPFS: ${(error as Error).message}`,
        );
        res
          .status(500)
          .send(
            `Error streaming CAR file from IPFS: ${(error as Error).message}`,
          );
      }
    } else {
      // Retrieve data from IPFS as an async iterable for non-CAR files
      const fileStream = heliaFs.cat(cidObject);
      console.log(`Fetching data for CID: ${cidObject.toString()}`);

      for await (const chunk of fileStream) {
        console.log(`Writing chunk of data for CID: ${cidObject.toString()}`);
        res.write(chunk);
      }

      console.log(`Finished writing data for CID: ${cidObject.toString()}`);
      res.end();
    }
  } catch (error) {
    console.error(`Error retrieving IPFS data: ${(error as Error).message}`);
    res
      .status(500)
      .send(`Error retrieving IPFS data: ${(error as Error).message}`);
  }
});

export default ipfsRouter;
