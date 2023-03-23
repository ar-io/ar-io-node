import { default as axios } from 'axios';
import winston from 'winston';

import { isValidDataId } from '../lib/validation.js';
import { NameResolution, NameResolver } from '../types.js';

const DEFAULT_TTL = 60 * 15; // 15 minutes

export class TrustedGatewayArNSResolver implements NameResolver {
  private log: winston.Logger;
  private trustedGatewayUrl: string;

  constructor({
    log,
    trustedGatewayUrl,
  }: {
    log: winston.Logger;
    trustedGatewayUrl: string;
  }) {
    this.log = log.child({ class: 'TrustedGatewayArNSResolver' });
    this.trustedGatewayUrl = trustedGatewayUrl;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      const nameUrl = this.trustedGatewayUrl.replace('__NAME__', name);
      const response = await axios({
        method: 'HEAD',
        url: '/',
        baseURL: nameUrl,
        validateStatus: (status) => status === 200,
      });
      const resolvedId = response.headers['x-arns-resolved-id'];
      const ttl =
        parseInt(response.headers['x-arns-ttl-seconds']) || DEFAULT_TTL;
      if (isValidDataId(resolvedId)) {
        this.log.info('Resolved name', { name, nameUrl, resolvedId, ttl });
        return {
          name,
          resolvedId,
          resolvedAt: Date.now(),
          ttl,
        };
      } else {
        this.log.warn('Invalid resolved data ID', {
          name,
          nameUrl,
          resolvedId,
          ttl,
        });
      }
    } catch (error: any) {
      this.log.warn('Unable to resolve name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    return {
      name,
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
    };
  }
}
