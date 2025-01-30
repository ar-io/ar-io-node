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
import axios from 'axios';
import * as EventEmitter from 'node:events';
import { URL } from 'node:url';
import * as winston from 'winston';
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';

import * as events from '../events.js';
import { NeverMatch } from '../filters.js';
import {
  ItemFilter,
  NormalizedDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';

type WebhookEmissionData =
  | NormalizedDataItem
  | PartialJsonTransaction
  | PartialJsonBlock;

interface WebhookEventWrapper {
  event: string;
  data: WebhookEmissionData;
}

interface WebhookEmissionDetails {
  targetServer: string;
  eventWrapper: WebhookEventWrapper;
}

const MAX_EMISSION_QUEUE_SIZE = 100;
const EMISSION_QUEUE_CONCURRENCY = 5;

// WebhookEmitter class
export class WebhookEmitter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private indexFilter: ItemFilter;
  private blockFilter: ItemFilter;
  private listenerReferences: Map<
    string,
    (data: WebhookEmissionData) => Promise<void>
  >;
  public targetServersUrls: string[];
  public maxEmissionQueueSize: number;
  public emissionQueueConcurrency: number;
  public emissionQueue: queueAsPromised<WebhookEmissionDetails, void>;
  public eventsToListenFor: string[];

  constructor({
    log,
    eventEmitter,
    targetServersUrls,
    indexFilter,
    blockFilter,
    maxEmissionQueueSize = MAX_EMISSION_QUEUE_SIZE,
    emissionQueueConcurrency = EMISSION_QUEUE_CONCURRENCY,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    targetServersUrls: string[];
    indexFilter: ItemFilter;
    blockFilter: ItemFilter;
    maxEmissionQueueSize?: number;
    emissionQueueConcurrency?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.eventEmitter = eventEmitter;
    this.targetServersUrls = targetServersUrls;
    this.indexFilter = indexFilter;
    this.blockFilter = blockFilter;
    this.listenerReferences = new Map();
    this.maxEmissionQueueSize = maxEmissionQueueSize;
    this.emissionQueueConcurrency = emissionQueueConcurrency;
    this.emissionQueue = fastq.promise(
      this.emitWebhookToTargetServer.bind(this),
      this.emissionQueueConcurrency,
    );
    this.eventsToListenFor = [
      events.TX_INDEXED,
      events.ANS104_DATA_ITEM_INDEXED,
      events.BLOCK_INDEXED,
    ];

    this.start();
  }

  private async start(): Promise<void> {
    if (this.targetServersUrls.length === 0) {
      this.log.info(
        'WebhookEmitter not initialized. No WEBHOOK_TARGET_SERVERS are set.',
      );
      return;
    }

    if (!this.validateTargetServersUrls()) {
      this.log.error(
        'WebhookEmitter not initialized. Some or all WEBHOOK_TARGET_SERVERS URLs are invalid.',
      );
      return;
    }

    if (
      this.indexFilter.constructor.name === NeverMatch.name &&
      this.blockFilter.constructor.name === NeverMatch.name
    ) {
      this.log.info(
        'WebhookEmitter not initialized. Filters are set to NeverMatch.',
      );
      return;
    }

    this.log.info('WebhookEmitter initialized.');

    await this.registerEventListeners();
  }

  public validateTargetServersUrls(): boolean {
    // Check if all target servers URLs are http or https
    return this.targetServersUrls.every((serverUrl) => {
      try {
        const url = new URL(serverUrl);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch (error) {
        return false;
      }
    });
  }

  public async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });

    // Remove specific listeners
    for (const [event, listener] of this.listenerReferences) {
      this.eventEmitter.removeListener(event, listener);
    }
    this.listenerReferences.clear();

    this.emissionQueue.kill();
    log.debug('Stopped successfully.');
  }

  private async registerEventListeners(): Promise<void> {
    this.log.debug('Registering WebhookEmitter listeners.');

    for (const event of this.eventsToListenFor) {
      const listener = async (data: WebhookEmissionData) => {
        let filterMatch = false;
        switch (event) {
          case events.TX_INDEXED:
            filterMatch = await this.indexFilter.match(
              data as PartialJsonTransaction,
            );
            break;
          case events.ANS104_DATA_ITEM_INDEXED:
            filterMatch = await this.indexFilter.match(
              data as NormalizedDataItem,
            );
            break;
          case events.BLOCK_INDEXED:
            filterMatch = await this.blockFilter.match(
              data as PartialJsonBlock,
            );
            break;
          default:
            this.log.error('Unknown event:', event);
            return;
        }

        if (filterMatch) {
          for (const targetServer of this.targetServersUrls) {
            const id = (data as any).id;
            const height = (data as any).height;

            if (this.emissionQueue.length() < this.maxEmissionQueueSize) {
              this.log.debug('Adding webhook to queue', {
                event,
                id,
                height,
              });

              this.emissionQueue.push({
                targetServer,
                eventWrapper: { event, data },
              });
            } else {
              this.log.debug('Webhook queue is full. Skipping webhook:', {
                event,
                id,
                height,
              });
            }
          }
        }
      };

      this.listenerReferences.set(event, listener);
      this.eventEmitter.on(event, listener);
    }
  }

  public async emitWebhookToTargetServer(
    details: WebhookEmissionDetails,
  ): Promise<void> {
    const { targetServer, eventWrapper } = details;
    this.log.debug(
      `Emitting webhook to ${targetServer} for ${eventWrapper.event}`,
    );

    try {
      const response = await axios.post(targetServer, eventWrapper);

      if (response.status >= 200 && response.status < 300) {
        this.log.info(
          `Webhook emitted successfully for: ${
            (eventWrapper.data as any).id ?? (eventWrapper.data as any).height
          }`,
        );
      } else {
        this.log.error(
          `Failed to emit webhook. Status code: ${response.status}`,
        );
      }
    } catch (error) {
      this.log.error('Unexpected error while emitting webhook:', error);
    }
  }

  queueDepth(): number {
    return this.emissionQueue.length();
  }
}
