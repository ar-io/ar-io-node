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
    this.log.info('Sequentialy fetching from data sources', {
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
