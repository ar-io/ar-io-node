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
import { unixfs } from '@helia/unixfs';
import { createHelia } from 'helia';

export const ipfsRouter = Router();

// Initialize Helia and UnixFS
const helia = await createHelia({
  // ... helia config
});
const heliaFs = unixfs(helia);

// Fetch IPFS data via CID
ipfsRouter.get('/ipfs/:cid', async (req, res) => {
  try {
    const { cid } = req.params;
    console.log(`Received request for CID: ${cid}`);

    const cidObject = CID.parse(cid);
    console.log(`Parsed CID: ${cidObject.toString()}`);

    // Retrieve data from IPFS as an async iterable
    const fileStream = heliaFs.cat(cidObject);
    console.log(`Fetching data for CID: ${cidObject.toString()}`);

    // Set the content type (optional, depending on what you're serving)
    res.setHeader('Content-Type', 'application/octet-stream');

    for await (const chunk of fileStream) {
      console.log(`Writing chunk of data for CID: ${cidObject.toString()}`);
      res.write(chunk);
    }

    console.log(`Finished writing data for CID: ${cidObject.toString()}`);
    res.end();
  } catch (error) {
    console.error(`Error retrieving IPFS data: ${(error as Error).message}`);
    res
      .status(500)
      .send(`Error retrieving IPFS data: ${(error as Error).message}`);
  }
});

export default ipfsRouter;
