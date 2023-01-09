import { default as axios } from 'axios';
import winston from 'winston';

import { ContiguousData, ContiguousDataSource } from '../types.js';

export class GatewayDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private trustedGatewayAxios;

  constructor({
    log,
    trustedGatewayUrl,
  }: {
    log: winston.Logger;
    trustedGatewayUrl: string;
  }) {
    this.log = log.child({ class: 'GatewayDataSource' });
    this.trustedGatewayAxios = axios.create({
      baseURL: trustedGatewayUrl,
    });
  }

  async getData(id: string): Promise<ContiguousData> {
    this.log.debug('Fetching contiguous data from gateway', {
      id,
      trustedGatewayUrl: this.trustedGatewayAxios.defaults.baseURL,
    });

    const response = await this.trustedGatewayAxios.request({
      method: 'GET',
      url: `/raw/${id}`,
      responseType: 'stream',
    });

    return {
      stream: response.data,
      size: parseInt(response.headers['content-length']),
      verified: false,
      contentType: response.headers['content-type'],
    };
  }
}
