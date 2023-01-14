import winston from 'winston';

import { ContiguousData, ContiguousDataSource } from '../types.js';

export class SequentialDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSources: ContiguousDataSource[];

  constructor({
    log,
    dataSources,
  }: {
    log: winston.Logger;
    dataSources: ContiguousDataSource[];
  }) {
    this.log = log.child({ class: 'SequentialDataSource' });
    this.dataSources = dataSources;
  }

  async getData(txId: string): Promise<ContiguousData> {
    this.log.debug('Fetching contiguous data from data sources', { txId });

    for (const dataSource of this.dataSources) {
      try {
        const data = await dataSource.getData(txId);
        return data;
      } catch (error: any) {
        this.log.debug('Error fetching contiguous data from data source', {
          txId,
          message: error.message,
          stack: error.stack,
        });
      }
    }

    throw new Error('Unable to fetch contiguous data from any data source');
  }
}
