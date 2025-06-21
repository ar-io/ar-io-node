/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ContiguousDataSource,
  ContiguousDataIndex,
  ContiguousDataAttributes,
  ChainSource,
  TransactionAttributesStore,
  DataItemAttributesStore,
  DataItemAttributes,
  TransactionAttributes,
  SignatureStore,
  OwnerStore,
  SignatureSource,
  OwnerSource,
} from '../types.js';
import winston from 'winston';
import { toB64Url } from '../lib/encoding.js';
import { isEmptyString } from '../lib/string.js';

export abstract class AttributeFetchers {
  protected log: winston.Logger;
  protected dataSource: ContiguousDataSource;
  protected dataIndex: ContiguousDataIndex;
  private dataItemAttributesStore: DataItemAttributesStore;
  private transactionAttributesStore: TransactionAttributesStore;

  constructor({
    log,
    dataSource,
    dataIndex,
    dataItemAttributesStore,
    transactionAttributesStore,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataIndex: ContiguousDataIndex;
    dataItemAttributesStore: DataItemAttributesStore;
    transactionAttributesStore: TransactionAttributesStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.dataIndex = dataIndex;
    this.dataItemAttributesStore = dataItemAttributesStore;
    this.transactionAttributesStore = transactionAttributesStore;
  }

  protected async fetchDataFromParent({
    parentId,
    offset,
    size,
  }: {
    parentId: string;
    offset: number;
    size: number;
  }): Promise<string> {
    const log = this.log.child({ method: 'fetchDataFromParent' });
    log.debug('Fetching data from parent', { parentId, offset, size });

    const { stream } = await this.dataSource.getData({
      id: parentId,
      dataAttributes: {
        size,
      } as ContiguousDataAttributes,
      region: {
        offset,
        size,
      },
    });

    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }

    return toB64Url(buffer);
  }

  protected async getDataItemAttributes(
    id: string,
  ): Promise<DataItemAttributes | undefined> {
    const log = this.log.child({ method: 'getDataItemAttributes' });

    let attributes = await this.dataItemAttributesStore.get(id);
    if (attributes !== undefined) {
      log.debug('Data item attributes found in store', { id });
      return attributes;
    }

    attributes = await this.dataIndex.getDataItemAttributes(id);

    if (attributes !== undefined) {
      await this.dataItemAttributesStore.set(id, attributes);
    }

    return attributes;
  }

  protected async getTransactionAttributes(
    id: string,
  ): Promise<TransactionAttributes | undefined> {
    const log = this.log.child({ method: 'getTransactionAttributes' });

    let attributes = await this.transactionAttributesStore.get(id);
    if (attributes !== undefined) {
      log.debug('Transaction attributes found in store', { id });
      return attributes;
    }

    attributes = await this.dataIndex.getTransactionAttributes(id);

    if (attributes !== undefined) {
      await this.transactionAttributesStore.set(id, attributes);
    }

    return attributes;
  }
}

