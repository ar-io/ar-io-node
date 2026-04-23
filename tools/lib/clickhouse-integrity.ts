/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { GraphQLTransaction } from './graphql-client.js';
import type { ClickHouseAnalysisClient } from './clickhouse-client.js';

interface DatabaseIntegrityResult {
  clickhouseDuplicates: Array<{
    transactionId: string;
    count: number;
    tables: string[];
    severity: 'critical' | 'warning';
  }>;
  graphqlToClickhouseMissing: Array<{
    transactionId: string;
    source: 'local' | 'remote' | 'both';
    height?: number;
    severity: 'critical' | 'warning';
  }>;
  clickhouseToGraphqlMissing: Array<{
    transactionId: string;
    target: 'local' | 'remote' | 'both';
    severity: 'critical' | 'warning';
  }>;
  summary: {
    totalClickhouseDuplicates: number;
    totalGraphqlToClickhouseMissing: number;
    totalClickhouseToGraphqlMissing: number;
    criticalIssues: number;
    warningIssues: number;
  };
}

interface IntegrityCheckOptions {
  enableDuplicateCheck?: boolean;
  enableMissingCheck?: boolean;
  sampleSize?: number;
  checkRemoteGraphql?: boolean;
}

export class ClickHouseIntegrityCheck {
  private clickhouseClient: ClickHouseAnalysisClient;
  private options: IntegrityCheckOptions;

  constructor(clickhouseClient: ClickHouseAnalysisClient, options: IntegrityCheckOptions = {}) {
    this.clickhouseClient = clickhouseClient;
    this.options = {
      enableDuplicateCheck: true,
      enableMissingCheck: true,
      sampleSize: 1000,
      checkRemoteGraphql: true,
      ...options,
    };
  }

  /**
   * Perform comprehensive database integrity check
   */
  async checkIntegrity(
    entity: { type: 'drive' | 'owner'; id: string },
    localTransactions: GraphQLTransaction[],
    remoteTransactions: GraphQLTransaction[]
  ): Promise<DatabaseIntegrityResult> {
    console.log(`   🔍 Checking ClickHouse database integrity for ${entity.type} ${entity.id}...`);

    const result: DatabaseIntegrityResult = {
      clickhouseDuplicates: [],
      graphqlToClickhouseMissing: [],
      clickhouseToGraphqlMissing: [],
      summary: {
        totalClickhouseDuplicates: 0,
        totalGraphqlToClickhouseMissing: 0,
        totalClickhouseToGraphqlMissing: 0,
        criticalIssues: 0,
        warningIssues: 0,
      },
    };

    try {
      // Get ClickHouse transaction IDs for this entity
      const clickhouseTransactionIds = await this.getClickhouseTransactionIds(entity);
      console.log(`   📊 Found ${clickhouseTransactionIds.length} transactions in ClickHouse for ${entity.type} ${entity.id}`);

      // Check for duplicates in ClickHouse
      if (this.options.enableDuplicateCheck) {
        result.clickhouseDuplicates = await this.checkClickhouseDuplicates(clickhouseTransactionIds);
      }

      // Check for missing transactions between GraphQL and ClickHouse
      if (this.options.enableMissingCheck) {
        const { graphqlToClickhouseMissing, clickhouseToGraphqlMissing } = await this.checkMissingTransactions(
          clickhouseTransactionIds,
          localTransactions,
          remoteTransactions
        );
        result.graphqlToClickhouseMissing = graphqlToClickhouseMissing;
        result.clickhouseToGraphqlMissing = clickhouseToGraphqlMissing;
      }

      // Calculate summary
      this.calculateSummary(result);

      console.log(`   ✅ Database integrity check complete: ${result.summary.criticalIssues} critical, ${result.summary.warningIssues} warnings`);

    } catch (error) {
      console.error(`   ❌ Database integrity check failed: ${error}`);
      // Add error to result
      result.summary.criticalIssues = 1;
    }

    return result;
  }

