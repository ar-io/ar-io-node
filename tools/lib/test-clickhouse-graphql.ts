/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ClickHouseAnalysisClient, type DriveCount, type OwnerCount } from './clickhouse-client.js';
import { GraphQLClient, type GraphQLTransaction } from './graphql-client.js';
import { ComparisonEngine } from './comparison-engine.js';
import { ClickHouseIntegrityCheck, type DatabaseIntegrityResult } from './clickhouse-integrity.js';

// The bash wrapper cd's to the repo root before exec, so process.cwd() is
// the project root and relative paths below resolve there.

// Types
interface TestConfig {
  clickhouse: {
    url: string;
    user?: string;
    password?: string;
  };
  endpoints: {
    local: string;
    remote: string;
  };
  discovery: {
    topDrives: number;
    topOwners: number;
    minTransactionCount: number;
  };
  testing: {
    pageSize: number;
    maxPagesPerTest: number;
    testBothDirections: boolean;
    maxTransactionsPerEntity?: number;
    allowPartialComparisons?: boolean;
  };
  databaseIntegrity?: {
    enabled?: boolean;
    enableDuplicateCheck?: boolean;
    enableMissingCheck?: boolean;
    sampleSize?: number;
    checkRemoteGraphql?: boolean;
  };
}

interface TestResult {
  entity: {
    type: 'drive' | 'owner';
    id: string;
    transactionCount: number;
  };
  comparison: {
    local: {
      totalFound: number;
      queryTime: number;
      pagesQueried: number;
    };
    remote: {
      totalFound: number;
      queryTime: number;
      pagesQueried: number;
    };
  };
  issues: {
    duplicates: Array<{
      transactionId: string;
      occurrences: number;
      source: 'local' | 'remote' | 'both';
    }>;
    missing: Array<{
      transactionId: string;
      presentIn: 'local' | 'remote';
      height: number;
      tags: Array<{ name: string; value: string }>;
    }>;
    discrepancies: Array<{
      transactionId: string;
      field: string;
      localValue: any;
      remoteValue: any;
      severity: 'critical' | 'minor' | 'informational';
    }>;
  };
  pagination: {
    ascending: {
      tested: boolean;
      consistent: boolean;
      errors: string[];
    };
    descending: {
      tested: boolean;
      consistent: boolean;
      errors: string[];
    };
  };
  databaseIntegrity?: DatabaseIntegrityResult;
  completeness: {
    isComplete: boolean;
    maxFetchableTransactions: number;
    localCoverage: number; // percentage (0-100)
    remoteCoverage: number; // percentage (0-100)
    explanation: string;
  };
}

// DriveCount and OwnerCount are imported from clickhouse-client

// Load environment variables with defaults.
// Canonical env var names match the rest of the project (see docker-compose.yaml
// and tools/queue-missing-bundles): CORE_PORT, CLICKHOUSE_HOST, CLICKHOUSE_PORT_2,
// CLICKHOUSE_USER, CLICKHOUSE_PASSWORD.
function getDefaultConfig(): TestConfig {
  const corePort = process.env.CORE_PORT ?? '4000';
  const clickhouseHost = process.env.CLICKHOUSE_HOST ?? 'localhost';
  const clickhousePort = process.env.CLICKHOUSE_PORT_2 ?? '8123';

  return {
    clickhouse: {
      url: `http://${clickhouseHost}:${clickhousePort}`,
      user: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
    },
    endpoints: {
      local: `http://localhost:${corePort}/graphql`,
      remote: 'https://arweave.net/graphql',
    },
    discovery: {
      topDrives: parseInt(process.env.TOP_DRIVES || '10', 10),
      topOwners: parseInt(process.env.TOP_OWNERS || '10', 10),
      minTransactionCount: parseInt(process.env.MIN_TRANSACTION_COUNT || '100', 10),
    },
    testing: {
      pageSize: parseInt(process.env.PAGE_SIZE || '100', 10),
      maxPagesPerTest: parseInt(process.env.MAX_PAGES_PER_TEST || '100', 10), // Increased default for better coverage
      testBothDirections: process.env.TEST_BOTH_DIRECTIONS !== 'false',
      maxTransactionsPerEntity: process.env.MAX_TRANSACTIONS_PER_ENTITY ?
        parseInt(process.env.MAX_TRANSACTIONS_PER_ENTITY, 10) : undefined,
      allowPartialComparisons: process.env.ALLOW_PARTIAL_COMPARISONS === 'true',
    },
    databaseIntegrity: {
      enabled: process.env.DATABASE_INTEGRITY_ENABLED !== 'false',
      enableDuplicateCheck: process.env.DATABASE_INTEGRITY_DUPLICATE_CHECK !== 'false',
      enableMissingCheck: process.env.DATABASE_INTEGRITY_MISSING_CHECK !== 'false',
      sampleSize: parseInt(process.env.DATABASE_INTEGRITY_SAMPLE_SIZE || '1000', 10),
      checkRemoteGraphql: process.env.DATABASE_INTEGRITY_CHECK_REMOTE !== 'false',
    },
  };
}

