/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as winston from 'winston';

import { ContiguousDataIndex } from '../types.js';
import { CachePolicyEvaluator } from '../cache/cache-policy-evaluator.js';

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_MAX_QUEUE_SIZE = 100;

export type DataContentAttributeProperties = {
  id: string;
  dataRoot?: string;
  hash: string;
  dataSize: number;
  contentType?: string;
  cachedAt?: number;
  verified?: boolean;
  verificationPriority?: number;
  owner?: string;
  target?: string;
  timestamp?: number;
  tags?: Array<{ name: string; value: string }>;
};

export class DataContentAttributeImporter {
  private log: winston.Logger;
  private contiguousDataIndex: ContiguousDataIndex;
  private policyEvaluator?: CachePolicyEvaluator;
  private maxQueueSize: number;
  private queue: queueAsPromised<DataContentAttributeProperties, void>;

  constructor({
    log,
    contiguousDataIndex,
    policyEvaluator,
    workerCount = DEFAULT_WORKER_COUNT,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    contiguousDataIndex: ContiguousDataIndex;
    policyEvaluator?: CachePolicyEvaluator;
    workerCount?: number;
    maxQueueSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.contiguousDataIndex = contiguousDataIndex;
    this.policyEvaluator = policyEvaluator;
    this.maxQueueSize = maxQueueSize;

    this.queue = fastq.promise(
      this.saveDataContentAttributes.bind(this),
      workerCount,
    );
  }

  queueDataContentAttributes(properties: DataContentAttributeProperties): void {
    const log = this.log.child({
      method: 'queueDataContentAttributes',
      id: properties.id,
    });
    if (this.queue.length() >= this.maxQueueSize) {
      log.debug('Skipping save data content attributes, queue is full.');
    } else {
      log.debug('Queueing data content attributes to be saved...');
      this.queue.push(properties);
      log.debug('Data content attributes queued.');
    }
  }

  private async saveDataContentAttributes(
    properties: DataContentAttributeProperties,
  ): Promise<void> {
    const log = this.log.child({ id: properties.id });
    log.debug('Saving data content attributes...');

    let retentionPolicyId: string | undefined;
    let retentionExpiresAt: number | undefined;

    // Evaluate cache policies if evaluator is configured
    if (
      this.policyEvaluator !== undefined &&
      properties.owner !== undefined &&
      properties.tags !== undefined
    ) {
      try {
        const policyResult = await this.policyEvaluator.evaluatePolicies(
          {
            id: properties.id,
            owner_address: properties.owner,
            target: properties.target,
            data_size: properties.dataSize,
            timestamp: properties.timestamp,
          },
          properties.tags,
        );

        if (policyResult) {
          retentionPolicyId = policyResult.policyId;
          retentionExpiresAt = policyResult.expiresAt;

          log.info('Applied cache retention policy', {
            policyId: policyResult.policyId,
            policyName: policyResult.policyName,
            retentionDays: policyResult.retentionDays,
            expiresAt: new Date(policyResult.expiresAt).toISOString(),
          });
        }
      } catch (error) {
        log.error('Error evaluating cache policies', error);
      }
    }

    await this.contiguousDataIndex.saveDataContentAttributes({
      ...properties,
      retentionPolicyId,
      retentionExpiresAt,
    });

    log.debug('Data content attributes saved...');
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    log.debug('Stopped successfully.');
  }

  queueDepth(): number {
    return this.queue.length();
  }
}