  /**
   * Get transaction IDs from ClickHouse for the specified entity
   */
  private async getClickhouseTransactionIds(entity: { type: 'drive' | 'owner'; id: string }): Promise<string[]> {
    if (entity.type === 'drive') {
      return this.clickhouseClient.getDriveTransactionIds(entity.id);
    } else {
      return this.clickhouseClient.getOwnerTransactionIds(entity.id);
    }
  }

  /**
   * Check for duplicate transactions in ClickHouse
   */
  private async checkClickhouseDuplicates(transactionIds: string[]): Promise<Array<{
    transactionId: string;
    count: number;
    tables: string[];
    severity: 'critical' | 'warning';
  }>> {
    console.log(`   🔍 Checking for duplicates in ClickHouse...`);

    // Sample transaction IDs if too many
    const sampled = this.sampleTransactionIds(transactionIds);
    const duplicates = await this.clickhouseClient.checkDuplicateTransactions(sampled);

    return duplicates.map(dup => ({
      ...dup,
      severity: (dup.count > 2 || dup.tables.length > 1) ? 'critical' as const : 'warning' as const,
    }));
  }

  /**
   * Check for missing transactions between GraphQL and ClickHouse
   */
  private async checkMissingTransactions(
    clickhouseTransactionIds: string[],
    localTransactions: GraphQLTransaction[],
    remoteTransactions: GraphQLTransaction[]
  ): Promise<{
    graphqlToClickhouseMissing: Array<{
      transactionId: string;
      source: 'local' | 'remote' | 'both';
      height?: number;
      severity: 'critical' | 'warning';
    }>;
    clickhouseToGraphqlMissing: Array<{
      transactionId: string;
      target: 'local' | 'remote' | 'both';
      severity: 'critical' | 'warning';
    }>;
  }> {
    console.log(`   🔍 Checking for missing transactions between GraphQL and ClickHouse...`);

    const clickhouseSet = new Set(clickhouseTransactionIds.map(id => id.toLowerCase()));
    const localSet = new Set(localTransactions.map(tx => tx.id.toLowerCase()));
    const remoteSet = new Set(remoteTransactions.map(tx => tx.id.toLowerCase()));

    const graphqlToClickhouseMissing: Array<{
      transactionId: string;
      source: 'local' | 'remote' | 'both';
      height?: number;
      severity: 'critical' | 'warning';
    }> = [];

    const clickhouseToGraphqlMissing: Array<{
      transactionId: string;
      target: 'local' | 'remote' | 'both';
      severity: 'critical' | 'warning';
    }> = [];

    // Find transactions in GraphQL but missing from ClickHouse
    for (const tx of localTransactions) {
      if (!clickhouseSet.has(tx.id.toLowerCase())) {
        const inRemote = remoteSet.has(tx.id.toLowerCase());
        graphqlToClickhouseMissing.push({
          transactionId: tx.id,
          source: inRemote ? 'both' : 'local',
          height: tx.block?.height,
          severity: inRemote ? 'critical' : 'warning', // Critical if both GraphQL endpoints have it
        });
      }
    }

    // Add remote-only transactions missing from ClickHouse
    for (const tx of remoteTransactions) {
      if (!clickhouseSet.has(tx.id.toLowerCase()) && !localSet.has(tx.id.toLowerCase())) {
        graphqlToClickhouseMissing.push({
          transactionId: tx.id,
          source: 'remote',
          height: tx.block?.height,
          severity: 'warning',
        });
      }
    }

    // Find transactions in ClickHouse but missing from GraphQL (sample to avoid performance issues)
    const sampledClickhouseIds = this.sampleTransactionIds(clickhouseTransactionIds);
    for (const txId of sampledClickhouseIds) {
      const inLocal = localSet.has(txId.toLowerCase());
      const inRemote = remoteSet.has(txId.toLowerCase());

      if (!inLocal && !inRemote) {
        clickhouseToGraphqlMissing.push({
          transactionId: txId,
          target: 'both',
          severity: 'critical',
        });
      } else if (!inLocal) {
        clickhouseToGraphqlMissing.push({
          transactionId: txId,
          target: 'local',
          severity: 'warning',
        });
      } else if (!inRemote && this.options.checkRemoteGraphql) {
        clickhouseToGraphqlMissing.push({
          transactionId: txId,
          target: 'remote',
          severity: 'warning',
        });
      }
    }

    return { graphqlToClickhouseMissing, clickhouseToGraphqlMissing };
  }

