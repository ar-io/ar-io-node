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
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it, mock } from 'node:test';
import * as winston from 'winston';
import { EventEmitter } from 'node:events';
import axios from 'axios';

import { WebhookEmitter } from '../../src/workers/webhook-emitter.js';
import { AlwaysMatch, NeverMatch } from '../filters.js';
import wait from 'wait';

describe('WebhookEmitter', () => {
  let log: winston.Logger;
  let eventEmitter: EventEmitter;
  let webhookEmitter: WebhookEmitter;
  const targetServersUrls = ['http://localhost:3000', 'https://localhost:3001'];
  const eventData = { id: 'test' };

  before(async () => {
    eventEmitter = new EventEmitter();
    log = winston.createLogger({ silent: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    webhookEmitter?.stop();
  });

  describe('eventListeners', () => {
    it('should not listen for events when the indexFilter is NeverMatch', async () => {
      mock.method(eventEmitter, 'listenerCount');

      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new NeverMatch(),
        blockFilter: new NeverMatch(),
        log,
      });

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
        assert.equal((eventEmitter.listenerCount as any).mock.callCount(), 0);
      }
    });

    it('should not listen for events when the targetServers is empty', async () => {
      mock.method(eventEmitter, 'listenerCount');

      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls: [],
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });
      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
        assert.equal((eventEmitter.listenerCount as any).mock.callCount(), 0);
      }
    });

    it('should not listen for events when the targetServers is not valid and indexFilter is NeverMatch', async () => {
      mock.method(eventEmitter, 'listenerCount');

      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls: [],
        indexFilter: new NeverMatch(),
        blockFilter: new NeverMatch(),
        log,
      });

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
        assert.equal((eventEmitter.listenerCount as any).mock.callCount(), 0);
      }
    });

    it('should listen for indexed events when the indexFilter is not NeverMatch', async () => {
      mock.method(eventEmitter, 'listenerCount');

      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
        assert.equal((eventEmitter.listenerCount as any).mock.callCount(), 0);
      }
    });
  });

  describe('emitWebhookToTargetServer', () => {
    it('should not emit a webhook when the indexFilter does not match', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new NeverMatch(),
        blockFilter: new NeverMatch(),
        log,
      });
      mock.method(webhookEmitter, 'emitWebhookToTargetServer');

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
        assert.equal(
          (webhookEmitter.emitWebhookToTargetServer as any).mock.callCount(),
          0,
        );
      }
    });

    it('should emit a webhook to all target servers', async () => {
      mock.method(
        WebhookEmitter.prototype,
        'emitWebhookToTargetServer',
        async () => Promise.resolve(),
      );
      mock.method(axios, 'post');

      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
      }

      await wait(0);

      assert.equal(
        (webhookEmitter.emitWebhookToTargetServer as any).mock.callCount(),
        webhookEmitter.targetServersUrls.length *
          webhookEmitter.eventsToListenFor.length,
      );

      // skipping axios post call test for now
      // for (const targetServer of webhookEmitter.targetServersUrls) {
      //   for (const [
      //     index,
      //     event,
      //   ] of webhookEmitter.indexEventsToListenFor.entries()) {
      //     assert.deepEqual((axios.post as any).mock.calls[index].arguments, [
      //       targetServer,
      //       { event, data: eventData },
      //     ]);
      //   }
      // }
    });
  });

  describe('validateTargetServersUrls', () => {
    it('should return true when all target servers are valid http or https urls', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });

      assert.equal(webhookEmitter.validateTargetServersUrls(), true);
    });

    it('should return false when any target server is not a valid http or https url', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls: ['http://localhost:3000', 'localhost:3001'],
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });

      assert.equal(webhookEmitter.validateTargetServersUrls(), false);
    });
  });

  describe('emissionQueue', () => {
    it('should limit the numbers of tasks in the queue', async () => {
      const maxEmissionQueueSize = 1;
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
        maxEmissionQueueSize,
      });

      webhookEmitter.emissionQueue.pause();

      for (let i = 0; i < maxEmissionQueueSize + 100; i++) {
        eventEmitter.emit(webhookEmitter.eventsToListenFor[0], eventData);
      }

      await wait(1);

      assert.equal(webhookEmitter.emissionQueue.length(), maxEmissionQueueSize);
    });
  });

  describe('stop', () => {
    it('should drain the emission queue', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });

      await webhookEmitter.emissionQueue.pause();

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
      }

      await wait(1);

      assert.equal(webhookEmitter.emissionQueue.length(), 6);

      webhookEmitter.stop();

      assert.equal(webhookEmitter.emissionQueue.length(), 0);
    });

    it('should remove all listeners', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        blockFilter: new AlwaysMatch(),
        log,
      });

      for (const event of webhookEmitter.eventsToListenFor) {
        eventEmitter.emit(event, eventData);
        assert.equal(eventEmitter.listenerCount(event), 1);
      }

      await webhookEmitter.stop();

      for (const event of webhookEmitter.eventsToListenFor) {
        assert.equal(eventEmitter.listenerCount(event), 0);
      }
    });
  });
});
