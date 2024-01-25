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
import { default as wait } from 'wait';
import axios from 'axios';

import log from '../../src/log.js';
import { WebhookEmitter } from '../../src/workers/webhook-emitter.js';
import { AlwaysMatch, NeverMatch } from '../filters.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);

describe('WebhookEmitter', () => {
  let eventEmitter: EventEmitter;
  let webhookEmitter: WebhookEmitter;
  let sandbox: sinon.SinonSandbox;
  const targetServers = ['http://localhost:3000', 'http://localhost:3001'];

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
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        targetServers,
        new NeverMatch(),
        log,
      );
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should not listen for events when the targetServers is undefined', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        undefined,
        new AlwaysMatch(),
        log,
      );
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should not listen for events when the targetServers is empty', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        [''],
        new AlwaysMatch(),
        log,
      );
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should not listen for events when the targetServers is not valid and indexFilter is NeverMatch', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        undefined,
        new NeverMatch(),
        log,
      );
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });

    it('should listen for indexed events when the indexFilter is not NeverMatch', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        targetServers,
        new AlwaysMatch(),
        log,
      );
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(eventEmitter.listenerCount(event)).to.equal(1);
      }
    });
  });

  describe('emitWebhook', () => {
    it('should not emit a webhook when the indexFilter does not match', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        targetServers,
        new NeverMatch(),
        log,
      );
      const emitWebhookSpy = sandbox.spy(webhookEmitter, 'emitWebhook');
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(emitWebhookSpy).to.not.have.been.called;
      }
    });

    it('should emit a webhook when the indexFilter matches', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        targetServers,
        new AlwaysMatch(),
        log,
      );
      const emitWebhookSpy = sandbox.spy(webhookEmitter, 'emitWebhook');
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
      }

      await wait(10);
      expect(emitWebhookSpy).to.have.been.callCount(
        webhookEmitter.indexEventsToListenFor.length,
      );
    });

    it('should emit a webhook to all target servers', async () => {
      const emitWebhookToTargetServerSpy = sandbox.spy(
        WebhookEmitter.prototype,
        'emitWebhookToTargetServer',
      );

      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        targetServers,
        new AlwaysMatch(),
        log,
      );

      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
      }

      await wait(10);

      if (webhookEmitter.webhookTargetServers !== undefined) {
        return expect(emitWebhookToTargetServerSpy).to.have.been.callCount(
          webhookEmitter.indexEventsToListenFor.length *
            webhookEmitter.webhookTargetServers.length,
        );
      }

      throw new Error();
    });
  });

  describe('emitWebhookToTargetServer', () => {
    it('should emit a webhook to a target server', async () => {
      const axiosPostStub = sandbox.stub(axios, 'post');

      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        ['http://localhost:3000'],
        new AlwaysMatch(),
        log,
      );

      await webhookEmitter.emitWebhookToTargetServer('http://localhost:3000', {
        event: 'test',
        data: { id: 'test' },
      });

      expect(axiosPostStub).to.have.been.calledOnceWith(
        'http://localhost:3000',
        {
          event: 'test',
          data: { id: 'test' },
        },
      );
    });
  });

  describe('shutdown', () => {
    it('should remove all listeners', async () => {
      webhookEmitter = new WebhookEmitter(
        eventEmitter,
        targetServers,
        new AlwaysMatch(),
        log,
      );
      for (const event of webhookEmitter.indexEventsToListenFor) {
        eventEmitter.emit(event, { id: 'test' });
        expect(eventEmitter.listenerCount(event)).to.equal(1);
      }

      webhookEmitter.shutdown();

      for (const event of webhookEmitter.indexEventsToListenFor) {
        expect(eventEmitter.listenerCount(event)).to.equal(0);
      }
    });
  });
});
