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
import { Readable } from 'node:stream';
import rangeParser from 'range-parser';
import { Logger } from 'winston';
import { headerNames } from '../../constants.js';

import { MANIFEST_CONTENT_TYPE } from '../../lib/encoding.js';
import {
  DataBlockListValidator,
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

const handleIfNoneMatch = (req: Request, res: Response): boolean => {
  const ifNoneMatch = req.get('if-none-match');
  const etag = res.getHeader('etag');

  if (ifNoneMatch !== undefined && etag !== undefined && ifNoneMatch === etag) {
    res.status(304);
    return true;
  }
  return false;
};

const setDigestStableVerifiedHeaders = ({
  req,
  res,
  dataAttributes,
  data,
}: {
  req: Request;
  res: Response;
  dataAttributes: ContiguousDataAttributes | undefined;
  data: ContiguousData;
}) => {
  if (dataAttributes !== undefined) {
    res.setHeader(headerNames.stable, dataAttributes.stable ? 'true' : 'false');
    res.setHeader(
      headerNames.verified,
      // NOTE: even if the DB indicates the data is verified, we can't be sure
      // we're streaming the right data unless it comes from our local cache
      dataAttributes.verified && data.cached ? 'true' : 'false',
    );

    // We only add digest and ETag headers when the data is either a HEAD
    // request or cached locally. If the data is not cached, we might stream
    // from the network and end up with a different hash than what is currently
    // stored in the DB.
    if (
      dataAttributes.hash !== undefined &&
      (data.cached || req.method === REQUEST_METHOD_HEAD)
    ) {
      res.setHeader(headerNames.digest, dataAttributes.hash);
      res.setHeader('ETag', `"${dataAttributes.hash}"`);
    }
  }

  // Set trusted header based on data source
  res.setHeader(headerNames.trusted, data.trusted ? 'true' : 'false');
};

const setDataHeaders = ({
  req,
  res,
  dataAttributes,
  data,
  id,
}: {
  req: Request;
  res: Response;
  dataAttributes: ContiguousDataAttributes | undefined;
  data: ContiguousData;
  id: string;
}) => {
  // TODO: cached header for zero length data (maybe...)

  // Set the data ID header to indicate which data ID is being served
  res.header(headerNames.dataId, id);

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
  res.header(headerNames.cache, data.cached ? 'HIT' : 'MISS');

  // Indicate the number of hops the request has made and origin
  if (data.requestAttributes !== undefined) {
    res.header(headerNames.hops, data.requestAttributes.hops.toString());
    if (data.requestAttributes.origin !== undefined) {
      res.header(headerNames.origin, data.requestAttributes.origin);
    }
    if (data.requestAttributes.originNodeRelease !== undefined) {
      res.header(
        headerNames.originNodeRelease,
        data.requestAttributes.originNodeRelease,
      );
    }
  }

  // Use the content type from the L1 or data item index if available
  res.contentType(
    dataAttributes?.contentType ??
      data.sourceContentType ??
      DEFAULT_CONTENT_TYPE,
  );

  if (dataAttributes?.contentEncoding != null) {
    res.header('Content-Encoding', dataAttributes.contentEncoding);
  }

  if (dataAttributes?.rootTransactionId != null) {
    res.header(headerNames.rootTransactionId, dataAttributes.rootTransactionId);
  }

  if (dataAttributes?.rootParentOffset != null) {
    res.header(
      headerNames.dataItemRootParentOffset,
      dataAttributes.rootParentOffset.toString(),
    );

    if (dataAttributes.offset != null) {
      res.header(headerNames.dataItemOffset, dataAttributes.offset.toString());
    }

    if (dataAttributes.itemSize != null) {
      res.header(headerNames.dataItemSize, dataAttributes.itemSize.toString());
    }

    if (dataAttributes.dataOffset != null) {
      res.header(
        headerNames.dataItemDataOffset,
        dataAttributes.dataOffset.toString(),
      );
    }
  }

  setDigestStableVerifiedHeaders({ req, res, dataAttributes, data });
};

const getRequestAttributes = (
  req: Request,
  res: Response,
): RequestAttributes => {
  const hopsHeader = req.headers[headerNames.hops.toLowerCase()] as string;
  const hops = parseInt(hopsHeader) || 0;
  return {
    hops,
    arnsName: res.get(headerNames.arnsName?.toLowerCase()),
    arnsBasename: res.get(headerNames.arnsBasename?.toLowerCase()),
    arnsRecord: res.get(headerNames.arnsRecord?.toLowerCase()),
    origin: req.headers[headerNames.origin.toLowerCase()] as string | undefined,
    originNodeRelease: req.headers[
      headerNames.originNodeRelease.toLowerCase()
    ] as string | undefined,
  };
};

interface HandleRangeRequestArgs {
  log: Logger;
  dataSource: ContiguousDataSource;
  rangeHeader: string;
  res: Response;
  req: Request;
  data: ContiguousData;
  id: string;
  dataAttributes: ContiguousDataAttributes | undefined;
  requestAttributes: RequestAttributes;
}

const handleRangeRequest = async ({
  log,
  dataSource,
  rangeHeader,
  res,
  req,
  data,
  id,
  dataAttributes,
  requestAttributes,
}: HandleRangeRequestArgs) => {
  const ranges = rangeParser(data.size, rangeHeader);

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
  const contentType =
    dataAttributes?.contentType ??
    data.sourceContentType ??
    'application/octet-stream';

  setDigestStableVerifiedHeaders({ req, res, dataAttributes, data });

  // FIXME: calculate Content-Length appropriately

  if (isSingleRange) {
    const totalSize = data.size;
    const start = ranges[0].start;
    const end = ranges[0].end;

    res.status(206); // Partial Content
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.contentType(contentType);

    // Handle If-None-Match for both HEAD and GET requests
    if (handleIfNoneMatch(req, res)) {
      res.end();
      return;
    }

    if (req.method === REQUEST_METHOD_HEAD) {
      res.end();
      return;
    }

    const rangeData = await dataSource.getData({
      id,
      dataAttributes,
      requestAttributes,
      region: {
        offset: start,
        size: end - start + 1,
      },
    });

    rangeData.stream.pipe(res);
  } else {
    const generateBoundary = () => {
      // This generates a 50 character boundary similar to those used by Firefox.
      // They are optimized for boyer-moore parsing.
      // https://github.com/rexxars/byte-range-stream/blob/98a8e06e46193afc45219b63bc2dc5d9c7f77459/src/index.js#L115-L124
      let boundary = '--------------------------';
      for (let i = 0; i < 24; i++) {
        boundary += Math.floor(Math.random() * 10).toString(16);
      }

      return boundary;
    };
    const boundary = generateBoundary();
    res.status(206); // Partial Content
    res.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);
    res.setHeader('Accept-Ranges', 'bytes');

    // Handle If-None-Match for both HEAD and GET requests
    if (handleIfNoneMatch(req, res)) {
      res.end();
      return;
    }

    if (req.method === REQUEST_METHOD_HEAD) {
      res.end();
      return;
    }

    const rangeStreams: { range: rangeParser.Range; stream: Readable }[] = [];

    for (const range of ranges) {
      const start = range.start;
      const end = range.end;

      const rangeData = await dataSource.getData({
        id,
        dataAttributes,
        requestAttributes,
        region: {
          offset: start,
          size: end - start + 1,
        },
      });

      rangeStreams.push({ range, stream: rangeData.stream });
    }

    for (const { range, stream } of rangeStreams) {
      res.write(`--${boundary}\r\n`);
      res.write(`Content-Type: ${contentType}\r\n`);
      res.write(
        `Content-Range: bytes ${range.start}-${range.end}/${data.size}\r\n`,
      );
      res.write('\r\n');

      for await (const chunk of stream) {
        res.write(chunk);
      }

      res.write('\r\n');
    }
    res.write(`--${boundary}--\r\n`);
    res.end();
  }
};

