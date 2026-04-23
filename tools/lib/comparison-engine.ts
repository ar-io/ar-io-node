/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { GraphQLTransaction } from './graphql-client.js';

interface ComparisonResult {
  duplicates: Array<{
    transactionId: string;
    occurrences: number;
    source: 'local' | 'remote' | 'both';
    indices?: number[];
  }>;
  missing: Array<{
    transactionId: string;
    presentIn: 'local' | 'remote';
    height: number;
    tags: Array<{ name: string; value: string }>;
    metadata: {
      owner: string;
      recipient: string;
      dataSize: string;
      timestamp?: number;
    };
  }>;
  discrepancies: Array<{
    transactionId: string;
    field: string;
    localValue: any;
    remoteValue: any;
    severity: 'critical' | 'minor' | 'informational';
  }>;
  summary: {
    totalLocal: number;
    totalRemote: number;
    totalMatched: number;
    duplicateCount: number;
    missingCount: number;
    discrepancyCount: number;
  };
}

interface ComparisonOptions {
  strictComparison?: boolean;
  ignoreFields?: string[];
  tolerateTimestampDifference?: number; // milliseconds
  checkOwnerKeys?: boolean;
}

export class ComparisonEngine {
  private options: ComparisonOptions;

  constructor(options: ComparisonOptions = {}) {
    this.options = {
      strictComparison: false,
      ignoreFields: ['owner.key'], // Owner keys might not always be available
      tolerateTimestampDifference: 1000, // 1 second tolerance for timestamps
      checkOwnerKeys: false,
      ...options,
    };
  }

  /**
   * Compare two sets of transactions and identify duplicates, missing items, and discrepancies
   */
  compareTransactionSets(
    localTransactions: GraphQLTransaction[],
    remoteTransactions: GraphQLTransaction[]
  ): ComparisonResult {
    console.log(`   🔍 Comparing ${localTransactions.length} local vs ${remoteTransactions.length} remote transactions...`);

    const result: ComparisonResult = {
      duplicates: [],
      missing: [],
      discrepancies: [],
      summary: {
        totalLocal: localTransactions.length,
        totalRemote: remoteTransactions.length,
        totalMatched: 0,
        duplicateCount: 0,
        missingCount: 0,
        discrepancyCount: 0,
      },
    };

    // Create maps for efficient lookups
    const localMap = this.createTransactionMap(localTransactions);
    const remoteMap = this.createTransactionMap(remoteTransactions);

    // Find duplicates within each set
    result.duplicates.push(...this.findDuplicatesInSet(localTransactions, 'local'));
    result.duplicates.push(...this.findDuplicatesInSet(remoteTransactions, 'remote'));

    // Find duplicates across both sets
    result.duplicates.push(...this.findCrossSourcDuplicates(localMap, remoteMap));

    // Find missing transactions
    result.missing.push(...this.findMissingTransactions(localMap, remoteMap, 'remote'));
    result.missing.push(...this.findMissingTransactions(remoteMap, localMap, 'local'));

    // Find discrepancies in matching transactions
    result.discrepancies.push(...this.findDiscrepancies(localMap, remoteMap));

    // Calculate summary
    const localIds = new Set(localTransactions.map(tx => tx.id));
    const remoteIds = new Set(remoteTransactions.map(tx => tx.id));
    const intersection = new Set([...localIds].filter(id => remoteIds.has(id)));

    result.summary.totalMatched = intersection.size;
    result.summary.duplicateCount = result.duplicates.length;
    result.summary.missingCount = result.missing.length;
    result.summary.discrepancyCount = result.discrepancies.length;

    console.log(`   ✓ Comparison complete: ${result.summary.totalMatched} matched, ${result.summary.missingCount} missing, ${result.summary.duplicateCount} duplicates, ${result.summary.discrepancyCount} discrepancies`);

    return result;
  }

