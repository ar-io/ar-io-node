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
import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import url from 'node:url';
import { Logger } from 'winston';
import { Transform } from 'stream';

import { MANIFEST_CONTENT_TYPE } from '../lib/encoding.js';
import {
  BlockListValidator,
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataSource,
  ManifestPathResolver,
} from '../types.js';

const parseRange = require('range-parser');
const STABLE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const UNSTABLE_MAX_AGE = 60 * 60 * 2; // 2 hours
const NOT_FOUND_MAX_AGE = 60; // 1 minute

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const setCommonDataHeaders = ({
  res,
  dataAttributes,
  data,
}: {
  res: Response;
  dataAttributes: ContiguousDataAttributes | undefined;
  data: ContiguousData;
}) => {
  // TODO add etag
  // TODO add header indicating stability
  // TODO add header indicating whether data is verified
  // TODO cached header for zero length data (maybe...)

  if (dataAttributes?.stable) {
    res.header('Cache-Control', `public, max-age=${STABLE_MAX_AGE}, immutable`);
  } else {
    res.header('Cache-Control', `public, max-age=${UNSTABLE_MAX_AGE}`);
  }

  res.contentType(
    dataAttributes?.contentType ??
      data.sourceContentType ??
      DEFAULT_CONTENT_TYPE,
  );
};

const handleRangedataResponse = (log: Logger, rangeHeader: string, res: Response, data: ContiguousData ) => {
  const totalSize = data.size;
  const subranges = parseRange(totalSize, rangeHeader, { combine: true });
  log.warn('subranges', {'subranges': subranges})

  if (subranges.type === 'bytes') {
    res.status(206); // Partial Content
    res.setHeader("Content-Range", `${rangeHeader}/${totalSize}`);
    res.setHeader("Accept-Ranges", "bytes");

    // Create a custom Transform stream to filter the range
    const rangeStream = new Transform({
      transform(chunk, _, callback) {
        // Calculate the byte range for this chunk relative to the global start position
        const chunkStart = (this as any).position;
        const chunkEnd = chunkStart + chunk.length - 1;

        while ((this as any).subranges.length > 0) {
          let r = (this as any).subranges.shift();

          // Determine the intersection between the global range and the chunk's range
          const intersectionStart = Math.max(r.start, chunkStart);
          const intersectionEnd = Math.min(r.end, chunkEnd);

          if (intersectionStart <= intersectionEnd) {
            // There is an intersection, so slice and push the relevant part of the chunk
            const slicedData = chunk.slice(intersectionStart - chunkStart, intersectionEnd - chunkStart + 1);
            this.push(slicedData);
          }

          if (chunkEnd <= r.end) {
            break;
          }
        }

        (this as any).position += chunk.length;
        callback();
      },
    });
    (rangeStream as any).position = 0;
    (rangeStream as any).subranges = subranges;

    rangeStream.on("close", () => {
      log.info('Stream is closed', {});
    });

    data.stream.pipe(rangeStream).pipe(res);
  } else {
    res.status(416).end();
  }
};

const setRawDataHeaders = (res: Response) => {
  // Unset CORS headers
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Methods');
  res.removeHeader('Access-Control-Allow-Headers');

  // TODO restict this to non-ArNS, non-manifest domains (requires knowledge of
  // primary domain)
  res.header(
    'Content-Security-Policy',
    `default-src 'self'; frame-src 'none'; object-src 'none'`,
  );
  res.header('Cross-Origin-Opener-Policy', 'same-origin');
  res.header('Cross-Origin-Embedder-Policy', 'require-corp');
  res.header('Accept-Ranges', 'bytes');
};

export const sendNotFound = (res: Response) => {
  res.header(
    'Cache-Control',
    `public, max-age=${NOT_FOUND_MAX_AGE}, immutable`,
  );
  res.status(404).send('Not found');
};