export const sendNotFound = (res: Response) => {
  res.header(
    'Cache-Control',
    `public, max-age=${NOT_FOUND_MAX_AGE}, immutable`,
  );
  res.status(404).send('Not found');
};

export const sendPaymentRequired = (
  res: Response,
  text = 'Payment required',
) => {
  res.status(402).send(text);
};

// Data routes
export const createRawDataHandler = ({
  log,
  dataIndex,
  dataSource,
  dataBlockListValidator,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  dataBlockListValidator: DataBlockListValidator;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    const id = req.params[0];

    // Return 404 if the data is blocked by ID
    try {
      if (await dataBlockListValidator.isIdBlocked(id)) {
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
      if (await dataBlockListValidator.isHashBlocked(dataAttributes?.hash)) {
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
        // Range requests create new streams so the original is no longer
        // needed
        data.stream.destroy();
        setDataHeaders({ req, res, dataAttributes, data, id });

        await handleRangeRequest({
          log,
          dataSource,
          rangeHeader,
          res,
          req,
          data,
          id,
          dataAttributes,
          requestAttributes,
        });
      } else {
        // Set headers and stream data
        setDataHeaders({ req, res, dataAttributes, data, id });
        res.header('Content-Length', data.size.toString());

        // Handle If-None-Match for both HEAD and GET requests
        if (handleIfNoneMatch(req, res)) {
          res.end();
          data.stream.destroy();
          return;
        }

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
      const queryString =
        new URL(req.url, `http://${req.headers.host}`).search ?? '';

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
        // Range requests create new streams so the original is no longer
        // needed
        data.stream.destroy();

        setDataHeaders({
          req,
          res,
          dataAttributes,
          data,
          id: resolvedId,
        });
        await handleRangeRequest({
          log,
          dataSource,
          rangeHeader,
          res,
          req,
          data,
          id: resolvedId,
          dataAttributes,
          requestAttributes,
        });
      } else {
        // Set headers and stream data
        setDataHeaders({
          req,
          res,
          dataAttributes,
          data,
          id: resolvedId,
        });
        res.header('Content-Length', data.size.toString());

        // Handle If-None-Match for both HEAD and GET requests
        if (handleIfNoneMatch(req, res)) {
          res.end();
          data.stream.destroy();
          return true;
        }

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
  dataBlockListValidator,
  manifestPathResolver,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  dataBlockListValidator: DataBlockListValidator;
  manifestPathResolver: ManifestPathResolver;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    const arnsResolvedId = res.getHeader(headerNames.arnsResolvedId);
    let id: string | undefined;
    let manifestPath: string | undefined;
    // TODO: add comment explaining this
    if (typeof arnsResolvedId === 'string') {
      id = arnsResolvedId;
      manifestPath = req.path.slice(1);
    } else {
      // Handle both named parameters (:id) and positional parameters ([0], [1])
      id = req.params.id ?? req.params[0] ?? req.params[1];
      manifestPath = req.params['*'] ?? req.params[2];
    }

    // Return 404 if the data is blocked by ID
    try {
      if (await dataBlockListValidator.isIdBlocked(id)) {
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
        if (await dataBlockListValidator.isHashBlocked(dataAttributes?.hash)) {
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
        // Range requests create new streams so the original is no longer
        // needed
        data.stream.destroy();

        setDataHeaders({
          req,
          res,
          dataAttributes,
          data,
          id,
        });

        await handleRangeRequest({
          log,
          dataSource,
          rangeHeader,
          res,
          req,
          data,
          id,
          dataAttributes,
          requestAttributes,
        });
      } else {
        // Set headers and stream data
        setDataHeaders({
          req,
          res,
          dataAttributes,
          data,
          id,
        });
        res.header('Content-Length', data.size.toString());

        // Handle If-None-Match for both HEAD and GET requests
        if (handleIfNoneMatch(req, res)) {
          res.end();
          data.stream.destroy();
          return;
        }

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
