/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Index publishing end to end: two real gateways, each with its index-swarm
 * sidecar, on a private network.
 *
 * The publisher's sidecar describes a band and signs a publication with an
 * observer key; its gateway serves it. The subscriber's sidecar resolves the
 * publisher, verifies the publication, downloads the band over HTTP and
 * installs it, and the subscriber's gateway answers a root-transaction
 * lookup from it with no restart.
 *
 * The one stand-in is the registry. A sidecar reads registry records from
 * its gateway's /ar-io/peers, which a real gateway fills from Solana; this
 * suite makes no RPC calls, so the subscriber's sidecar reads a small stub
 * on the host that lists the publisher, as a real gateway would.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import {
  Network,
  StartedNetwork,
  StartedTestContainer,
  TestContainers,
  Wait,
} from 'testcontainers';

import { getCoreContainer } from './utils.js';
import { getSolanaAddress } from '../../src/lib/httpsig.js';
import { toB64Url } from '../../src/lib/encoding.js';
import { encodeCdb64Value } from '../../src/lib/cdb64-encoding.js';
import { PartitionedCdb64Writer } from '../../src/lib/partitioned-cdb64-writer.js';
import {
  serializeIndexPublication,
  signIndexPublication,
} from '../../src/lib/index-publication.js';

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