class ClickHouseGraphQLTester {
  private config: TestConfig;
  private outputDir: string;
  private clickhouseClient: ClickHouseAnalysisClient;
  private localGraphQLClient: GraphQLClient;
  private remoteGraphQLClient: GraphQLClient;
  private comparisonEngine: ComparisonEngine;
  private integrityChecker?: ClickHouseIntegrityCheck;

  constructor(config: TestConfig, verbose: boolean = false) {
    this.config = config;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '-' +
                     new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
    this.outputDir = path.join(process.cwd(), 'test-results', 'runs', timestamp);

    // Initialize clients
    this.clickhouseClient = new ClickHouseAnalysisClient(config.clickhouse);
    this.localGraphQLClient = new GraphQLClient(config.endpoints.local, 30000, verbose);
    this.remoteGraphQLClient = new GraphQLClient(config.endpoints.remote, 30000, verbose);
    this.comparisonEngine = new ComparisonEngine({
      strictComparison: false,
      checkOwnerKeys: false,
      tolerateTimestampDifference: 1000,
    });

    // Initialize database integrity checker if enabled
    if (config.databaseIntegrity?.enabled) {
      this.integrityChecker = new ClickHouseIntegrityCheck(this.clickhouseClient, {
        enableDuplicateCheck: config.databaseIntegrity.enableDuplicateCheck,
        enableMissingCheck: config.databaseIntegrity.enableMissingCheck,
        sampleSize: config.databaseIntegrity.sampleSize,
        checkRemoteGraphql: config.databaseIntegrity.checkRemoteGraphql,
      });
    }
  }

