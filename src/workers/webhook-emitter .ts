import * as EventEmitter from 'node:events';
import { WEBHOOK_TARGET_SERVER } from '../config';
import * as winston from 'winston';

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
        // Listen to all events
        this.eventEmitter.on('any', (eventData) => {
            this.emitWebhook(eventData);
        });
    }

    private async emitWebhook(eventData: any): Promise<void> {
        if (this.webhookTargetServer) {
            this.log.info(`Emitting webhook to ${this.webhookTargetServer}`, eventData);
            // Implement the logic to emit the event data to the webhook target server
            // Here you would typically use a library like axios or fetch to send the data
        } else {
            this.log.warn("Webhook target server is not defined. Webhook emission skipped.");
        }
    }
}

// Usage (to be implemented in the main application logic):
// const eventEmitter = new EventEmitter();
// const logger = winston.createLogger({ /* logger configuration */ });
// const webhookEmitter = new WebhookEmitter(eventEmitter, logger);