/** Poll until `check` holds or the time runs out. */
const eventually = async (
  check: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

const exists = async (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe('Index publishing', { timeout: 600_000 }, () => {
  let network: StartedNetwork;
  let pubCore: StartedTestContainer;
  let pubSidecar: StartedTestContainer;
  let subCore: StartedTestContainer;
  let subSidecar: StartedTestContainer;
  let stub: http.Server;
  let stubPort: number;
  let canaryHits = 0;
  let root: string;
  let pubData: string;
  let subData: string;

  // The publisher's identity: one key as both wallet and observer, which is
  // how most gateways are registered.
  const keys = crypto.generateKeyPairSync('ed25519');
  const address = getSolanaAddress(keys.publicKey);

  const itemId = crypto.randomBytes(32);
  const itemRoot = crypto.randomBytes(32);

  const writeBand = async (
    dir: string,
    entries: Array<[Buffer, Buffer]>,
  ): Promise<void> => {
    const writer = new PartitionedCdb64Writer(dir);
    await writer.open();
    for (const [id, rootTxId] of entries) {
      await writer.add(id, encodeCdb64Value({ rootTxId }));
    }
    await writer.finalize();
  };

  /** Hand-sign what the publisher's gateway serves: a newer or hostile publisher. */
  const serveDocument = async (
    mutate: (doc: any) => void | Promise<void>,
  ): Promise<void> => {
    const file = path.join(pubData, 'published', 'publication.json');
    const doc: any = JSON.parse(await fs.readFile(file, 'utf8'));
    delete doc.signature;
    doc.sequence += 100;
    doc.previousManifestSha256 = null;
    await mutate(doc);
    await fs.writeFile(
      file,
      serializeIndexPublication(
        signIndexPublication(doc, keys.privateKey, address),
      ),
    );
  };

  /** Describe a band directory the way the publisher does, for a hand-made document. */
  const describeBand = async (bandId: string) => {
    const dir = path.join(pubData, 'published', 'root-tx-index', bandId);
    const files = [];
    for (const name of (await fs.readdir(dir)).sort()) {
      const bytes = await fs.readFile(path.join(dir, name));
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      files.push({ name, size: bytes.length, sha256 });
      // The blob route serves the publisher's hard links.
      await fs.mkdir(path.join(pubData, 'published', 'blobs'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(pubData, 'published', 'blobs', sha256),
        bytes,
      );
    }
    return {
      id: bandId,
      files,
      http: { baseUrl: `/ar-io/indexes/root-tx-index/${bandId}/` },
    };
  };

  const subscriberInstalled = (bandId: string) =>
    exists(
      path.join(subData, 'installed', 'root-tx-index', bandId, 'manifest.json'),
    );

  const subscriberMetric = async (pattern: RegExp): Promise<number> => {
    const port = subSidecar.getMappedPort(9101);
    const text = await (await fetch(`http://localhost:${port}/metrics`)).text();
    return text
      .split('\n')
      .filter((line) => pattern.test(line))
      .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
  };

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'index-publishing-e2e-'));
    pubData = path.join(root, 'pub');
    subData = path.join(root, 'sub');
    const wallets = path.join(root, 'wallets');
    await fs.mkdir(path.join(pubData, 'published', 'root-tx-index'), {
      recursive: true,
    });
    await fs.mkdir(subData, { recursive: true });
    await fs.mkdir(wallets, { recursive: true });

    // A Solana keypair file: the 32-byte seed, then the 32-byte public key.
    const jwk = keys.privateKey.export({ format: 'jwk' });
    const seed = Buffer.from(jwk.d as string, 'base64url');
    const pub = Buffer.from(jwk.x as string, 'base64url');
    await fs.writeFile(
      path.join(wallets, 'observer.json'),
      JSON.stringify([...seed, ...pub]),
    );

    await writeBand(
      path.join(pubData, 'published', 'root-tx-index', 'band-a'),
      [[itemId, itemRoot]],
    );

    // The registry as the subscriber's gateway would present it.
    stub = http.createServer((req, res) => {
      if (req.url === '/canary') {
        canaryHits++;
        res.writeHead(404).end();
      } else if (req.url === '/ar-io/info') {
        res.end(JSON.stringify({ release: '84-pre' }));
      } else if (req.url === '/ar-io/peers') {
        res.end(
          JSON.stringify({
            gateways: {
              'core-pub:4000': {
                url: 'http://core-pub:4000',
                dataWeight: 50,
                chunkWeight: 50,
                wallet: address,
                observerAddress: address,
                operatorStake: 1,
                status: 'joined',
              },
            },
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => stub.listen(0, resolve));
    stubPort = (stub.address() as AddressInfo).port;
    await TestContainers.exposeHostPorts(stubPort);

    network = await new Network().start();
    const isolated = {
      START_WRITERS: 'false',
      SOLANA_RPC_URL: 'http://127.0.0.1:1',
      TRUSTED_NODE_URL: 'http://127.0.0.1:1',
      // Somewhere unreachable: nothing in this suite may leave the host.
      TRUSTED_GATEWAYS_URLS: '{"http://127.0.0.1:1": 1}',
      LOG_LEVEL: 'info',
    };

    pubCore = await (
      await getCoreContainer()
    )
      .withEnvironment({ ...isolated })
      .withBindMounts([
        { source: pubData, target: '/app/data/indexes', mode: 'ro' },
      ])
      .withNetwork(network)
      .withNetworkAliases('core-pub')
      .withExposedPorts(4000)
      .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
      .start();

    pubSidecar = await (
      await getCoreContainer()
    )
      .withEntrypoint(['/nodejs/bin/node', 'dist/index-swarm/main.js'])
      .withUser(`${uid}:${gid}`)
      .withEnvironment({
        INDEX_SWARM_DATA_DIR: '/app/data/indexes',
        INDEX_SWARM_PUBLISH:
          '[{"name":"root-tx-index","kind":"cdb64-root-tx"}]',
        INDEX_SWARM_PUBLISH_SCAN_INTERVAL_SECONDS: '1',
        OBSERVER_KEYPAIR_PATH: '/app/wallets/observer.json',
        AR_IO_WALLET: address,
        INDEX_SWARM_CORE_URL: 'http://core-pub:4000',
      })
      .withBindMounts([
        { source: pubData, target: '/app/data/indexes' },
        { source: wallets, target: '/app/wallets', mode: 'ro' },
      ])
      .withNetwork(network)
      .start();

    subCore = await (
      await getCoreContainer()
    )
      .withEnvironment({
        ...isolated,
        CDB64_ROOT_TX_INDEX_SOURCES: 'data/indexes/installed/root-tx-index',
        ROOT_TX_LOOKUP_ORDER: 'cdb',
        ON_DEMAND_RETRIEVAL_ORDER: 'chunks-offset-aware',
      })
      .withBindMounts([
        { source: subData, target: '/app/data/indexes', mode: 'ro' },
      ])
      .withNetwork(network)
      .withExposedPorts(4000)
      .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
      .start();

    subSidecar = await (
      await getCoreContainer()
    )
      .withEntrypoint(['/nodejs/bin/node', 'dist/index-swarm/main.js'])
      .withUser(`${uid}:${gid}`)
      .withEnvironment({
        INDEX_SWARM_DATA_DIR: '/app/data/indexes',
        INDEX_SWARM_SUBSCRIBE: `[{"publisher":"${address}","name":"root-tx-index"}]`,
        INDEX_SWARM_POLL_INTERVAL_SECONDS: '2',
        INDEX_SWARM_SUPERSEDE_GRACE_SECONDS: '1',
        INDEX_SWARM_CORE_URL: `http://host.testcontainers.internal:${stubPort}`,
      })
      .withBindMounts([{ source: subData, target: '/app/data/indexes' }])
      .withNetwork(network)
      .withExposedPorts(9101)
      // The image is distroless: the default wait, which checks the port
      // from inside the container with a shell, cannot run there.
      .withWaitStrategy(Wait.forHttp('/healthz', 9101))
      .start();
  });

  after(async () => {
    await Promise.allSettled([
      subSidecar?.stop(),
      subCore?.stop(),
      pubSidecar?.stop(),
      pubCore?.stop(),
    ]);
    await network?.stop();
    // before() can fail ahead of assigning these; without the guards this hook
    // would wait on a close that never runs and hide the real error.
    if (stub !== undefined) {
      const server = stub;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (root !== undefined) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a signed band, and the subscriber installs it and answers from it', async () => {
    const pubPort = pubCore.getMappedPort(4000);
    assert(
      await eventually(async () => {
        const res = await fetch(`http://localhost:${pubPort}/ar-io/indexes`);
        return res.ok;
      }),
      'the publisher gateway serves the signed publication',
    );
    const doc = await (
      await fetch(`http://localhost:${pubPort}/ar-io/indexes`)
    ).json();
    assert.equal(doc.publisher, address);
    assert.equal(doc.signature.keyId, address);

    assert(
      await eventually(() => subscriberInstalled('band-a')),
      'the subscriber installed the band',
    );

    // The subscriber's gateway picks the band up with no restart and
    // resolves the item's root from it.
    const subPort = subCore.getMappedPort(4000);
    const found = await eventually(async () => {
      await fetch(`http://localhost:${subPort}/raw/${toB64Url(itemId)}`, {
        method: 'HEAD',
      }).catch(() => undefined);
      const metrics = await (
        await fetch(`http://localhost:${subPort}/ar-io/__gateway_metrics`)
      ).text();
      return /root_tx_lookup_total\{source="cdb64",status="found"[^}]*\} [1-9]/.test(
        metrics,
      );
    });
    assert(found, 'the gateway resolved the item from the installed band');
  });

  it('refuses a signed band whose manifest points a partition at a URL', async () => {
    // From here on the tests hand-sign what the publisher serves, so its own
    // sidecar must not rewrite the document underneath them.
    await pubSidecar.stop();
    await writeBand(
      path.join(pubData, 'published', 'root-tx-index', 'band-ssrf'),
      [[crypto.randomBytes(32), crypto.randomBytes(32)]],
    );
    const bandDir = path.join(
      pubData,
      'published',
      'root-tx-index',
      'band-ssrf',
    );
    const manifestPath = path.join(bandDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const victim = manifest.partitions[0];
    await fs.rm(path.join(bandDir, victim.location.filename));
    victim.location = {
      type: 'http',
      url: `http://host.testcontainers.internal:${stubPort}/canary`,
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const hostile = await describeBand('band-ssrf');

    const failedBefore = await subscriberMetric(
      /^index_subscription_total\{.*result="verify_failed"/,
    );
    await serveDocument((doc) => {
      doc.indexes[0].bands.push(hostile);
    });

    assert(
      await eventually(
        async () =>
          (await subscriberMetric(
            /^index_subscription_total\{.*result="verify_failed"/,
          )) > failedBefore,
      ),
      'the band was refused',
    );
    assert.equal(await subscriberInstalled('band-ssrf'), false);
    assert.equal(canaryHits, 0, 'the publisher-chosen URL was never requested');
    assert.equal(
      await subscriberInstalled('band-a'),
      true,
      'the good band stays installed',
    );
  });

  it('accepts a document from a newer publisher that adds fields', async () => {
    await writeBand(
      path.join(pubData, 'published', 'root-tx-index', 'band-future'),
      [[crypto.randomBytes(32), crypto.randomBytes(32)]],
    );
    const future: any = await describeBand('band-future');
    future.addedLater = { at: 'band' };
    for (const file of future.files) {
      file.merkle = { 'arweave-data-root': 'x'.repeat(43) };
    }
    await serveDocument((doc) => {
      doc.addedLater = true;
      // Drop the hostile band; keep the rest.
      doc.indexes[0].bands = doc.indexes[0].bands
        .filter((band: any) => band.id !== 'band-ssrf')
        .concat(future);
    });

    assert(
      await eventually(() => subscriberInstalled('band-future')),
      'a document with unknown fields verified and installed',
    );
  });
});
