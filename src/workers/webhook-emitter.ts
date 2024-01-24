import axios from 'axios';
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import { WEBHOOK_TARGET_SERVER } from '../config.js';
import * as events from '../events.js';
import { NeverMatch } from '../filters.js';
import { ItemFilter } from '../types.js';

// WebhookEmitter class
export class WebhookEmitter {
  private eventEmitter: EventEmitter;
  private webhookTargetServer?: string;
  private log: winston.Logger;
  private indexFilter: ItemFilter;
  public indexEventsToListenFor: string[];

  constructor(eventEmitter: EventEmitter, indexFilter: ItemFilter, log: winston.Logger) {
    this.eventEmitter = eventEmitter;
    this.indexFilter = indexFilter;
    this.webhookTargetServer = WEBHOOK_TARGET_SERVER;
    this.indexEventsToListenFor = [events.TX_INDEXED, events.ANS104_DATA_ITEM_INDEXED];
    this.log = log.child({ class: 'WebhookEmitter' });

    this.log.info('WebhookEmitter initialized.');

    if (indexFilter.constructor.name == NeverMatch.name) {
      this.log.info('WebhookEmitter will not listen for events.');
      return;
    }

    this.log.info('Registering WebhookEmitter listeners.');
    this.registerEventListeners();
  }

  public shutdown(): void {
    // Remove all listeners to prevent memory leaks
    this.eventEmitter.removeAllListeners();
    this.log.info('WebhookEmitter shutdown completed.');
  }

  private registerEventListeners(): void {
    for (const event of this.indexEventsToListenFor) {
      this.eventEmitter.on(event, async (data) => {
        if (await this.indexFilter.match(data)) {
          this.emitWebhook({ event: event, data: data });
        }
      });
    }
  }

  public async emitWebhook(eventWrapper: {
    event: string;
    data: any;
  }): Promise<void> {
    if (this.webhookTargetServer) {
      this.log.info(
        `Emitting webhook to ${this.webhookTargetServer} for ${eventWrapper.event}`,
      );

      try {
        // Send a POST request to the webhookTargetServer with the eventWrapper
        const response = await axios.post(
          this.webhookTargetServer,
          eventWrapper,
        );

        // Check the response and handle it as needed
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
    } else {
      return;
    }
  }
}