  private createTransactionMap(transactions: GraphQLTransaction[]): Map<string, GraphQLTransaction[]> {
    const map = new Map<string, GraphQLTransaction[]>();

    for (const tx of transactions) {
      const existing = map.get(tx.id) || [];
      existing.push(tx);
      map.set(tx.id, existing);
    }

    return map;
  }

  private findDuplicatesInSet(
    transactions: GraphQLTransaction[],
    source: 'local' | 'remote'
  ): Array<{
    transactionId: string;
    occurrences: number;
    source: 'local' | 'remote' | 'both';
    indices?: number[];
  }> {
    const duplicates: Array<{
      transactionId: string;
      occurrences: number;
      source: 'local' | 'remote' | 'both';
      indices?: number[];
    }> = [];

    const idCounts = new Map<string, number[]>();

    transactions.forEach((tx, index) => {
      const indices = idCounts.get(tx.id) || [];
      indices.push(index);
      idCounts.set(tx.id, indices);
    });

    for (const [id, indices] of idCounts) {
      if (indices.length > 1) {
        duplicates.push({
          transactionId: id,
          occurrences: indices.length,
          source,
          indices,
        });
      }
    }

    return duplicates;
  }

  private findCrossSourcDuplicates(
    localMap: Map<string, GraphQLTransaction[]>,
    remoteMap: Map<string, GraphQLTransaction[]>
  ): Array<{
    transactionId: string;
    occurrences: number;
    source: 'local' | 'remote' | 'both';
  }> {
    const duplicates: Array<{
      transactionId: string;
      occurrences: number;
      source: 'local' | 'remote' | 'both';
    }> = [];

    for (const [id, localTxs] of localMap) {
      const remoteTxs = remoteMap.get(id);
      if (remoteTxs && (localTxs.length > 1 || remoteTxs.length > 1)) {
        duplicates.push({
          transactionId: id,
          occurrences: localTxs.length + remoteTxs.length,
          source: 'both',
        });
      }
    }

    return duplicates;
  }

  private findMissingTransactions(
    sourceMap: Map<string, GraphQLTransaction[]>,
    targetMap: Map<string, GraphQLTransaction[]>,
    presentIn: 'local' | 'remote'
  ): Array<{
    transactionId: string;
    presentIn: 'local' | 'remote';
    height: number;
    tags: Array<{ name: string; value: string }>;
    metadata: {
      owner: string;
      recipient: string;
      dataSize: string;
      timestamp?: number;
    };
  }> {
    const missing: Array<{
      transactionId: string;
      presentIn: 'local' | 'remote';
      height: number;
      tags: Array<{ name: string; value: string }>;
      metadata: {
        owner: string;
        recipient: string;
        dataSize: string;
        timestamp?: number;
      };
    }> = [];

    for (const [id, txs] of sourceMap) {
      if (!targetMap.has(id)) {
        // Take the first transaction if there are multiple (shouldn't happen, but defensive)
        const tx = txs[0];
        missing.push({
          transactionId: id,
          presentIn,
          height: tx.block?.height || 0,
          tags: tx.tags,
          metadata: {
            owner: tx.owner.address,
            recipient: tx.recipient,
            dataSize: tx.data.size,
            timestamp: tx.block?.timestamp,
          },
        });
      }
    }

    return missing;
  }

  private findDiscrepancies(
    localMap: Map<string, GraphQLTransaction[]>,
    remoteMap: Map<string, GraphQLTransaction[]>
  ): Array<{
    transactionId: string;
    field: string;
    localValue: any;
    remoteValue: any;
    severity: 'critical' | 'minor' | 'informational';
  }> {
    const discrepancies: Array<{
      transactionId: string;
      field: string;
      localValue: any;
      remoteValue: any;
      severity: 'critical' | 'minor' | 'informational';
    }> = [];

    for (const [id, localTxs] of localMap) {
      const remoteTxs = remoteMap.get(id);
      if (remoteTxs) {
        // Compare the first transaction from each set
        const localTx = localTxs[0];
        const remoteTx = remoteTxs[0];

        discrepancies.push(...this.compareTransactions(id, localTx, remoteTx));
      }
    }

    return discrepancies;
  }