// Data routes
export const RAW_DATA_PATH_REGEX = /^\/raw\/([a-zA-Z0-9-_]{43})\/?$/i;
export const createRawDataHandler = ({
  log,
  dataIndex,
  dataSource,
  blockListValidator,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  blockListValidator: BlockListValidator;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const id = req.params[0];

    // Return 404 if the data is blocked by ID
    try {
      if (await blockListValidator.isIdBlocked(id)) {
        sendNotFound(res);
        return;
      }
    } catch (error: any) {
      log.error('Error checking blocklist:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      // TODO return 500
    }

    // Retrieve authoritative data attributes if they're available
    let dataAttributes: ContiguousDataAttributes | undefined;
    try {
      dataAttributes = await dataIndex.getDataAttributes(id);
    } catch (error: any) {
      log.error('Error retrieving data attributes:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      sendNotFound(res);
      return;
    }

    // Return 404 if the data is blocked by hash
    try {
      if (await blockListValidator.isHashBlocked(dataAttributes?.hash)) {
        sendNotFound(res);
        return;
      }
    } catch (error: any) {
      log.error('Error checking blocklist:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
    }

    // Set headers and attempt to retrieve and stream data
    let data: ContiguousData | undefined;
    try {
      data = await dataSource.getData(id, dataAttributes);
      // Check if the request includes a Range header
      const rangeHeader = req.headers.range;
      if (rangeHeader && data) {
        setCommonDataHeaders ({ res, dataAttributes, data });
        handleRangedataResponse(log, rangeHeader, res, data);
        setRawDataHeaders(res);
      } else {
        // Set headers and stream data
        setCommonDataHeaders ({ res, dataAttributes, data });
        res.header('Content-Length', data.size.toString());
        setRawDataHeaders(res);
        data.stream.pipe(res);
        
      }      


    } catch (error: any) {
      log.warn('Unable to retrieve contiguous data:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      sendNotFound(res);
      data?.stream.destroy();
      return;
    }
  });
};

const sendManifestResponse = async ({
  log,
  req,
  res,
  dataSource,
  dataIndex,
  id,
  resolvedId,
  complete,
}: {
  log: Logger;
  req: Request;
  res: Response;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  id: string;
  resolvedId: string | undefined;
  complete: boolean;
}): Promise<boolean> => {
  let data: ContiguousData | undefined;
  if (resolvedId !== undefined) {
    // Add a trailing slash if needed
    if (req.path === `/${id}`) {
      // Extract query string using the url module
      const queryString = url.parse(req.url).search ?? '';

      // Add a trailing slash and replace any number of repeated slashes
      res.redirect(301, `/${id}/${queryString}`);
      return true;
    }

    let dataAttributes: ContiguousDataAttributes | undefined;
    try {
      dataAttributes = await dataIndex.getDataAttributes(resolvedId);
    } catch (error: any) {
      log.error('Error retrieving data attributes:', {
        dataId: resolvedId,
        message: error.message,
        stack: error.stack,
      });
      // Indicate response was NOT sent
      return false;
    }

    // Retrieve data based on ID resolved from manifest path or index
    try {
      data = await dataSource.getData(resolvedId, dataAttributes);
    } catch (error: any) {
      log.warn('Unable to retrieve contiguous data:', {
        dataId: resolvedId,
        message: error.message,
        stack: error.stack,
      });
      // Indicate response was NOT sent
      return false;
    }

    // Set headers and stream data
    try {
      // Check if the request includes a Range header
      const rangeHeader = req.headers.range;
      if (rangeHeader && data) {
        setCommonDataHeaders ({ res, dataAttributes, data });
        handleRangedataResponse(log, rangeHeader, res, data);
      } else {
        // Set headers and stream data
        setCommonDataHeaders ({
          res,
          dataAttributes,
          data,
        });
        res.header('Content-Length', data.size.toString());

        data.stream.pipe(res);
      }

    } catch (error: any) {
      log.error('Error retrieving data attributes:', {
        dataId: resolvedId,
        message: error.message,
        stack: error.stack,
      });
      data?.stream.destroy();
      // Indicate response was NOT sent
      return false;
    }

    // Indicate response was sent
    return true;
  }

  // Return 404 for not found index or path (arweave.net gateway behavior)
  if (complete) {
    sendNotFound(res);

    // Indicate response was sent
    return true;
  }

  // Indicate response was NOT sent
  return false;
};

export const DATA_PATH_REGEX =
  /^\/?([a-zA-Z0-9-_]{43})\/?$|^\/?([a-zA-Z0-9-_]{43})\/(.*)$/i;
export const createDataHandler = ({
  log,
  dataIndex,
  dataSource,
  blockListValidator,
  manifestPathResolver,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  blockListValidator: BlockListValidator;
  manifestPathResolver: ManifestPathResolver;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const arnsResolvedId = res.getHeader('X-ArNS-Resolved-Id');
    let id: string | undefined;
    let manifestPath: string | undefined;
    if (typeof arnsResolvedId === 'string') {
      id = arnsResolvedId;
      manifestPath = req.path.slice(1);
    } else {
      id = req.params[0] ?? req.params[1];
      manifestPath = req.params[2];
    }

    // Return 404 if the data is blocked by ID
    try {
      if (await blockListValidator.isIdBlocked(id)) {
        sendNotFound(res);
        return;
      }
    } catch (error: any) {
      log.error('Error checking blocklist:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
    }

    let data: ContiguousData | undefined;
    let dataAttributes: ContiguousDataAttributes | undefined;
    try {
      // Retrieve authoritative data attributes if available
      dataAttributes = await dataIndex.getDataAttributes(id);

      // Return 404 if the data is blocked by hash
      try {
        if (await blockListValidator.isHashBlocked(dataAttributes?.hash)) {
          sendNotFound(res);
          return;
        }
      } catch (error: any) {
        log.error('Error checking blocklist:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
      }

      // Attempt manifest path resolution from the index (without data parsing)
      if (dataAttributes?.isManifest) {
        const manifestResolution = await manifestPathResolver.resolveFromIndex(
          id,
          manifestPath,
        );

        // Send response based on manifest resolution (data ID and
        // completeness)
        if (
          await sendManifestResponse({
            log,
            req,
            res,
            dataIndex,
            dataSource,
            ...manifestResolution,
          })
        ) {
          // Manifest response successfully sent
          return;
        }
      }

      // Attempt to retrieve data
      try {
        data = await dataSource.getData(id, dataAttributes);

      } catch (error: any) {
        log.warn('Unable to retrieve contiguous data:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        sendNotFound(res);
        return;
      }

      // Fall back to on-demand manifest parsing
      if (
        (dataAttributes?.contentType ?? data.sourceContentType) ===
        MANIFEST_CONTENT_TYPE
      ) {
        const manifestResolution = await manifestPathResolver.resolveFromData(
          data,
          id,
          manifestPath,
        );

        // The original stream is no longer needed after path resolution
        data.stream.destroy();

        // Send response based on manifest resolution (data ID and
        // completeness)
        if (
          !(await sendManifestResponse({
            log,
            req,
            res,
            dataIndex,
            dataSource,
            ...manifestResolution,
          }))
        ) {
          // This should be unreachable since resolution from data is always
          // considered complete, but just in case...
          sendNotFound(res);
        }
        return;
      }

      // Check if the request includes a Range header
      const rangeHeader = req.headers.range;
      if (rangeHeader && data) {
        setCommonDataHeaders ({ res, dataAttributes, data });
        handleRangedataResponse(log, rangeHeader, res, data);
      } else {
        // Set headers and stream data
        setCommonDataHeaders ({
          res,
          dataAttributes,
          data,
        });
        res.header('Content-Length', data.size.toString());

        data.stream.pipe(res);
      }


    } catch (error: any) {
      log.error('Error retrieving data:', {
        dataId: id,
        manifestPath,
        message: error.message,
        stack: error.stack,
      });
      sendNotFound(res);
      data?.stream.destroy();
    }
  });
};
