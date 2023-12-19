import axios from 'axios';
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import { WEBHOOK_TARGET_SERVER } from '../config.js';
import * as events from '../events.js';

// WebhookEmitter class
export class WebhookEmitter {
  private eventEmitter: EventEmitter;
  private webhookTargetServer?: string;
  private log: winston.Logger;

  constructor(eventEmitter: EventEmitter, log: winston.Logger) {
    this.eventEmitter = eventEmitter;
    this.webhookTargetServer = WEBHOOK_TARGET_SERVER;
    this.log = log.child({ class: 'WebhookEmitter' });
    this.registerEventListeners();
  }

  private registerEventListeners(): void {
    // Listen to specific events from BlockImporter
    this.eventEmitter.on(events.BLOCK_FETCHED, (blockData) => {
      this.emitWebhook({ event: 'BLOCK_FETCHED', data: blockData });
    });

    this.eventEmitter.on(events.BLOCK_TX_FETCHED, (txData) => {
      this.emitWebhook({ event: 'BLOCK_TX_FETCHED', data: txData });
    });

    this.eventEmitter.on(events.BLOCK_TX_FETCH_FAILED, (txData) => {
      this.emitWebhook({ event: 'BLOCK_TX_FETCH_FAILED', data: txData });
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
