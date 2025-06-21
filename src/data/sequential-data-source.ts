/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  Region,
  RequestAttributes,
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
    this.log = log.child({ class: this.constructor.name });
    this.dataSources = dataSources;
  }

  async getData({
    id,
    dataAttributes,
    requestAttributes,
    region,
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    this.log.debug('Sequentialy fetching from data sources', {
      id,
    });

    for (const dataSource of this.dataSources) {
      try {
        const data = await dataSource.getData({
          id,
          dataAttributes,
          requestAttributes,
          region,
        });
        return data;
      } catch (error: any) {
        // Some errors are expected, so log them as warnings
        this.log.warn('Unable to fetch data from data source', {
          id,
          message: error.message,
          stack: error.stack,
        });
      }
    }

    throw new Error('Unable to fetch data from any data source');
  }
}
