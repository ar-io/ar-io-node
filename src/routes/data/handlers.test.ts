/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import { Readable } from 'node:stream';
import { default as request } from 'supertest';

import { headerNames } from '../../constants.js';
import log from '../../log.js';
import { release } from '../../version.js';
import {
  ContiguousDataIndex,
  ContiguousDataSource,
  DataAttributesSource,
  DataBlockListValidator,
  ManifestPathResolver,
} from '../../types.js';
import { createDataHandler, getRequestAttributes } from './handlers.js';

describe('Data routes', () => {
  describe('createDataHandler', () => {
    let app: express.Express;
    let dataIndex: ContiguousDataIndex;
    let dataAttributesSource: DataAttributesSource;
    let dataSource: ContiguousDataSource;
    let dataBlockListValidator: DataBlockListValidator;
    let manifestPathResolver: ManifestPathResolver;

    beforeEach(() => {
      app = express();
      dataIndex = {
        getDataAttributes: () => Promise.resolve(undefined),
        getDataItemAttributes: () => Promise.resolve(undefined),
        getTransactionAttributes: () => Promise.resolve(undefined),
        getDataParent: () => Promise.resolve(undefined),
        saveDataContentAttributes: () => Promise.resolve(undefined),
        getVerifiableDataIds: () => Promise.resolve([]),
        getRootTxId: () => Promise.resolve(undefined),
        saveVerificationStatus: () => Promise.resolve(undefined),
      };
      dataAttributesSource = {
        getDataAttributes: () => Promise.resolve(undefined),
      };
      dataSource = {
        getData: (params?: any) => {
          const fullData = Buffer.from('testing...');
          let data = fullData;

          // Handle range requests
          if (params?.region) {
            const { offset, size } = params.region;
            data = fullData.slice(offset, offset + size);
          }

          return Promise.resolve({
            stream: Readable.from(data),
            size: 10,
            verified: false,
            cached: false,
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
            },
          });
        },
      };
      dataBlockListValidator = {
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=2-3')
        .expect(206)
        .expect('Content-Range', 'bytes 2-3/10')
        .expect('Content-Length', '2')
        .then((res: any) => {
          assert.equal(res.body.toString(), 'st');
        });
    });

    it('should return 206 status code and empty data for a HEAD range request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .head('/not-a-real-id')
        .set('Range', 'bytes=2-3')
        .expect(206)
        .expect('Content-Range', 'bytes 2-3/10')
        .expect('Content-Length', '2')
        .then((res: any) => {
          assert.deepEqual(res.body, {});
        });
    });

    it('should return 416 status code for a unsatisfiable range request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=12-30')
        .expect(416)
        .expect('Content-Range', 'bytes */10')
        .expect(
          'Content-Length',
          Buffer.byteLength('Range not satisfiable').toString(),
        )
        .expect('Accept-Ranges', 'bytes') // RFC 7233: SHOULD include Accept-Ranges on 416
        .expect('Content-Type', 'text/plain; charset=utf-8') // RFC 7233: proper Content-Type for error
        .then((res: any) => {
          assert.equal(res.text, 'Range not satisfiable');
        });
    });

    it('should return 400 for malformed range header', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .set('Range', 'invalid-range-header')
        .expect(400)
        .expect('Accept-Ranges', 'bytes') // Should include Accept-Ranges even on errors
        .expect('Content-Type', 'text/plain; charset=utf-8') // Proper Content-Type for error
        .then((res: any) => {
          assert.equal(res.text, "Malformed 'range' header");
        });
    });

    it('should return 206 status code and partial data for a range request with multiple ranges', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=1-2,4-5')
        .expect(206)
        // .expect('Content-Length', calculated based on boundary and parts) // Will add this manually after boundary capture
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

          // Calculate expected Content-Length
          const contentType = 'application/octet-stream';
          const dataSize = 10;
          let expectedTotalLength = 0;
          const ranges = [
            { start: 1, end: 2 },
            { start: 4, end: 5 },
          ]; // bytes=1-2,4-5

          for (const range of ranges) {
            expectedTotalLength += Buffer.byteLength(`--${boundary}\r\n`);
            expectedTotalLength += Buffer.byteLength(
              `Content-Type: ${contentType}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength(
              `Content-Range: bytes ${range.start}-${range.end}/${dataSize}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength('\r\n');
            expectedTotalLength += range.end - range.start + 1;
            expectedTotalLength += Buffer.byteLength('\r\n');
          }
          expectedTotalLength += Buffer.byteLength(`--${boundary}--\r\n`);
          assert.equal(
            res.get('Content-Length'),
            expectedTotalLength.toString(),
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=4-5,1-2')
        .expect(206)
        // .expect('Content-Length', calculated based on boundary and parts) // Will add this manually after boundary capture
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

          // Calculate expected Content-Length
          const contentType = 'application/octet-stream';
          const dataSize = 10;
          let expectedTotalLength = 0;
          const ranges = [
            { start: 4, end: 5 },
            { start: 1, end: 2 },
          ]; // bytes=4-5,1-2

          for (const range of ranges) {
            expectedTotalLength += Buffer.byteLength(`--${boundary}\r\n`);
            expectedTotalLength += Buffer.byteLength(
              `Content-Type: ${contentType}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength(
              `Content-Range: bytes ${range.start}-${range.end}/${dataSize}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength('\r\n');
            expectedTotalLength += range.end - range.start + 1;
            expectedTotalLength += Buffer.byteLength('\r\n');
          }
          expectedTotalLength += Buffer.byteLength(`--${boundary}--\r\n`);
          assert.equal(
            res.get('Content-Length'),
            expectedTotalLength.toString(),
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=1-2,2-3')
        .expect(206)
        // .expect('Content-Length', calculated based on boundary and parts) // Will add this manually after boundary capture
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

          // Calculate expected Content-Length
          const contentType = 'application/octet-stream';
          const dataSize = 10;
          let expectedTotalLength = 0;
          const ranges = [
            { start: 1, end: 2 },
            { start: 2, end: 3 },
          ]; // bytes=1-2,2-3

          for (const range of ranges) {
            expectedTotalLength += Buffer.byteLength(`--${boundary}\r\n`);
            expectedTotalLength += Buffer.byteLength(
              `Content-Type: ${contentType}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength(
              `Content-Range: bytes ${range.start}-${range.end}/${dataSize}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength('\r\n');
            expectedTotalLength += range.end - range.start + 1;
            expectedTotalLength += Buffer.byteLength('\r\n');
          }
          expectedTotalLength += Buffer.byteLength(`--${boundary}--\r\n`);
          assert.equal(
            res.get('Content-Length'),
            expectedTotalLength.toString(),
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=5-20') // data 'testing...' (10 bytes) -> range 5-9 ('ng...')
        .expect(206)
        .expect('Content-Range', 'bytes 5-9/10')
        .expect('Content-Length', '5') // 9 - 5 + 1 = 5
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );
      const head = request(app)
        .head('/not-a-real-id')
        .set('Range', 'bytes=1-2,4-5')
        .expect(206)
        .expect('Accept-Ranges', 'bytes')
        .then((res: any) => {
          const boundary = res.boundary;
          assert.equal(
            res.get('Content-Type'),
            `multipart/byteranges; boundary=${boundary}`,
          );

          // Calculate expected Content-Length for HEAD multipart
          const contentType = 'application/octet-stream';
          const dataSize = 10;
          let expectedTotalLength = 0;
          const ranges = [
            { start: 1, end: 2 },
            { start: 4, end: 5 },
          ]; // bytes=1-2,4-5

          for (const range of ranges) {
            expectedTotalLength += Buffer.byteLength(`--${boundary}\r\n`);
            expectedTotalLength += Buffer.byteLength(
              `Content-Type: ${contentType}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength(
              `Content-Range: bytes ${range.start}-${range.end}/${dataSize}\r\n`,
            );
            expectedTotalLength += Buffer.byteLength('\r\n');
            expectedTotalLength += range.end - range.start + 1;
            expectedTotalLength += Buffer.byteLength('\r\n');
          }
          expectedTotalLength += Buffer.byteLength(`--${boundary}--\r\n`);
          assert.equal(
            res.get('Content-Length'),
            expectedTotalLength.toString(),
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
          dataAttributesSource,
          dataSource,
          dataBlockListValidator,
          manifestPathResolver,
        }),
      );

      mock.method(dataBlockListValidator, 'isIdBlocked', () =>
        Promise.resolve(true),
      );

      const get = request(app).get('/not-a-real-id').expect(404);
      const head = request(app).head('/not-a-real-id').expect(404);
      await Promise.all([get, head]);
    });

    describe('Headers', () => {
      describe('X-AR-IO-Verified', () => {
        it("should return false when data isn't verified", async () => {
          dataAttributesSource.getDataAttributes = () =>
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
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
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
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
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
          dataAttributesSource.getDataAttributes = () =>
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
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
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
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
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
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-digest'], undefined);
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['etag'], undefined);
            });
        });

        it("shouldn't return digest/etag when hash is available AND data is not cached", async () => {
          dataAttributesSource.getDataAttributes = () =>
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
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-digest'], undefined);
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['etag'], undefined);
            });
        });

        it('should return digest/etag when hash is available AND data is cached', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-digest'], 'hash');
              assert.equal(res.headers['content-digest'], 'sha-256=:hash:');
              assert.equal(res.headers['etag'], '"hash"');
            });
        });

        it('should return Content-Digest header with RFC 9530 format when hash is available AND data is cached', async () => {
          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          // Mock data with base64url hash
          dataAttributesSource.getDataAttributes = async () => ({
            hash: '4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4',
            size: 100,
            contentType: 'text/plain',
            stable: true,
            verified: true,
            offset: 0,
          });

          dataSource.getData = async () => ({
            stream: Readable.from(Buffer.from('test data')),
            size: 100,
            sourceContentType: 'text/plain',
            verified: true,
            cached: true,
            trusted: true,
          });

          await request(app)
            .get('/test-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(
                res.headers['x-ar-io-digest'],
                '4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4',
              );
              assert.equal(
                res.headers['content-digest'],
                'sha-256=:4ROTs2lTPAKbr8Y41WrjHu+2q+7S+m+yTuO7fAUzZI4=:',
              );
              assert.equal(
                res.headers['etag'],
                '"4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4"',
              );
            });
        });
      });

      describe('X-AR-IO-Root-Transaction-Id', () => {
        it("shouldn't return root transaction id for transactions", async () => {
          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(
                res.headers['x-ar-io-root-transaction-id'],
                undefined,
              );
            });
        });

        it('should return root transaction id for data items', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              rootTransactionId: 'root-tx',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(
                res.headers['x-ar-io-root-transaction-id'],
                'root-tx',
              );
            });
        });
      });

      describe('If-None-Match', () => {
        it('should return 304 for HEAD request when If-None-Match matches ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .head('/not-a-real-id')
            .set('If-None-Match', '"test-hash"')
            .expect(304)
            .then((res: any) => {
              assert.equal(res.headers['etag'], '"test-hash"');
              assert.deepEqual(res.body, {});
              // 304 responses must not have entity headers per RFC 7232
              assert.equal(res.headers['content-length'], undefined);
              assert.equal(res.headers['content-encoding'], undefined);
              assert.equal(res.headers['content-range'], undefined);
              assert.equal(res.headers['content-type'], undefined);
            });
        });

        it('should return 200 for HEAD request when If-None-Match does not match ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .head('/not-a-real-id')
            .set('If-None-Match', '"different-hash"')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['etag'], '"test-hash"');
              assert.deepEqual(res.body, {});
            });
        });

        it('should return 304 for GET request when If-None-Match matches ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .set('If-None-Match', '"test-hash"')
            .expect(304)
            .then((res: any) => {
              assert.equal(res.headers['etag'], '"test-hash"');
              // 304 responses should have empty body
              assert.equal(res.text || '', '');
              // 304 responses must not have entity headers per RFC 7232
              assert.equal(res.headers['content-length'], undefined);
              assert.equal(res.headers['content-encoding'], undefined);
              assert.equal(res.headers['content-range'], undefined);
              assert.equal(res.headers['content-type'], undefined);
            });
        });

        it('should return 200 for GET request when If-None-Match does not match ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .set('If-None-Match', '"different-hash"')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['etag'], '"test-hash"');
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('should not return 304 when ETag is not set', async () => {
          // No hash means no ETag
          dataAttributesSource.getDataAttributes = () =>
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
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .set('If-None-Match', '"some-hash"')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['etag'], undefined);
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('should return 304 for range request when If-None-Match matches ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .set('Range', 'bytes=2-3')
            .set('If-None-Match', '"test-hash"')
            .expect(304)
            .then((res: any) => {
              assert.equal(res.headers['etag'], '"test-hash"');
              assert.equal(res.text || '', '');
              // 304 responses must not have entity headers per RFC 7232
              assert.equal(res.headers['content-length'], undefined);
              assert.equal(res.headers['content-encoding'], undefined);
              assert.equal(res.headers['content-range'], undefined);
              assert.equal(res.headers['content-type'], undefined);
            });
        });
      });

      describe('X-AR-IO-Trusted header', () => {
        it('should set X-AR-IO-Trusted to true when data.trusted is true', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              trusted: true, // data.trusted is true
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-trusted'], 'true');
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('should set X-AR-IO-Trusted to false when data.trusted is false', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              trusted: false, // data.trusted is false
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-trusted'], 'false');
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('should set X-AR-IO-Trusted header correctly for HEAD requests', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              trusted: true, // data.trusted is true
              cached: false,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .head('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-trusted'], 'true');
              assert.deepEqual(res.body, {});
            });
        });

        it('should set X-AR-IO-Trusted header for non-cached data', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              trusted: false, // data.trusted is false
              cached: false, // non-cached data
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-trusted'], 'false');
              assert.equal(res.headers['x-ar-io-cache'], 'MISS');
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('should set X-AR-IO-Trusted header for range requests', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });

          dataSource.getData = (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            // Handle range requests
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              trusted: true, // data.trusted is true
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          };

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/not-a-real-id')
            .set('Range', 'bytes=2-3')
            .expect(206)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-trusted'], 'true');
              assert.equal(res.body.toString(), 'st');
            });
        });
      });

      describe('X-AR-IO-Data-Id header', () => {
        it('should set X-AR-IO-Data-Id header with resolved ID when manifest path resolution succeeds', async () => {
          const resolvedId = 'resolved-manifest-path-id';

          // Mock the data attributes to indicate this is a manifest
          mock.method(dataAttributesSource, 'getDataAttributes', () =>
            Promise.resolve({
              size: 100,
              contentType: 'application/x.arweave-manifest+json',
              isManifest: true,
              stable: true,
              verified: true,
              signature: null,
            }),
          );

          // Mock resolveFromIndex to return undefined resolvedId (forcing fallback to resolveFromData)
          mock.method(manifestPathResolver, 'resolveFromIndex', () =>
            Promise.resolve({
              id: 'manifest-id',
              resolvedId: undefined,
              complete: false,
            }),
          );

          // Mock the data source to return a valid manifest JSON
          mock.method(dataSource, 'getData', () => {
            const manifestJson = JSON.stringify({
              manifest: 'arweave/paths',
              version: '0.1.0',
              index: { path: 'index.html' },
              paths: {
                'path/to/file.txt': { id: resolvedId },
              },
            });
            return Promise.resolve({
              stream: Readable.from(Buffer.from(manifestJson)),
              size: manifestJson.length,
              verified: true,
              cached: false,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            });
          });

          // Mock resolveFromData to return the correct resolved ID
          mock.method(manifestPathResolver, 'resolveFromData', () =>
            Promise.resolve({
              id: 'manifest-id',
              resolvedId,
              complete: true,
            }),
          );

          app.get(
            '/:id/*',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/manifest-id/path/to/file.txt')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-data-id'], resolvedId);
            });
        });

        it('should set X-AR-IO-Data-Id header with data ID for direct data access', async () => {
          mock.method(dataAttributesSource, 'getDataAttributes', () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            }),
          );

          mock.method(dataSource, 'getData', () =>
            Promise.resolve({
              stream: Readable.from(Buffer.from('test data')),
              size: 9,
              verified: true,
              cached: false,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            }),
          );

          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/direct-data-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-data-id'], 'direct-data-id');
            });
        });

        it('should set X-AR-IO-Data-Id header with ArNS resolved ID when ArNS resolution occurs', async () => {
          const arnsResolvedId = 'arns-resolved-data-id';

          mock.method(dataAttributesSource, 'getDataAttributes', () =>
            Promise.resolve({
              size: 10,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            }),
          );

          mock.method(dataSource, 'getData', () =>
            Promise.resolve({
              stream: Readable.from(Buffer.from('test data')),
              size: 9,
              verified: true,
              cached: false,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
              },
            }),
          );

          // Mock req.dataId to simulate ArNS resolution
          app.get(
            '/:id',
            (req, res, next) => {
              // Simulate ArNS resolution by setting the dataId on request
              req.dataId = arnsResolvedId;
              next();
            },
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
            }),
          );

          return request(app)
            .get('/original-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-data-id'], arnsResolvedId);
            });
        });
      });

      describe('Request Attributes Initialization', () => {
        it('should propagate existing X-AR-IO-Origin and X-AR-IO-Origin-Node-Release headers', () => {
          const mockReq = {
            headers: {
              'x-ar-io-hops': '3',
              'x-ar-io-origin': 'original-gateway.ar.io',
              'x-ar-io-origin-node-release': 'v1.0.0',
            },
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes);

          assert.equal(requestAttributes.hops, 3);
          assert.equal(requestAttributes.origin, 'original-gateway.ar.io');
          assert.equal(requestAttributes.originNodeRelease, 'v1.0.0');
        });

        it('should not initialize originNodeRelease when only origin is present in headers', () => {
          const mockReq = {
            headers: {
              'x-ar-io-hops': '1',
              'x-ar-io-origin': 'partial-origin.ar.io',
            },
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes, {
            arnsRootHost: 'test-gateway.ar.io',
            nodeRelease: 'test-release-1.0.0',
          });

          assert.equal(requestAttributes.hops, 1);
          assert.equal(requestAttributes.origin, 'partial-origin.ar.io');
          assert.equal(requestAttributes.originNodeRelease, undefined);
        });

        it('should not initialize origin when only originNodeRelease is present in headers', () => {
          const mockReq = {
            headers: {
              'x-ar-io-hops': '2',
              'x-ar-io-origin-node-release': 'v2.0.0',
            },
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes, {
            arnsRootHost: 'test-gateway.ar.io',
            nodeRelease: 'test-release-1.0.0',
          });

          assert.equal(requestAttributes.hops, 2);
          assert.equal(requestAttributes.origin, undefined);
          assert.equal(requestAttributes.originNodeRelease, 'v2.0.0');
        });

        it('should initialize origin and originNodeRelease when ARNS_ROOT_HOST is configured', () => {
          const mockReq = {
            headers: {},
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes, {
            arnsRootHost: 'test-gateway.ar.io',
            nodeRelease: 'test-release-2.0.0',
          });

          assert.equal(requestAttributes.hops, 0);
          assert.equal(requestAttributes.origin, 'test-gateway.ar.io');
          assert.equal(
            requestAttributes.originNodeRelease,
            'test-release-2.0.0',
          );
        });

        it('should not initialize origin when ARNS_ROOT_HOST is not configured', () => {
          const mockReq = {
            headers: {},
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes, {
            arnsRootHost: undefined,
            nodeRelease: 'test-release-3.0.0',
          });

          assert.equal(requestAttributes.hops, 0);
          assert.equal(requestAttributes.origin, undefined);
          assert.equal(requestAttributes.originNodeRelease, undefined);
        });

        it('should handle invalid hops header gracefully', () => {
          const mockReq = {
            headers: {
              'x-ar-io-hops': 'invalid',
              'x-ar-io-origin': 'test-origin.ar.io',
            },
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes, {
            nodeRelease: 'test-release-4.0.0',
          });

          assert.equal(requestAttributes.hops, 0); // parseInt('invalid') || 0 = 0
          assert.equal(requestAttributes.origin, 'test-origin.ar.io');
          assert.equal(requestAttributes.originNodeRelease, undefined); // Not initialized since origin is from headers
        });

        it('should get ArNS attributes from req.arns when present', () => {
          const mockReq = {
            headers: {},
            arns: {
              name: 'test-name',
              basename: 'test-basename',
              record: 'test-record',
            },
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes);

          assert.equal(requestAttributes.arnsName, 'test-name');
          assert.equal(requestAttributes.arnsBasename, 'test-basename');
          assert.equal(requestAttributes.arnsRecord, 'test-record');
        });

        it('should return undefined ArNS attributes when req.arns is not present', () => {
          const mockReq = {
            headers: {},
          } as any;
          const mockRes = {
            get: () => undefined,
          } as any;

          const requestAttributes = getRequestAttributes(mockReq, mockRes);

          assert.equal(requestAttributes.arnsName, undefined);
          assert.equal(requestAttributes.arnsBasename, undefined);
          assert.equal(requestAttributes.arnsRecord, undefined);
        });
      });
    });
  });
});
