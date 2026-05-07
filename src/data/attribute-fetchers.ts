/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ContiguousDataSource,
  ContiguousDataIndex,
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
    signal,
  }: {
    parentId: string;
    offset: number;
    size: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const log = this.log.child({ method: 'fetchDataFromParent' });

    // Validate inputs. A `size` of 0 or negative cannot produce a meaningful
    // signature/owner range, and historically caused the upstream Range
    // header to be malformed (`bytes=0--1`) — most data sources then
    // returned the FULL parent bundle as a 200 response, which the previous
    // implementation silently accumulated into a multi-hundred-MB Buffer
    // pinned in this async function's saved register frame across the
    // upstream stall. (PE-9081.)
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(
        `fetchDataFromParent: invalid size ${size} (parentId=${parentId}, offset=${offset})`,
      );
    }
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error(
        `fetchDataFromParent: invalid offset ${offset} (parentId=${parentId}, size=${size})`,
      );
    }

    // Bail before any allocation if the caller already aborted.
    signal?.throwIfAborted();

    log.debug('Fetching data from parent', { parentId, offset, size });

    const { stream } = await this.dataSource.getData({
      id: parentId,
      region: {
        offset,
        size,
      },
      signal,
    });

    // Pre-allocated, fixed-size buffer with offset writes. Avoids the
    // O(N²) Buffer.concat-per-chunk shape and removes the slot-8 pinned-
    // accumulator leak. If upstream emits more bytes than requested,
    // destroy the stream and throw — do not silently buffer past `size`.
    // If the caller aborts mid-stream we tear down the upstream stream
    // and rethrow the AbortError so callers can clean up promptly.
    const buffer = Buffer.alloc(size);
    let bytesRead = 0;

    const onAbort = () => {
      if (typeof (stream as { destroy?: () => void }).destroy === 'function') {
        (stream as { destroy: (err?: Error) => void }).destroy(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Aborted'),
        );
      }
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        throw signal.reason ?? new Error('Aborted');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      for await (const chunk of stream) {
        if (bytesRead + chunk.length > size) {
          if (
            typeof (stream as { destroy?: () => void }).destroy === 'function'
          ) {
            (stream as { destroy: () => void }).destroy();
          }
          throw new Error(
            `fetchDataFromParent: upstream returned more bytes than requested ` +
              `(parentId=${parentId}, requestedSize=${size}, ` +
              `bytesAtOverage=${bytesRead + chunk.length})`,
          );
        }
        chunk.copy(buffer, bytesRead);
        bytesRead += chunk.length;
      }
    } catch (error) {
      // Ensure the buffer reference can be GC'd promptly even when the
      // for-await yields back to a still-pending Promise. Forward the
      // caught error to destroy() so the abort reason is preserved when
      // upstream is being torn down due to AbortSignal — otherwise the
      // first destroy(reason) from the abort handler would be overwritten
      // by a no-arg destroy() here.
      const s = stream as {
        destroy?: (err?: Error) => void;
        destroyed?: boolean;
      };
      if (typeof s.destroy === 'function' && s.destroyed !== true) {
        s.destroy(error as Error);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (bytesRead !== size) {
      throw new Error(
        `fetchDataFromParent: short read from upstream ` +
          `(parentId=${parentId}, requestedSize=${size}, actualSize=${bytesRead})`,
      );
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
    signal,
  }: {
    id: string;
    parentId?: string;
    signatureSize?: number;
    signatureOffset?: number;
    signal?: AbortSignal;
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

      // Incomplete-root-atom guard. Two failure modes converge here:
      //   - PE-9073: rows produced by an admin POST that arrived before the
      //     unbundle path can have a populated parent_id but NULL
      //     signature_offset / signature_size. Coercing those NULLs into
      //     FsDataStore.get yields a degenerate read range
      //     (end = offset + size - 1 = -1) and throws RangeError.
      //   - PE-9081: a 0 / negative signatureSize would produce a malformed
      //     Range request; upstreams that ignore malformed Range return the
      //     full parent bundle, which fetchDataFromParent previously
      //     accumulated into a multi-hundred-MB Buffer.
      // Both are downstream symptoms of the same data-integrity problem
      // (incomplete root atom). Bail out with a warning instead.
      // `== null` catches both null (from DB rows) and undefined.
      if (
        parentId == null ||
        signatureSize == null ||
        signatureSize <= 0 ||
        signatureOffset == null ||
        signatureOffset < 0
      ) {
        log.warn(
          'Skipping signature fetch — data item has incomplete root atom (likely a shadow row pending repair, see PE-9073 follow-up)',
          { id, parentId, signatureSize, signatureOffset },
        );
        return undefined;
      }

      const signature = await this.fetchDataFromParent({
        parentId,
        offset: signatureOffset,
        size: signatureSize,
        signal,
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
    signal,
  }: {
    id: string;
    signal?: AbortSignal;
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
        signal,
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
    signal,
  }: {
    id: string;
    parentId?: string;
    ownerSize?: number;
    ownerOffset?: number;
    signal?: AbortSignal;
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

      // Incomplete-root-atom guard. See getDataItemSignature for the full
      // rationale (shadow-row RangeError + malformed-Range memory leak).
      if (
        parentId == null ||
        ownerSize == null ||
        ownerSize <= 0 ||
        ownerOffset == null ||
        ownerOffset < 0
      ) {
        log.warn(
          'Skipping owner fetch — data item has incomplete root atom (likely a shadow row pending repair, see PE-9073 follow-up)',
          { id, parentId, ownerSize, ownerOffset },
        );
        return undefined;
      }

      const owner = await this.fetchDataFromParent({
        parentId,
        offset: ownerOffset,
        size: ownerSize,
        signal,
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
    signal,
  }: {
    id: string;
    signal?: AbortSignal;
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

      const ownerChainField = await this.chainSource.getTxField(
        id,
        'owner',
        signal,
      );

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
