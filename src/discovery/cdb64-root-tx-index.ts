/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64-based Root TX Index
 *
 * Provides O(1) lookups of data item ID → root transaction ID mappings
 * from a pre-built CDB64 file. This acts as a distributable historical
 * index that can be used without network access to external APIs.
 */

import winston from 'winston';
import { DataItemRootIndex } from '../types.js';
import { Cdb64Reader } from '../lib/cdb64.js';
import { decodeCdb64Value, isCompleteValue } from '../lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';

export class Cdb64RootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private reader: Cdb64Reader;
  private cdbPath: string;
  private initialized = false;
  private initError: Error | null = null;

  constructor({ log, cdbPath }: { log: winston.Logger; cdbPath: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.cdbPath = cdbPath;
    this.reader = new Cdb64Reader(cdbPath);
  }

  /**
   * Initializes the reader by opening the CDB64 file.
   * Called lazily on first lookup.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      if (this.initError) {
        throw this.initError;
      }
      return;
    }

    try {
      await this.reader.open();
      this.initialized = true;
      this.log.info('CDB64 root TX index initialized', {
        path: this.cdbPath,
      });
    } catch (error: any) {
      this.initialized = true;
      this.initError = error;
      this.log.error('Failed to initialize CDB64 root TX index', {
        path: this.cdbPath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Looks up a data item ID and returns its root transaction information.
   *
   * @param id - Base64URL-encoded data item ID (43 characters)
   * @returns Root TX info if found, undefined otherwise
   */
  async getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    try {
      await this.ensureInitialized();
    } catch {
      // If initialization failed, return undefined to allow fallback
      return undefined;
    }

    try {
      // Convert base64url ID to 32-byte binary key
      const keyBuffer = fromB64Url(id);

      if (keyBuffer.length !== 32) {
        this.log.debug('Invalid data item ID length', {
          id,
          length: keyBuffer.length,
        });
        return undefined;
      }

      // Look up in CDB64
      const valueBuffer = await this.reader.get(keyBuffer);

      if (valueBuffer === undefined) {
        return undefined;
      }

      // Decode MessagePack value
      const value = decodeCdb64Value(valueBuffer);

      // Convert binary rootTxId back to base64url
      const rootTxId = toB64Url(value.rootTxId);

      // Return result based on value format
      if (isCompleteValue(value)) {
        return {
          rootTxId,
          rootOffset: value.rootDataItemOffset,
          rootDataOffset: value.rootDataOffset,
        };
      }

      // Simple format - no offset information
      return {
        rootTxId,
      };
    } catch (error: any) {
      this.log.error('Error looking up root TX in CDB64', {
        id,
        error: error.message,
      });
      return undefined;
    }
  }

  /**
   * Closes the CDB64 file handle.
   * Should be called during shutdown.
   */
  async close(): Promise<void> {
    if (this.reader.isOpen()) {
      await this.reader.close();
      this.log.info('CDB64 root TX index closed');
    }
  }
}