export class SignatureFetcher
  extends AttributeFetchers
  implements SignatureSource
{
  private chainSource: ChainSource;
  private signatureStore: SignatureStore;

  constructor({
    log,
    dataSource,
    dataIndex,
    chainSource,
    dataItemAttributesStore,
    transactionAttributesStore,
    signatureStore,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataIndex: ContiguousDataIndex;
    chainSource: ChainSource;
    dataItemAttributesStore: DataItemAttributesStore;
    transactionAttributesStore: TransactionAttributesStore;
    signatureStore: SignatureStore;
  }) {
    super({
      log,
      dataSource,
      dataIndex,
      dataItemAttributesStore,
      transactionAttributesStore,
    });
    this.chainSource = chainSource;
    this.signatureStore = signatureStore;
  }

  async getDataItemSignature({
    id,
    parentId,
    signatureSize,
    signatureOffset,
  }: {
    id: string;
    parentId?: string;
    signatureSize?: number;
    signatureOffset?: number;
  }): Promise<string | undefined> {
    const log = this.log.child({ method: 'getDataItemSignature' });
    log.debug('Fetching data item signature', { id });
    const signature = await this.signatureStore.get(id);

    if (signature !== undefined) {
      log.debug('Data item signature fetched from store', { id });
      return signature;
    }

    try {
      if (
        parentId === undefined ||
        signatureSize === undefined ||
        signatureOffset === undefined
      ) {
        const dataItemAttributes = await this.getDataItemAttributes(id);

        if (dataItemAttributes === undefined) {
          this.log.warn('No attributes found for data item', { id });
          return undefined;
        }

        if (typeof dataItemAttributes.signature === 'string') {
          await this.signatureStore.set(id, dataItemAttributes.signature);

          return dataItemAttributes.signature;
        }

        parentId = dataItemAttributes.parentId;
        signatureSize = dataItemAttributes.signatureSize;
        signatureOffset = dataItemAttributes.signatureOffset;
      }

      const signature = await this.fetchDataFromParent({
        parentId,
        offset: signatureOffset,
        size: signatureSize,
      });

      await this.signatureStore.set(id, signature);

      return signature;
    } catch (error) {
      log.error('Error fetching data item signature', {
        id,
        error: (error as Error).message,
      });

      return undefined;
    }
  }

  async getTransactionSignature({
    id,
  }: {
    id: string;
  }): Promise<string | undefined> {
    const log = this.log.child({ method: 'getTransactionSignature' });
    log.debug('Fetching transaction signature', { id });

    const signature = await this.signatureStore.get(id);

    if (signature !== undefined) {
      log.debug('Transaction signature fetched from store', { id });
      return signature;
    }

    try {
      const transactionAttributes = await this.getTransactionAttributes(id);

      if (transactionAttributes === undefined) {
        this.log.warn('No attributes found for transaction', { id });
      }

      if (typeof transactionAttributes?.signature === 'string') {
        await this.signatureStore.set(id, transactionAttributes.signature);

        return transactionAttributes.signature;
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
      log.error('Error fetching transaction signature', {
        id,
        error: (error as Error).message,
      });

      return undefined;
    }
  }
}

export class OwnerFetcher extends AttributeFetchers implements OwnerSource {
  private chainSource: ChainSource;
  private ownerStore: OwnerStore;

  constructor({
    log,
    dataSource,
    dataIndex,
    chainSource,
    dataItemAttributesStore,
    transactionAttributesStore,
    ownerStore,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    dataIndex: ContiguousDataIndex;
    chainSource: ChainSource;
    dataItemAttributesStore: DataItemAttributesStore;
    transactionAttributesStore: TransactionAttributesStore;
    ownerStore: OwnerStore;
  }) {
    super({
      log,
      dataSource,
      dataIndex,
      dataItemAttributesStore,
      transactionAttributesStore,
    });
    this.chainSource = chainSource;
    this.ownerStore = ownerStore;
  }

  async getDataItemOwner({
    id,
    parentId,
    ownerSize,
    ownerOffset,
  }: {
    id: string;
    parentId?: string;
    ownerSize?: number;
    ownerOffset?: number;
  }): Promise<string | undefined> {
    const log = this.log.child({ method: 'getDataItemOwner' });
    log.debug('Fetching data item owner', { id });

    const owner = await this.ownerStore.get(id);

    if (owner !== undefined) {
      log.debug('Data item owner fetched from store', { id });
      return owner;
    }

    try {
      if (
        parentId === undefined ||
        ownerSize === undefined ||
        ownerOffset === undefined
      ) {
        const dataItemAttributes = await this.getDataItemAttributes(id);

        if (dataItemAttributes === undefined) {
          this.log.warn('No attributes found for data item', { id });
          return undefined;
        }

        parentId = dataItemAttributes.parentId;
        ownerSize = dataItemAttributes.ownerSize;
        ownerOffset = dataItemAttributes.ownerOffset;
      }

      const owner = await this.fetchDataFromParent({
        parentId,
        offset: ownerOffset,
        size: ownerSize,
      });

      await this.ownerStore.set(id, owner);
      return owner;
    } catch (error) {
      log.error('Error fetching data item owner', {
        id,
        error: (error as Error).message,
      });

      return undefined;
    }
  }

  async getTransactionOwner({
    id,
  }: {
    id: string;
  }): Promise<string | undefined> {
    const log = this.log.child({ method: 'getTransactionOwner' });
    log.debug('Fetching transaction owner', { id });

    const owner = await this.ownerStore.get(id);

    if (owner !== undefined) {
      log.debug('Transaction owner fetched from store', { id });
      return owner;
    }

    try {
      const transactionAttributes = await this.getTransactionAttributes(id);

      if (
        transactionAttributes !== undefined &&
        typeof transactionAttributes.owner === 'string'
      ) {
        await this.ownerStore.set(id, transactionAttributes.owner);

        return transactionAttributes.owner;
      }

      this.log.warn('No attributes found for transaction', { id });

      let ownerFromChain;

      const ownerChainField = await this.chainSource.getTxField(id, 'owner');

      // Arweave supports transactions where the owner field is an empty string.
      // This is possible because the public owner key can be derived from the signature payload.
      // The derivation is achieved through ECDSA public key recovery using the secp256k1 algorithm.
      // getTx handles the retrieval of transaction and owner derivation when the owner field is empty.
      // For more details, see: https://github.com/ArweaveTeam/arweave/releases/tag/N.2.9.1
      if (
        typeof ownerChainField === 'string' &&
        !isEmptyString(ownerChainField)
      ) {
        ownerFromChain = ownerChainField;
      } else {
        const chainTransaction = await this.chainSource.getTx({ txId: id });
        ownerFromChain = chainTransaction.owner;
      }

      if (ownerFromChain === undefined) {
        this.log.warn('No owner found for transaction', { id });
        return undefined;
      }

      await this.ownerStore.set(id, ownerFromChain);

      return ownerFromChain;
    } catch (error) {
      log.error('Error fetching transaction signature', {
        id,
        error: (error as Error).message,
      });

      return undefined;
    }
  }
}
