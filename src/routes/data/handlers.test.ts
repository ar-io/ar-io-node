/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { default as request } from 'supertest';
import { gzipSync } from 'node:zlib';

import { headerNames } from '../../constants.js';
import * as config from '../../config.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'Data routes' });
import {
  ContiguousDataSource,
  DataAttributesSource,
  DataBlockListValidator,
  ManifestPathResolver,
} from '../../types.js';
import {
  createDataHandler,
  createRawDataHandler,
  getRequestAttributes,
  matchContentTypePattern,
  shouldUsePrivateCacheControl,
} from './handlers.js';
import { MemoryRateLimiter } from '../../limiter/memory-rate-limiter.js';
import { setRequestSignal } from '../../middleware/abort-signal.js';
import type {
  PaymentProcessor,
  PaymentRequirementsContext,
  PaymentVerificationResult,
  PaymentSettlementResult,
} from '../../payments/types.js';
import type { PaymentPayload, PaymentRequirements } from 'x402/types';
import type { Request, Response } from 'express';

describe('Data routes', () => {
  describe('createDataHandler', () => {
    let app: express.Express;
    let dataAttributesSource: DataAttributesSource;
    let dataSource: ContiguousDataSource;
    let dataBlockListValidator: DataBlockListValidator;
    let manifestPathResolver: ManifestPathResolver;

    beforeEach(() => {
      app = express();
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
            trusted: false,
            cached: false,
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
              clientIps: [],
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
        resolveFromTrustedCache: () => undefined,
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

    describe('Content-Encoding', () => {
      const body = Buffer.from('{"compressed":"on chain"}');
      const gzipped = gzipSync(body);
      // superagent decodes a gzip response before this parser sees it, so an
      // encoding header that does not match the bytes fails the request.
      const bufferBody = (res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      };
      const get = () =>
        request(app)
          .get('/not-a-real-id')
          .buffer(true)
          .parse(bufferBody)
          .expect(200);
      const serve = (sourceContentEncoding?: string) => {
        dataSource = {
          getData: () =>
            Promise.resolve({
              stream: Readable.from(
                sourceContentEncoding !== undefined ? gzipped : body,
              ),
              size:
                sourceContentEncoding !== undefined
                  ? gzipped.length
                  : body.length,
              verified: false,
              trusted: true,
              cached: false,
              sourceContentEncoding,
            }),
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
      };

      it('labels bytes its upstream reports as gzip-encoded when the item is not indexed', async () => {
        serve('gzip');

        const res = await get();

        assert.equal(res.headers['content-encoding'], 'gzip');
        assert.equal(res.headers['content-length'], String(gzipped.length));
        // Decoded by the client: fails if the header does not fit the bytes.
        assert.deepEqual(res.body, body);
      });

      it("uses the item's indexed encoding", async () => {
        dataAttributesSource = {
          getDataAttributes: () =>
            Promise.resolve({ contentEncoding: 'gzip' } as any),
        };
        serve('gzip');

        const res = await get();

        assert.equal(res.headers['content-encoding'], 'gzip');
        assert.deepEqual(res.body, body);
      });

      it('normalizes an indexed tag value', async () => {
        dataAttributesSource = {
          getDataAttributes: () =>
            Promise.resolve({ contentEncoding: ' GZIP ' } as any),
        };
        serve('gzip');

        const res = await get();

        assert.equal(res.headers['content-encoding'], 'gzip');
        assert.deepEqual(res.body, body);
      });

      it('names no coding a client may not decode', async () => {
        // Stacked codings and unknown ones are served without the header, as
        // before, rather than with one the client cannot decode.
        for (const encoding of ['gzip, br', 'x-custom']) {
          app = express();
          dataAttributesSource = {
            getDataAttributes: () =>
              Promise.resolve({ contentEncoding: encoding } as any),
          };
          serve(undefined);

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined, encoding);
        }
      });

      it('drops an indexed coding the bytes do not use', async () => {
        // A Content-Encoding tag is the uploader's claim: an item can be
        // tagged gzip and carry plain bytes.
        dataAttributesSource = {
          getDataAttributes: () =>
            Promise.resolve({ contentEncoding: 'gzip' } as any),
        };
        serve(undefined);

        const res = await get();

        assert.equal(res.headers['content-encoding'], undefined);
        assert.equal(res.headers['content-length'], String(body.length));
        assert.deepEqual(res.body, body);
      });

      it('keeps gzip when the first chunk is shorter than its magic', async () => {
        dataAttributesSource = {
          getDataAttributes: () =>
            Promise.resolve({ contentEncoding: 'gzip' } as any),
        };
        dataSource = {
          getData: () =>
            Promise.resolve({
              stream: Readable.from([
                gzipped.subarray(0, 1),
                gzipped.subarray(1),
              ]),
              size: gzipped.length,
              verified: false,
              trusted: true,
              cached: false,
            }),
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

        const res = await get();

        assert.equal(res.headers['content-encoding'], 'gzip');
        // Decoded by the client, so every byte survived the peek.
        assert.deepEqual(res.body, body);
      });

      it('reads past a first chunk shorter than the magic', async () => {
        // Plain bytes whose first byte happens to be gzip's first magic byte,
        // arriving one byte at a time: the first chunk alone cannot rule gzip
        // out.
        const plain = Buffer.from([0x1f, ...Buffer.from(' plain text')]);
        dataAttributesSource = {
          getDataAttributes: () =>
            Promise.resolve({ contentEncoding: 'gzip' } as any),
        };
        dataSource = {
          getData: () =>
            Promise.resolve({
              stream: Readable.from([plain.subarray(0, 1), plain.subarray(1)]),
              size: plain.length,
              verified: false,
              trusted: true,
              cached: false,
            }),
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

        const res = await get();

        assert.equal(res.headers['content-encoding'], undefined);
        assert.deepEqual(res.body, plain);
      });

      describe('responses that do not send the body', () => {
        const HASH = 'a'.repeat(43);
        const mount = (stream: () => Readable, cached: boolean) => {
          dataAttributesSource = {
            getDataAttributes: () =>
              Promise.resolve({ contentEncoding: 'gzip', hash: HASH } as any),
          };
          dataSource = {
            getData: () =>
              Promise.resolve({
                stream: stream(),
                size: gzipped.length,
                verified: false,
                trusted: true,
                cached,
              }),
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
        };
        // Fails as soon as it is read, as a broken cache file or upstream does.
        const failing = () =>
          new Readable({
            read() {
              this.destroy(new Error('read failed'));
            },
          });

        it('checks cached bytes on HEAD', async () => {
          mount(() => Readable.from([body]), true);

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('does not wait on an upstream for HEAD: declares the coding unchecked', async () => {
          // Nothing reads an uncached stream for a response without a body.
          mount(() => Readable.from([body]), false);

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], 'gzip');
        });

        it('falls back to the declared coding when a cached read fails on HEAD', async () => {
          mount(failing, true);

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], 'gzip');
        });

        it('answers a matching If-None-Match with 304 when the read fails', async () => {
          mount(failing, true);

          await request(app)
            .get('/not-a-real-id')
            .set('If-None-Match', `"${HASH}"`)
            .expect(304);
        });

        describe('when routed through an ArNS name', () => {
          const RESOLVED_ID = 'd1FJ-x_35islazgNjqw54eKERvE78j8X2FntbALlkaM';
          // As the ArNS middleware does before the data handler runs.
          const routeThroughName = () =>
            app.use((_req, res, next) => {
              res.setHeader(headerNames.arnsResolvedId, RESOLVED_ID);
              next();
            });

          it('answers its composite tag with 304 when the read fails', async () => {
            // The stream prediction must use the tag the response sends, or
            // it expects a body here and the failed read fails the 304.
            routeThroughName();
            mount(failing, true);

            await request(app)
              .get('/not-a-real-id')
              .set('If-None-Match', `"${HASH}.${RESOLVED_ID}"`)
              .expect(304);
          });

          it('answers the plain digest with a full response and the composite tag', async () => {
            // A cache holding a copy from before the name was re-pointed (or
            // before this tag format) gets fresh headers, not a 304.
            routeThroughName();
            mount(() => Readable.from([gzipped]), true);

            const res = await request(app)
              .get('/not-a-real-id')
              .set('If-None-Match', `"${HASH}"`)
              .expect(200);

            assert.equal(res.headers['etag'], `"${HASH}.${RESOLVED_ID}"`);
            assert.equal(res.headers['x-arns-resolved-id'], RESOLVED_ID);
          });
        });

        it('fails a full GET when the read fails, since it sends the body', async () => {
          mount(failing, true);

          const res = await request(app).get('/not-a-real-id');

          assert.notEqual(res.status, 200);
        });
      });

      it('sends no Content-Encoding for unencoded bytes', async () => {
        serve(undefined);

        const res = await get();

        assert.equal(res.headers['content-encoding'], undefined);
        assert.deepEqual(res.body, body);
      });

      describe("the item's Content-Encoding tag on a hit with no recorded coding", () => {
        const gzipTag = [{ name: 'Content-Encoding', value: 'gzip' }];
        const serveTagged = ({
          bytes,
          cached = true,
          tags = gzipTag,
          viaResolver = false,
          contentEncoding,
        }: {
          bytes: Buffer;
          cached?: boolean;
          tags?: { name: string; value: string }[];
          viaResolver?: boolean;
          contentEncoding?: string;
        }) => {
          if (contentEncoding !== undefined) {
            dataAttributesSource = {
              getDataAttributes: () =>
                Promise.resolve({ contentEncoding } as any),
            };
          }
          dataSource = {
            getData: (params?: any) =>
              Promise.resolve({
                stream: Readable.from(
                  params?.region !== undefined
                    ? bytes.subarray(
                        params.region.offset,
                        params.region.offset + params.region.size,
                      )
                    : bytes,
                ),
                size: bytes.length,
                verified: false,
                trusted: true,
                cached,
                ...(viaResolver ? {} : { upstreamTags: tags }),
              }),
          };
          const dataItemMetaResolver = viaResolver
            ? ({
                resolveFromLocal: () => Promise.resolve({ tags }),
                resolve: () => Promise.resolve(undefined),
              } as any)
            : undefined;
          app.get(
            '/:id',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
              dataItemMetaResolver,
            }),
          );
        };

        it('declares the tagged gzip coding when the cached bytes carry its magic', async () => {
          serveTagged({ bytes: gzipped });

          const res = await get();

          assert.equal(res.headers['content-encoding'], 'gzip');
          assert.equal(res.headers['content-length'], String(gzipped.length));
          // Decoded by the client: fails if the header does not fit the bytes.
          assert.deepEqual(res.body, body);
        });

        it('takes the tag from the local item-header resolver, as on a real cache hit', async () => {
          serveTagged({ bytes: gzipped, viaResolver: true });

          const res = await get();

          assert.equal(res.headers['content-encoding'], 'gzip');
          assert.deepEqual(res.body, body);
        });

        it('declares it on a cached HEAD', async () => {
          serveTagged({ bytes: gzipped });

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], 'gzip');
        });

        it('declares it on a cached range response, whose body is a slice of the stored bytes', async () => {
          serveTagged({ bytes: gzipped });

          const res = await request(app)
            .get('/not-a-real-id')
            .set('Range', 'bytes=0-9')
            .buffer(true)
            .parse(bufferBody)
            .expect(206);

          assert.equal(res.headers['content-encoding'], 'gzip');
          assert.equal(
            res.headers['content-range'],
            `bytes 0-9/${gzipped.length}`,
          );
        });

        it('declares it on an uncached GET, which reads the bytes it sends', async () => {
          serveTagged({ bytes: gzipped, cached: false });

          const res = await get();

          assert.equal(res.headers['content-encoding'], 'gzip');
          assert.deepEqual(res.body, body);
        });

        it('sends no header when the bytes do not carry the magic (decoded upstream)', async () => {
          serveTagged({ bytes: body });

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined);
          assert.deepEqual(res.body, body);
        });

        it('sends no header for a body shorter than the magic', async () => {
          serveTagged({ bytes: Buffer.from([0x1f]) });

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('sends no header for a tagged coding without magic (br)', async () => {
          serveTagged({
            bytes: gzipped,
            tags: [{ name: 'Content-Encoding', value: 'br' }],
          });

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('sends no header on an uncached HEAD, which reads no bytes', async () => {
          serveTagged({ bytes: gzipped, cached: false });

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('sends no header without a Content-Encoding tag', async () => {
          serveTagged({
            bytes: gzipped,
            tags: [{ name: 'Content-Type', value: 'application/wasm' }],
          });

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('only the first Content-Encoding tag counts', async () => {
          serveTagged({
            bytes: gzipped,
            tags: [
              { name: 'Content-Encoding', value: 'br' },
              { name: 'Content-Encoding', value: 'gzip' },
            ],
          });

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('declares a tagged zstd coding when the cached bytes carry its magic', async () => {
          const zstdBytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]);
          serveTagged({
            bytes: zstdBytes,
            tags: [{ name: 'Content-Encoding', value: 'zstd' }],
          });

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], 'zstd');
        });

        it('sends no header, and still answers, when a cached HEAD cannot read the bytes', async () => {
          dataSource = {
            getData: () =>
              Promise.resolve({
                stream: new Readable({
                  read() {
                    this.destroy(new Error('disk read failed'));
                  },
                }),
                size: gzipped.length,
                verified: false,
                trusted: true,
                cached: true,
                upstreamTags: gzipTag,
              }),
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

          const res = await request(app).head('/not-a-real-id').expect(200);

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('a recorded coding the gateway does not honour is not replaced by the tag', async () => {
          serveTagged({ bytes: gzipped, contentEncoding: 'gzip, br' });

          const res = await get();

          assert.equal(res.headers['content-encoding'], undefined);
        });

        it('a recorded coding still takes precedence over the tag', async () => {
          serveTagged({
            bytes: gzipped,
            tags: [{ name: 'Content-Encoding', value: 'zstd' }],
            contentEncoding: 'gzip',
          });

          const res = await get();

          assert.equal(res.headers['content-encoding'], 'gzip');
          assert.deepEqual(res.body, body);
        });
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

    it('should return 451 given a blocked ID', async () => {
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

      const get = request(app)
        .get('/not-a-real-id')
        .expect(451)
        .then((res: any) => {
          assert.match(
            res.text,
            /Requested content blocked by this node's content policy/,
          );
        });
      const head = request(app).head('/not-a-real-id').expect(451);
      await Promise.all([get, head]);
    });

    describe('single range of an uncached item', () => {
      const body = Buffer.from('0123456789abcdefghij');
      let calls: any[];
      let streams: Readable[];
      let attributes: any;
      let source: {
        totalSize?: number;
        cached?: boolean;
        contentType?: string;
        contentEncoding?: string;
        fail?: Error;
        body?: Buffer;
        /** Clamp ranges to the body, as a root-bundle source does. */
        clamp?: boolean;
      };

      // Reads the body as bytes; superagent would otherwise parse or decode it.
      const raw = (res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      };

      beforeEach(() => {
        calls = [];
        streams = [];
        source = {};
        attributes = {
          size: body.length,
          contentType: 'text/plain',
          isManifest: false,
          stable: false,
          verified: false,
          signature: null,
        };
        dataAttributesSource.getDataAttributes = async () => attributes;
        dataSource.getData = async (params: any) => {
          calls.push(params);
          if (source.fail !== undefined) {
            throw source.fail;
          }
          const full = source.body ?? body;
          if (
            source.clamp === true &&
            params.region !== undefined &&
            params.region.offset >= full.length
          ) {
            throw new Error('Requested region offset exceeds data item size');
          }
          const bytes =
            params.region !== undefined
              ? full.subarray(
                  params.region.offset,
                  params.region.offset + params.region.size,
                )
              : full;
          const stream = Readable.from(bytes);
          streams.push(stream);
          return {
            stream,
            size:
              source.clamp === true
                ? bytes.length
                : (params.region?.size ?? full.length),
            totalSize: source.totalSize,
            verified: false,
            trusted: true,
            cached: source.cached ?? false,
            sourceContentType: source.contentType,
            sourceContentEncoding: source.contentEncoding,
            requestAttributes: { origin: 'node-url', hops: 2, clientIps: [] },
            upstreamTags: [{ name: 'App-Name', value: 'range-test' }],
          };
        };
      });

      const useDataHandler = (extra: Record<string, unknown> = {}) => {
        app.get(
          '/:id',
          createDataHandler({
            log,
            dataAttributesSource,
            dataSource,
            dataBlockListValidator,
            manifestPathResolver,
            ...extra,
          }),
        );
      };

      const getRange = (range: string) =>
        request(app)
          .get('/not-a-real-id')
          .set('Range', range)
          .buffer(true)
          .parse(raw);

      it('fetches only the range, once', async () => {
        useDataHandler();

        const res = await getRange('bytes=2-5').expect(206);

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].region, { offset: 2, size: 4 });
        assert.equal(res.body.toString(), '2345');
        assert.equal(res.headers['content-range'], 'bytes 2-5/20');
        assert.equal(res.headers['content-length'], '4');
        assert.equal(res.headers['accept-ranges'], 'bytes');
        assert.match(res.headers['content-type'], /^text\/plain/);
        assert.equal(res.headers[headerNames.cache.toLowerCase()], 'MISS');
        assert.equal(res.headers[headerNames.trusted.toLowerCase()], 'true');
        assert.equal(res.headers[headerNames.hops.toLowerCase()], '2');
        assert.equal(
          res.headers[headerNames.dataId.toLowerCase()],
          'not-a-real-id',
        );
        assert.equal(res.headers['x-arweave-tag-app-name'], 'range-test');
        assert.equal(res.headers['content-digest'], undefined);
        assert.equal(res.headers.etag, undefined);
      });

      it('serves a suffix range against the indexed size', async () => {
        useDataHandler();

        const res = await getRange('bytes=-3').expect(206);

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].region, { offset: 17, size: 3 });
        assert.equal(res.body.toString(), 'hij');
        assert.equal(res.headers['content-range'], 'bytes 17-19/20');
      });

      it('accepts a reported total size that matches the index', async () => {
        source.totalSize = body.length;
        useDataHandler();

        const res = await getRange('bytes=0-0').expect(206);

        assert.equal(calls.length, 1);
        assert.equal(res.body.toString(), '0');
        assert.equal(res.headers['content-range'], 'bytes 0-0/20');
      });

      it("sends the item's indexed Content-Encoding", async () => {
        attributes.contentEncoding = 'gzip';
        useDataHandler();

        // Not decoded by the client: a 206 of gzip bytes is not a gzip body.
        const res = await new Promise<{ status?: number; headers: any }>(
          (resolve, reject) => {
            const server = app.listen(0, () => {
              const { port } = server.address() as { port: number };
              http
                .get(
                  {
                    port,
                    path: '/not-a-real-id',
                    headers: { Range: 'bytes=4-7' },
                  },
                  (response) => {
                    response.resume();
                    response.on('end', () => {
                      server.close();
                      resolve({
                        status: response.statusCode,
                        headers: response.headers,
                      });
                    });
                  },
                )
                .on('error', (error) => {
                  server.close();
                  reject(error);
                });
            });
          },
        );

        assert.equal(res.status, 206);
        assert.equal(res.headers['content-encoding'], 'gzip');
        assert.equal(calls.length, 1);
      });

      it('falls back when the bytes are cached and their coding must be checked', async () => {
        attributes.contentEncoding = 'gzip';
        source.cached = true;
        useDataHandler();

        await getRange('bytes=4-7').expect(206);

        // The ranged fetch, then the full-object path's two fetches.
        assert.equal(calls.length, 3);
        assert.notEqual(calls[0].region, undefined);
        assert.equal(calls[1].region, undefined);
        assert.ok(streams[0].destroyed);
      });

      it('falls back for any bytes that came from the cache, coded or not', async () => {
        source.cached = true;
        useDataHandler();

        await getRange('bytes=4-7').expect(206);

        assert.equal(calls.length, 3);
        assert.notEqual(calls[0].region, undefined);
        assert.equal(calls[1].region, undefined);
        assert.ok(streams[0].destroyed);
      });

      it('falls back to the full-object path when the source reports another size', async () => {
        source.body = Buffer.from('0123456789abcdefghijKLMNO');
        source.totalSize = 25;
        useDataHandler();

        const res = await getRange('bytes=18-22').expect(206);

        assert.equal(calls.length, 3);
        assert.deepEqual(calls[0].region, { offset: 18, size: 2 });
        assert.equal(calls[1].region, undefined);
        assert.deepEqual(calls[2].region, { offset: 18, size: 5 });
        assert.ok(streams[0].destroyed);
        assert.equal(res.body.toString(), 'ijKLM');
        assert.equal(res.headers['content-range'], 'bytes 18-22/25');
      });

      it('answers 404 when the ranged fetch fails', async () => {
        source.fail = new Error('every source failed');
        const negativeDataCache = {
          isNegativelyCached: mock.fn(() => false),
          evict: mock.fn(() => undefined),
          recordSuccess: mock.fn(() => undefined),
          recordMiss: mock.fn(() => undefined),
        } as any;
        useDataHandler({ negativeDataCache });

        await getRange('bytes=2-5').expect(404);

        assert.equal(calls.length, 1);
        assert.notEqual(calls[0].region, undefined);
        // The item is indexed, so a failed fetch is not a negative result.
        assert.equal(negativeDataCache.recordMiss.mock.calls.length, 0);
        assert.equal(negativeDataCache.evict.mock.calls.length, 0);
      });

      it('evicts the id from the negative cache when served', async () => {
        const negativeDataCache = {
          isNegativelyCached: mock.fn(() => false),
          evict: mock.fn(() => undefined),
          recordSuccess: mock.fn(() => undefined),
          recordMiss: mock.fn(() => undefined),
        } as any;
        useDataHandler({ negativeDataCache });

        await getRange('bytes=2-5').expect(206);

        assert.equal(negativeDataCache.evict.mock.calls.length, 1);
        assert.equal(negativeDataCache.recordSuccess.mock.calls.length, 1);
      });

      it('answers 499 when the client aborted the ranged fetch', async () => {
        const abortError = new Error('aborted');
        abortError.name = 'AbortError';
        source.fail = abortError;
        app.use((req: any, _res, next) => {
          const controller = new AbortController();
          controller.abort();
          setRequestSignal(req, controller.signal);
          next();
        });
        useDataHandler();

        await getRange('bytes=2-5').expect(499);

        assert.equal(calls.length, 1);
        assert.notEqual(calls[0].region, undefined);
      });

      describe('when the indexed size is larger than the item', () => {
        beforeEach(() => {
          // 15 bytes, indexed as 20; the source reports no total size and
          // clamps a range at the item's real end.
          source.body = body.subarray(0, 15);
          source.clamp = true;
        });

        it('falls back when the source returns a shorter range', async () => {
          useDataHandler();

          const res = await getRange('bytes=10-19').expect(206);

          assert.equal(calls.length, 3);
          assert.deepEqual(calls[0].region, { offset: 10, size: 10 });
          assert.equal(calls[1].region, undefined);
          assert.ok(streams[0].destroyed);
          // The full-object path's answer: the range cut at the real end.
          assert.equal(res.body.toString(), 'abcde');
          assert.equal(res.headers['content-range'], 'bytes 10-14/15');
          assert.equal(res.headers['content-length'], '5');
        });

        it('answers 404, not 416, for a range starting past the real end', async () => {
          // Documented in serveUncachedRange: a failed fetch cannot be told
          // apart from an item no source has.
          useDataHandler();

          await getRange('bytes=16-19').expect(404);

          assert.equal(calls.length, 1);
        });
      });

      it('sends the same headers as the full-object path', async () => {
        attributes.stable = true;
        attributes.verified = true;
        source.contentType = 'text/plain';
        useDataHandler();
        const names = [
          headerNames.trusted,
          headerNames.hops,
          headerNames.stable,
          headerNames.verified,
          headerNames.cache,
          headerNames.dataId,
          'content-type',
          'cache-control',
          'content-range',
          'content-length',
          'accept-ranges',
          'x-arweave-tag-app-name',
        ].map((name) => name.toLowerCase());
        const pick = (headers: any) =>
          Object.fromEntries(names.map((name) => [name, headers[name]]));

        const fast = await getRange('bytes=2-5').expect(206);
        assert.equal(calls.length, 1);

        // The same item without an indexed type takes the full-object path;
        // the source supplies the same type.
        delete attributes.contentType;
        calls = [];
        const full = await getRange('bytes=2-5').expect(206);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].region, undefined);

        assert.deepEqual(pick(fast.headers), pick(full.headers));
        assert.deepEqual(fast.body, full.body);
      });

      describe('keeps the full-object path', () => {
        const assertFullFirst = () => {
          assert.ok(calls.length >= 1);
          assert.equal(calls[0].region, undefined);
        };

        it('when the item is not indexed', async () => {
          attributes = undefined;
          useDataHandler();
          await getRange('bytes=2-5').expect(206);
          assertFullFirst();
        });

        it('when the indexed size is zero', async () => {
          attributes.size = 0;
          useDataHandler();
          await getRange('bytes=2-5').expect(206);
          assertFullFirst();
        });

        it('when the item has a stored hash', async () => {
          attributes.hash = 'stored-hash';
          useDataHandler();
          await getRange('bytes=2-5').expect(206);
          assertFullFirst();
        });

        it('when the content type is not indexed', async () => {
          delete attributes.contentType;
          useDataHandler();
          await getRange('bytes=2-5').expect(206);
          assertFullFirst();
        });

        it('when the item is a manifest by content type', async () => {
          attributes.contentType = 'application/x.arweave-manifest+json';
          manifestPathResolver.resolveFromData = async () => ({
            id: 'not-a-real-id',
            resolvedId: undefined,
            complete: true,
          });
          useDataHandler();
          await getRange('bytes=2-5').expect(404);
          assertFullFirst();
        });

        it('when the item is flagged as a manifest', async () => {
          attributes.isManifest = true;
          manifestPathResolver.resolveFromIndex = async () => ({
            id: 'not-a-real-id',
            resolvedId: undefined,
            complete: false,
          });
          useDataHandler();
          await getRange('bytes=2-5').expect(206);
          assertFullFirst();
        });

        it('for multiple ranges', async () => {
          useDataHandler();
          await getRange('bytes=0-1,4-5').expect(206);
          assertFullFirst();
        });

        it('for a malformed range', async () => {
          useDataHandler();
          await getRange('invalid-range-header').expect(400);
          assertFullFirst();
        });

        it('for an unsatisfiable range', async () => {
          useDataHandler();
          const res = await getRange('bytes=30-40').expect(416);
          assert.equal(res.headers['content-range'], 'bytes */20');
          assertFullFirst();
        });

        it('for HEAD', async () => {
          useDataHandler();
          await request(app)
            .head('/not-a-real-id')
            .set('Range', 'bytes=2-5')
            .expect(206);
          assertFullFirst();
        });

        it('without a Range header', async () => {
          useDataHandler();
          await request(app).get('/not-a-real-id').expect(200);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].region, undefined);
        });
      });

      describe('raw data route', () => {
        const useRawHandler = () => {
          app.get(
            '/raw/:id',
            (req, _res, next) => {
              req.params[0] = req.params.id;
              next();
            },
            createRawDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
            }),
          );
        };

        it('fetches only the range, once, whatever the content type', async () => {
          attributes.contentType = 'application/x.arweave-manifest+json';
          useRawHandler();

          const res = await request(app)
            .get('/raw/not-a-real-id')
            .set('Range', 'bytes=2-5')
            .buffer(true)
            .parse(raw)
            .expect(206);

          assert.equal(calls.length, 1);
          assert.deepEqual(calls[0].region, { offset: 2, size: 4 });
          assert.equal(res.body.toString(), '2345');
          assert.equal(res.headers['content-range'], 'bytes 2-5/20');
          assert.equal(res.headers['x-arweave-tag-app-name'], 'range-test');
        });

        it('keeps the full-object path when the item has a stored hash', async () => {
          attributes.hash = 'stored-hash';
          useRawHandler();

          await request(app)
            .get('/raw/not-a-real-id')
            .set('Range', 'bytes=2-5')
            .expect(206);

          assert.equal(calls[0].region, undefined);
        });
      });

      describe('manifest-resolved item', () => {
        const manifestAttributes = {
          size: 100,
          contentType: 'application/x.arweave-manifest+json',
          isManifest: true,
          stable: true,
          verified: true,
          signature: null,
        };

        const useManifest = (
          resolutionType: 'path' | 'fallback',
          extra: Record<string, unknown> = {},
        ) => {
          dataAttributesSource.getDataAttributes = async (id: string) =>
            id === 'manifest-id' ? manifestAttributes : attributes;
          manifestPathResolver.resolveFromIndex = async () => ({
            id: 'manifest-id',
            resolvedId: 'inner-id',
            complete: true,
            resolutionType,
          });
          app.get(
            '/:id/*',
            (_req, res, next) => {
              // An ArNS name's long TTL, which a fallback must override.
              res.setHeader('Cache-Control', 'public, max-age=3600');
              next();
            },
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
              ...extra,
            }),
          );
        };

        it('leaves no headers behind when serving fails after setting them', async () => {
          // Tags that are not iterable make setDataHeaders throw part-way,
          // after it has set the data headers.
          const dataItemMetaResolver = {
            resolveFromLocal: async () => ({ tags: { length: 1 } }),
            resolve: async () => undefined,
          } as any;
          manifestPathResolver.resolveFromData = async () => ({
            id: 'manifest-id',
            resolvedId: undefined,
            complete: true,
          });
          useManifest('fallback', { dataItemMetaResolver });

          const res = await request(app)
            .get('/manifest-id/file.txt')
            .set('Range', 'bytes=2-5')
            .expect(404);

          assert.equal(calls[0].id, 'inner-id');
          assert.notEqual(calls[0].region, undefined);
          assert.ok(streams[0].destroyed);
          assert.equal(res.headers['content-range'], undefined);
          assert.equal(res.headers['accept-ranges'], undefined);
          assert.equal(
            res.headers[headerNames.dataId.toLowerCase()],
            undefined,
          );
          assert.equal(res.headers[headerNames.cache.toLowerCase()], undefined);
        });

        it('fetches only the range of the resolved item, once', async () => {
          useManifest('path');

          const res = await request(app)
            .get('/manifest-id/file.txt')
            .set('Range', 'bytes=2-5')
            .buffer(true)
            .parse(raw)
            .expect(206);

          assert.equal(calls.length, 1);
          assert.equal(calls[0].id, 'inner-id');
          assert.deepEqual(calls[0].region, { offset: 2, size: 4 });
          assert.equal(res.body.toString(), '2345');
          assert.equal(res.headers['content-range'], 'bytes 2-5/20');
          assert.equal(
            res.headers[headerNames.dataId.toLowerCase()],
            'inner-id',
          );
          assert.equal(res.headers['cache-control'], 'public, max-age=3600');
        });

        it('sends the short fallback Cache-Control', async () => {
          useManifest('fallback');

          const res = await request(app)
            .get('/manifest-id/file.txt')
            .set('Range', 'bytes=2-5')
            .buffer(true)
            .parse(raw)
            .expect(206);

          assert.equal(calls.length, 1);
          assert.equal(
            res.headers['cache-control'],
            `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
          );
        });

        it('keeps the full-object path when the resolved item has a stored hash', async () => {
          attributes.hash = 'stored-hash';
          useManifest('path');

          await request(app)
            .get('/manifest-id/file.txt')
            .set('Range', 'bytes=2-5')
            .expect(206);

          assert.equal(calls[0].region, undefined);
        });
      });
    });

    describe('Content-Type', () => {
      // Non-ASCII, so the tests also show the bytes pass through unchanged.
      const body = Buffer.from('{"name":"café ☕"}');

      // Reads the body as bytes; superagent would otherwise parse it.
      const raw = (res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      };

      const serve = (contentType: string) => {
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
        dataAttributesSource.getDataAttributes = async () => ({
          size: body.length,
          contentType,
          isManifest: false,
          stable: true,
          verified: true,
          signature: null,
          offset: 0,
        });
        dataSource.getData = async (params?: any) => {
          const data =
            params?.region !== undefined
              ? body.subarray(
                  params.region.offset,
                  params.region.offset + params.region.size,
                )
              : body;
          return {
            stream: Readable.from(data),
            size: body.length,
            verified: true,
            cached: false,
            trusted: true,
          };
        };
      };

      it('sends a JSON type exactly as uploaded, without a charset', async () => {
        serve('application/json');
        const get = request(app)
          .get('/not-a-real-id')
          .buffer(true)
          .parse(raw)
          .expect(200)
          .expect('Content-Type', 'application/json')
          .then((res: any) => {
            assert.deepEqual(res.body, body);
          });
        const head = request(app)
          .head('/not-a-real-id')
          .expect(200)
          .expect('Content-Type', 'application/json');
        await Promise.all([get, head]);
      });

      it('sends a JSON range response without a charset', async () => {
        serve('application/json');
        await request(app)
          .get('/not-a-real-id')
          .set('Range', 'bytes=0-3')
          .buffer(true)
          .parse(raw)
          .expect(206)
          .expect('Content-Type', 'application/json')
          .then((res: any) => {
            assert.deepEqual(res.body, body.subarray(0, 4));
          });
      });

      it('keeps a charset the uploader set on a JSON type', async () => {
        serve('application/json; charset=utf-8');
        await request(app)
          .get('/not-a-real-id')
          .buffer(true)
          .parse(raw)
          .expect(200)
          .expect('Content-Type', 'application/json; charset=utf-8');
      });

      it('adds a charset to text types that have none', async () => {
        serve('text/plain');
        await request(app)
          .get('/not-a-real-id')
          .expect(200)
          .expect('Content-Type', 'text/plain; charset=utf-8');
      });

      it('adds a charset to text/html that has none', async () => {
        serve('text/html');
        await request(app)
          .get('/not-a-real-id')
          .expect(200)
          .expect('Content-Type', 'text/html; charset=utf-8');
      });

      it('leaves other types unchanged', async () => {
        serve('image/png');
        await request(app)
          .get('/not-a-real-id')
          .expect(200)
          .expect('Content-Type', 'image/png');
      });
    });

    describe('Headers', () => {
      describe('X-AR-IO-Verified', () => {
        it("should return false when data isn't verified", async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              offset: 0,
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
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
              offset: 0,
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
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
        // Contract change (2026): the buffered-digest helper
        // (src/routes/data/buffered-digest.ts) emits Content-Digest/Etag for
        // small uncached responses too — so the gateway's signed response
        // binds the body cryptographically end-to-end. Old tests that asserted
        // "no digest for uncached" no longer reflect the new behavior; the
        // assertions now expect the computed digest of the served body.
        // The "no digest" branch is exercised in buffered-digest.test.ts
        // (size_too_large, size_unknown, disabled).
        const EXPECTED_TESTING_DIGEST_B64URL =
          'rH97YzYj4XAQhOYHRljfHw1lLl1XTQP5--TfXcNws7Q';
        const EXPECTED_TESTING_CONTENT_DIGEST = `sha-256=:rH97YzYj4XAQhOYHRljfHw1lLl1XTQP5++TfXcNws7Q=:`;

        it('computes digest/etag from the buffered body when no stored hash is available', async () => {
          // dataAttributesSource returns undefined (no stored hash).
          // dataSource returns 10 bytes ('testing...') with size=10, under
          // the 2 MiB buffer threshold, so the helper buffers + hashes.
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
                res.headers['x-ar-io-digest'],
                EXPECTED_TESTING_DIGEST_B64URL,
              );
              assert.equal(
                res.headers['content-digest'],
                EXPECTED_TESTING_CONTENT_DIGEST,
              );
              assert.equal(
                res.headers['etag'],
                `"${EXPECTED_TESTING_DIGEST_B64URL}"`,
              );
            });
        });

        it('computes digest/etag from the buffered body when uncached even if a stored hash exists', async () => {
          // Stored hash is 'hash' but data is not cached. Old behavior was to
          // skip Content-Digest entirely; new behavior is to compute the
          // digest from the actual served body so the response is verifiable.
          // The computed digest reflects the served bytes, not the stored hash.
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'hash',
              size: 10,
              offset: 0,
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
              assert.equal(
                res.headers['x-ar-io-digest'],
                EXPECTED_TESTING_DIGEST_B64URL,
              );
              assert.equal(
                res.headers['content-digest'],
                EXPECTED_TESTING_CONTENT_DIGEST,
              );
              assert.equal(
                res.headers['etag'],
                `"${EXPECTED_TESTING_DIGEST_B64URL}"`,
              );
            });
        });

        it('emits X-AR-IO-Digest from chain index for uncached LARGE responses (above buffer threshold) but no Content-Digest/ETag', async () => {
          // Body is larger than HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES (2 MiB
          // default) and uncached, so the buffered helper skips digest
          // computation. Pre-Option-A: no digest headers at all.
          // Post-Option-A: X-AR-IO-Digest is set from the chain hash as an
          // informational/advisory header, but Content-Digest and ETag stay
          // omitted because we haven't verified the bytes ourselves.
          const HASH = 'chain-hash-large-body';
          const LARGE_SIZE = 3 * 1024 * 1024; // 3 MiB > 2 MiB threshold
          const largeBody = Buffer.alloc(LARGE_SIZE, 0x5a);

          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: HASH,
              size: LARGE_SIZE,
              offset: 0,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            });
          dataSource.getData = async () => ({
            stream: Readable.from(largeBody),
            size: LARGE_SIZE,
            sourceContentType: 'application/octet-stream',
            verified: false,
            cached: false, // NOT cached
            trusted: true,
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
            .get('/some-large-id')
            .expect(200)
            .then((res: any) => {
              // The advisory header IS now emitted from the chain hash.
              assert.equal(res.headers['x-ar-io-digest'], HASH);
              // But the committed-to representation headers are NOT emitted
              // for uncached responses we haven't verified.
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['etag'], undefined);
            });
        });

        it('should return digest/etag when hash is available AND data is cached', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'hash',
              size: 10,
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
          const testData = Buffer.from('test data');
          dataAttributesSource.getDataAttributes = async () => ({
            hash: '4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4',
            size: testData.length,
            contentType: 'text/plain',
            isManifest: false,
            stable: true,
            verified: true,
            offset: 0,
            signature: null,
          });

          dataSource.getData = async () => ({
            stream: Readable.from(testData),
            size: testData.length,
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

      describe('digest headers on partial responses', () => {
        const hash = '4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4';
        const formatted =
          'sha-256=:4ROTs2lTPAKbr8Y41WrjHu+2q+7S+m+yTuO7fAUzZI4=:';
        const testData = Buffer.from('test data');

        beforeEach(() => {
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
          dataAttributesSource.getDataAttributes = async () => ({
            hash,
            size: testData.length,
            contentType: 'text/plain',
            isManifest: false,
            stable: true,
            verified: true,
            signature: null,
            offset: 0,
          });
          dataSource.getData = async (params?: any) => {
            const bytes =
              params?.region !== undefined
                ? testData.subarray(
                    params.region.offset,
                    params.region.offset + params.region.size,
                  )
                : testData;
            return {
              stream: Readable.from(bytes),
              size: testData.length,
              sourceContentType: 'text/plain',
              verified: true,
              cached: true,
              trusted: true,
            };
          };
        });

        it('sends Repr-Digest, not Content-Digest, on a cached single-range 206', async () => {
          await request(app)
            .get('/test-id')
            .set('Range', 'bytes=0-3')
            .expect(206)
            .then((res: any) => {
              assert.equal(res.text, 'test');
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['repr-digest'], formatted);
              assert.equal(res.headers['etag'], `"${hash}"`);
              assert.equal(res.headers['x-ar-io-digest'], hash);
            });
        });

        it('sends Repr-Digest, not Content-Digest, on a HEAD range response', async () => {
          await request(app)
            .head('/test-id')
            .set('Range', 'bytes=0-3')
            .expect(206)
            .then((res: any) => {
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['repr-digest'], formatted);
            });
        });

        it('sends Repr-Digest, not Content-Digest, on a multipart 206', async () => {
          await request(app)
            .get('/test-id')
            .set('Range', 'bytes=0-1,5-6')
            .expect(206)
            .then((res: any) => {
              assert.match(
                res.headers['content-type'],
                /^multipart\/byteranges/,
              );
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['repr-digest'], formatted);
            });
        });

        it('sends no Content-Digest on a 416', async () => {
          await request(app)
            .get('/test-id')
            .set('Range', 'bytes=100-200')
            .expect(416)
            .then((res: any) => {
              assert.equal(res.headers['content-digest'], undefined);
              assert.equal(res.headers['repr-digest'], formatted);
            });
        });

        it('sends no Content-Digest on a 400 for a malformed range', async () => {
          await request(app)
            .get('/test-id')
            .set('Range', 'invalid-range-header')
            .expect(400)
            .then((res: any) => {
              assert.equal(res.headers['content-digest'], undefined);
            });
        });

        it('keeps Content-Digest, and sends no Repr-Digest, on a full 200', async () => {
          await request(app)
            .get('/test-id')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.text, 'test data');
              assert.equal(res.headers['content-digest'], formatted);
              assert.equal(res.headers['repr-digest'], undefined);
            });
        });
      });

      describe('range units', () => {
        beforeEach(() => {
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
        });

        it('ignores a Range header with a unit other than bytes', async () => {
          await request(app)
            .get('/not-a-real-id')
            .set('Range', 'items=0-5')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.body.toString(), 'testing...');
              assert.equal(res.headers['content-range'], undefined);
            });
        });

        it('ignores a unit other than bytes on the raw route', async () => {
          const rawId = '3b9XZ2XlcuA3vCahZ81mnYYULrN9I6QnzA5pZd08Fpo';
          app.get(
            /^\/raw\/([a-zA-Z0-9-_]{43})$/,
            createRawDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
            }),
          );

          await request(app)
            .get(`/raw/${rawId}`)
            .set('Range', 'items=0-5')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.body.toString(), 'testing...');
            });
          await request(app)
            .get(`/raw/${rawId}`)
            .set('Range', 'BYTES=2-3')
            .expect(206)
            .expect('Content-Range', 'bytes 2-3/10');
        });

        it('treats the bytes unit case-insensitively', async () => {
          await request(app)
            .get('/not-a-real-id')
            .set('Range', 'BYTES=2-3')
            .expect(206)
            .expect('Content-Range', 'bytes 2-3/10')
            .then((res: any) => {
              assert.equal(res.body.toString(), 'st');
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
              offset: 0,
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

      describe('X-AR-IO-Root-Path', () => {
        it('emits [rootTransactionId] for single-level data items (parentId === rootTransactionId)', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              offset: 0,
              contentType: 'application/octet-stream',
              rootTransactionId: 'root-tx',
              parentId: 'root-tx', // single-level: parent IS the root
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
              assert.equal(res.headers['x-ar-io-root-path'], 'root-tx');
            });
        });

        it('omits the header for multi-level data items (parentId !== rootTransactionId)', async () => {
          // navigatePathAndFind would throw on a missing intermediate
          // bundle, so emitting `[root, parent]` is strictly worse than
          // not emitting. Receiving gateway falls back to linear search.
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              offset: 0,
              contentType: 'application/octet-stream',
              rootTransactionId: 'root-tx',
              parentId: 'intermediate-bundle', // multi-level
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
              assert.equal(res.headers['x-ar-io-root-path'], undefined);
            });
        });

        it('omits the header for L1 transactions (no parentId, no rootTransactionId)', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              offset: 0,
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
              assert.equal(res.headers['x-ar-io-root-path'], undefined);
            });
        });
      });

      describe('If-None-Match', () => {
        it('should return 304 for HEAD request when If-None-Match matches ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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

        it('returns 200 with buffered-digest ETag when If-None-Match does not match', async () => {
          // Contract change (2026): the buffered-digest helper now computes
          // and sets ETag for small uncached responses. This test covers the
          // non-match path — request sends a wrong If-None-Match, so the 304
          // short-circuit is skipped and we get the 200 + body + ETag from the
          // computed buffered digest. (The old test asserted "no ETag therefore
          // 200" — that case now requires a body > buffer threshold, which is
          // exercised in buffered-digest.test.ts.)
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              size: 10,
              offset: 0,
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

          // Send a non-matching If-None-Match — ETag from buffered digest
          // won't match, so we get 200 with the body.
          return request(app)
            .get('/not-a-real-id')
            .set('If-None-Match', '"some-other-hash"')
            .expect(200)
            .then((res: any) => {
              assert.equal(
                res.headers['etag'],
                `"rH97YzYj4XAQhOYHRljfHw1lLl1XTQP5--TfXcNws7Q"`,
              );
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('returns 304 when If-None-Match matches the cached-digest ETag', async () => {
          // The 304 short-circuit fires *before* sendBodyWithOptionalDigest
          // runs (handlers.ts handleIfNoneMatch path), so it can only match
          // when an ETag was set earlier — i.e. when the cached/HEAD digest
          // path (setDigestStableVerifiedHeaders) populated ETag from
          // dataAttributes.hash. That gate requires data.cached === true OR
          // a HEAD request, so we override the data source to return cached.
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'rH97YzYj4XAQhOYHRljfHw1lLl1XTQP5--TfXcNws7Q',
              size: 10,
              offset: 0,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });
          dataSource.getData = (_params?: any) =>
            Promise.resolve({
              hash: 'rH97YzYj4XAQhOYHRljfHw1lLl1XTQP5--TfXcNws7Q',
              stream: Readable.from(Buffer.from('testing...')),
              size: 10,
              sourceContentType: 'application/octet-stream',
              verified: true,
              trusted: true,
              cached: true,
              requestAttributes: { hops: 0, clientIps: [] },
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

          await request(app)
            .get('/not-a-real-id')
            .set(
              'If-None-Match',
              '"rH97YzYj4XAQhOYHRljfHw1lLl1XTQP5--TfXcNws7Q"',
            )
            .expect(304);
        });

        it('should return 304 for range request when If-None-Match matches ETag', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              offset: 0,
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
              trusted: false,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
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
              offset: 0,
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
                clientIps: [],
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
              offset: 0,
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
                clientIps: [],
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
              offset: 0,
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
                clientIps: [],
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
              offset: 0,
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
                clientIps: [],
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
              assert.equal(res.headers['x-cache'], 'MISS');
              assert.equal(res.body.toString(), 'testing...');
            });
        });

        it('should set X-AR-IO-Trusted header for range requests', async () => {
          dataAttributesSource.getDataAttributes = () =>
            Promise.resolve({
              hash: 'test-hash',
              size: 10,
              offset: 0,
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
                clientIps: [],
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

      describe('manifests the index does not know', () => {
        const resolvedId = 'resolved-manifest-path-id';
        const manifestJson = JSON.stringify({
          manifest: 'arweave/paths',
          version: '0.1.0',
          paths: { 'path/to/file.txt': { id: resolvedId } },
        });
        let requestedIds: string[];

        beforeEach(() => {
          requestedIds = [];
          mock.method(dataSource, 'getData', (params: any) => {
            requestedIds.push(params.id);
            const whole =
              params.id === 'manifest-id'
                ? Buffer.from(manifestJson)
                : Buffer.from('file contents');
            const body =
              params.region !== undefined
                ? whole.subarray(
                    params.region.offset,
                    params.region.offset + params.region.size,
                  )
                : whole;
            return Promise.resolve({
              stream: Readable.from(body),
              size: whole.length,
              sourceContentType:
                params.id === 'manifest-id'
                  ? 'application/x.arweave-manifest+json'
                  : 'text/plain',
              verified: false,
              cached: true,
              trusted: true,
              requestAttributes: { origin: 'node-url', hops: 0, clientIps: [] },
            });
          });
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
        });

        it('serves a trusted cached resolution without fetching the manifest', async () => {
          mock.method(manifestPathResolver, 'resolveFromTrustedCache', () => ({
            id: 'manifest-id',
            resolvedId,
            complete: true,
            resolutionType: 'path',
          }));
          const resolveFromIndex = mock.method(
            manifestPathResolver,
            'resolveFromIndex',
          );
          const resolveFromData = mock.method(
            manifestPathResolver,
            'resolveFromData',
          );

          await request(app)
            .get('/manifest-id/path/to/file.txt')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.text, 'file contents');
              assert.equal(res.headers['x-ar-io-data-id'], resolvedId);
            });

          assert.deepEqual(requestedIds, [resolvedId]);
          assert.equal(resolveFromIndex.mock.callCount(), 0);
          assert.equal(resolveFromData.mock.callCount(), 0);
        });

        it('applies the range-unit rules to a manifest-resolved path', async () => {
          mock.method(manifestPathResolver, 'resolveFromTrustedCache', () => ({
            id: 'manifest-id',
            resolvedId,
            complete: true,
            resolutionType: 'path',
          }));

          await request(app)
            .get('/manifest-id/path/to/file.txt')
            .set('Range', 'BYTES=0-3')
            .expect(206)
            .expect('Content-Range', 'bytes 0-3/13')
            .then((res: any) => {
              assert.equal(res.text, 'file');
            });
          await request(app)
            .get('/manifest-id/path/to/file.txt')
            .set('Range', 'items=0-3')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.text, 'file contents');
            });
        });

        it('fetches and parses the manifest when there is no trusted cached resolution', async () => {
          mock.method(manifestPathResolver, 'resolveFromData', () =>
            Promise.resolve({
              id: 'manifest-id',
              resolvedId,
              complete: true,
              resolutionType: 'path',
            }),
          );

          await request(app)
            .get('/manifest-id/path/to/file.txt')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.text, 'file contents');
              assert.equal(res.headers['x-ar-io-data-id'], resolvedId);
            });

          assert.deepEqual(requestedIds, ['manifest-id', resolvedId]);
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
                clientIps: [],
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

        it('should return 451 when a manifest resolves to a data item blocked by ID', async () => {
          const manifestId = 'manifest-id';
          const resolvedId = 'resolved-blocked-id';

          // manifest-id is a manifest; the resolved leaf is a normal item.
          mock.method(
            dataAttributesSource,
            'getDataAttributes',
            (checkId: string) =>
              Promise.resolve({
                size: 100,
                contentType:
                  checkId === manifestId
                    ? 'application/x.arweave-manifest+json'
                    : 'text/html',
                isManifest: checkId === manifestId,
                stable: true,
                verified: true,
                signature: null,
              }),
          );

          // The manifest itself is NOT blocked; only the resolved leaf is.
          mock.method(
            dataBlockListValidator,
            'isIdBlocked',
            (checkId: string) => Promise.resolve(checkId === resolvedId),
          );

          mock.method(manifestPathResolver, 'resolveFromIndex', () =>
            Promise.resolve({
              id: manifestId,
              resolvedId,
              complete: true,
              resolutionType: 'path',
            }),
          );

          // Blocked content must never be fetched/streamed.
          const getDataMock = mock.method(dataSource, 'getData', () =>
            Promise.reject(
              new Error('getData should not be called for blocked content'),
            ),
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

          await request(app)
            .get('/manifest-id/path/to/file.html')
            .expect(451)
            .then((res: any) => {
              assert.match(
                res.text,
                /Requested content blocked by this node's content policy/,
              );
              // The blocked leaf id is reported, not the manifest id.
              assert.match(res.text, new RegExp(resolvedId));
            });

          assert.equal(getDataMock.mock.calls.length, 0);
        });

        it('should return 451 when a manifest resolves to a data item blocked by hash', async () => {
          const manifestId = 'manifest-id';
          const resolvedId = 'resolved-hash-blocked-id';
          const blockedHash = 'blocked-content-hash';

          mock.method(
            dataAttributesSource,
            'getDataAttributes',
            (checkId: string) =>
              Promise.resolve(
                checkId === manifestId
                  ? {
                      size: 100,
                      contentType: 'application/x.arweave-manifest+json',
                      isManifest: true,
                      stable: true,
                      verified: true,
                      signature: null,
                    }
                  : {
                      size: 42,
                      contentType: 'text/html',
                      isManifest: false,
                      stable: true,
                      verified: true,
                      signature: null,
                      hash: blockedHash,
                    },
              ),
          );

          // Nothing blocked by ID; the resolved leaf's content hash IS blocked.
          mock.method(dataBlockListValidator, 'isIdBlocked', () =>
            Promise.resolve(false),
          );
          mock.method(dataBlockListValidator, 'isHashBlocked', (hash: string) =>
            Promise.resolve(hash === blockedHash),
          );

          mock.method(manifestPathResolver, 'resolveFromIndex', () =>
            Promise.resolve({
              id: manifestId,
              resolvedId,
              complete: true,
              resolutionType: 'path',
            }),
          );

          const getDataMock = mock.method(dataSource, 'getData', () =>
            Promise.reject(
              new Error('getData should not be called for blocked content'),
            ),
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

          await request(app).get('/manifest-id/path/to/file.html').expect(451);

          assert.equal(getDataMock.mock.calls.length, 0);
        });

        it('should fail closed (503) when the blocklist check throws for a manifest-resolved item', async () => {
          const manifestId = 'manifest-id';
          const resolvedId = 'resolved-id';

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

          // Top-level id check passes; the resolved-leaf check throws.
          mock.method(
            dataBlockListValidator,
            'isIdBlocked',
            (checkId: string) => {
              if (checkId === resolvedId) {
                return Promise.reject(
                  new Error('blocklist backend unavailable'),
                );
              }
              return Promise.resolve(false);
            },
          );

          mock.method(manifestPathResolver, 'resolveFromIndex', () =>
            Promise.resolve({
              id: manifestId,
              resolvedId,
              complete: true,
              resolutionType: 'path',
            }),
          );

          // Content must not be served when we cannot verify it is unblocked.
          const getDataMock = mock.method(dataSource, 'getData', () =>
            Promise.reject(
              new Error('getData should not be called when failing closed'),
            ),
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

          await request(app).get('/manifest-id/path/to/file.html').expect(503);

          assert.equal(getDataMock.mock.calls.length, 0);
        });

        it('should evict resolvedId from negative cache when manifest-resolved data is served', async () => {
          const manifestId = 'manifest-id';
          const resolvedId = 'resolved-manifest-path-id';

          const negativeDataCache = {
            isNegativelyCached: mock.fn(() => false),
            evict: mock.fn(() => undefined),
            recordSuccess: mock.fn(() => undefined),
            recordMiss: mock.fn(() => undefined),
          } as any;

          mock.method(
            dataAttributesSource,
            'getDataAttributes',
            (id: string) => {
              if (id === manifestId) {
                return Promise.resolve({
                  size: 100,
                  contentType: 'application/x.arweave-manifest+json',
                  isManifest: true,
                  stable: true,
                  verified: true,
                  signature: null,
                });
              }
              return Promise.resolve({
                size: 9,
                contentType: 'application/octet-stream',
                isManifest: false,
                stable: true,
                verified: true,
                signature: null,
              });
            },
          );

          mock.method(manifestPathResolver, 'resolveFromIndex', () =>
            Promise.resolve({
              id: manifestId,
              resolvedId,
              complete: true,
            }),
          );

          mock.method(dataSource, 'getData', ({ id }: { id: string }) =>
            Promise.resolve({
              stream: Readable.from(Buffer.from(`data:${id}`)),
              size: `data:${id}`.length,
              verified: true,
              cached: false,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
              },
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
              negativeDataCache,
            }),
          );

          await request(app)
            .get('/manifest-id/path/to/file.txt')
            .expect(200)
            .expect((res: any) => {
              assert.equal(res.headers['x-ar-io-data-id'], resolvedId);
            });

          assert.equal((negativeDataCache.evict as any).mock.calls.length, 1);
          assert.equal(
            (negativeDataCache.evict as any).mock.calls[0].arguments[0],
            resolvedId,
          );
          assert.equal(
            (negativeDataCache.recordSuccess as any).mock.calls.length,
            1,
          );
          assert.equal(
            (negativeDataCache.recordMiss as any).mock.calls.length,
            0,
          );
        });

        it('should resolve item headers for the INNER data item on manifest-resolved responses', async () => {
          // Regression: sendManifestResponse previously called setDataHeaders
          // without itemHeaders, so X-Arweave-Tag-*, X-Arweave-Owner-Address,
          // etc. were missing on ArNS apex/manifest-served responses. This
          // test asserts that dataItemMetaResolver.resolveFromLocal is invoked
          // with the INNER resolved data item ID (not the manifest TX ID) so
          // tags for the served content are available to setDataHeaders.
          const manifestId = 'manifest-id';
          const resolvedId = 'resolved-inner-data-item-id';

          mock.method(
            dataAttributesSource,
            'getDataAttributes',
            (id: string) => {
              if (id === manifestId) {
                return Promise.resolve({
                  size: 100,
                  contentType: 'application/x.arweave-manifest+json',
                  isManifest: true,
                  stable: true,
                  verified: true,
                  signature: null,
                });
              }
              return Promise.resolve({
                size: 9,
                contentType: 'text/html',
                isManifest: false,
                stable: true,
                verified: true,
                signature: null,
              });
            },
          );

          mock.method(manifestPathResolver, 'resolveFromIndex', () =>
            Promise.resolve({
              id: manifestId,
              resolvedId,
              complete: true,
            }),
          );

          mock.method(dataSource, 'getData', () =>
            Promise.resolve({
              stream: Readable.from(Buffer.from('<html></html>')),
              size: 13,
              verified: true,
              cached: false,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
              },
            }),
          );

          const resolveFromLocalMock = mock.fn((_id: string) =>
            Promise.resolve(undefined),
          );
          const dataItemMetaResolver = {
            resolveFromLocal: resolveFromLocalMock,
            resolve: mock.fn(() => Promise.resolve(undefined)),
          } as any;

          app.get(
            '/:id/*',
            createDataHandler({
              log,
              dataAttributesSource,
              dataSource,
              dataBlockListValidator,
              manifestPathResolver,
              dataItemMetaResolver,
            }),
          );

          await request(app)
            .get('/manifest-id/index.html')
            .expect(200)
            .then((res: any) => {
              assert.equal(res.headers['x-ar-io-data-id'], resolvedId);
            });

          // resolveFromLocal MUST be called with the inner data item ID
          // (resolvedId), never only with the manifest TX ID.
          const callArgs = resolveFromLocalMock.mock.calls.map(
            (c) => c.arguments[0],
          );
          assert.ok(
            callArgs.includes(resolvedId),
            `resolveFromLocal must be called with inner data item ID (${resolvedId}); got: [${callArgs.join(', ')}]`,
          );
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
                clientIps: [],
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
                clientIps: [],
              },
            }),
          );

          // Mock req.dataId to simulate ArNS resolution
          app.get(
            '/:id',
            (req, _res, next) => {
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

        it('never reads a negative hop count, which would get past the hop limits', () => {
          for (const value of ['-5', '-1']) {
            const requestAttributes = getRequestAttributes(
              { headers: { 'x-ar-io-hops': value } } as any,
              { get: () => undefined } as any,
            );
            assert.equal(requestAttributes.hops, 0);
          }
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

      describe('User-Agent based skip forwarding', () => {
        const mockRes = { get: () => undefined } as any;

        it('should skip forwarding when User-Agent is empty and skipForwardingEmptyUserAgent is true', () => {
          const mockReq = { headers: {} } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: true,
            skipForwardingUserAgents: [],
          });
          assert.equal(attrs.skipRemoteForwarding, true);
        });

        it('should not skip forwarding when User-Agent is empty and skipForwardingEmptyUserAgent is false', () => {
          const mockReq = { headers: {} } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: false,
            skipForwardingUserAgents: [],
          });
          assert.equal(attrs.skipRemoteForwarding, undefined);
        });

        it('should skip forwarding when User-Agent matches a configured substring', () => {
          const mockReq = {
            headers: { 'user-agent': 'HyperBEAM/1.0' },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: false,
            skipForwardingUserAgents: ['hyperbeam'],
          });
          assert.equal(attrs.skipRemoteForwarding, true);
        });

        it('should not skip forwarding when User-Agent does not match any configured substring', () => {
          const mockReq = {
            headers: { 'user-agent': 'Mozilla/5.0' },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: false,
            skipForwardingUserAgents: ['hyperbeam'],
          });
          assert.equal(attrs.skipRemoteForwarding, undefined);
        });

        it('should not perform substring matching when skipForwardingUserAgents is empty', () => {
          const mockReq = {
            headers: { 'user-agent': 'SomeAgent/1.0' },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: false,
            skipForwardingUserAgents: [],
          });
          assert.equal(attrs.skipRemoteForwarding, undefined);
        });

        it('should perform case-insensitive substring matching', () => {
          const mockReq = {
            headers: { 'user-agent': 'HYPERBEAM/2.0 (Linux)' },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: false,
            skipForwardingUserAgents: ['hyperbeam'],
          });
          assert.equal(attrs.skipRemoteForwarding, true);
        });

        it('should not check User-Agent when headers already triggered skip forwarding', () => {
          const mockReq = {
            headers: { 'ao-peer-port': '9000', 'user-agent': 'Mozilla/5.0' },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes, {
            skipForwardingEmptyUserAgent: true,
            skipForwardingUserAgents: [],
          });
          assert.equal(attrs.skipRemoteForwarding, true);
        });
      });

      describe('Root TX ID and path hint headers', () => {
        const mockRes = { get: () => undefined } as any;

        it('should populate rootTransactionIdHint with valid TX ID', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-transaction-id':
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(
            attrs.rootTransactionIdHint,
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          );
        });

        it('should not populate rootTransactionIdHint with invalid TX ID', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-transaction-id': 'not-a-valid-id',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootTransactionIdHint, undefined);
        });

        it('should populate rootPathHint with valid comma-separated TX IDs', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-path':
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.deepEqual(attrs.rootPathHint, [
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          ]);
        });

        it('should not populate rootPathHint when any TX ID is invalid', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-path':
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,invalid',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootPathHint, undefined);
        });

        it('should not include hint fields when headers are absent', () => {
          const mockReq = { headers: {} } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootTransactionIdHint, undefined);
          assert.equal(attrs.rootPathHint, undefined);
        });
      });

      describe('Root byte hint headers', () => {
        const mockRes = { get: () => undefined } as any;

        it('should populate rootByteHint when both offset and size are valid', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-item-offset': '12345',
              'x-ar-io-root-item-size': '67890',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.deepEqual(attrs.rootByteHint, {
            offset: 12345,
            size: 67890,
          });
        });

        it('should accept zero as a valid offset', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-item-offset': '0',
              'x-ar-io-root-item-size': '100',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.deepEqual(attrs.rootByteHint, { offset: 0, size: 100 });
        });

        it('should not populate rootByteHint when only offset is provided', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-item-offset': '12345',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootByteHint, undefined);
        });

        it('should not populate rootByteHint when only size is provided', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-item-size': '67890',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootByteHint, undefined);
        });

        it('should not populate rootByteHint with negative offset', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-item-offset': '-1',
              'x-ar-io-root-item-size': '100',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootByteHint, undefined);
        });

        it('should not populate rootByteHint with non-numeric size', () => {
          const mockReq = {
            headers: {
              'x-ar-io-root-item-offset': '12345',
              'x-ar-io-root-item-size': 'abc',
            },
          } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootByteHint, undefined);
        });

        it('should not include rootByteHint when headers are absent', () => {
          const mockReq = { headers: {} } as any;

          const attrs = getRequestAttributes(mockReq, mockRes);
          assert.equal(attrs.rootByteHint, undefined);
        });
      });
    });

    // Test stub for PaymentProcessor
    class TestPaymentProcessor implements PaymentProcessor {
      public shouldVerify = true;
      public shouldSettle = true;
      public calculatedContexts: PaymentRequirementsContext[] = [];
      public verifyCalls = 0;
      public settleCalls = 0;

      isBrowserRequest(_req: Request): boolean {
        return false;
      }

      calculateRequirements(
        context: PaymentRequirementsContext,
      ): PaymentRequirements {
        this.calculatedContexts.push(context);
        return {
          scheme: 'exact',
          description: `Test payment for ${context.contentSize} bytes`,
          network: 'base-sepolia',
          maxAmountRequired: context.contentSize.toString(),
          payTo: '0x0000000000000000000000000000000000000001',
          asset: '0x0000000000000000000000000000000000000002',
          resource: `${context.protocol}://${context.host}${context.originalUrl}`,
          mimeType: context.contentType,
          maxTimeoutSeconds: 300,
        };
      }

      async verifyPayment(
        _payload: PaymentPayload,
        _requirements: PaymentRequirements,
      ): Promise<PaymentVerificationResult> {
        this.verifyCalls++;
        return this.shouldVerify
          ? { isValid: true }
          : { isValid: false, invalidReason: 'Payment failed' };
      }

      async settlePayment(
        _payload: PaymentPayload,
        _requirements: PaymentRequirements,
      ): Promise<PaymentSettlementResult> {
        this.settleCalls++;
        return this.shouldSettle
          ? { success: true }
          : { success: false, errorReason: 'Settlement failed' };
      }

      sendPaymentRequiredResponse(
        _req: Request,
        res: Response,
        requirements: PaymentRequirements,
        options?: { error?: string; message?: string },
      ): void {
        res.status(402).json({
          error: options?.error,
          message: options?.message,
          accepts: [requirements],
        });
      }

      extractPayment(req: Request): PaymentPayload | undefined {
        if (req.headers['x-payment'] === undefined) {
          return undefined;
        }
        return {
          x402Version: 1,
          scheme: 'exact',
          network: 'base-sepolia',
          payload: {
            signature: '0xsignature',
            authorization: {
              from: '0x0000000000000000000000000000000000000003',
              to: '0x0000000000000000000000000000000000000001',
              value: '10',
              validAfter: '0',
              validBefore: '9999999999',
              nonce: '0x01',
            },
          },
        };
      }
    }

    describe('handleDataRateLimitingAndPayment', () => {
      let rateLimiter: MemoryRateLimiter;
      let paymentProcessor: TestPaymentProcessor;
      let testApp: express.Express;
      let testDataAttributesSource: DataAttributesSource;
      let testDataSource: ContiguousDataSource;
      let testDataBlockListValidator: DataBlockListValidator;
      let testManifestPathResolver: ManifestPathResolver;

      beforeEach(() => {
        rateLimiter = new MemoryRateLimiter({
          resourceCapacity: 1000,
          resourceRefillRate: 10,
          ipCapacity: 500,
          ipRefillRate: 5,
          limitsEnabled: true,
          ipAllowlist: [],
          capacityMultiplier: 10,
        });
        paymentProcessor = new TestPaymentProcessor();
        testApp = express();

        testDataAttributesSource = {
          getDataAttributes: () =>
            Promise.resolve({
              size: 10,
              offset: 0,
              contentType: 'application/octet-stream',
              isManifest: false,
              stable: true,
              verified: false,
              signature: null,
            }),
        };

        testDataSource = {
          getData: (params?: any) => {
            const fullData = Buffer.from('testing...');
            let data = fullData;

            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.slice(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 10,
              verified: false,
              cached: false,
              trusted: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
              },
            });
          },
        };

        testDataBlockListValidator = {
          isIdBlocked: () => Promise.resolve(false),
          isHashBlocked: () => Promise.resolve(false),
        };

        testManifestPathResolver = {
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
          resolveFromTrustedCache: () => undefined,
        };
      });

      afterEach(() => {
        mock.restoreAll();
      });

      it('should return true when neither rateLimiter nor paymentProcessor configured', async () => {
        testApp.get(
          '/:id',
          createDataHandler({
            log,
            dataAttributesSource: testDataAttributesSource,
            dataSource: testDataSource,
            dataBlockListValidator: testDataBlockListValidator,
            manifestPathResolver: testManifestPathResolver,
            // No rateLimiter or paymentProcessor
          }),
        );

        await request(testApp).get('/test-id').expect(200);
      });

      it('should work with rate limiter configured', async () => {
        testApp.get(
          '/:id',
          createDataHandler({
            log,
            dataAttributesSource: testDataAttributesSource,
            dataSource: testDataSource,
            dataBlockListValidator: testDataBlockListValidator,
            manifestPathResolver: testManifestPathResolver,
            rateLimiter,
          }),
        );

        await request(testApp).get('/test-id').expect(200);
      });

      it('should calculate requirements and allow the request when no payment is attached', async () => {
        testApp.get(
          '/:id',
          createDataHandler({
            log,
            dataAttributesSource: testDataAttributesSource,
            dataSource: testDataSource,
            dataBlockListValidator: testDataBlockListValidator,
            manifestPathResolver: testManifestPathResolver,
            rateLimiter,
            paymentProcessor,
          }),
        );

        await request(testApp).get('/test-id').expect(200);

        assert.equal(paymentProcessor.calculatedContexts.length, 1);
        assert.equal(paymentProcessor.calculatedContexts[0].contentSize, 10);
        assert.equal(paymentProcessor.verifyCalls, 0);
        assert.equal(paymentProcessor.settleCalls, 0);
      });

      it('should respond 402 when an attached payment fails verification', async () => {
        paymentProcessor.shouldVerify = false;
        testApp.get(
          '/:id',
          createDataHandler({
            log,
            dataAttributesSource: testDataAttributesSource,
            dataSource: testDataSource,
            dataBlockListValidator: testDataBlockListValidator,
            manifestPathResolver: testManifestPathResolver,
            rateLimiter,
            paymentProcessor,
          }),
        );

        const res = await request(testApp)
          .get('/test-id')
          .set('X-Payment', 'test-payment')
          .expect(402);

        assert.equal(res.body.error, 'payment_verification_failed');
        assert.equal(res.body.message, 'Payment failed');
        assert.equal(paymentProcessor.verifyCalls, 1);
        assert.equal(paymentProcessor.settleCalls, 0);
      });
    });

    describe('Cache-Control max-age tiers', () => {
      it('should use 30-day max-age with immutable for stable data', async () => {
        dataAttributesSource.getDataAttributes = () =>
          Promise.resolve({
            hash: 'test-hash',
            size: 10,
            offset: 0,
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
            verified: true,
            trusted: true,
            cached: true,
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
              clientIps: [],
            },
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
              res.headers['cache-control'],
              'public, max-age=2592000, immutable',
            );
          });
      });

      it('should use 12-hour max-age for unstable but trusted data', async () => {
        dataAttributesSource.getDataAttributes = () =>
          Promise.resolve({
            hash: 'test-hash',
            size: 10,
            offset: 0,
            contentType: 'application/octet-stream',
            isManifest: false,
            stable: false,
            verified: false,
            signature: null,
          });

        dataSource.getData = () =>
          Promise.resolve({
            stream: Readable.from(Buffer.from('testing...')),
            size: 10,
            verified: false,
            trusted: true,
            cached: true,
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
              clientIps: [],
            },
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
            assert.equal(res.headers['cache-control'], 'public, max-age=43200');
          });
      });

      it('should use 2-hour max-age for unstable and untrusted data', async () => {
        dataAttributesSource.getDataAttributes = () =>
          Promise.resolve({
            hash: 'test-hash',
            size: 10,
            offset: 0,
            contentType: 'application/octet-stream',
            isManifest: false,
            stable: false,
            verified: false,
            signature: null,
          });

        dataSource.getData = () =>
          Promise.resolve({
            stream: Readable.from(Buffer.from('testing...')),
            size: 10,
            verified: false,
            trusted: false,
            cached: true,
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
              clientIps: [],
            },
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
            assert.equal(res.headers['cache-control'], 'public, max-age=7200');
          });
      });
    });

    describe('Cache-Control: manifest fallback override (PE-9072)', () => {
      // Helper: install a middleware that simulates ArNS pre-setting a long
      // ANT TTL Cache-Control header before the data handler runs. The fix
      // must override this for fallback resolutions, but preserve it for
      // path/index resolutions.
      const withSimulatedArnsTtl =
        (ttl: number) => (_req: any, res: any, next: any) => {
          res.setHeader('Cache-Control', `public, max-age=${ttl}`);
          next();
        };

      // Helper: build a manifest-shaped data attributes / data source pair
      // that flows through sendManifestResponse with a given resolutionType.
      const setupManifestFlow = (
        resolutionType: 'path' | 'index' | 'fallback',
      ) => {
        const resolvedId = 'resolved-inner-id';

        // First lookup: outer manifest is stable+trusted (worst-case TTL).
        // Second lookup: inner resolved id is also stable+trusted.
        dataAttributesSource.getDataAttributes = (id: string) => {
          if (id === resolvedId) {
            return Promise.resolve({
              hash: 'inner-hash',
              size: 10,
              offset: 0,
              contentType: 'text/html',
              isManifest: false,
              stable: true,
              verified: true,
              signature: null,
            });
          }
          return Promise.resolve({
            hash: 'manifest-hash',
            size: 100,
            offset: 0,
            contentType: 'application/x.arweave-manifest+json',
            isManifest: true,
            stable: true,
            verified: true,
            signature: null,
          });
        };

        dataSource.getData = (params: any) => {
          if (params?.id === resolvedId) {
            // Honour the requested range, as the real source does. Returning
            // the whole body for a range request makes the handler declare a
            // partial length and then send more than that, which the client
            // rejects as a protocol error rather than a failed assertion.
            const fullData = Buffer.from('inner-content');
            let data = fullData;
            if (params?.region) {
              const { offset, size } = params.region;
              data = fullData.subarray(offset, offset + size);
            }

            return Promise.resolve({
              stream: Readable.from(data),
              size: 13,
              verified: true,
              trusted: true,
              cached: true,
              requestAttributes: {
                origin: 'node-url',
                hops: 0,
                clientIps: [],
              },
            });
          }
          // Outer manifest body — content doesn't matter, resolveFromData
          // is mocked.
          return Promise.resolve({
            stream: Readable.from(Buffer.from('{}')),
            size: 2,
            verified: true,
            trusted: true,
            cached: true,
            sourceContentType: 'application/x.arweave-manifest+json',
            requestAttributes: {
              origin: 'node-url',
              hops: 0,
              clientIps: [],
            },
          });
        };

        manifestPathResolver = {
          resolveFromIndex: () =>
            Promise.resolve({
              id: 'manifest-id',
              resolvedId: undefined,
              complete: false,
            }),
          resolveFromData: () =>
            Promise.resolve({
              id: 'manifest-id',
              resolvedId,
              complete: true,
              resolutionType,
            }),
          resolveFromTrustedCache: () => undefined,
        };
      };

      it('should override pre-set ArNS Cache-Control with short TTL on fallback resolutions', async () => {
        setupManifestFlow('fallback');

        app.get(
          '/:id/*',
          withSimulatedArnsTtl(86400),
          createDataHandler({
            log,
            dataAttributesSource,
            dataSource,
            dataBlockListValidator,
            manifestPathResolver,
          }),
        );

        return request(app)
          .get('/manifest-id/missing/path')
          .expect(200)
          .then((res: any) => {
            assert.equal(
              res.headers['cache-control'],
              `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
            );
          });
      });

      it('should preserve pre-set ArNS Cache-Control on path resolutions', async () => {
        setupManifestFlow('path');

        app.get(
          '/:id/*',
          withSimulatedArnsTtl(86400),
          createDataHandler({
            log,
            dataAttributesSource,
            dataSource,
            dataBlockListValidator,
            manifestPathResolver,
          }),
        );

        return request(app)
          .get('/manifest-id/some/path')
          .expect(200)
          .then((res: any) => {
            assert.equal(res.headers['cache-control'], 'public, max-age=86400');
          });
      });

      it('should preserve pre-set ArNS Cache-Control on index resolutions', async () => {
        setupManifestFlow('index');

        app.get(
          '/:id/*',
          withSimulatedArnsTtl(86400),
          createDataHandler({
            log,
            dataAttributesSource,
            dataSource,
            dataBlockListValidator,
            manifestPathResolver,
          }),
        );

        return request(app)
          .get('/manifest-id/')
          .expect(200)
          .then((res: any) => {
            assert.equal(res.headers['cache-control'], 'public, max-age=86400');
          });
      });

      it('should override pre-set ArNS Cache-Control with short TTL on fallback range requests', async () => {
        setupManifestFlow('fallback');

        app.get(
          '/:id/*',
          withSimulatedArnsTtl(86400),
          createDataHandler({
            log,
            dataAttributesSource,
            dataSource,
            dataBlockListValidator,
            manifestPathResolver,
          }),
        );

        return request(app)
          .get('/manifest-id/missing/path')
          .set('Range', 'bytes=0-4')
          .expect(206)
          .then((res: any) => {
            assert.equal(
              res.headers['cache-control'],
              `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
            );
          });
      });

      it('should fall back to data-layer TTL when no Cache-Control was pre-set and resolution is path', async () => {
        setupManifestFlow('path');

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

        // Inner resolved id is stable+trusted → 30-day immutable.
        return request(app)
          .get('/manifest-id/some/path')
          .expect(200)
          .then((res: any) => {
            assert.equal(
              res.headers['cache-control'],
              'public, max-age=2592000, immutable',
            );
          });
      });

      it('should still apply short TTL on fallback even when no ArNS Cache-Control was pre-set', async () => {
        setupManifestFlow('fallback');

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
          .get('/manifest-id/missing/path')
          .expect(200)
          .then((res: any) => {
            assert.equal(
              res.headers['cache-control'],
              `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
            );
          });
      });
    });

    describe('Cache-Control: 404 directives (PE-9072)', () => {
      it('should use must-revalidate (not immutable) on sendNotFound 404', async () => {
        // Force a 404 by failing data retrieval.
        dataAttributesSource.getDataAttributes = () =>
          Promise.resolve(undefined);
        dataSource.getData = () => Promise.reject(new Error('not found'));

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
          .get('/missing-id')
          .expect(404)
          .then((res: any) => {
            assert.equal(
              res.headers['cache-control'],
              `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
            );
          });
      });
    });

    describe('Cache-Control private directive', () => {
      describe('matchContentTypePattern', () => {
        it('should match exact content types', () => {
          assert.strictEqual(
            matchContentTypePattern('application/json', 'application/json'),
            true,
          );
          assert.strictEqual(
            matchContentTypePattern('image/png', 'image/png'),
            true,
          );
        });

        it('should not match different content types', () => {
          assert.strictEqual(
            matchContentTypePattern('text/html', 'application/json'),
            false,
          );
        });

        it('should match wildcard patterns', () => {
          assert.strictEqual(
            matchContentTypePattern('image/png', 'image/*'),
            true,
          );
          assert.strictEqual(
            matchContentTypePattern('image/jpeg', 'image/*'),
            true,
          );
          assert.strictEqual(
            matchContentTypePattern('video/mp4', 'video/*'),
            true,
          );
        });

        it('should not match wildcard patterns across slashes', () => {
          assert.strictEqual(
            matchContentTypePattern('text/html', 'image/*'),
            false,
          );
        });
      });

      describe('shouldUsePrivateCacheControl', () => {
        let originalContentTypes: string[];

        beforeEach(() => {
          // Save original config array contents
          originalContentTypes = [...config.CACHE_PRIVATE_CONTENT_TYPES];
        });

        afterEach(() => {
          // Restore original config array contents
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push(...originalContentTypes);
        });

        it('should return false for small responses below threshold', () => {
          assert.strictEqual(
            shouldUsePrivateCacheControl('application/json', 100),
            false,
          );
        });

        it('should return true for large responses above threshold', () => {
          assert.strictEqual(
            shouldUsePrivateCacheControl('application/json', 200000000),
            true,
          );
        });

        it('should return true for exact content type match', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('application/json');

          assert.strictEqual(
            shouldUsePrivateCacheControl('application/json', 100),
            true,
          );
        });

        it('should return true for wildcard content type match', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('image/*');

          assert.strictEqual(
            shouldUsePrivateCacheControl('image/png', 100),
            true,
          );
          assert.strictEqual(
            shouldUsePrivateCacheControl('image/jpeg', 100),
            true,
          );
        });

        it('should return false when content type does not match pattern', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('image/*');

          assert.strictEqual(
            shouldUsePrivateCacheControl('text/plain', 100),
            false,
          );
        });

        it('should normalize content type parameters', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('image/png');

          // Should match even with parameters
          assert.strictEqual(
            shouldUsePrivateCacheControl('image/png; charset=utf-8', 100),
            true,
          );
        });

        it('should normalize content type case', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('image/png');

          // Should match even with different case
          assert.strictEqual(
            shouldUsePrivateCacheControl('Image/PNG', 100),
            true,
          );
        });

        it('should normalize content type whitespace', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('image/png');

          // Should match even with whitespace
          assert.strictEqual(
            shouldUsePrivateCacheControl(' image/png ', 100),
            true,
          );
        });

        it('should handle combined normalization', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('image/png');

          // Should match with all normalization issues combined
          assert.strictEqual(
            shouldUsePrivateCacheControl(' Image/PNG; charset=UTF-8 ', 100),
            true,
          );
        });

        it('should return true when either size or content type condition is met', () => {
          config.CACHE_PRIVATE_CONTENT_TYPES.length = 0;
          config.CACHE_PRIVATE_CONTENT_TYPES.push('video/*');

          // Small size but matching content type
          assert.strictEqual(
            shouldUsePrivateCacheControl('video/mp4', 100),
            true,
          );

          // Large size but non-matching content type
          assert.strictEqual(
            shouldUsePrivateCacheControl('text/plain', 200000000),
            true,
          );
        });
      });
    });
  });
});
