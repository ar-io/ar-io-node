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
import { Transform } from 'node:stream';
import url from 'node:url';
import rangeParser from 'range-parser';
import { Logger } from 'winston';
import { headerNames } from '../../constants.js';

import { MANIFEST_CONTENT_TYPE } from '../../lib/encoding.js';
import {
  BlockListValidator,
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataSource,
  ManifestPathResolver,
  RequestAttributes,
} from '../../types.js';

const STABLE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const UNSTABLE_MAX_AGE = 60 * 60 * 2; // 2 hours
const NOT_FOUND_MAX_AGE = 60; // 1 minute

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const REQUEST_METHOD_HEAD = 'HEAD';

const setDataHeaders = ({
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

  // Allow range requests
  res.header('Accept-Ranges', 'bytes');

  // Only set Cache-Control header if it's not already set (e.g., for on ArNS
  // TTLs)
  if (!res.hasHeader('Cache-Control')) {
    // Aggressively cache data before max fork depth
    if (dataAttributes?.stable) {
      res.header(
        'Cache-Control',
        `public, max-age=${STABLE_MAX_AGE}, immutable`,
      );
    } else {
      res.header('Cache-Control', `public, max-age=${UNSTABLE_MAX_AGE}`);
    }
  }

  // Indicate whether the data was served from cache
  res.header(headerNames.cached, data.cached ? 'HIT' : 'MISS');

  // Indicate the number of hops the request has made and origin
  if (data.requestAttributes !== undefined) {
    res.header(headerNames.hops, data.requestAttributes.hops.toString());
    if (data.requestAttributes.origin !== undefined) {
      res.header(headerNames.origin, data.requestAttributes.origin);
    }
  }

  // Use the content type from the L1 or data item index if available
  res.contentType(
    dataAttributes?.contentType ??
      data.sourceContentType ??
      DEFAULT_CONTENT_TYPE,
  );
};

const getRequestAttributes = (
  req: Request,
  arnsRootHost?: string,
): RequestAttributes => {
  let origin: string | undefined;
  const originHeader = req.headers[headerNames.origin.toLowerCase()] as string;
  const hopsHeader = req.headers[headerNames.hops.toLowerCase()] as string;
  if (originHeader !== undefined) {
    origin = originHeader;
  } else if (arnsRootHost !== undefined) {
    origin = arnsRootHost;
  }
  const hops = parseInt(hopsHeader) || 0;
  return { origin, hops };
};

const handleRangeRequest = (
  log: Logger,
  rangeHeader: string,
  res: Response,
  req: Request,
  data: ContiguousData,
  dataAttributes: ContiguousDataAttributes | undefined,
) => {
  const ranges = rangeParser(data.size, rangeHeader, {
    combine: true,
  });

  // Malformed range header
  if (ranges === -2) {
    log.warn(`Malformed 'range' header`);
    res.status(400).type('text').send(`Malformed 'range' header`);
    return;
  }

  // Unsatisfiable range
  if (ranges === -1 || ranges.type !== 'bytes') {
    log.warn('Range not satisfiable');
    res
      .status(416)
      .set('Content-Range', `bytes */${data.size}`)
      .type('text')
      .send('Range not satisfiable');
    return;
  }

  const isSingleRange = ranges.length === 1;
  if (isSingleRange) {
    const totalSize = data.size;
    const start = ranges[0].start;
    const end = ranges[0].end;

    res.status(206); // Partial Content
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Accept-Ranges', 'bytes');

    res.contentType(
      dataAttributes?.contentType ??
        data.sourceContentType ??
        DEFAULT_CONTENT_TYPE,
    );

    if (req.method === REQUEST_METHOD_HEAD) {
      res.end();
      data.stream.destroy();
      return;
    }

    // Create a custom Transform stream to filter the range
    let position = 0;
    const rangeStream = new Transform({
      transform(chunk, _, callback) {
        // Calculate the byte range for this chunk relative to the global start
        // position
        const chunkStart = position;
        const chunkEnd = chunkStart + chunk.length - 1;

        // Determine the intersection between the global range and the chunk's
        // range
        const intersectionStart = Math.max(start, chunkStart);
        const intersectionEnd = Math.min(end, chunkEnd);

        if (intersectionStart <= intersectionEnd) {
          // There is an intersection, so slice and push the relevant part of
          // the chunk
          const slicedData = chunk.slice(
            intersectionStart - chunkStart,
            intersectionEnd - chunkStart + 1,
          );
          this.push(slicedData);
        }

        position += chunk.length;
        callback();
      },
    });

    data.stream.pipe(rangeStream).pipe(res);
  } else {
    log.warn('Multiple ranges are not yet supported');
    res.status(416).type('text').send('Multiple ranges are not yet supported');
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
};

export const sendNotFound = (res: Response) => {
  res.header(
    'Cache-Control',
    `public, max-age=${NOT_FOUND_MAX_AGE}, immutable`,
  );
  res.status(404).send('Not found');
};

// Data routes
export const createRawDataHandler = ({
  log,
  dataIndex,
  dataSource,
  blockListValidator,
  arnsRootHost,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  blockListValidator: BlockListValidator;
  arnsRootHost?: string;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, arnsRootHost);
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
      data = await dataSource.getData({
        id,
        dataAttributes,
        requestAttributes,
      });
      // Check if the request includes a Range header
      const rangeHeader = req.headers.range;
      if (rangeHeader !== undefined) {
        setRawDataHeaders(res);
        handleRangeRequest(log, rangeHeader, res, req, data, dataAttributes);
      } else {
        // Set headers and stream data
        setDataHeaders({ res, dataAttributes, data });
        setRawDataHeaders(res);
        res.header('Content-Length', data.size.toString());

        if (req.method === REQUEST_METHOD_HEAD) {
          res.end();
          data.stream.destroy();
          return;
        }

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
  requestAttributes,
}: {
  log: Logger;
  req: Request;
  res: Response;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  id: string;
  resolvedId: string | undefined;
  complete: boolean;
  requestAttributes: RequestAttributes;
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
      data = await dataSource.getData({
        id: resolvedId,
        dataAttributes,
        requestAttributes,
      });
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
      if (rangeHeader !== undefined) {
        setDataHeaders({
          res,
          dataAttributes,
          data,
        });
        handleRangeRequest(log, rangeHeader, res, req, data, dataAttributes);
      } else {
        // Set headers and stream data
        setDataHeaders({
          res,
          dataAttributes,
          data,
        });
        res.header('Content-Length', data.size.toString());

        if (req.method === REQUEST_METHOD_HEAD) {
          res.end();
          data.stream.destroy();
          return true;
        }

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

export const createDataHandler = ({
  log,
  dataIndex,
  dataSource,
  blockListValidator,
  manifestPathResolver,
  arnsRootHost,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  blockListValidator: BlockListValidator;
  manifestPathResolver: ManifestPathResolver;
  arnsRootHost?: string;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, arnsRootHost);
    const arnsResolvedId = res.getHeader(headerNames.arnsResolvedId);
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
            requestAttributes,
            ...manifestResolution,
          })
        ) {
          // Manifest response successfully sent
          return;
        }
      }

      // Attempt to retrieve data
      try {
        data = await dataSource.getData({
          id,
          dataAttributes,
          requestAttributes,
        });
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
            requestAttributes,
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
      if (rangeHeader !== undefined && data !== undefined) {
        handleRangeRequest(log, rangeHeader, res, req, data, dataAttributes);
      } else {
        // Set headers and stream data
        setDataHeaders({
          res,
          dataAttributes,
          data,
        });
        res.header('Content-Length', data.size.toString());

        if (req.method === REQUEST_METHOD_HEAD) {
          res.end();
          data.stream.destroy();
          return;
        }

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
