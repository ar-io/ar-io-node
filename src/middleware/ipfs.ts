/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request, Response, NextFunction } from 'express';

import * as config from '../config.js';
import { isValidCid, cidToV1Base32 } from '../lib/ipfs-cid.js';

/**
 * Middleware that intercepts `{CID}.{root_host}` subdomain requests.
 * Must be mounted BEFORE the ArNS middleware to prevent ArNS from attempting
 * to resolve CIDs as ArNS names.
 *
 * CIDv1 base32 strings are ~59 characters — always longer than the ArNS
 * name limit (51 chars), so there's no collision with ArNS names.
 * This also avoids needing a multi-level wildcard TLS certificate
 * (*.ipfs.host would require a separate cert from *.host).
 *
 * Express subdomain array for `bafyabc.my-gateway.io` (root=my-gateway.io):
 *   req.subdomains = ['bafyabc'] (single subdomain)
 *   req.subdomains[0] = CID
 */
export function createIpfsSubdomainMiddleware({
  ipfsHandler,
}: {
  ipfsHandler: Handler;
}): Handler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.IPFS_ENABLED || config.ARNS_ROOT_HOSTS.length === 0) {
      next();
      return;
    }

    const matchedEntry = config.matchArnsRootHost(req.hostname);
    if (matchedEntry === undefined) {
      next();
      return;
    }

    // For {CID}.{root_host}, we expect exactly 1 subdomain beyond
    // the root host's own subdomain depth.
    const cidLabelIndex = matchedEntry.subdomainLength;

    if (
      !Array.isArray(req.subdomains) ||
      req.subdomains.length !== cidLabelIndex + 1
    ) {
      next();
      return;
    }

    const cidLabel = req.subdomains[cidLabelIndex];
    if (!isValidCid(cidLabel)) {
      // Not a CID — let ArNS handle it (likely an ArNS name)
      next();
      return;
    }

    // Attach IPFS context to request
    (req as any).ipfsCid = cidLabel;

    // Handle /ipfs/ paths on subdomain requests.
    // Kubo's directory listings generate absolute links like /ipfs/{CID}/file.
    let reqPath: string | undefined =
      req.path === '/' ? undefined : req.path.slice(1);
    if (reqPath !== undefined && reqPath.startsWith('ipfs/')) {
      const afterIpfs = reqPath.slice(5); // strip 'ipfs/'
      const slashIdx = afterIpfs.indexOf('/');
      const pathCid =
        slashIdx >= 0 ? afterIpfs.slice(0, slashIdx) : afterIpfs;
      const remainder =
        slashIdx >= 0 ? afterIpfs.slice(slashIdx + 1) : undefined;

      if (pathCid === cidLabel) {
        // Same CID — strip the redundant prefix
        reqPath = remainder !== undefined ? remainder : undefined;
      } else if (isValidCid(pathCid)) {
        // Different CID — redirect to that CID's subdomain
        try {
          const targetCid = cidToV1Base32(pathCid);
          const rootHost = matchedEntry.host;
          const pathSuffix =
            remainder !== undefined ? `/${remainder}` : '/';
          res.redirect(
            302,
            `${req.protocol}://${targetCid}.${rootHost}${pathSuffix}`,
          );
          return;
        } catch {
          // CID conversion failed — fall through to handler
        }
      }
    }
    (req as any).ipfsPath = reqPath;

    // Delegate to the IPFS handler
    ipfsHandler(req, res, next);
  };
}
