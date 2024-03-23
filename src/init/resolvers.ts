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
import { Logger } from 'winston';
import { StandaloneArNSResolver } from '../resolution/standalone-arns-resolver.js';
import { TrustedGatewayArNSResolver } from '../resolution/trusted-gateway-arns-resolver.js';
import { NameResolver } from '../types.js';

export const createArNSResolver = ({
  log,
  type,
  url,
}: {
  log: Logger;
  type: string;
  url: string;
}): NameResolver => {
  log.info(`Using ${type} for arns name resolution`);
  switch (type) {
    case 'resolver': {
      return new StandaloneArNSResolver({
        log,
        resolverUrl: url,
      });
    }
    case 'gateway': {
      return new TrustedGatewayArNSResolver({
        log,
        trustedGatewayUrl: url,
      });
    }
    default: {
      throw new Error(`Unknown ArNSResolver type: ${type}`);
    }
  }
};