  /**
   * Sample transaction IDs to limit the scope of checks for performance
   */
  private sampleTransactionIds(transactionIds: string[]): string[] {
    if (!this.options.sampleSize || transactionIds.length <= this.options.sampleSize) {
      return transactionIds;
    }

    // Simple random sampling
    const sampled: string[] = [];
    const step = Math.floor(transactionIds.length / this.options.sampleSize);

    for (let i = 0; i < transactionIds.length; i += step) {
      sampled.push(transactionIds[i]);
      if (sampled.length >= this.options.sampleSize) break;
    }

    return sampled;
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(result: DatabaseIntegrityResult): void {
    result.summary.totalClickhouseDuplicates = result.clickhouseDuplicates.length;
    result.summary.totalGraphqlToClickhouseMissing = result.graphqlToClickhouseMissing.length;
    result.summary.totalClickhouseToGraphqlMissing = result.clickhouseToGraphqlMissing.length;

    result.summary.criticalIssues = [
      ...result.clickhouseDuplicates,
      ...result.graphqlToClickhouseMissing,
      ...result.clickhouseToGraphqlMissing,
    ].filter(issue => issue.severity === 'critical').length;

    result.summary.warningIssues = [
      ...result.clickhouseDuplicates,
      ...result.graphqlToClickhouseMissing,
      ...result.clickhouseToGraphqlMissing,
    ].filter(issue => issue.severity === 'warning').length;
  }

  /**
   * Generate human-readable report of database integrity issues
   */
  generateReport(result: DatabaseIntegrityResult): string {
    const lines: string[] = [];

    lines.push('=== ClickHouse Database Integrity Report ===');
    lines.push('');

    // Summary
    lines.push('Summary:');
    lines.push(`  ClickHouse Duplicates: ${result.summary.totalClickhouseDuplicates}`);
    lines.push(`  GraphQL→ClickHouse Missing: ${result.summary.totalGraphqlToClickhouseMissing}`);
    lines.push(`  ClickHouse→GraphQL Missing: ${result.summary.totalClickhouseToGraphqlMissing}`);
    lines.push(`  Critical Issues: ${result.summary.criticalIssues}`);
    lines.push(`  Warning Issues: ${result.summary.warningIssues}`);
    lines.push('');

    // ClickHouse Duplicates
    if (result.clickhouseDuplicates.length > 0) {
      lines.push('ClickHouse Duplicates:');
      for (const dup of result.clickhouseDuplicates) {
        lines.push(`  [${dup.severity.toUpperCase()}] ${dup.transactionId}: ${dup.count} copies in [${dup.tables.join(', ')}]`);
      }
      lines.push('');
    }

    // GraphQL→ClickHouse Missing
    if (result.graphqlToClickhouseMissing.length > 0) {
      lines.push('Transactions in GraphQL but missing from ClickHouse:');
      for (const missing of result.graphqlToClickhouseMissing) {
        const heightStr = missing.height ? ` (height ${missing.height})` : '';
        lines.push(`  [${missing.severity.toUpperCase()}] ${missing.transactionId}: in ${missing.source} GraphQL${heightStr}`);
      }
      lines.push('');
    }

    // ClickHouse→GraphQL Missing
    if (result.clickhouseToGraphqlMissing.length > 0) {
      lines.push('Transactions in ClickHouse but missing from GraphQL:');
      for (const missing of result.clickhouseToGraphqlMissing) {
        lines.push(`  [${missing.severity.toUpperCase()}] ${missing.transactionId}: missing from ${missing.target} GraphQL`);
      }
      lines.push('');
    }

    if (result.summary.criticalIssues === 0 && result.summary.warningIssues === 0) {
      lines.push('✅ No database integrity issues found!');
    }

    return lines.join('\n');
  }
}

export type { DatabaseIntegrityResult, IntegrityCheckOptions };