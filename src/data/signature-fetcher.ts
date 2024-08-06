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
import {
  SignatureSource,
  ContiguousDataSource,
  ContiguousDataIndex,
  ContiguousDataAttributes,
} from '../types.js';
import winston from 'winston';
import { toB64Url } from '../lib/encoding.js';

export class SignatureFetcher implements SignatureSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private dataIndex: ContiguousDataIndex;

  constructor({
    log,
    dataSource,
    dataIndex,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataIndex: ContiguousDataIndex;
  }) {
    this.log = log.child({ class: 'SignatureFetcher' });
    this.dataSource = dataSource;
    this.dataIndex = dataIndex;
  }

  async getDataItemSignature(id: string): Promise<string | undefined> {
    try {
      this.log.debug('Fetching data item signature', { id });

      const dataItemAttributes = await this.dataIndex.getDataItemAttributes(id);

      if (!dataItemAttributes) {
        this.log.warn('No attributes found for data item', { id });
        return undefined;
      }

      const { parentId, signature, signatureOffset, signatureSize } =
        dataItemAttributes;

      if (signature) {
        return signature;
      }

      const { stream } = await this.dataSource.getData({
        id: parentId,
        dataAttributes: {
          size: signatureSize,
        } as ContiguousDataAttributes,
        region: {
          offset: signatureOffset,
          size: signatureSize,
        },
      });

      let signatureBuffer = Buffer.alloc(0);

      for await (const chunk of stream) {
        signatureBuffer = Buffer.concat([signatureBuffer, chunk]);
      }

      return toB64Url(signatureBuffer);
    } catch (error) {
      this.log.error('Error fetching data itemsignature', {
        id,
        error: (error as Error).message,
      });
      return undefined;
    }
  }
}
