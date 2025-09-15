/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import { Readable } from 'node:stream';
import rangeParser from 'range-parser';
import { Logger } from 'winston';
import { headerNames } from '../../constants.js';
import * as config from '../../config.js';
import { release } from '../../version.js';
import { tracer } from '../../tracing.js';
import { Span } from '@opentelemetry/api';

import { MANIFEST_CONTENT_TYPE } from '../../lib/encoding.js';
import { formatContentDigest } from '../../lib/digest.js';
import {
  DataBlockListValidator,
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  DataAttributesSource,
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
    // Remove entity headers per RFC 7232 Section 4.1
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Encoding');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Type');
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
      res.setHeader(
        headerNames.contentDigest,
        formatContentDigest(dataAttributes.hash),
      );
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

  // Indicate the number of hops the request has made
  if (data.requestAttributes !== undefined) {
    res.header(headerNames.hops, data.requestAttributes.hops.toString());
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

export const getRequestAttributes = (
  req: Request,
  _res: Response,
  {
    arnsRootHost = config.ARNS_ROOT_HOST,
    nodeRelease = release,
  }: {
    arnsRootHost?: string;
    nodeRelease?: string;
  } = {},
): RequestAttributes => {
  const hopsHeader = req.headers[headerNames.hops.toLowerCase()] as string;
  const hops = parseInt(hopsHeader) || 0;

  // Get origin and originNodeRelease from request headers
  let origin = req.headers[headerNames.origin.toLowerCase()] as
    | string
    | undefined;
  let originNodeRelease = req.headers[
    headerNames.originNodeRelease.toLowerCase()
  ] as string | undefined;

  // Initialize both origin and originNodeRelease only if neither is present and ARNS_ROOT_HOST is configured
  if (origin == null && originNodeRelease == null && arnsRootHost != null) {
    origin = arnsRootHost;
    originNodeRelease = nodeRelease;
  }

  // Extract client IP from request headers (X-Forwarded-For) or connection
  let clientIp: string | undefined;
  const xForwardedFor = req.headers['x-forwarded-for'] as string;
  if (xForwardedFor !== undefined && xForwardedFor !== '') {
    // X-Forwarded-For can contain multiple IPs, take the first one
    clientIp = xForwardedFor.split(',')[0].trim();
  } else if (
    req.socket?.remoteAddress !== undefined &&
    req.socket.remoteAddress !== ''
  ) {
    clientIp = req.socket.remoteAddress;
  }

  return {
    hops,
    origin,
    originNodeRelease,
    arnsName: req.arns?.name,
    arnsBasename: req.arns?.basename,
    arnsRecord: req.arns?.record,
    clientIp,
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
  parentSpan?: Span;
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
  parentSpan,
}: HandleRangeRequestArgs) => {
  const { startChildSpan } = await import('../../tracing.js');
  const span = startChildSpan(
    'handleRangeRequest',
    {
      attributes: {
        'http.range_header': rangeHeader,
        'data.id': id,
        'data.size': data.size,
      },
    },
    parentSpan,
  );

  try {
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
      res.setHeader('Content-Length', (end - start + 1).toString());

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
        requestAttributes,
        region: {
          offset: start,
          size: end - start + 1,
        },
        parentSpan: span,
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
      res.setHeader(
        'Content-Type',
        `multipart/byteranges; boundary=${boundary}`,
      );
      res.setHeader('Accept-Ranges', 'bytes');

      // Pre-build all multipart response parts
      const partBoundary = `--${boundary}\r\n`;
      const finalBoundary = `--${boundary}--\r\n`;
      const contentTypeHeader = `Content-Type: ${contentType}\r\n`;
      const blankLine = '\r\n';

      type ResponsePart = string | { type: 'data'; range: rangeParser.Range };
      const responseParts: ResponsePart[] = [];

      for (const range of ranges) {
        responseParts.push(partBoundary);
        responseParts.push(contentTypeHeader);
        responseParts.push(
          `Content-Range: bytes ${range.start}-${range.end}/${data.size}\r\n`,
        );
        responseParts.push(blankLine);
        responseParts.push({ type: 'data', range });
        responseParts.push(blankLine);
      }
      responseParts.push(finalBoundary);

      // Calculate Content-Length from pre-built parts
      let totalLength = 0;
      for (const part of responseParts) {
        if (typeof part === 'string') {
          totalLength += Buffer.byteLength(part);
        } else if (part.type === 'data') {
          totalLength += part.range.end - part.range.start + 1;
        }
      }

      res.setHeader('Content-Length', totalLength.toString());

      // Handle If-None-Match for both HEAD and GET requests
      if (handleIfNoneMatch(req, res)) {
        res.end();
        return;
      }

      if (req.method === REQUEST_METHOD_HEAD) {
        res.end();
        return;
      }

      // Get data streams for all ranges
      const rangeStreams: { range: rangeParser.Range; stream: Readable }[] = [];

      for (const range of ranges) {
        const start = range.start;
        const end = range.end;

        const rangeData = await dataSource.getData({
          id,
          requestAttributes,
          region: {
            offset: start,
            size: end - start + 1,
          },
          parentSpan: span,
        });

        rangeStreams.push({ range, stream: rangeData.stream });
      }

      // Write response using pre-built parts
      let rangeIndex = 0;
      for (const part of responseParts) {
        if (typeof part === 'string') {
          res.write(part);
        } else if (part.type === 'data') {
          const { stream } = rangeStreams[rangeIndex];
          for await (const chunk of stream) {
            res.write(chunk);
          }
          rangeIndex++;
        }
      }
      res.end();
    }
  } catch (error: any) {
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
};

export const sendInvalidId = (res: Response, id: string) => {
  res.status(400).send(`Invalid ID: ${id}`);
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
  dataAttributesSource,
  dataSource,
  dataBlockListValidator,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataAttributesSource: DataAttributesSource;
  dataBlockListValidator: DataBlockListValidator;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    const id = req.params[0];

    const span = tracer.startSpan('RawDataHandler.handle', {
      attributes: {
        'http.method': req.method,
        'http.target': req.originalUrl,
        'data.request.id': id,
        'arns.name': requestAttributes?.arnsName,
        'arns.basename': requestAttributes?.arnsBasename,
      },
    });

    try {
      // Ensure this is a valid id
      if (
        id != null &&
        id?.match(/^[a-zA-Z0-9-_]{43}$/) &&
        Buffer.from(id, 'base64url').toString('base64url') !== id
      ) {
        span.setAttribute('http.status_code', 400);
        span.setAttribute('data.error', 'invalid_id');
        log.warn('Invalid ID', { id });
        sendInvalidId(res, id);
        return;
      }

      // Return 404 if the data is blocked by ID
      span.addEvent('Checking blocklist for ID');
      try {
        if (await dataBlockListValidator.isIdBlocked(id)) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('data.error', 'id_blocked');
          sendNotFound(res);
          return;
        }
      } catch (error: any) {
        span.recordException(error);
        log.error('Error checking blocklist:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        // TODO return 500
      }

      // Retrieve authoritative data attributes if they're available
      let dataAttributes: ContiguousDataAttributes | undefined;
      span.addEvent('Retrieving data attributes');
      const attributesStartTime = Date.now();
      try {
        dataAttributes = await dataAttributesSource.getDataAttributes(id);
        const attributesDuration = Date.now() - attributesStartTime;
        span.setAttribute(
          'data.attributes_retrieval_duration_ms',
          attributesDuration,
        );
        if (dataAttributes) {
          span.setAttributes({
            'data.size': dataAttributes.size,
            'data.hash': dataAttributes.hash,
            'data.stable': dataAttributes.stable,
            'data.verified': dataAttributes.verified,
            'data.content_type': dataAttributes.contentType,
          });
        }
      } catch (error: any) {
        const attributesDuration = Date.now() - attributesStartTime;
        span.setAttribute(
          'data.attributes_retrieval_duration_ms',
          attributesDuration,
        );
        span.recordException(error);
        log.error('Error retrieving data attributes:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        span.setAttribute('http.status_code', 404);
        sendNotFound(res);
        return;
      }

      // Return 404 if the data is blocked by hash
      if (dataAttributes?.hash !== undefined) {
        span.addEvent('Checking blocklist for hash');
        try {
          if (await dataBlockListValidator.isHashBlocked(dataAttributes.hash)) {
            span.setAttribute('http.status_code', 404);
            span.setAttribute('data.error', 'hash_blocked');
            sendNotFound(res);
            return;
          }
        } catch (error: any) {
          span.recordException(error);
          log.error('Error checking blocklist:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
        }
      }

      // Set headers and attempt to retrieve and stream data
      let data: ContiguousData | undefined;
      span.addEvent('Starting data retrieval');
      const dataStartTime = Date.now();
      try {
        data = await dataSource.getData({
          id,
          requestAttributes,
          parentSpan: span,
        });
        const dataDuration = Date.now() - dataStartTime;
        span.setAttributes({
          'data.retrieval.duration_ms': dataDuration,
          'data.cached': data.cached,
          'data.trusted': data.trusted,
          'cache.status': data.cached ? 'HIT' : 'MISS',
        });
        span.addEvent('Data retrieval successful');

        // Check if the request includes a Range header
        const rangeHeader = req.headers.range;
        if (rangeHeader !== undefined) {
          span.addEvent('Handling range request');
          span.setAttribute('data.request.range_request', true);
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
          span.setAttribute('http.status_code', res.statusCode);
        } else {
          // Set headers and stream data
          setDataHeaders({ req, res, dataAttributes, data, id });
          res.header('Content-Length', data.size.toString());

          // Handle If-None-Match for both HEAD and GET requests
          if (handleIfNoneMatch(req, res)) {
            span.setAttribute('http.status_code', 304);
            span.addEvent('Not modified - ETag match');
            res.end();
            data.stream.destroy();
            return;
          }

          if (req.method === REQUEST_METHOD_HEAD) {
            span.setAttribute('http.status_code', res.statusCode || 200);
            span.addEvent('HEAD request - headers only');
            res.end();
            data.stream.destroy();
            return;
          }

          span.setAttribute('http.status_code', res.statusCode || 200);
          span.addEvent('Streaming data to client');
          data.stream.pipe(res);
        }
      } catch (error: any) {
        const dataDuration = Date.now() - dataStartTime;
        span.setAttributes({
          'data.retrieval.duration_ms': dataDuration,
          'http.status_code': 404,
          'data.retrieval.error': 'retrieval_failed',
        });
        span.recordException(error);
        log.warn('Unable to retrieve contiguous data:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        sendNotFound(res);
        data?.stream.destroy();
        return;
      }
    } catch (error: any) {
      span.recordException(error);
      span.setAttribute('http.status_code', 500);
      log.error('Unexpected error in raw data handler:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      res.status(500).send('Internal server error');
    } finally {
      span.end();
    }
  });
};

const sendManifestResponse = async ({
  log,
  req,
  res,
  dataSource,
  dataAttributesSource,
  id,
  resolvedId,
  complete,
  requestAttributes,
  parentSpan,
}: {
  log: Logger;
  req: Request;
  res: Response;
  dataSource: ContiguousDataSource;
  dataAttributesSource: DataAttributesSource;
  id: string;
  resolvedId: string | undefined;
  complete: boolean;
  requestAttributes: RequestAttributes;
  parentSpan?: Span;
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
      dataAttributes = await dataAttributesSource.getDataAttributes(resolvedId);
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
        requestAttributes,
        parentSpan,
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
          parentSpan,
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
  dataAttributesSource,
  dataSource,
  dataBlockListValidator,
  manifestPathResolver,
}: {
  log: Logger;
  dataSource: ContiguousDataSource;
  dataAttributesSource: DataAttributesSource;
  dataBlockListValidator: DataBlockListValidator;
  manifestPathResolver: ManifestPathResolver;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const requestAttributes = getRequestAttributes(req, res);
    // Use dataId from request context (set by ArNS middleware) or from route params
    const id = req.dataId ?? req.params.id ?? req.params[0] ?? req.params[1];
    const manifestPath = req.manifestPath ?? req.params['*'] ?? req.params[2];

    const span = tracer.startSpan('DataHandler.handle', {
      attributes: {
        'http.method': req.method,
        'http.target': req.originalUrl,
        'data.request.id': id,
        'data.request.manifest_path': manifestPath,
        'arns.name': requestAttributes?.arnsName,
        'arns.basename': requestAttributes?.arnsBasename,
      },
    });

    let data: ContiguousData | undefined;

    try {
      // TODO: remove regex match if possible
      // Ensure this is a valid id
      if (
        id != null &&
        id?.match(/^[a-zA-Z0-9-_]{43}$/) &&
        Buffer.from(id, 'base64url').toString('base64url') !== id
      ) {
        span.setAttribute('http.status_code', 400);
        span.setAttribute('data.error', 'invalid_id');
        log.warn('Invalid ID', { id });
        sendInvalidId(res, id);
        return;
      }

      // Return 404 if the data is blocked by ID
      span.addEvent('Checking blocklist for ID');
      try {
        if (await dataBlockListValidator.isIdBlocked(id)) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('data.error', 'id_blocked');
          sendNotFound(res);
          return;
        }
      } catch (error: any) {
        span.recordException(error);
        log.error('Error checking blocklist:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
      }

      let dataAttributes: ContiguousDataAttributes | undefined;

      // Retrieve authoritative data attributes if available
      span.addEvent('Retrieving data attributes');
      const attributesStartTime = Date.now();
      try {
        dataAttributes = await dataAttributesSource.getDataAttributes(id);
        const attributesDuration = Date.now() - attributesStartTime;
        span.setAttribute(
          'data.attributes_retrieval_duration_ms',
          attributesDuration,
        );
        if (dataAttributes) {
          span.setAttributes({
            'data.size': dataAttributes.size,
            'data.hash': dataAttributes.hash,
            'data.stable': dataAttributes.stable,
            'data.verified': dataAttributes.verified,
            'data.is_manifest': dataAttributes.isManifest,
            'data.content_type': dataAttributes.contentType,
          });
        }
      } catch (error: any) {
        const attributesDuration = Date.now() - attributesStartTime;
        span.setAttribute(
          'data.attributes_retrieval_duration_ms',
          attributesDuration,
        );
        span.recordException(error);
        log.error('Error retrieving data attributes:', {
          dataId: id,
          message: error.message,
          stack: error.stack,
        });
        span.setAttribute('http.status_code', 404);
        sendNotFound(res);
        return;
      }

      // Return 404 if the data is blocked by hash
      if (dataAttributes?.hash !== undefined) {
        span.addEvent('Checking blocklist for hash');
        try {
          if (await dataBlockListValidator.isHashBlocked(dataAttributes.hash)) {
            span.setAttribute('http.status_code', 404);
            span.setAttribute('data.error', 'hash_blocked');
            sendNotFound(res);
            return;
          }
        } catch (error: any) {
          span.recordException(error);
          log.error('Error checking blocklist:', {
            dataId: id,
            message: error.message,
            stack: error.stack,
          });
        }
      }

      // Attempt manifest path resolution from the index (without data parsing)
      if (dataAttributes?.isManifest) {
        span.addEvent('Resolving manifest path from index');
        const manifestStartTime = Date.now();
        const manifestResolution = await manifestPathResolver.resolveFromIndex(
          id,
          manifestPath,
        );
        const manifestDuration = Date.now() - manifestStartTime;
        span.setAttribute('manifest.resolution_duration_ms', manifestDuration);
        if (
          manifestResolution.resolvedId !== undefined &&
          manifestResolution.resolvedId !== ''
        ) {
          span.setAttribute(
            'manifest.resolved_id',
            manifestResolution.resolvedId,
          );
        }

        // Send response based on manifest resolution (data ID and
        // completeness)
        if (
          await sendManifestResponse({
            log,
            req,
            res,
            dataAttributesSource,
            dataSource,
            requestAttributes,
            parentSpan: span,
            ...manifestResolution,
          })
        ) {
          span.setAttribute('http.status_code', res.statusCode);
          span.addEvent('Manifest response sent successfully');
          // Manifest response successfully sent
          return;
        }
      }

      // Attempt to retrieve data
      span.addEvent('Starting data retrieval');
      const dataStartTime = Date.now();
      try {
        data = await dataSource.getData({
          id,
          requestAttributes,
          parentSpan: span,
        });
        const dataDuration = Date.now() - dataStartTime;
        span.setAttributes({
          'data.retrieval.duration_ms': dataDuration,
          'data.cached': data.cached,
          'data.trusted': data.trusted,
          'cache.status': data.cached ? 'HIT' : 'MISS',
        });
        span.addEvent('Data retrieval successful');
      } catch (error: any) {
        const dataDuration = Date.now() - dataStartTime;
        span.setAttributes({
          'data.retrieval.duration_ms': dataDuration,
          'http.status_code': 404,
          'data.retrieval.error': 'retrieval_failed',
        });
        span.recordException(error);
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
        span.addEvent('Resolving manifest path from data');
        const manifestStartTime = Date.now();
        const manifestResolution = await manifestPathResolver.resolveFromData(
          data,
          id,
          manifestPath,
        );
        const manifestDuration = Date.now() - manifestStartTime;
        span.setAttribute(
          'manifest.resolution_from_data_duration_ms',
          manifestDuration,
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
            dataAttributesSource,
            dataSource,
            requestAttributes,
            ...manifestResolution,
          }))
        ) {
          // This should be unreachable since resolution from data is always
          // considered complete, but just in case...
          span.setAttribute('http.status_code', 404);
          sendNotFound(res);
        } else {
          span.setAttribute('http.status_code', res.statusCode);
        }
        return;
      }

      // Check if the request includes a Range header
      const rangeHeader = req.headers.range;
      if (rangeHeader !== undefined && data !== undefined) {
        span.addEvent('Handling range request');
        span.setAttribute('data.range_request', true);
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
        span.setAttribute('http.status_code', res.statusCode);
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
          span.setAttribute('http.status_code', 304);
          span.addEvent('Not modified - ETag match');
          res.end();
          data.stream.destroy();
          return;
        }

        if (req.method === REQUEST_METHOD_HEAD) {
          span.setAttribute('http.status_code', res.statusCode || 200);
          span.addEvent('HEAD request - headers only');
          res.end();
          data.stream.destroy();
          return;
        }

        span.setAttribute('http.status_code', res.statusCode || 200);
        span.addEvent('Streaming data to client');
        data.stream.pipe(res);
      }
    } catch (error: any) {
      span.recordException(error);
      span.setAttribute('http.status_code', 404);
      log.error('Error retrieving data:', {
        dataId: id,
        manifestPath,
        message: error.message,
        stack: error.stack,
      });
      sendNotFound(res);
      data?.stream.destroy();
    } finally {
      span.end();
    }
  });
};
