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
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import { Readable } from 'node:stream';
import { default as request } from 'supertest';

import log from '../../log.js';
import {
  ContiguousDataIndex,
  ContiguousDataSource,
  ManifestPathResolver,
} from '../../types.js';
import { createDataHandler } from './handlers.js';

describe('Data routes', () => {
  describe('createDataHandler', () => {
    let app: express.Express;
    let dataIndex: ContiguousDataIndex;
    let dataSource: ContiguousDataSource;
    let blockListValidator: any;
    let manifestPathResolver: ManifestPathResolver;

    beforeEach(() => {
      app = express();
      dataIndex = {
        getDataItemAttributes: () => Promise.resolve(undefined),
        getDataAttributes: () => Promise.resolve(undefined),
        getDataParent: () => Promise.resolve(undefined),
        saveDataContentAttributes: () => Promise.resolve(undefined),
        getTransactionAttributes: () => Promise.resolve(undefined),
      };
      dataSource = {
        getData: () =>
          Promise.resolve({
            stream: Readable.from(Buffer.from('testing...')),
            size: 10,
            verified: false,
            cached: false,
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
            },
          }),
      };
      blockListValidator = {
        isIdBlocked: () => Promise.resolve(false),
        isHashBlocked: () => Promise.resolve(false),
      };
      manifestPathResolver = {
        resolveFromIndex: () =>
          Promise.resolve({
            id: 'not-a-real-id',
            resolvedId: 'not-a-real-id',
            complete: false,
          }),
        resolveFromData: () =>
          Promise.resolve({
            id: 'not-a-real-id',
            resolvedId: 'not-a-real-id',
            complete: false,
          }),
      };
    });

    afterEach(() => {
      mock.restoreAll();
    });

    it('should return 200 status code and data for unblocked data request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .expect(200)
        .then((res: any) => {
          assert.equal(res.body.toString(), 'testing...');
        });
    });

    it('should return 200 status code and empty data for unblocked data HEAD request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .head('/not-a-real-id')
        .expect(200)
        .then((res: any) => {
          assert.deepEqual(res.body, {});
        });
    });

    it('should return 206 status code and partial data for a range request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=2-3')
        .expect(206)
        .then((res: any) => {
          assert.equal(res.body.toString(), 'st');
        });
    });

    it('should return 206 status code and empty data for a HEAD range request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .head('/not-a-real-id')
        .set('Range', 'bytes=2-3')
        .expect(206)
        .then((res: any) => {
          assert.deepEqual(res.body, {});
        });
    });

    it('should return 416 status code for a unsatisfiable range request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=12-30')
        .expect(416)
        .then((res: any) => {
          assert.equal(res.text, 'Range not satisfiable');
        });
    });

    it('should return 206 status code and partial data for a range request with multiple ranges', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=1-2,4-5')
        .expect(206)
        .buffer()
        .parse((res: any, callback: any) => {
          res.setEncoding('binary');
          res.data = '';
          res.on('data', function (chunk: any) {
            res.data += chunk;
          });
          res.on('end', function () {
            callback(null, Buffer.from(res.data));
          });
        })
        .then((res: any) => {
          const boundary = res.boundary;
          assert.equal(
            res.get('Content-Type'),
            `multipart/byteranges; boundary=${boundary}`,
          );

          // binary response data is in res.body as a buffer
          assert.ok(Buffer.isBuffer(res.body));

          // As  the server respond with a \r\n linebreak and JS template literals use \n linebreaks, \n is replaced by \r\n in the expected response
          const expectedResponse = `--${boundary}
Content-Type: application/octet-stream
Content-Range: bytes 1-2/10

es
--${boundary}
Content-Type: application/octet-stream
Content-Range: bytes 4-5/10

in
--${boundary}--
`.replace(/\n/g, '\r\n');
          assert.equal(res.body.toString(), expectedResponse);
        });

      await get;
    });

    it('should return 206 status code and partial data for a range request with multiple ranges in inverted order', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=4-5,1-2')
        .expect(206)
        .buffer()
        .parse((res: any, callback: any) => {
          res.setEncoding('binary');
          res.data = '';
          res.on('data', function (chunk: any) {
            res.data += chunk;
          });
          res.on('end', function () {
            callback(null, Buffer.from(res.data));
          });
        })
        .then((res: any) => {
          const boundary = res.boundary;
          assert.equal(
            res.get('Content-Type'),
            `multipart/byteranges; boundary=${boundary}`,
          );

          // binary response data is in res.body as a buffer
          assert.ok(Buffer.isBuffer(res.body));

          // As  the server respond with a \r\n linebreak and JS template literals use \n linebreaks, \n is replaced by \r\n in the expected response
          const expectedResponse = `--${boundary}
Content-Type: application/octet-stream
Content-Range: bytes 4-5/10

in
--${boundary}
Content-Type: application/octet-stream
Content-Range: bytes 1-2/10

es
--${boundary}--
`.replace(/\n/g, '\r\n');
          assert.equal(res.body.toString(), expectedResponse);
        });

      await get;
    });

    it('should return 206 status code and partial data for a range request with multiple ranges without combining ranges', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=1-2,2-3')
        .expect(206)
        .buffer()
        .parse((res: any, callback: any) => {
          res.setEncoding('binary');
          res.data = '';
          res.on('data', function (chunk: any) {
            res.data += chunk;
          });
          res.on('end', function () {
            callback(null, Buffer.from(res.data));
          });
        })
        .then((res: any) => {
          const boundary = res.boundary;
          assert.equal(
            res.get('Content-Type'),
            `multipart/byteranges; boundary=${boundary}`,
          );

          // binary response data is in res.body as a buffer
          assert.ok(Buffer.isBuffer(res.body));

          // As  the server respond with a \r\n linebreak and JS template literals use \n linebreaks, \n is replaced by \r\n in the expected response
          const expectedResponse = `--${boundary}
Content-Type: application/octet-stream
Content-Range: bytes 1-2/10

es
--${boundary}
Content-Type: application/octet-stream
Content-Range: bytes 2-3/10

st
--${boundary}--
`.replace(/\n/g, '\r\n');
          assert.equal(res.body.toString(), expectedResponse);
        });

      await get;
    });

    it('should return 206 status code and partial data for a range within size but bigger than size', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=5-20')
        .expect(206)
        .then((res: any) => {
          assert.equal(res.get('Content-Type'), 'application/octet-stream');

          assert.equal(res.body.toString(), 'ng...');
        });

      await get;
    });

    it('should return 206 status code and empty data and boundary header for a HEAD range request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      const head = request(app)
        .head('/not-a-real-id')
        .set('Range', 'bytes=1-2,4-5')
        .expect(206)
        .expect('Accept-Ranges', 'bytes')
        .then((res: any) => {
          assert.equal(
            res.get('Content-Type'),
            `multipart/byteranges; boundary=${res.boundary}`,
          );
          assert.deepEqual(res.body, {});
        });

      await head;
    });

    it('should return 404 given a blocked ID', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      mock.method(blockListValidator, 'isIdBlocked', () =>
        Promise.resolve(true),
      );

      const get = request(app).get('/not-a-real-id-id').expect(404);
      const head = request(app).head('/not-a-real-id-id').expect(404);
      await Promise.all([get, head]);
    });

    describe('Headers', () => {
      describe('X-AR-IO-Verified', () => {
        it("should return false when data isn't verified", async () => {
          dataIndex.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-cache'], 'MISS');
              assert.equal(res.headers['x-ar-io-verified'], 'false');
            });
        });

        it("should return false when data isn't verified AND cached", async () => {
          dataIndex.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });

          dataSource.getData = () =>
            Promise.resolve({
              stream: Readable.from(Buffer.from('testing...')),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-cache'], 'HIT');
              assert.equal(res.headers['x-ar-io-verified'], 'false');
            });
        });

        it('should return false when data is verified but not cached', async () => {
          dataIndex.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-cache'], 'MISS');
              assert.equal(res.headers['x-ar-io-verified'], 'false');
            });
        });

        it('should return true when data is verified AND cached', async () => {
          dataIndex.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = () =>
            Promise.resolve({
              stream: Readable.from(Buffer.from('testing...')),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-cache'], 'HIT');
              assert.equal(res.headers['x-ar-io-verified'], 'true');
            });
        });
      });

      describe('X-AR-IO-Digest/Etag', () => {
        it("shouldn't return digest/etag when hash is not available", async () => {
          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-digest'], undefined);
              assert.equal(res.headers['etag'], undefined);
            });
        });

        it("shouldn't return digest/etag when hash is available AND data is not cached", async () => {
          dataIndex.getDataAttributes = () =>
            Promise.resolve({
              hash: 'hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-digest'], undefined);
              assert.equal(res.headers['etag'], undefined);
            });
        });

        it('should return digest/etag when hash is available AND data is cached', async () => {
          dataIndex.getDataAttributes = () =>
            Promise.resolve({
              hash: 'hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });

          dataSource.getData = () =>
            Promise.resolve({
              stream: Readable.from(Buffer.from('testing...')),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataIndex,
              dataSource,
              blockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-digest'], 'hash');
              assert.equal(res.headers['etag'], 'hash');
            });
        });
      });
    });
  });
});