  private compareTransactions(
    id: string,
    localTx: GraphQLTransaction,
    remoteTx: GraphQLTransaction
  ): Array<{
    transactionId: string;
    field: string;
    localValue: any;
    remoteValue: any;
    severity: 'critical' | 'minor' | 'informational';
  }> {
    const discrepancies: Array<{
      transactionId: string;
      field: string;
      localValue: any;
      remoteValue: any;
      severity: 'critical' | 'minor' | 'informational';
    }> = [];

    // Define field comparison rules
    const fieldRules = [
      {
        field: 'owner.address',
        getValue: (tx: GraphQLTransaction) => tx.owner.address,
        severity: 'critical' as const,
      },
      {
        field: 'owner.key',
        getValue: (tx: GraphQLTransaction) => tx.owner.key,
        severity: 'informational' as const,
        skip: !this.options.checkOwnerKeys || this.options.ignoreFields?.includes('owner.key'),
      },
      {
        field: 'recipient',
        getValue: (tx: GraphQLTransaction) => tx.recipient,
        severity: 'critical' as const,
      },
      {
        field: 'fee.winston',
        getValue: (tx: GraphQLTransaction) => tx.fee.winston,
        severity: 'minor' as const,
      },
      {
        field: 'quantity.winston',
        getValue: (tx: GraphQLTransaction) => tx.quantity.winston,
        severity: 'critical' as const,
      },
      {
        field: 'data.size',
        getValue: (tx: GraphQLTransaction) => tx.data.size,
        severity: 'critical' as const,
      },
      {
        field: 'data.type',
        getValue: (tx: GraphQLTransaction) => tx.data.type,
        severity: 'minor' as const,
      },
      {
        field: 'block.height',
        getValue: (tx: GraphQLTransaction) => tx.block?.height,
        severity: 'critical' as const,
      },
      {
        field: 'block.timestamp',
        getValue: (tx: GraphQLTransaction) => tx.block?.timestamp,
        severity: 'minor' as const,
        customCompare: (local: number, remote: number) => {
          if (this.options.tolerateTimestampDifference) {
            return Math.abs(local - remote) <= this.options.tolerateTimestampDifference;
          }
          return local === remote;
        },
      },
      {
        field: 'bundledIn.id',
        getValue: (tx: GraphQLTransaction) => tx.bundledIn?.id,
        severity: 'minor' as const,
      },
    ];

    // Compare tags separately
    const tagDiscrepancies = this.compareTags(id, localTx.tags, remoteTx.tags);
    discrepancies.push(...tagDiscrepancies);

    // Compare other fields
    for (const rule of fieldRules) {
      if (rule.skip) continue;

      const localValue = rule.getValue(localTx);
      const remoteValue = rule.getValue(remoteTx);

      let isEqual = false;
      if (rule.customCompare && typeof localValue === 'number' && typeof remoteValue === 'number') {
        isEqual = rule.customCompare(localValue, remoteValue);
      } else {
        isEqual = this.deepEqual(localValue, remoteValue);
      }

      if (!isEqual) {
        discrepancies.push({
          transactionId: id,
          field: rule.field,
          localValue,
          remoteValue,
          severity: rule.severity,
        });
      }
    }

    return discrepancies;
  }

  private compareTags(
    id: string,
    localTags: Array<{ name: string; value: string }>,
    remoteTags: Array<{ name: string; value: string }>
  ): Array<{
    transactionId: string;
    field: string;
    localValue: any;
    remoteValue: any;
    severity: 'critical' | 'minor' | 'informational';
  }> {
    const discrepancies: Array<{
      transactionId: string;
      field: string;
      localValue: any;
      remoteValue: any;
      severity: 'critical' | 'minor' | 'informational';
    }> = [];

    // ANS-104 allows repeated tag names, so we group all values per name and
    // compare the sorted-values array. A plain Map<name, value> would silently
    // drop duplicates and make two transactions compare equal when one side
    // has a repeated tag and the other doesn't.
    const toTagMap = (tags: Array<{ name: string; value: string }>): Map<string, string[]> => {
      const tagMap = new Map<string, string[]>();
      for (const tag of tags) {
        const values = tagMap.get(tag.name) ?? [];
        values.push(tag.value);
        tagMap.set(tag.name, values);
      }
      for (const values of tagMap.values()) {
        values.sort();
      }
      return tagMap;
    };

    const sameValues = (a: string[], b: string[]): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };

