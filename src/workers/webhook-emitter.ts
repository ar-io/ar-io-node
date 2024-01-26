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
import * as winston from 'winston';
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';

import * as events from '../events.js';
import { NeverMatch } from '../filters.js';
import { ItemFilter } from '../types.js';

interface WebhookEventWrapper {
  event: string;
  data: any;
}

interface WebhookEmissionDetails {
  targetServer: string;
  eventWrapper: WebhookEventWrapper;
}

// WebhookEmitter class
export class WebhookEmitter {
  private eventEmitter: EventEmitter;
  private indexFilter: ItemFilter;
  private log: winston.Logger;
  public emissionQueue: queueAsPromised<WebhookEmissionDetails, void>;
  public emissionQueueSize: number;
  public indexEventsToListenFor: string[];
  public webhookTargetServers?: string[];

  constructor(
    eventEmitter: EventEmitter,
    targetServers: string[] | undefined,
    indexFilter: ItemFilter,
    log: winston.Logger,
  ) {
    this.eventEmitter = eventEmitter;
    this.indexFilter = indexFilter;
    this.webhookTargetServers = targetServers;
    this.indexEventsToListenFor = [
      events.TX_INDEXED,
      events.ANS104_DATA_ITEM_INDEXED,
    ];
    this.emissionQueue = fastq.promise(
      this.emitWebhookToTargetServer.bind(this),
      5,
    );
    this.emissionQueueSize = 100;

    this.log = log.child({ class: 'WebhookEmitter' });

    this.log.info('WebhookEmitter initialized.');

    if (
      indexFilter.constructor.name === NeverMatch.name ||
      !this.webhookTargetServers
    ) {
      this.log.info('WebhookEmitter will not listen for events.');
      return;
    }

    if (this.webhookTargetServers.every((s) => s === '')) {
      this.log.error('WEBHOOK_TARGET_SERVERS is wrongly set.');
      return;
    }

    this.log.debug('Registering WebhookEmitter listeners.');
    this.registerEventListeners();
  }

  public shutdown(): void {
    this.eventEmitter.removeAllListeners();
    this.log.info('WebhookEmitter shutdown completed.');
  }

  private registerEventListeners(): void {
    for (const event of this.indexEventsToListenFor) {
      this.eventEmitter.on(event, async (data) => {
        if ((await this.indexFilter.match(data)) && this.webhookTargetServers) {
          for (const targetServer of this.webhookTargetServers) {
            if (this.emissionQueue.length() < this.emissionQueueSize) {
              this.log.debug('adding webhook to queue', { event, data });

              this.emissionQueue.push({
                targetServer,
                eventWrapper: { event: event, data: data },
              });
            } else {
              this.log.debug('webhook queue is full. Skipping webhook:', {
                event,
                data,
              });
            }
          }
        }
      });
    }
  }

  public async emitWebhookToTargetServer(
    details: WebhookEmissionDetails,
  ): Promise<void> {
    const { targetServer, eventWrapper } = details;
    this.log.info(
      `Emitting webhook to ${targetServer} for ${eventWrapper.event}`,
    );

    try {
      const response = await axios.post(targetServer, eventWrapper);

      if (response.status === 200) {
        this.log.info(
          `Webhook emitted successfully for: ${eventWrapper.data.id}`,
        );
      } else {
        this.log.error(
          `Failed to emit webhook. Status code: ${response.status}`,
        );
      }
    } catch (error: any) {
      this.log.error('Error while emitting webhook:', error.message);
    }
  }
}
