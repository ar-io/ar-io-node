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

import axios, {
  AxiosHeaders,
  AxiosResponse,
  InternalAxiosRequestConfig,
  RawAxiosRequestHeaders,
} from 'axios';
import http, { OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

export type AxiosResponseWithTimings = AxiosResponse & {
  ttfb: number;
  kbps: number;
};

/**
 * Helper to transform Axios headers (AxiosHeaders or a plain object)
 * into Node.js-compatible OutgoingHttpHeaders.
 */
function transformAxiosHeaders(
  headers?: RawAxiosRequestHeaders | AxiosHeaders,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};

  if (!headers) return result;

  let headerObj: Record<string, any>;
  // If it's an AxiosHeaders instance (Axios 1.x), or has a .toJSON() method:
  if (
    headers !== null &&
    headers !== undefined &&
    typeof headers.toJSON === 'function'
  ) {
    headerObj = headers.toJSON();
  } else {
    // Otherwise, assume it's a plain object
    headerObj = headers;
  }

  // Convert all values to string or string[] per Node.js requirement
  for (const [key, val] of Object.entries(headerObj)) {
    if (val === undefined || val === null) {
      continue;
    } else if (Array.isArray(val)) {
      // E.g., multiple values for the same header
      result[key] = val.map(String);
    } else {
      result[key] = String(val);
    }
  }

  return result;
}

/**
 * Custom Axios adapter to measure TTFB & download speed.
 * IMPORTANT: must accept and return types that align with Axios v1's
 * internal adapter signature -> `InternalAxiosRequestConfig` & `AxiosResponse`.
 */
async function ttfbAdapter(
  config: InternalAxiosRequestConfig,
): Promise<AxiosResponseWithTimings> {
  return new Promise<AxiosResponseWithTimings>((resolve, reject) => {
    if (config.url === undefined || config.url === '' || config.url === null) {
      return reject(new Error('No URL provided'));
    }

    // Use the modern WHATWG URL API
    const urlObj = new URL(config.url);

    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Start timing before the request goes out
    const startTime = performance.now();
    let ttfb = Number.POSITIVE_INFINITY;

    // Prepare Node.js request options
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port === '' ? undefined : urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: config.method?.toUpperCase() ?? 'GET',
      headers: transformAxiosHeaders(config.headers),
    };

    const req = transport.request(options, (res) => {
      // TTFB: when we get the first chunk of response headers
      ttfb = performance.now() - startTime;

      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      res.on('end', () => {
        const endTime = performance.now();
        const responseData = Buffer.concat(chunks);

        // Calculate total download time from TTFB to the end
        // If you want from the moment the request was sent, use `endTime - startTime`
        // Here, we measure from after TTFB to end for "download time".
        const downloadTimeMs = endTime - (startTime + (ttfb ?? 0));

        const totalBytes = responseData.length;
        // Kilobytes = bytes / 1024
        const totalKB = totalBytes / 1024;
        // Convert ms -> seconds
        const downloadSeconds = downloadTimeMs / 1000;
        // Avoid division by zero (small responses might set TTFB ~ total time)
        const kbps = downloadSeconds > 0 ? totalKB / downloadSeconds : 0;

        // Construct the AxiosResponse with the fields Axios expects
        const axiosResponse: AxiosResponseWithTimings = {
          data: responseData,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          // Cast config to `InternalAxiosRequestConfig` to satisfy TS
          config: config as InternalAxiosRequestConfig,
          request: req,
          // Attach TTFB and kB/s to the response (custom properties)
          ttfb,
          kbps,
        };

        resolve(axiosResponse);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    // If the request has a body
    if (config.data) {
      req.write(config.data);
    }

    req.end();
  });
}

export const makeAxiosInstanceWithTimings = () =>
  axios.create({
    adapter: ttfbAdapter,
  });

export type AxiosInstanceWithTimingsAdapter = ReturnType<
  typeof makeAxiosInstanceWithTimings
>;
