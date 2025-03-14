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
  ChainSource,
  SignatureStore,
} from '../types.js';
import winston from 'winston';
import { toB64Url } from '../lib/encoding.js';
import { Sign } from 'crypto';

export class SignatureFetcher implements SignatureSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private dataIndex: ContiguousDataIndex;
  private chainSource: ChainSource;
  private signatureStore: SignatureStore;

  constructor({
    log,
    dataSource,
    dataIndex,
    chainSource,
    signatureStore,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataIndex: ContiguousDataIndex;
    chainSource: ChainSource;
    signatureStore: SignatureStore;
  }) {
    this.log = log.child({ class: 'SignatureFetcher' });
    this.dataSource = dataSource;
    this.dataIndex = dataIndex;
    this.chainSource = chainSource;
    this.signatureStore = signatureStore;
  }

  async getDataItemSignature(
    id: string,
    parentId?: string,
    signatureSize?: string | null,
    signatureOffset?: string | null,
  ): Promise<string | undefined> {
    try {
      this.log.debug('Fetching data item signature from store', { id });
      const signatureFromStore = await this.signatureStore.get(id);

      if (signatureFromStore !== undefined) {
        return signatureFromStore;
      }

      let dataSignature: string | null = null;
      let dataParentId = parentId;
      let dataSignatureOffset =
        typeof signatureOffset === 'string'
          ? parseInt(signatureOffset)
          : undefined;
      let dataSignatureSize =
        typeof signatureSize === 'string' ? parseInt(signatureSize) : undefined;

      this.log.debug('Fetching data item signature', { id });

      if (
        dataParentId === undefined ||
        dataSignatureOffset === undefined ||
        dataSignatureSize === undefined
      ) {
        const dataItemAttributes =
          await this.dataIndex.getDataItemAttributes(id);

        if (dataItemAttributes === undefined) {
          this.log.warn('No attributes found for data item', { id });
          return undefined;
        }

        dataSignature = dataItemAttributes.signature;
        dataParentId = dataItemAttributes.parentId;
        dataSignatureOffset = dataItemAttributes.signatureOffset;
        dataSignatureSize = dataItemAttributes.signatureSize;
      }

      if (typeof dataSignature === 'string') {
        return dataSignature;
      }

      const { stream } = await this.dataSource.getData({
        id: dataParentId,
        dataAttributes: {
          size: dataSignatureSize,
        } as ContiguousDataAttributes,
        region: {
          offset: dataSignatureOffset,
          size: dataSignatureSize,
        },
      });

      let signatureBuffer = Buffer.alloc(0);

      for await (const chunk of stream) {
        signatureBuffer = Buffer.concat([signatureBuffer, chunk]);
      }

      return toB64Url(signatureBuffer);
    } catch (error) {
      this.log.error('Error fetching data item signature', {
        id,
        error: (error as Error).message,
      });

      return undefined;
    }
  }

  async getTransactionSignature(id: string): Promise<string | undefined> {
    try {
      this.log.debug('Fetching transaction signature from store', { id });
      const signatureFromStore = await this.signatureStore.get(id);

      if (signatureFromStore !== undefined) {
        return signatureFromStore;
      }

      this.log.debug('Fetching transaction signature', { id });
      const transactionAttributes =
        await this.dataIndex.getTransactionAttributes(id);

      if (transactionAttributes === undefined) {
        this.log.warn('No attributes found for transaction', { id });
      }

      const signature = transactionAttributes?.signature;

      if (typeof signature === 'string') {
        return signature;
      }

      const signatureFromChain = await this.chainSource.getTxField(
        id,
        'signature',
      );

      if (typeof signatureFromChain === 'string') {
        await this.signatureStore.set(id, signatureFromChain);

        return signatureFromChain;
      }

      return undefined;
    } catch (error) {
      this.log.error('Error fetching transaction signature', {
        id,
        error: (error as Error).message,
      });

      return undefined;
    }
  }
}
