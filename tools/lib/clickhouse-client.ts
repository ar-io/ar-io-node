/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ClickHouseClient, createClient } from '@clickhouse/client';

// Shape of the JSON response from ClickHouse for SELECT queries. Row fields are
// query-dependent; call sites read them loosely rather than typing each query.
interface ClickHouseJsonResult<TRow = any> {
  data: TRow[];
}

interface DriveCount {
  driveId: string;
  transactionCount: number;
}

interface OwnerCount {
  ownerAddress: string;
  transactionCount: number;
}

interface ClickHouseConfig {
  url: string;
  user?: string;
  password?: string;
}

export class ClickHouseAnalysisClient {
  private client: ClickHouseClient;

  constructor(config: ClickHouseConfig) {
    this.client = createClient({
      url: config.url,
      username: config.user || 'default',
      password: config.password || '',
    });
  }

  /**
   * Get transaction counts by Drive-Id tag
   */
  async getDriveTransactionCounts(minTransactionCount: number = 1): Promise<DriveCount[]> {
    // Drive-Id tag is typically hex-encoded in ClickHouse
    const driveIdTagHex = Buffer.from('Drive-Id').toString('hex');

    // Use a more robust query that handles the array types correctly
    const query = `
      SELECT
        hex(tag_value) as drive_id_hex,
        COUNT(*) as transaction_count
      FROM (
        SELECT
          arrayJoin(tags) as tag_pair,
          tag_pair.1 as tag_name,
          tag_pair.2 as tag_value
        FROM transactions
        WHERE length(tags) > 0
      )
      WHERE hex(tag_name) = '${driveIdTagHex.toUpperCase()}'
        AND tag_value != ''
      GROUP BY tag_value
      HAVING transaction_count >= ${minTransactionCount}
      ORDER BY transaction_count DESC
    `;

    console.log('🔍 Querying ClickHouse for Drive-Id transaction counts...');

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;

      return data.data.map((row: any) => ({
        driveId: this.hexToString(row.drive_id_hex),
        transactionCount: parseInt(row.transaction_count, 10),
      }));
    } catch (error) {
      console.error('Error querying Drive-Id counts:', error);
      throw error;
    }
  }

  /**
   * Get transaction counts by owner address
   */
  async getOwnerTransactionCounts(minTransactionCount: number = 1): Promise<OwnerCount[]> {
    // There is no dedicated owner_transactions table in the current
    // ClickHouse schema — aggregate directly from `transactions`.
    const query = `
      SELECT
        hex(owner_address) as owner_address_hex,
        COUNT(*) as transaction_count
      FROM transactions
      WHERE length(owner_address) > 0
      GROUP BY owner_address
      HAVING transaction_count >= ${minTransactionCount}
      ORDER BY transaction_count DESC
    `;

    console.log('🔍 Querying ClickHouse for owner transaction counts...');

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;

      return data.data.map((row: any) => ({
        ownerAddress: row.owner_address_hex,
        transactionCount: parseInt(row.transaction_count, 10),
      }));
    } catch (error) {
      console.error('Error querying owner counts:', error);
      throw error;
    }
  }

  /**
   * Get transaction count for a specific Drive-Id
   */
  async getDriveTransactionCount(driveId: string): Promise<number> {
    const driveIdHex = Buffer.from(driveId).toString('hex');
    const driveIdTagHex = Buffer.from('Drive-Id').toString('hex');

    const query = `
      SELECT COUNT(*) as transaction_count
      FROM (
        SELECT *
        FROM transactions
        WHERE arrayExists(tag_pair -> (hex(tag_pair.1) = '${driveIdTagHex.toUpperCase()}' AND hex(tag_pair.2) = '${driveIdHex.toUpperCase()}'), tags)
      )
    `;

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;
      return parseInt(data.data[0]?.transaction_count || '0', 10);
    } catch (error) {
      console.error(`Error getting transaction count for drive ${driveId}:`, error);
      return 0;
    }
  }

  /**
   * Get transaction count for a specific owner address
   */
  async getOwnerTransactionCount(ownerAddress: string): Promise<number> {
    const query = `
      SELECT COUNT(*) as transaction_count
      FROM transactions
      WHERE hex(owner_address) = '${ownerAddress.replace(/^0x/, '').toUpperCase()}'
    `;

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;
      return parseInt(data.data[0]?.transaction_count || '0', 10);
    } catch (error) {
      console.error(`Error getting transaction count for owner ${ownerAddress}:`, error);
      return 0;
    }
  }

  /**
   * Get all unique Drive-Ids in the database
   */
  async getAllDriveIds(): Promise<string[]> {
    const driveIdTagHex = Buffer.from('Drive-Id').toString('hex');

    const query = `
      SELECT DISTINCT hex(arrayFirst(x -> x.1 = unhex('${driveIdTagHex}'), tags).2) as drive_id_hex
      FROM transactions
      WHERE has(tags, tuple(unhex('${driveIdTagHex}'), anyHeavy(arrayMap(x -> x.2, arrayFilter(y -> y.1 = unhex('${driveIdTagHex}'), tags)))))
        AND drive_id_hex != ''
      ORDER BY drive_id_hex
    `;

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;
      return data.data.map((row: any) => this.hexToString(row.drive_id_hex));
    } catch (error) {
      console.error('Error getting all Drive-Ids:', error);
      return [];
    }
  }

  /**
   * Get all unique owner addresses in the database
   */
  async getAllOwners(): Promise<string[]> {
    const query = `
      SELECT DISTINCT hex(owner_address) as owner_address_hex
      FROM transactions
      WHERE length(owner_address) > 0
      ORDER BY owner_address_hex
    `;

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;
      return data.data.map((row: any) => row.owner_address_hex);
    } catch (error) {
      console.error('Error getting all owners:', error);
      return [];
    }
  }

  /**
   * Test ClickHouse connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.client.query({ query: 'SELECT 1 as test' });
      const data = (await result.json()) as ClickHouseJsonResult;
      // ClickHouse's JSON format stringifies numeric columns by default, so
      // compare after coercion rather than with a strict `=== 1`.
      return Number(data.data[0]?.test) === 1;
    } catch (error) {
      console.error('ClickHouse connection test failed:', error);
      return false;
    }
  }

  /**
   * Get the height range available in ClickHouse
   */
  async getHeightRange(): Promise<{ minHeight: number; maxHeight: number }> {
    try {
      const query = `
        SELECT
          MIN(height) as min_height,
          MAX(height) as max_height
        FROM transactions
        WHERE height IS NOT NULL AND height > 0
      `;

      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;

      const minHeight = parseInt(data.data[0]?.min_height || '0', 10);
      const maxHeight = parseInt(data.data[0]?.max_height || '0', 10);

      return { minHeight, maxHeight };
    } catch (error) {
      console.error('Error getting height range:', error);
      return { minHeight: 0, maxHeight: 0 };
    }
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{
    totalTransactions: number;
    totalDrives: number;
    totalOwners: number;
    avgTransactionsPerDrive: number;
    avgTransactionsPerOwner: number;
    heightRange: { minHeight: number; maxHeight: number };
  }> {
    try {
      // Get total transactions
      const totalResult = await this.client.query({
        query: 'SELECT COUNT(*) as total FROM transactions'
      });
      const totalData = (await totalResult.json()) as ClickHouseJsonResult;
      const totalTransactions = parseInt(totalData.data[0]?.total || '0', 10);

      // Get drive count (this is an approximation)
      const driveIdTagHex = Buffer.from('Drive-Id').toString('hex');
      const driveResult = await this.client.query({
        query: `
          SELECT COUNT(DISTINCT tag_value) as drive_count
          FROM (
            SELECT
              arrayJoin(tags) as tag_pair,
              tag_pair.1 as tag_name,
              tag_pair.2 as tag_value
            FROM transactions
            WHERE length(tags) > 0
          )
          WHERE hex(tag_name) = '${driveIdTagHex.toUpperCase()}'
            AND tag_value != ''
        `
      });
      const driveData = (await driveResult.json()) as ClickHouseJsonResult;
      const totalDrives = parseInt(driveData.data[0]?.drive_count || '0', 10);

      // Get owner count
      const ownerResult = await this.client.query({
        query: 'SELECT COUNT(DISTINCT owner_address) as owner_count FROM transactions WHERE length(owner_address) > 0'
      });
      const ownerData = (await ownerResult.json()) as ClickHouseJsonResult;
      const totalOwners = parseInt(ownerData.data[0]?.owner_count || '0', 10);

      // Get height range
      const heightRange = await this.getHeightRange();

      return {
        totalTransactions,
        totalDrives,
        totalOwners,
        avgTransactionsPerDrive: totalDrives > 0 ? totalTransactions / totalDrives : 0,
        avgTransactionsPerOwner: totalOwners > 0 ? totalTransactions / totalOwners : 0,
        heightRange,
      };
    } catch (error) {
      console.error('Error getting database stats:', error);
      return {
        totalTransactions: 0,
        totalDrives: 0,
        totalOwners: 0,
        avgTransactionsPerDrive: 0,
        avgTransactionsPerOwner: 0,
        heightRange: { minHeight: 0, maxHeight: 0 },
      };
    }
  }

  /**
   * Convert hex string to UTF-8 string, handling potential encoding issues
   */
  private hexToString(hex: string): string {
    try {
      // Remove any '0x' prefix and ensure even length
      const cleanHex = hex.replace(/^0x/, '');
      if (cleanHex.length % 2 !== 0) {
        return cleanHex; // Return as-is if odd length
      }

      const bytes = Buffer.from(cleanHex, 'hex');
      return bytes.toString('utf-8');
    } catch (error) {
      // If conversion fails, return the hex string as-is
      return hex;
    }
  }

  /**
   * Get transaction IDs for a specific Drive-Id
   */
  async getDriveTransactionIds(driveId: string): Promise<string[]> {
    const driveIdHex = Buffer.from(driveId).toString('hex');
    const driveIdTagHex = Buffer.from('Drive-Id').toString('hex');

    const query = `
      SELECT DISTINCT hex(id) as transaction_id
      FROM transactions
      WHERE arrayExists(tag_pair -> (hex(tag_pair.1) = '${driveIdTagHex.toUpperCase()}' AND hex(tag_pair.2) = '${driveIdHex.toUpperCase()}'), tags)
      ORDER BY transaction_id
    `;

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;
      return data.data.map((row: any) => row.transaction_id);
    } catch (error) {
      console.error(`Error getting transaction IDs for drive ${driveId}:`, error);
      return [];
    }
  }

  /**
   * Get transaction IDs for a specific owner address
   */
  async getOwnerTransactionIds(ownerAddress: string): Promise<string[]> {
    const query = `
      SELECT DISTINCT hex(id) as transaction_id
      FROM transactions
      WHERE hex(owner_address) = '${ownerAddress.replace(/^0x/, '').toUpperCase()}'
      ORDER BY transaction_id
    `;

    try {
      const result = await this.client.query({ query });
      const data = (await result.json()) as ClickHouseJsonResult;
      return data.data.map((row: any) => row.transaction_id);
    } catch (error) {
      console.error(`Error getting transaction IDs for owner ${ownerAddress}:`, error);
      return [];
    }
  }

  /**
   * Check for duplicate transaction IDs in ClickHouse
   */
  async checkDuplicateTransactions(transactionIds?: string[]): Promise<Array<{
    transactionId: string;
    count: number;
    tables: string[];
  }>> {
    try {
      let whereClause = '';
      if (transactionIds && transactionIds.length > 0) {
        const hexIds = transactionIds.map(id => `'${id.replace(/^0x/, '').toUpperCase()}'`).join(', ');
        whereClause = `WHERE hex(id) IN (${hexIds})`;
      }

      // Only the `transactions` table is canonical in the current schema, so
      // duplicate detection reduces to "is id duplicated within transactions".
      const transactionsQuery = `
        SELECT
          hex(id) as transaction_id,
          COUNT(*) as count
        FROM transactions
        ${whereClause}
        GROUP BY id
        HAVING count > 1
        ORDER BY count DESC
      `;

      const transactionsResult = await this.client.query({ query: transactionsQuery });
      const transactionsData = (await transactionsResult.json()) as ClickHouseJsonResult;

      return transactionsData.data.map((row: any) => ({
        transactionId: row.transaction_id,
        count: parseInt(row.count, 10),
        tables: ['transactions'],
      }));
    } catch (error) {
      console.error('Error checking for duplicate transactions:', error);
      return [];
    }
  }


  /**
   * Close the ClickHouse client connection
   */
  async close(): Promise<void> {
    await this.client.close();
  }
}

export type { DriveCount, OwnerCount, ClickHouseConfig };