  async initialize(): Promise<void> {
    // Test connections first
    console.log('🔌 Testing connections...');

    const clickhouseOk = await this.clickhouseClient.testConnection();
    const localOk = await this.localGraphQLClient.testConnection();
    const remoteOk = await this.remoteGraphQLClient.testConnection();

    if (!clickhouseOk) {
      throw new Error('❌ ClickHouse connection failed');
    }
    if (!localOk) {
      throw new Error('❌ Local GraphQL endpoint connection failed');
    }
    if (!remoteOk) {
      throw new Error('❌ Remote GraphQL endpoint connection failed');
    }

    console.log('✅ All connections successful');

    // Create output directory structure
    await fs.mkdir(this.outputDir, { recursive: true });
    await fs.mkdir(path.join(this.outputDir, 'discovery'), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, 'tests', 'drives'), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, 'tests', 'owners'), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, 'comparisons'), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, 'database-integrity'), { recursive: true });

    // Save config snapshot
    await fs.writeFile(
      path.join(this.outputDir, 'config.json'),
      JSON.stringify(this.config, null, 2)
    );

    // Create/update latest symlink
    const latestPath = path.join(process.cwd(), 'test-results', 'latest');
    try {
      await fs.unlink(latestPath);
    } catch {
      // Ignore if symlink doesn't exist
    }
    await fs.symlink(this.outputDir, latestPath);

    console.log(`✓ Initialized test run in: ${this.outputDir}`);
  }

  /**
   * Calculate the maximum number of transactions we can fetch for complete comparison
   */
  private getMaxFetchableTransactions(): number {
    // Use explicit config value if set, otherwise calculate from page settings
    return this.config.testing.maxTransactionsPerEntity ||
           (this.config.testing.pageSize * this.config.testing.maxPagesPerTest);
  }

  /**
   * Filter entities to only include those where we can fetch all transactions
   */
  private filterCompletableEntities<T extends { transactionCount: number }>(
    entities: T[],
    entityType: string
  ): { complete: T[]; filtered: T[] } {
    if (this.config.testing.allowPartialComparisons) {
      return { complete: entities, filtered: [] };
    }

    const maxFetchable = this.getMaxFetchableTransactions();
    const complete = entities.filter(e => e.transactionCount <= maxFetchable);
    const filtered = entities.filter(e => e.transactionCount > maxFetchable);

    if (filtered.length > 0) {
      console.log(`   ⚠️  Filtered out ${filtered.length} ${entityType}s with > ${maxFetchable} transactions (incomplete comparison)`);
      console.log(`   📊 Use --allow-partial or increase maxPagesPerTest to include them`);
    }

    return { complete, filtered };
  }

  async discoverEntities(): Promise<{ drives: DriveCount[]; owners: OwnerCount[] }> {
    console.log('\n📊 Discovering entities by transaction count...');

    // Get database statistics first
    const stats = await this.clickhouseClient.getStats();
    console.log(`   📈 Database stats: ${stats.totalTransactions} transactions, ~${stats.totalDrives} drives, ${stats.totalOwners} owners`);
    console.log(`   📊 ClickHouse height range: ${stats.heightRange.minHeight} - ${stats.heightRange.maxHeight}`);

    // Get drive transaction counts
    console.log('   🔍 Querying Drive-Id transaction counts...');
    const allDrives = await this.clickhouseClient.getDriveTransactionCounts(this.config.discovery.minTransactionCount);
    console.log(`   ✓ Found ${allDrives.length} drives with >= ${this.config.discovery.minTransactionCount} transactions`);

    // Filter drives for complete comparison
    const driveFilter = this.filterCompletableEntities(allDrives, 'drive');
    const drives = driveFilter.complete;

    // Get owner transaction counts
    console.log('   🔍 Querying owner transaction counts...');
    const allOwners = await this.clickhouseClient.getOwnerTransactionCounts(this.config.discovery.minTransactionCount);
    console.log(`   ✓ Found ${allOwners.length} owners with >= ${this.config.discovery.minTransactionCount} transactions`);

    // Filter owners for complete comparison
    const ownerFilter = this.filterCompletableEntities(allOwners, 'owner');
    const owners = ownerFilter.complete;

    // Save discovery results
    await fs.writeFile(
      path.join(this.outputDir, 'discovery', 'drive-counts.json'),
      JSON.stringify(drives, null, 2)
    );
    await fs.writeFile(
      path.join(this.outputDir, 'discovery', 'owner-counts.json'),
      JSON.stringify(owners, null, 2)
    );

    // Save filtered entities for reference
    if (driveFilter.filtered.length > 0) {
      await fs.writeFile(
        path.join(this.outputDir, 'discovery', 'drive-counts-filtered.json'),
        JSON.stringify(driveFilter.filtered, null, 2)
      );
    }
    if (ownerFilter.filtered.length > 0) {
      await fs.writeFile(
        path.join(this.outputDir, 'discovery', 'owner-counts-filtered.json'),
        JSON.stringify(ownerFilter.filtered, null, 2)
      );
    }

    const maxFetchable = this.getMaxFetchableTransactions();
    const summary = {
      databaseStats: stats,
      maxFetchableTransactions: maxFetchable,
      allowPartialComparisons: this.config.testing.allowPartialComparisons,
      totalDrives: drives.length,
      totalOwners: owners.length,
      filteredDrives: driveFilter.filtered.length,
      filteredOwners: ownerFilter.filtered.length,
      topDrives: drives.slice(0, this.config.discovery.topDrives),
      topOwners: owners.slice(0, this.config.discovery.topOwners),
      timestamp: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(this.outputDir, 'discovery', 'summary.json'),
      JSON.stringify(summary, null, 2)
    );

    const filterMsg = (driveFilter.filtered.length + ownerFilter.filtered.length) > 0 ?
      ` (${driveFilter.filtered.length + ownerFilter.filtered.length} filtered)` : '';
    console.log(`✓ Discovery complete: ${drives.length} drives, ${owners.length} owners${filterMsg}`);
    console.log(`   📏 Max fetchable transactions per entity: ${maxFetchable}`);

    return { drives, owners };
  }

  async testEntity(entity: { type: 'drive' | 'owner'; id: string; transactionCount: number }): Promise<TestResult> {
    console.log(`\n🧪 Testing ${entity.type}: ${entity.id} (${entity.transactionCount} transactions)`);

    // Get actual transaction count if not provided
    let actualCount = entity.transactionCount;
    if (actualCount === 0) {
      if (entity.type === 'drive') {
        actualCount = await this.clickhouseClient.getDriveTransactionCount(entity.id);
      } else {
        actualCount = await this.clickhouseClient.getOwnerTransactionCount(entity.id);
      }
      console.log(`   📊 Found ${actualCount} transactions in ClickHouse`);
    }

    const result: TestResult = {
      entity: { ...entity, transactionCount: actualCount },
      comparison: {
        local: { totalFound: 0, queryTime: 0, pagesQueried: 0 },
        remote: { totalFound: 0, queryTime: 0, pagesQueried: 0 },
      },
      issues: {
        duplicates: [],
        missing: [],
        discrepancies: [],
      },
      pagination: {
        ascending: { tested: false, consistent: true, errors: [] },
        descending: { tested: false, consistent: true, errors: [] },
      },
      completeness: {
        isComplete: false,
        maxFetchableTransactions: 0,
        localCoverage: 0,
        remoteCoverage: 0,
        explanation: '',
      },
    };

    try {
      // Get ClickHouse height range to filter queries
      const heightRange = await this.clickhouseClient.getHeightRange();
      console.log(`   📊 Filtering to ClickHouse height range: ${heightRange.minHeight} - ${heightRange.maxHeight}`);

      // Query both endpoints for all transactions
      console.log('   🔄 Querying local GraphQL endpoint...');
      const localResults = await this.queryEntityTransactions('local', entity, heightRange);
      result.comparison.local = {
        totalFound: localResults.allTransactions.length,
        queryTime: localResults.totalQueryTime,
        pagesQueried: localResults.totalPages,
      };

      console.log('   🔄 Querying remote GraphQL endpoint...');
      const remoteResults = await this.queryEntityTransactions('remote', entity, heightRange);
      result.comparison.remote = {
        totalFound: remoteResults.allTransactions.length,
        queryTime: remoteResults.totalQueryTime,
        pagesQueried: remoteResults.totalPages,
      };

      // Compare the results
      console.log('   🔍 Comparing results...');
      const comparison = this.comparisonEngine.compareTransactionSets(
        localResults.allTransactions,
        remoteResults.allTransactions
      );

      result.issues = {
        duplicates: comparison.duplicates,
        missing: comparison.missing,
        discrepancies: comparison.discrepancies,
      };

      // Calculate completeness information
      const maxFetchable = this.getMaxFetchableTransactions();
      const localCoverage = actualCount > 0 ? Math.min(100, (result.comparison.local.totalFound / actualCount) * 100) : 100;
      const remoteCoverage = actualCount > 0 ? Math.min(100, (result.comparison.remote.totalFound / actualCount) * 100) : 100;
      const isComplete = actualCount <= maxFetchable && localCoverage >= 99.9 && remoteCoverage >= 99.9;

      let explanation = '';
      if (actualCount > maxFetchable) {
        explanation = `Entity has ${actualCount} transactions, but only ${maxFetchable} can be fetched. Increase maxPagesPerTest or use --max-transactions.`;
      } else if (localCoverage < 99.9 || remoteCoverage < 99.9) {
        explanation = `Incomplete coverage: local ${localCoverage.toFixed(1)}%, remote ${remoteCoverage.toFixed(1)}%. Some transactions may not be accessible.`;
      } else {
        explanation = 'Complete comparison - all transactions fetched and compared.';
      }

      result.completeness = {
        isComplete,
        maxFetchableTransactions: maxFetchable,
        localCoverage,
        remoteCoverage,
        explanation,
      };

      // Test pagination if enabled
      if (this.config.testing.testBothDirections) {
        console.log('   🔄 Testing pagination consistency...');
        const paginationTest = await this.testPaginationForEntity(entity);
        result.pagination = paginationTest;
      }

      // Perform database integrity check if enabled
      if (this.integrityChecker) {
        console.log('   🔍 Checking database integrity...');
        const integrityResult = await this.integrityChecker.checkIntegrity(
          entity,
          localResults.allTransactions,
          remoteResults.allTransactions
        );
        result.databaseIntegrity = integrityResult;
      }

      // Save detailed transaction logs
      await this.saveTransactionDetails(entity, localResults.allTransactions, remoteResults.allTransactions);

      const totalIssues = result.issues.missing.length + result.issues.duplicates.length + result.issues.discrepancies.length;
      const dbIssues = result.databaseIntegrity ?
        (result.databaseIntegrity.summary.criticalIssues + result.databaseIntegrity.summary.warningIssues) : 0;

      const completenessIcon = result.completeness.isComplete ? '✅' : '⚠️ ';
      console.log(`   ${completenessIcon} Test complete: ${result.comparison.local.totalFound} local, ${result.comparison.remote.totalFound} remote, ${totalIssues} GraphQL issues, ${dbIssues} DB issues`);
      if (!result.completeness.isComplete) {
        console.log(`   📊 ${result.completeness.explanation}`);
      }

    } catch (error) {
      console.error(`   ❌ Test failed: ${error}`);
      result.issues.discrepancies.push({
        transactionId: 'N/A',
        field: 'test_error',
        localValue: null,
        remoteValue: null,
        severity: 'critical',
      });
    }

    // Save individual test result
    const filename = `${entity.type}_${entity.id.replace(/[^a-zA-Z0-9]/g, '_')}_test.json`;
    await fs.writeFile(
      path.join(this.outputDir, 'tests', `${entity.type}s`, filename),
      JSON.stringify(result, null, 2)
    );

    return result;
  }

  private async queryEntityTransactions(
    endpoint: 'local' | 'remote',
    entity: { type: 'drive' | 'owner'; id: string; transactionCount: number },
    heightRange?: { minHeight: number; maxHeight: number }
  ): Promise<{
    allTransactions: GraphQLTransaction[];
    totalPages: number;
    totalQueryTime: number;
  }> {
    const client = endpoint === 'local' ? this.localGraphQLClient : this.remoteGraphQLClient;
    const maxPages = this.config.testing.maxPagesPerTest;
    const pageSize = this.config.testing.pageSize;

    if (entity.type === 'drive') {
      return client.queryAllTransactions({
        driveId: entity.id,
        maxPages,
        pageSize,
        sortOrder: 'HEIGHT_DESC',
        heightRange,
      });
    } else {
      return client.queryAllTransactions({
        ownerAddress: entity.id,
        maxPages,
        pageSize,
        sortOrder: 'HEIGHT_DESC',
        heightRange,
      });
    }
  }

  private async testPaginationForEntity(entity: { type: 'drive' | 'owner'; id: string; transactionCount: number }): Promise<{
    ascending: { tested: boolean; consistent: boolean; errors: string[] };
    descending: { tested: boolean; consistent: boolean; errors: string[] };
  }> {
    const testPages = Math.min(3, this.config.testing.maxPagesPerTest);
    const pageSize = Math.min(50, this.config.testing.pageSize);

    // Get ClickHouse height range to filter queries
    const heightRange = await this.clickhouseClient.getHeightRange();

    // Test local endpoint pagination
    const localPagination = await this.localGraphQLClient.testPaginationConsistency({
      ...(entity.type === 'drive' ? { driveId: entity.id } : { ownerAddress: entity.id }),
      testPages,
      pageSize,
      heightRange,
    });

    // Test remote endpoint pagination
    const remotePagination = await this.remoteGraphQLClient.testPaginationConsistency({
      ...(entity.type === 'drive' ? { driveId: entity.id } : { ownerAddress: entity.id }),
      testPages,
      pageSize,
      heightRange,
    });

    // Combine results (both endpoints must be consistent)
    return {
      ascending: {
        tested: true,
        consistent: localPagination.ascending.consistent && remotePagination.ascending.consistent,
        errors: [
          ...localPagination.ascending.errors.map(e => `Local: ${e}`),
          ...remotePagination.ascending.errors.map(e => `Remote: ${e}`),
        ],
      },
      descending: {
        tested: true,
        consistent: localPagination.descending.consistent && remotePagination.descending.consistent,
        errors: [
          ...localPagination.descending.errors.map(e => `Local: ${e}`),
          ...remotePagination.descending.errors.map(e => `Remote: ${e}`),
        ],
      },
    };
  }

  private async saveTransactionDetails(
    entity: { type: 'drive' | 'owner'; id: string },
    localTransactions: GraphQLTransaction[],
    remoteTransactions: GraphQLTransaction[]
  ): Promise<void> {
    const filename = `${entity.type}_${entity.id.replace(/[^a-zA-Z0-9]/g, '_')}_details.jsonl`;
    const filePath = path.join(this.outputDir, 'tests', `${entity.type}s`, filename);

    const lines: string[] = [];

    // Log all local transactions
    for (const tx of localTransactions) {
      lines.push(JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'query',
        source: 'local',
        transactionId: tx.id,
        data: tx,
      }));
    }

    // Log all remote transactions
    for (const tx of remoteTransactions) {
      lines.push(JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'query',
        source: 'remote',
        transactionId: tx.id,
        data: tx,
      }));
    }

    await fs.writeFile(filePath, lines.join('\n'));
  }

  async generateReports(results: TestResult[]): Promise<void> {
    console.log('\n📋 Generating reports...');

    // Aggregate all issues
    const allDuplicates = results.flatMap(r => r.issues.duplicates);
    const allMissing = results.flatMap(r => r.issues.missing);
    const allDiscrepancies = results.flatMap(r => r.issues.discrepancies);

    // Aggregate database integrity issues
    const allDbDuplicates = results.flatMap(r => r.databaseIntegrity?.clickhouseDuplicates || []);
    const allDbGraphqlToClickhouseMissing = results.flatMap(r => r.databaseIntegrity?.graphqlToClickhouseMissing || []);
    const allDbClickhouseToGraphqlMissing = results.flatMap(r => r.databaseIntegrity?.clickhouseToGraphqlMissing || []);

    await fs.writeFile(
      path.join(this.outputDir, 'comparisons', 'duplicates.json'),
      JSON.stringify(allDuplicates, null, 2)
    );
    await fs.writeFile(
      path.join(this.outputDir, 'comparisons', 'missing.json'),
      JSON.stringify(allMissing, null, 2)
    );
    await fs.writeFile(
      path.join(this.outputDir, 'comparisons', 'discrepancies.json'),
      JSON.stringify(allDiscrepancies, null, 2)
    );

    // Save database integrity issues
    await fs.writeFile(
      path.join(this.outputDir, 'database-integrity', 'clickhouse-duplicates.json'),
      JSON.stringify(allDbDuplicates, null, 2)
    );
    await fs.writeFile(
      path.join(this.outputDir, 'database-integrity', 'graphql-to-clickhouse-missing.json'),
      JSON.stringify(allDbGraphqlToClickhouseMissing, null, 2)
    );
    await fs.writeFile(
      path.join(this.outputDir, 'database-integrity', 'clickhouse-to-graphql-missing.json'),
      JSON.stringify(allDbClickhouseToGraphqlMissing, null, 2)
    );

    // Generate summary report
    const summary = {
      timestamp: new Date().toISOString(),
      totalEntitiesTested: results.length,
      totalTransactionsCompared: results.reduce((sum, r) => sum + r.entity.transactionCount, 0),
      issuesSummary: {
        duplicates: allDuplicates.length,
        missing: allMissing.length,
        discrepancies: allDiscrepancies.length,
      },
      databaseIntegrityIssues: {
        clickhouseDuplicates: allDbDuplicates.length,
        graphqlToClickhouseMissing: allDbGraphqlToClickhouseMissing.length,
        clickhouseToGraphqlMissing: allDbClickhouseToGraphqlMissing.length,
        totalCritical: [...allDbDuplicates, ...allDbGraphqlToClickhouseMissing, ...allDbClickhouseToGraphqlMissing]
          .filter(issue => issue.severity === 'critical').length,
        totalWarnings: [...allDbDuplicates, ...allDbGraphqlToClickhouseMissing, ...allDbClickhouseToGraphqlMissing]
          .filter(issue => issue.severity === 'warning').length,
      },
      performanceMetrics: {
        averageLocalQueryTime: results.reduce((sum, r) => sum + r.comparison.local.queryTime, 0) / results.length,
        averageRemoteQueryTime: results.reduce((sum, r) => sum + r.comparison.remote.queryTime, 0) / results.length,
      },
      results,
    };

    await fs.writeFile(
      path.join(this.outputDir, 'report.json'),
      JSON.stringify(summary, null, 2)
    );

    // Generate HTML report
    const htmlReport = this.generateHTMLReport(summary);
    await fs.writeFile(path.join(this.outputDir, 'report.html'), htmlReport);

    const totalGraphqlIssues = allDuplicates.length + allMissing.length + allDiscrepancies.length;
    const totalDbIssues = allDbDuplicates.length + allDbGraphqlToClickhouseMissing.length + allDbClickhouseToGraphqlMissing.length;

    console.log(`✓ Reports saved to: ${this.outputDir}`);
    console.log(`📊 Summary: ${results.length} entities tested, ${totalGraphqlIssues} GraphQL issues, ${totalDbIssues} DB integrity issues found`);
  }

  private generateHTMLReport(summary: any): string {
    // Entity IDs (Drive-Id tag values, owner addresses) are attacker-controlled
    // on-chain data. Escape everything interpolated as text so the report is
    // safe to open in a browser.
    const escapeHtml = (value: unknown): string =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const dbIssues = summary.databaseIntegrityIssues;
    const dbIssuesTotal =
      (dbIssues?.clickhouseDuplicates ?? 0) +
      (dbIssues?.graphqlToClickhouseMissing ?? 0) +
      (dbIssues?.clickhouseToGraphqlMissing ?? 0);

    return `
<!DOCTYPE html>
<html>
<head>
    <title>ClickHouse GraphQL Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .issue { background: #fff3cd; padding: 10px; margin: 5px 0; border-radius: 3px; }
        .error { background: #f8d7da; }
        .success { background: #d4edda; }
        table { border-collapse: collapse; width: 100%; margin: 10px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <h1>ClickHouse GraphQL Test Report</h1>
    <div class="summary">
        <h2>Summary</h2>
        <p><strong>Timestamp:</strong> ${escapeHtml(summary.timestamp)}</p>
        <p><strong>Entities Tested:</strong> ${escapeHtml(summary.totalEntitiesTested)}</p>
        <p><strong>Transactions Compared:</strong> ${escapeHtml(summary.totalTransactionsCompared)}</p>
        <p><strong>GraphQL Issues Found:</strong> ${summary.issuesSummary.duplicates + summary.issuesSummary.missing + summary.issuesSummary.discrepancies}</p>
        <ul>
            <li>Duplicates: ${escapeHtml(summary.issuesSummary.duplicates)}</li>
            <li>Missing: ${escapeHtml(summary.issuesSummary.missing)}</li>
            <li>Discrepancies: ${escapeHtml(summary.issuesSummary.discrepancies)}</li>
        </ul>
        <p><strong>Database Integrity Issues:</strong> ${dbIssuesTotal}</p>
        <ul>
            <li>ClickHouse Duplicates: ${escapeHtml(dbIssues?.clickhouseDuplicates ?? 0)}</li>
            <li>GraphQL→ClickHouse Missing: ${escapeHtml(dbIssues?.graphqlToClickhouseMissing ?? 0)}</li>
            <li>ClickHouse→GraphQL Missing: ${escapeHtml(dbIssues?.clickhouseToGraphqlMissing ?? 0)}</li>
            <li>Critical Issues: ${escapeHtml(dbIssues?.totalCritical ?? 0)}</li>
            <li>Warning Issues: ${escapeHtml(dbIssues?.totalWarnings ?? 0)}</li>
        </ul>
    </div>

    <h2>Performance Metrics</h2>
    <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Average Local Query Time</td><td>${summary.performanceMetrics.averageLocalQueryTime.toFixed(2)}ms</td></tr>
        <tr><td>Average Remote Query Time</td><td>${summary.performanceMetrics.averageRemoteQueryTime.toFixed(2)}ms</td></tr>
    </table>

    <h2>Test Results</h2>
    <table>
        <tr><th>Entity Type</th><th>Entity ID</th><th>Transaction Count</th><th>Coverage</th><th>Complete</th><th>GraphQL Issues</th><th>DB Issues</th></tr>
        ${summary.results.map((result: TestResult) => `
            <tr>
                <td>${escapeHtml(result.entity.type)}</td>
                <td>${escapeHtml(result.entity.id)}</td>
                <td>${escapeHtml(result.entity.transactionCount)}</td>
                <td>${result.completeness.localCoverage.toFixed(1)}% / ${result.completeness.remoteCoverage.toFixed(1)}%</td>
                <td>${result.completeness.isComplete ? '✅' : '⚠️'}</td>
                <td>${result.issues.duplicates.length + result.issues.missing.length + result.issues.discrepancies.length}</td>
                <td>${result.databaseIntegrity ? (result.databaseIntegrity.summary.criticalIssues + result.databaseIntegrity.summary.warningIssues) : 0}</td>
            </tr>
        `).join('')}
    </table>
</body>
</html>`;
  }

  async run(options: {
    driveIds?: string[];
    ownerAddresses?: string[];
    autoDiscover?: boolean;
    discoverDrives?: boolean;
    discoverOwners?: boolean;
    topEntities?: number;
    verbose?: boolean;
  }): Promise<void> {
    console.log('🚀 Starting ClickHouse GraphQL testing...');

    await this.initialize();

    let entitiesToTest: Array<{ type: 'drive' | 'owner'; id: string; transactionCount: number }> = [];

    const anyDiscovery = options.autoDiscover || options.discoverDrives || options.discoverOwners;
    if (anyDiscovery) {
      // --auto-discover implies both. --discover-drives / --discover-owners filter to one.
      const includeDrives = options.autoDiscover || options.discoverDrives;
      const includeOwners = options.autoDiscover || options.discoverOwners;

      const { drives, owners } = await this.discoverEntities();
      const topCount = options.topEntities || Math.min(this.config.discovery.topDrives, this.config.discovery.topOwners);

      if (includeDrives) {
        entitiesToTest.push(
          ...drives.slice(0, topCount).map(d => ({ type: 'drive' as const, id: d.driveId, transactionCount: d.transactionCount })),
        );
      }
      if (includeOwners) {
        entitiesToTest.push(
          ...owners.slice(0, topCount).map(o => ({ type: 'owner' as const, id: o.ownerAddress, transactionCount: o.transactionCount })),
        );
      }
    } else {
      // Manual testing mode
      if (options.driveIds) {
        for (const driveId of options.driveIds) {
          entitiesToTest.push({ type: 'drive', id: driveId, transactionCount: 0 }); // Count will be determined during testing
        }
      }
      if (options.ownerAddresses) {
        for (const ownerAddress of options.ownerAddresses) {
          entitiesToTest.push({ type: 'owner', id: ownerAddress, transactionCount: 0 });
        }
      }
    }

    if (entitiesToTest.length === 0) {
      throw new Error(
        'No entities selected. Pass --auto-discover, --discover-drives, --discover-owners, --drive-id, or --owner.',
      );
    }

    const results: TestResult[] = [];
    for (const entity of entitiesToTest) {
      const result = await this.testEntity(entity);
      results.push(result);
    }

    await this.generateReports(results);
    console.log('\n✅ Testing completed!');
  }
}

