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
import { Handler } from 'express';
import { asyncMiddleware } from 'middleware-async';
import { URL } from 'node:url';

import * as config from '../config.js';
import { headerNames } from '../constants.js';
import { sendNotFound, sendPaymentRequired } from '../routes/data/handlers.js';
import { RAW_DATA_PATH_REGEX, DATA_PATH_REGEX } from '../constants.js';
import { NameResolver } from '../types.js';
import * as metrics from '../metrics.js';
import * as system from '../system.js';

const EXCLUDED_SUBDOMAINS = new Set('www');
const MAX_ARNS_NAME_LENGTH = 51;

export const createArnsMiddleware = ({
  dataHandler,
  nameResolver,
}: {
  dataHandler: Handler;
  nameResolver: NameResolver;
}): Handler =>
  asyncMiddleware(async (req, res, next) => {
    // Skip all ArNS processing if the root ArNS host is not set.
    if (config.ARNS_ROOT_HOST === undefined || config.ARNS_ROOT_HOST === '') {
      next();
      return;
    }

    let arnsSubdomain: string | undefined;
    const hostNameIsArNSRoot = req.hostname === config.ARNS_ROOT_HOST;
    if (hostNameIsArNSRoot) {
      // Ensure certain paths pass through even if an apex ID or ArNS name is
      // set.
      if (
        req.path.match(DATA_PATH_REGEX) ||
        req.path.match(RAW_DATA_PATH_REGEX) ||
        req.path.match(/^\/local\//) ||
        req.path.match(/^\/ar-io\//) ||
        req.path.match(/^\/chunk\//) ||
        req.path === '/openapi.json' ||
        req.path === '/api-docs/' ||
        req.path === '/graphql'
      ) {
        next();
        return;
      }

      // Use apex ID as ArNS root data if it's set.
      if (config.APEX_TX_ID !== undefined) {
        res.header(headerNames.arnsResolvedId, config.APEX_TX_ID);
        dataHandler(req, res, next);
        return;
      }

      // If apex ArNS name is set and hostname matches root use the apex ArNS
      // name as the ArNS subdomain.
      if (config.APEX_ARNS_NAME !== undefined) {
        arnsSubdomain = config.APEX_ARNS_NAME;
      }
    }

    if (
      // Ignore requests that do not end with the ArNS root hostname.
      !req.hostname.endsWith('.' + config.ARNS_ROOT_HOST) ||
      // Ignore requests that do not include subdomains since ArNS always
      // requires a subdomain.
      !Array.isArray(req.subdomains) ||
      // Ignore subdomains that are part of the ArNS root hostname or are
      // shorter than it (e.g., localhost).
      req.subdomains.length <= config.ROOT_HOST_SUBDOMAIN_LENGTH
    ) {
      next();
      return;
    } else {
      arnsSubdomain = req.subdomains[req.subdomains.length - 1];
    }

    if (
      EXCLUDED_SUBDOMAINS.has(arnsSubdomain) ||
      // Avoid collisions with sandbox URLs by ensuring the subdomain length is
      // below the minimum length of a sandbox subdomain. Undernames are are an
      // exception because they can be longer and '_' cannot appear in base32.
      (arnsSubdomain.length > MAX_ARNS_NAME_LENGTH && !arnsSubdomain.match(/_/))
    ) {
      next();
      return;
    }

    // TODO: add comment explaining this behavior
    if (DATA_PATH_REGEX.test(req.path)) {
      next();
      return;
    }

    if (system.blockedNamesCache.isBlocked(arnsSubdomain)) {
      sendNotFound(res);
      return;
    }

    // NOTE: Errors and in-flight resolution deduplication are expected to be
    // handled by the resolver.
    const end = metrics.arnsResolutionTime.startTimer();
    let { resolvedId, ttl, processId, resolvedAt, limit, index } =
      await nameResolver.resolve({
        name: arnsSubdomain,
      });
    end();
    if (resolvedId === undefined) {
      // Extract host from referer if available
      let refererHost;
      if (req.headers.referer !== undefined) {
        try {
          const refererUrl = new URL(req.headers.referer);
          refererHost = refererUrl.host;
        } catch (e) {
          // Invalid URL, ignore
        }
      }
      if (req.path === '' || req.path === '/') {
        res.status(404);
      } else if (req.headers.host !== refererHost) {
        res.redirect('/');
        return;
      }
      if (
        // ArNS undername should not use custom 404 pages.
        // TODO: expand this explanation
        arnsSubdomain?.match(/_/) ||
        // Custom 404s should not be used for Apex ArNS.
        hostNameIsArNSRoot
      ) {
        sendNotFound(res);
        return;
      } else if (config.ARNS_NOT_FOUND_TX_ID !== undefined) {
        resolvedId = config.ARNS_NOT_FOUND_TX_ID;
      } else if (config.ARNS_NOT_FOUND_ARNS_NAME !== undefined) {
        ({ resolvedId, ttl, processId, resolvedAt, limit, index } =
          await nameResolver.resolve({
            name: config.ARNS_NOT_FOUND_ARNS_NAME,
          }));
      } else {
        sendNotFound(res);
        return;
      }
    }

    res.header(headerNames.arnsResolvedId, resolvedId);
    res.header(headerNames.arnsTtlSeconds, ttl?.toString());
    res.header(headerNames.arnsProcessId, processId);
    res.header(headerNames.arnsResolvedAt, resolvedAt?.toString());
    // Limit and index can be undefined if they come from a cache that existed
    // before they were added.
    if (limit !== undefined && index !== undefined) {
      res.header(headerNames.arnsLimit, limit.toString());
      res.header(headerNames.arnsIndex, index.toString());

      // handle undername limit exceeded
      if (config.ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT && index > limit) {
        sendPaymentRequired(
          res,
          'ArNS undername limit exceeded. Purchase additional undernames to continue.',
        );
        return;
      }
    }

    // TODO: add a header for arns cache status
    res.header('Cache-Control', `public, max-age=${ttl}`);
    dataHandler(req, res, next);
  });