    const localTagMap = toTagMap(localTags);
    const remoteTagMap = toTagMap(remoteTags);

    // Check for missing/differing tags by name
    for (const [name, values] of localTagMap) {
      const remoteValues = remoteTagMap.get(name);
      if (remoteValues === undefined) {
        discrepancies.push({
          transactionId: id,
          field: `tags.${name}`,
          localValue: values,
          remoteValue: null,
          severity: 'minor',
        });
      } else if (!sameValues(values, remoteValues)) {
        discrepancies.push({
          transactionId: id,
          field: `tags.${name}`,
          localValue: values,
          remoteValue: remoteValues,
          severity: 'minor',
        });
      }
    }

    // Extra tag names in remote
    for (const [name, values] of remoteTagMap) {
      if (!localTagMap.has(name)) {
        discrepancies.push({
          transactionId: id,
          field: `tags.${name}`,
          localValue: null,
          remoteValue: values,
          severity: 'minor',
        });
      }
    }

    return discrepancies;
  }

  private deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;

    if (typeof a === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);

      if (keysA.length !== keysB.length) return false;

      for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!this.deepEqual(a[key], b[key])) return false;
      }

      return true;
    }

    return false;
  }

  /**
   * Generate a summary report of comparison results
   */
  generateSummaryReport(result: ComparisonResult): string {
    const { summary, duplicates, missing, discrepancies } = result;

    let report = `
=== Comparison Summary ===
Total Local Transactions: ${summary.totalLocal}
Total Remote Transactions: ${summary.totalRemote}
Matched Transactions: ${summary.totalMatched}
Missing Transactions: ${summary.missingCount}
Duplicate Transactions: ${summary.duplicateCount}
Field Discrepancies: ${summary.discrepancyCount}

`;

    if (duplicates.length > 0) {
      report += `=== Duplicates ===\n`;
      for (const dup of duplicates.slice(0, 10)) { // Show first 10
        report += `- ${dup.transactionId} (${dup.occurrences}x in ${dup.source})\n`;
      }
      if (duplicates.length > 10) {
        report += `... and ${duplicates.length - 10} more\n`;
      }
      report += '\n';
    }

    if (missing.length > 0) {
      report += `=== Missing Transactions ===\n`;
      for (const miss of missing.slice(0, 10)) { // Show first 10
        report += `- ${miss.transactionId} (present in ${miss.presentIn}, height: ${miss.height})\n`;
      }
      if (missing.length > 10) {
        report += `... and ${missing.length - 10} more\n`;
      }
      report += '\n';
    }

    if (discrepancies.length > 0) {
      report += `=== Field Discrepancies ===\n`;
      const criticalCount = discrepancies.filter(d => d.severity === 'critical').length;
      const minorCount = discrepancies.filter(d => d.severity === 'minor').length;
      const infoCount = discrepancies.filter(d => d.severity === 'informational').length;

      report += `Critical: ${criticalCount}, Minor: ${minorCount}, Informational: ${infoCount}\n`;

      for (const disc of discrepancies.slice(0, 10)) { // Show first 10
        report += `- ${disc.transactionId}.${disc.field}: ${JSON.stringify(disc.localValue)} vs ${JSON.stringify(disc.remoteValue)} (${disc.severity})\n`;
      }
      if (discrepancies.length > 10) {
        report += `... and ${discrepancies.length - 10} more\n`;
      }
    }

    return report;
  }
}

export type { ComparisonResult, ComparisonOptions };