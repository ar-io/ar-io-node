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
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { EventEmitter } from 'node:events';
import * as sinon from 'sinon';
import sinonChai from 'sinon-chai';
import axios from 'axios';

import log from '../../src/log.js';
import { WebhookEmitter } from '../../src/workers/webhook-emitter.js';
import { AlwaysMatch, NeverMatch } from '../filters.js';
import wait from 'wait';

chai.use(chaiAsPromised);
chai.use(sinonChai);

describe('WebhookEmitter', () => {
  let eventEmitter: EventEmitter;
  let webhookEmitter: WebhookEmitter;
  let sandbox: sinon.SinonSandbox;
  const targetServersUrls = ['http://localhost:3000', 'https://localhost:3001'];
  const eventData = { id: 'test' };

  before(async () => {
    eventEmitter = new EventEmitter();
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
  });

  afterEach(async () => {
    sandbox.restore();
    webhookEmitter.shutdown();
  });

  describe('eventListeners', () => {
    it('should not listen for events when the indexFilter is NeverMatch', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new NeverMatch(),
        log,
      });

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should not listen for events when the targetServers is empty', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls: [],
        indexFilter: new AlwaysMatch(),
        log,
      });
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should not listen for events when the targetServers is not valid and indexFilter is NeverMatch', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls: [],
        indexFilter: new NeverMatch(),
        log,
      });

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should listen for indexed events when the indexFilter is not NeverMatch', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        log,
      });

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
        expect(eventEmitter.listenerCount(event)).to.equal(1);
      }
    });
  });

  describe('emitWebhookToTargetServer', () => {
    it('should not emit a webhook when the indexFilter does not match', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new NeverMatch(),
        log,
      });
      const emitWebhookSpy = sandbox.spy(
        webhookEmitter,
        'emitWebhookToTargetServer',
      );

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
        expect(emitWebhookSpy).to.not.have.been.called;
      }
    });

    it('should emit a webhook to all target servers', async () => {
      const axiosPostStub = sandbox.stub(axios, 'post');
      const emitWebhookToTargetServerSpy = sandbox.spy(
        WebhookEmitter.prototype,
        'emitWebhookToTargetServer',
      );
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        log,
      });

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
      }

      await webhookEmitter.emissionQueue.drained();

      if (webhookEmitter.targetServersUrls !== undefined) {
        expect(emitWebhookToTargetServerSpy).to.have.been.callCount(
          webhookEmitter.targetServersUrls.length *
            webhookEmitter.indexEventsToListenFor.length,
        );

        for (const targetServer of webhookEmitter.targetServersUrls) {
          for (const event of webhookEmitter.indexEventsToListenFor) {
            expect(axiosPostStub).to.have.been.calledWith(targetServer, {
              event,
              data: eventData,
            });
          }
        }
      }
    });
  });

  describe('validateTargetServersUrls', () => {
    it('should return true when all target servers are valid http or https urls', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        log,
      });

      expect(webhookEmitter.validateTargetServersUrls()).to.equal(true);
    });

    it('should return false when any target server is not a valid http or https url', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls: ['http://localhost:3000', 'localhost:3001'],
        indexFilter: new AlwaysMatch(),
        log,
      });

      expect(webhookEmitter.validateTargetServersUrls()).to.equal(false);
    });
  });

  describe('emissionQueue', () => {
    it('should limit the numbers of tasks in the queue', async () => {
      const maxEmissionQueueSize = 1;
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        log,
        maxEmissionQueueSize,
      });

      webhookEmitter.emissionQueue.pause();

      for (let i = 0; i < maxEmissionQueueSize + 100; i++) {
        eventEmitter.emit(webhookEmitter.indexEventsToListenFor[0], eventData);
      }

      await wait(1);

      expect(webhookEmitter.emissionQueue.length()).to.equal(
        maxEmissionQueueSize,
      );
    });
  });

  describe('shutdown', () => {
    it('should drain the emission queue', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        log,
      });

      await webhookEmitter.emissionQueue.pause();

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
      }

      await wait(1);

      expect(webhookEmitter.emissionQueue.length()).to.equal(4);

      webhookEmitter.shutdown();

      expect(webhookEmitter.emissionQueue.length()).to.equal(0);
    });

    it('should remove all listeners', async () => {
      webhookEmitter = new WebhookEmitter({
        eventEmitter,
        targetServersUrls,
        indexFilter: new AlwaysMatch(),
        log,
      });

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, eventData);
        expect(eventEmitter.listenerCount(event)).to.equal(1);
      }

      await webhookEmitter.shutdown();

      for (const event of webhookEmitter.indexEventsToListenFor) {
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });
  });
});