// CLI parsing and main function
async function main() {
  const args = process.argv.slice(2);
  let config = getDefaultConfig();

  // Parse command line arguments
  const options: {
    driveIds?: string[];
    ownerAddresses?: string[];
    autoDiscover?: boolean;
    discoverDrives?: boolean;
    discoverOwners?: boolean;
    topEntities?: number;
    configFile?: string;
    verbose?: boolean;
  } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--config':
        if (nextArg) {
          options.configFile = nextArg;
          i++;
        }
        break;
      case '--drive-id':
        if (nextArg) {
          options.driveIds = options.driveIds || [];
          options.driveIds.push(nextArg);
          i++;
        }
        break;
      case '--owner':
        if (nextArg) {
          options.ownerAddresses = options.ownerAddresses || [];
          options.ownerAddresses.push(nextArg);
          i++;
        }
        break;
      case '--auto-discover':
        options.autoDiscover = true;
        break;
      case '--discover-drives':
        options.discoverDrives = true;
        break;
      case '--discover-owners':
        options.discoverOwners = true;
        break;
      case '--top':
        if (nextArg) {
          options.topEntities = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--sample-size':
        if (nextArg) {
          options.topEntities = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--clickhouse-url':
        if (nextArg) {
          config.clickhouse.url = nextArg;
          i++;
        }
        break;
      case '--clickhouse-user':
        if (nextArg) {
          config.clickhouse.user = nextArg;
          i++;
        }
        break;
      case '--clickhouse-password':
        if (nextArg) {
          config.clickhouse.password = nextArg;
          i++;
        }
        break;
      case '--local-endpoint':
        if (nextArg) {
          config.endpoints.local = nextArg;
          i++;
        }
        break;
      case '--remote-endpoint':
        if (nextArg) {
          config.endpoints.remote = nextArg;
          i++;
        }
        break;
      case '--max-transactions':
        if (nextArg) {
          config.testing.maxTransactionsPerEntity = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--allow-partial':
        config.testing.allowPartialComparisons = true;
        break;
      case '--complete-only':
        config.testing.allowPartialComparisons = false;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--help':
        console.log(`
Usage: test-clickhouse-graphql [options]

Environment Variables (read from .env by the wrapper):
  CORE_PORT                    Local service port (default: 4000)
                               Used to build http://localhost:\${CORE_PORT}/graphql
  CLICKHOUSE_HOST              ClickHouse host (default: localhost)
  CLICKHOUSE_PORT_2            ClickHouse HTTP port (default: 8123)
  CLICKHOUSE_USER              ClickHouse user (default: default)
  CLICKHOUSE_PASSWORD          ClickHouse password (no default)

Options:
  --config <file>              Use configuration file
  --drive-id <id>              Test specific drive ID
  --owner <address>            Test specific owner address
  --auto-discover              Auto-discover entities by transaction count
  --discover-drives            Discover and test drives
  --discover-owners            Discover and test owners
  --top <n>                    Number of top entities to test
  --sample-size <n>            Alias for --top
  --clickhouse-url <url>       ClickHouse URL (overrides env var)
  --clickhouse-user <user>     ClickHouse user (overrides env var)
  --clickhouse-password <pwd>  ClickHouse password (overrides env var)
  --local-endpoint <url>       Local GraphQL endpoint (overrides env var)
  --remote-endpoint <url>      Remote GraphQL endpoint (overrides env var)
  --max-transactions <n>       Override max transactions per entity for complete comparison
  --allow-partial              Allow partial comparisons (include entities with many transactions)
  --complete-only              Only test entities where all transactions can be fetched (default)
  --verbose, -v                Enable verbose mode (show GraphQL queries)
  --help                       Show this help message

Examples:
  # Auto-discover and test top 10 entities (uses .env for credentials)
  test-clickhouse-graphql --auto-discover --top 10

  # Test specific drive with verbose GraphQL query logging
  test-clickhouse-graphql --drive-id abc123 --verbose

  # Allow partial comparisons for entities with many transactions
  test-clickhouse-graphql --auto-discover --allow-partial

  # Set custom max transactions per entity for complete comparisons
  test-clickhouse-graphql --auto-discover --max-transactions 5000

  # Use custom configuration with verbose mode
  test-clickhouse-graphql --config my-config.json --verbose

Note: The script automatically loads configuration from .env file in the project root.
        `);
        process.exit(0);
        break;
    }
  }

  // Load config file if specified
  if (options.configFile) {
    try {
      const configContent = await fs.readFile(options.configFile, 'utf-8');
      const fileConfig = JSON.parse(configContent) as Partial<TestConfig>;
      // Deep-merge each known section so partial config files don't wipe out
      // sibling defaults (e.g. testing: { pageSize: 50 } should keep the
      // default maxPagesPerTest etc.).
      config = {
        ...config,
        ...fileConfig,
        clickhouse: { ...config.clickhouse, ...fileConfig.clickhouse },
        endpoints: { ...config.endpoints, ...fileConfig.endpoints },
        discovery: { ...config.discovery, ...fileConfig.discovery },
        testing: { ...config.testing, ...fileConfig.testing },
        databaseIntegrity: { ...config.databaseIntegrity, ...fileConfig.databaseIntegrity },
      };
    } catch (error) {
      console.error(`Error loading config file: ${error}`);
      process.exit(1);
    }
  }

  const tester = new ClickHouseGraphQLTester(config, options.verbose);
  await tester.run(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { ClickHouseGraphQLTester, type TestConfig, type TestResult };