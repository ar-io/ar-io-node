import winston from 'winston';

import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
} from '../types.js';

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

  async getData(
    txId: string,
    dataAttributes?: ContiguousDataAttributes,
  ): Promise<ContiguousData> {
    this.log.info('Sequentialy fetching from data sources', {
      txId,
    });

    for (const dataSource of this.dataSources) {
      try {
        const data = await dataSource.getData(txId, dataAttributes);
        return data;
      } catch (error: any) {
        // Some errors are expected, so log them as warnings
        this.log.warn('Unable to fetch data from data source', {
          txId,
          message: error.message,
          stack: error.stack,
        });
      }
    }

    throw new Error('Unable to fetch data from any data source');
  }
}
