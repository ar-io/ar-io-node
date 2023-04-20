/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import stream from 'node:stream';
import * as sinon from 'sinon';

import { emitAns104UnbundleEvents } from '../../src/lib/bundles.js';
import log from '../../src/log.js';
import { stubAns104Bundle, stubTxID } from '../../test/stubs.js';

describe('importAns102Bundle', () => {
  it('should do something (placedholder test)', () => {
    expect(true).to.equal(true);
  });
});

describe('importAns104Bundle', () => {
  let ans104Bundle: stream.Readable;
  let eventEmitter: EventEmitter;

  beforeEach(async () => {
    eventEmitter = new EventEmitter();
    ans104Bundle = await stubAns104Bundle();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should proccess bundles and save data items to the database using default batch size', async () => {
    let emitCount = 0;
    eventEmitter.on('data-item-unbundled', () => {
      emitCount++;
    });
    await emitAns104UnbundleEvents({
      log,
      eventEmitter,
      bundleStream: ans104Bundle,
      parentTxId: stubTxID,
    });
    expect(emitCount).to.equal(2);
  });
});
