import axios from 'axios';
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import {
  // ANS104_UNBUNDLE_FILTER,
  ANS104_INDEX_FILTER,
  WEBHOOK_TARGET_SERVER,
} from '../config.js';
import * as events from '../events.js';
import { createFilter } from '../filters.js';
import { ItemFilter } from '../types.js';

// WebhookEmitter class
export class WebhookEmitter {
  private eventEmitter: EventEmitter;
  private webhookTargetServer?: string;
  private log: winston.Logger;
  // private unbundleFilter: ItemFilter;
  private indexFilter: ItemFilter;

  constructor(eventEmitter: EventEmitter, log: winston.Logger) {
    this.eventEmitter = eventEmitter;
    this.webhookTargetServer = WEBHOOK_TARGET_SERVER;
    this.log = log.child({ class: 'WebhookEmitter' });
    // this.unbundleFilter = createFilter(ANS104_UNBUNDLE_FILTER);
    this.indexFilter = createFilter(ANS104_INDEX_FILTER);
    this.registerEventListeners();
  }
  public shutdown(): void {
    // Remove all listeners to prevent memory leaks
    this.eventEmitter.removeAllListeners();
    this.log.info('WebhookEmitter shutdown completed.');
  }

  private registerEventListeners(): void {
    this.eventEmitter.on(events.TX_INDEXED, async (tx) => {
      console.log('indexed a tx: ', tx);
      if (await this.indexFilter.match(tx)) {
        this.emitWebhook({ event: 'TX_INDEXED', data: tx });
      }
    });

    this.eventEmitter.on(events.ANS104_NESTED_BUNDLE_INDEXED, async (item) => {
      console.log('indexed a bundle data item: ', item);
      if (await this.indexFilter.match(item)) {
        this.emitWebhook({ event: 'ANS104_DATA_ITEM_INDEXED', data: item });
      }
    });

    // Add more listeners as needed for other events
  }

  public async emitWebhook(eventWrapper: {
    event: string;
    data: any;
  }): Promise<void> {
    if (this.webhookTargetServer) {
      this.log.info(
        `Emitting webhook to ${this.webhookTargetServer}`,
        eventWrapper,
      );
      try {
        // Send a POST request to the webhookTargetServer with the eventWrapper
        const response = await axios.post(
          this.webhookTargetServer,
          eventWrapper,
        );

        // Check the response and handle it as needed
        if (response.status === 200) {
          this.log.info('Webhook emitted successfully.');
        } else {
          this.log.error(
            `Failed to emit webhook. Status code: ${response.status}`,
          );
        }
      } catch (error: any) {
        this.log.error('Error while emitting webhook:', error.message);
      }
    } else {
      this.log.warn(
        'Webhook target server is not defined. Webhook emission skipped.',
      );
    }
  }
}
