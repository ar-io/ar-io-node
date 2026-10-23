/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { EnvFile } from './env-file.js';
import {
  INSTALLED_ROOT_TX_SOURCE,
  planSetup,
  SetupOptions,
  subscriberLookupOrder,
  subscriberSources,
} from './setup-plan.js';

const TURBO = '34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5';
const OTHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';

const options = (o: Partial<SetupOptions>): SetupOptions => ({
  subscribe: [],
  publish: false,
  torrent: false,
  gateway: true,
  ...o,
});

const plan = (text: string, o: Partial<SetupOptions>) =>
  planSetup(new EnvFile(text), options(o));

/** The engine runs by default, so it is always recreated with the sidecar. */
const ENGINE_SERVICES = ['index-swarm-engine-init', 'index-swarm-engine'];

/** Apply a plan to the text, as the CLI does. */
const apply = (text: string, o: Partial<SetupOptions>) => {
  const env = new EnvFile(text);
  for (const change of planSetup(env, options(o)).changes) {
    env.set(change.key, change.value, 'added');
  }
  return env.toString();
};

const valueOf = (p: ReturnType<typeof plan>, key: string) =>
  p.changes.find((c) => c.key === key)?.value;

describe('planSetup', () => {
  it('sets up a subscriber on a fresh .env: subscription and budget, leaving the defaults that already fit', () => {
    const p = plan('', { subscribe: [TURBO] });
    assert.deepEqual(p.errors, []);
    assert.equal(
      valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
      JSON.stringify([{ publisher: TURBO, name: 'root-tx-index' }]),
    );
    // The sidecar applies its 64 GiB default only to the default
    // subscription, so the explicit one written here carries it. The
    // gateway's default sources and lookup order already ask the installed
    // bands first, so neither is written.
    assert.equal(
      valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'),
      String(64 * 1024 ** 3),
    );
    assert.equal(valueOf(p, 'CDB64_ROOT_TX_INDEX_SOURCES'), undefined);
    assert.equal(valueOf(p, 'ROOT_TX_LOOKUP_ORDER'), undefined);
    // No password is written: the engine's init generates one.
    assert.equal(valueOf(p, 'INDEX_SWARM_ENGINE_AUTH'), undefined);
    // Nothing the gateway reads changed, so it is not restarted.
    assert.equal(p.restartCore, false);
    assert.deepEqual(p.services, [...ENGINE_SERVICES, 'index-swarm']);
  });

  it('keeps the default subscription when adding another publisher to an unset one', () => {
    const p = plan('', { subscribe: [OTHER] });
    assert.deepEqual(p.errors, []);
    assert.equal(
      valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
      JSON.stringify([
        { publisher: TURBO, name: 'root-tx-index' },
        { publisher: OTHER, name: 'root-tx-index' },
      ]),
    );
  });

  it('never adds the default publisher to its own gateway', () => {
    const p = plan(`AR_IO_WALLET=${TURBO}`, { subscribe: [OTHER] });
    assert.deepEqual(p.errors, []);
    assert.equal(
      valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
      JSON.stringify([{ publisher: OTHER, name: 'root-tx-index' }]),
    );
  });

  it('adds no budget to a subscription that was already explicit', () => {
    const p = plan(
      `INDEX_SWARM_SUBSCRIBE='[{"publisher":"${TURBO}","name":"root-tx-index"}]'`,
      { subscribe: [OTHER] },
    );
    assert.deepEqual(p.errors, []);
    assert.equal(valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'), undefined);
  });

  it('writes no lookup order when it is unset, and keeps a set one whole', () => {
    assert.equal(
      valueOf(plan('', { subscribe: [OTHER] }), 'ROOT_TX_LOOKUP_ORDER'),
      undefined,
    );
    const p = plan('ROOT_TX_LOOKUP_ORDER=db,gateways,graphql,hyperbeam', {
      subscribe: [OTHER],
    });
    assert.equal(
      valueOf(p, 'ROOT_TX_LOOKUP_ORDER'),
      'db,cdb,gateways,graphql,hyperbeam,cdb-remote',
    );
    // The default order, written out, is left as it is.
    const q = plan(
      'ROOT_TX_LOOKUP_ORDER=db,cdb,gateways,graphql,hyperbeam,cdb-remote',
      { subscribe: [OTHER] },
    );
    assert.equal(valueOf(q, 'ROOT_TX_LOOKUP_ORDER'), undefined);
  });

  it('adds a publisher to an explicit opt-out without bringing the default back', () => {
    const p = plan('INDEX_SWARM_SUBSCRIBE=[]', { subscribe: [OTHER] });
    assert.equal(
      valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
      JSON.stringify([{ publisher: OTHER, name: 'root-tx-index' }]),
    );
  });

  it("raises an existing subscriber's budget with --max-disk-gib alone, without restarting the gateway", () => {
    const existing = apply('', { subscribe: [TURBO], maxDiskGiB: 25 });
    const p = plan(existing, {
      maxDiskGiB: 60,
    });
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.changes.map((c) => [c.key, c.value]),
      [['INDEX_SWARM_MAX_DISK_BYTES', String(60 * 1024 ** 3)]],
    );
    assert.equal(p.restartCore, false);
    assert.deepEqual(p.services, [...ENGINE_SERVICES, 'index-swarm']);
  });

  it("moves an existing engine's peer port with --engine-port alone, restarting the engine but not the gateway", () => {
    const existing = apply('', { subscribe: [TURBO], torrent: true });
    const p = plan(existing, { enginePort: 6882 });
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.changes.map((c) => [c.key, c.value]),
      [['INDEX_SWARM_ENGINE_PORT', '6882']],
    );
    assert.equal(p.restartCore, false);
    assert.deepEqual(p.services, [
      'index-swarm-engine-init',
      'index-swarm-engine',
      'index-swarm',
    ]);
    assert.match(p.notes.join('\n'), /Open port 6882/);
  });

  it("sets an existing engine's public host with --public-host alone", () => {
    const existing = apply('', { subscribe: [TURBO], torrent: true });
    const p = plan(existing, { publicHost: '203.0.113.7' });
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.changes.map((c) => [c.key, c.value]),
      [['INDEX_SWARM_ENGINE_PUBLIC_HOST', '203.0.113.7']],
    );
  });

  it('is idempotent: a second run changes nothing and restarts no gateway', () => {
    const once = apply('', { subscribe: [TURBO], torrent: true });
    const again = plan(once, { subscribe: [TURBO], torrent: true });
    assert.deepEqual(again.changes, []);
    assert.equal(again.restartCore, false);
    // The engine is still on, so it is still started.
    assert.ok(again.services.includes('index-swarm-engine'));
  });

  it('adds a second publisher without disturbing the first', () => {
    const once = apply('', { subscribe: [TURBO] });
    const p = plan(once, { subscribe: [OTHER] });
    assert.equal(
      valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
      JSON.stringify([
        { publisher: TURBO, name: 'root-tx-index' },
        { publisher: OTHER, name: 'root-tx-index' },
      ]),
    );
    assert.equal(p.restartCore, false, 'the gateway already reads the bands');
  });

  describe('--l1', () => {
    it('takes L1 bands as well, and has the gateway fill its history from them', () => {
      const p = plan('', { subscribe: [TURBO], l1: true });
      assert.deepEqual(p.errors, []);
      assert.equal(
        valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
        JSON.stringify([
          { publisher: TURBO, name: ['root-tx-index', 'parquet-l1'] },
        ]),
      );
      assert.equal(valueOf(p, 'L1_BAND_IMPORT_ENABLED'), 'true');
      assert.equal(
        valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'),
        String(100 * 1024 ** 3),
      );
      assert.equal(p.restartCore, true);
    });

    it('adds L1 to an existing subscription, keeping what it takes', () => {
      const once = apply('', { subscribe: [TURBO] });
      const p = plan(once, { subscribe: [TURBO], l1: true });
      assert.equal(
        valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
        JSON.stringify([
          { publisher: TURBO, name: ['root-tx-index', 'parquet-l1'] },
        ]),
      );
      assert.equal(valueOf(p, 'L1_BAND_IMPORT_ENABLED'), 'true');
      assert.equal(p.restartCore, true);
      // Root-TX alone wrote the 64 GiB default, so the L1 one replaces it.
      assert.equal(
        valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'),
        String(100 * 1024 ** 3),
      );
    });

    it('only warns about an existing budget too small for L1 bands', () => {
      const once = apply('', { subscribe: [TURBO], maxDiskGiB: 50 });
      const p = plan(once, { subscribe: [TURBO], l1: true });
      assert.equal(valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'), undefined);
      assert.ok(p.warnings.some((w) => /under 100 GiB/.test(w)));
    });

    it('is idempotent', () => {
      const once = apply('', { subscribe: [TURBO], l1: true });
      const again = plan(once, { subscribe: [TURBO], l1: true });
      assert.deepEqual(again.changes, []);
      assert.equal(again.restartCore, false);
    });

    it('needs a publisher to take the bands from', () => {
      const p = plan('', { l1: true, publish: true });
      assert.ok(p.errors.some((e) => /--subscribe/.test(e)));
    });
  });

  it('keeps an operator’s own sources and order, moving only what it needs', () => {
    const text = [
      'CDB64_ROOT_TX_INDEX_SOURCES=data/my-index,./data/indexes/installed/root-tx-index/',
      'ROOT_TX_LOOKUP_ORDER=db,gateways,turbo,cdb',
      'INDEX_SWARM_MAX_DISK_BYTES=1000',
    ].join('\n');
    const p = plan(text, { subscribe: [TURBO] });
    assert.equal(
      valueOf(p, 'CDB64_ROOT_TX_INDEX_SOURCES'),
      `${INSTALLED_ROOT_TX_SOURCE},data/my-index`,
    );
    assert.equal(
      valueOf(p, 'ROOT_TX_LOOKUP_ORDER'),
      'db,cdb,gateways,turbo,cdb-remote',
    );
    assert.equal(valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'), undefined, 'kept');
  });

  it('warns about hyperbeam in an explicit order, but never drops it', () => {
    const p = plan('ROOT_TX_LOOKUP_ORDER=db,gateways,hyperbeam,cdb', {
      subscribe: [TURBO],
    });
    assert.equal(
      valueOf(p, 'ROOT_TX_LOOKUP_ORDER'),
      'db,cdb,gateways,hyperbeam,cdb-remote',
    );
    assert.match(p.warnings.join('\n'), /hyperbeam/);
  });

  it('leaves the gateway alone with --no-gateway', () => {
    const p = plan('', { subscribe: [TURBO], gateway: false });
    assert.equal(valueOf(p, 'CDB64_ROOT_TX_INDEX_SOURCES'), undefined);
    assert.equal(valueOf(p, 'ROOT_TX_LOOKUP_ORDER'), undefined);
    assert.equal(p.restartCore, false);
  });

  it('takes --torrent for older instructions, writing no password (the engine init generates one)', () => {
    const p = plan(`INDEX_SWARM_SUBSCRIBE='[{"publisher":"${TURBO}"}]'`, {
      torrent: true,
    });
    assert.deepEqual(p.errors, []);
    assert.equal(valueOf(p, 'INDEX_SWARM_ENGINE_AUTH'), undefined);
    assert.equal(valueOf(p, 'INDEX_SWARM_ENGINE_URL'), undefined, 'defaults');
    assert.deepEqual(p.profiles, ['index-swarm', 'index-swarm-torrent']);
    assert.deepEqual(p.services, [
      'index-swarm-engine-init',
      'index-swarm-engine',
      'index-swarm',
    ]);
    assert.match(p.notes.join('\n'), /Open port 6881/);
  });

  it('refuses to replace an unusable engine password', () => {
    const p = plan(
      `INDEX_SWARM_SUBSCRIBE='[{"publisher":"${TURBO}"}]'\nINDEX_SWARM_ENGINE_AUTH=swarm:short`,
      {
        torrent: true,
      },
    );
    assert.match(p.errors.join('\n'), /INDEX_SWARM_ENGINE_AUTH is unusable/);
    assert.equal(valueOf(p, 'INDEX_SWARM_ENGINE_AUTH'), undefined);
  });

  it('publishes with a tracker at the public host, IPv6 in brackets', () => {
    const base = 'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W';
    const p = plan(base, {
      publish: true,
      torrent: true,
      publicHost: '2001:db8::1',
    });
    assert.deepEqual(p.errors, []);
    assert.equal(
      valueOf(p, 'INDEX_SWARM_PUBLISH'),
      JSON.stringify([{ name: 'root-tx-index', kind: 'cdb64-root-tx' }]),
    );
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'http://[2001:db8::1]:6969/announce',
    );
    assert.equal(valueOf(p, 'INDEX_SWARM_ENGINE_PUBLIC_HOST'), '2001:db8::1');
    // Compose publishes the direct port on loopback unless told otherwise.
    assert.equal(valueOf(p, 'INDEX_SWARM_TRACKER_HOST_IP'), '0.0.0.0');
    assert.match(p.notes.join('\n'), /Open the tracker port 6969/);
  });

  it('announces through the gateway’s HTTPS when it knows its public URL, with no tracker port to open', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example,other.example';
    const p = plan(base, {
      publish: true,
      torrent: true,
      publicHost: '203.0.113.7',
    });
    assert.deepEqual(p.errors, []);
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'https://gateway.example/ar-io/indexes/announce',
    );
    // The engine is still listed at the node's own address.
    assert.equal(valueOf(p, 'INDEX_SWARM_ENGINE_PUBLIC_HOST'), '203.0.113.7');
    assert.equal(valueOf(p, 'INDEX_SWARM_TRACKER_HOST_IP'), undefined);
    assert.doesNotMatch(p.notes.join('\n'), /tracker port/);
    assert.doesNotMatch(p.notes.join('\n'), /INDEXES_PUBLIC_URL/);
    assert.doesNotMatch(p.notes.join('\n'), /lists this node's engine/);
  });

  it('says where the engine will be listed when only the gateway’s name is known', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example';
    const p = plan(base, { publish: true, torrent: true });
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'https://gateway.example/ar-io/indexes/announce',
    );
    assert.match(
      p.notes.join('\n'),
      /lists this node's engine at gateway\.example:6881.*--public-host/,
    );
  });

  it('takes --public-url over ARNS_ROOT_HOST', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example';
    const p = plan(base, {
      publish: true,
      torrent: true,
      publicUrl: 'https://fleet.example/',
    });
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'https://fleet.example/ar-io/indexes/announce',
    );
  });

  it('takes INDEXES_PUBLIC_URL over ARNS_ROOT_HOST, as core does for its feeds and WebSeed', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=ar.example\nINDEXES_PUBLIC_URL=http://gw.example:8443/';
    const p = plan(base, { publish: true, torrent: true });
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'http://gw.example:8443/ar-io/indexes/announce',
    );
    // Alone, too.
    const alone = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nINDEXES_PUBLIC_URL=https://gw.example',
      { publish: true, torrent: true },
    );
    assert.equal(
      valueOf(alone, 'INDEX_SWARM_TRACKERS'),
      'https://gw.example/ar-io/indexes/announce',
    );
  });

  it('stops on an INDEXES_PUBLIC_URL the gateway would not start with', () => {
    for (const value of [
      'gw.example',
      'https://gw.example/path',
      'https://user:secret@gw.example',
    ]) {
      const bad = plan(
        `INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=ar.example\nINDEXES_PUBLIC_URL=${value}`,
        { publish: true, torrent: true },
      );
      assert.equal(bad.errors.length, 1, value);
      assert.match(bad.errors[0], /INDEXES_PUBLIC_URL is not an origin/);
      assert.ok(!bad.errors[0].includes(value), 'the value is not echoed');
      assert.deepEqual(bad.changes, [], 'nothing is written');
    }
  });

  it('says the announce route needs a current Envoy, and how to check it', () => {
    const p = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example',
      { publish: true, torrent: true },
    );
    assert.match(
      p.notes.join('\n'),
      /Envoy, which must be release 85 or later.*curl -s 'https:\/\/gateway\.example\/ar-io\/indexes\/announce\?info_hash=x'/,
    );
  });

  it('never replaces an existing tracker list, and asks to open the port it names', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example\nINDEX_SWARM_TRACKERS=http://203.0.113.7:6969/announce';
    const p = plan(base, { publish: true, torrent: true });
    assert.equal(valueOf(p, 'INDEX_SWARM_TRACKERS'), undefined);
    // It names the loopback binding rather than change an existing setup.
    assert.equal(valueOf(p, 'INDEX_SWARM_TRACKER_HOST_IP'), undefined);
    assert.match(
      p.notes.join('\n'),
      /tracker port 6969 directly.*INDEX_SWARM_TRACKER_HOST_IP=0\.0\.0\.0/,
    );
    const open = plan(`${base}\nINDEX_SWARM_TRACKER_HOST_IP=0.0.0.0`, {
      publish: true,
    });
    assert.match(open.notes.join('\n'), /Open the tracker port 6969/);
  });

  it('sets the publisher tracker up without --torrent, since the engine runs by default', () => {
    const p = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example',
      { publish: true },
    );
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'https://gateway.example/ar-io/indexes/announce',
    );
  });

  it('notes that the feed needs a public URL when the gateway has none', () => {
    const base = 'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W';
    const p = plan(base, {
      publish: true,
      torrent: true,
      publicUrl: 'https://gw.example',
    });
    assert.equal(
      valueOf(p, 'INDEX_SWARM_TRACKERS'),
      'https://gw.example/ar-io/indexes/announce',
    );
    assert.match(
      p.notes.join('\n'),
      /INDEXES_PUBLIC_URL=https:\/\/gw\.example/,
    );
  });

  it('sets up index-export when publishing, with the header check off this gateway by default', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nANS104_UNBUNDLE_FILTER={"always":true}';
    const p = plan(base, { publish: true, startHeight: 1950000 });
    assert.deepEqual(p.errors, []);
    assert.ok(p.profiles.includes('index-export'));
    assert.ok(p.services.includes('index-export'));
    assert.equal(
      valueOf(p, 'INDEX_EXPORT_HEADER_CHECK_URL'),
      'https://turbo-gateway.com',
    );
    assert.equal(valueOf(p, 'INDEX_EXPORT_START_HEIGHT'), '1950000');
    // Torrents are on by default, and nothing names this gateway's address.
    assert.deepEqual(
      p.warnings.filter((w) => !/without a tracker/.test(w)),
      [],
    );
    assert.match(p.notes.join('\n'), /--once --dry-run/);
    assert.equal(p.restartCore, false, 'index-export needs nothing of core');
  });

  it('starts index-export with the torrent engine too', () => {
    const p = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nANS104_UNBUNDLE_FILTER={"always":true}',
      {
        publish: true,
        torrent: true,
        publicHost: '203.0.113.5',
        startHeight: 1,
      },
    );
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.services, [
      'index-swarm-engine-init',
      'index-swarm-engine',
      'index-swarm',
      'index-export',
    ]);
    assert.ok(p.profiles.includes('index-export'));
    assert.ok(p.profiles.includes('index-swarm-torrent'));
  });

  it('warns when publishing would read headers from core, start nowhere, or build nothing', () => {
    const p = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W',
      {
        publish: true,
        headerCheckUrl: 'http://core:4000',
      },
    );
    const warnings = p.warnings.join('\n');
    assert.equal(
      valueOf(p, 'INDEX_EXPORT_HEADER_CHECK_URL'),
      'http://core:4000',
    );
    assert.match(warnings, /reads from this gateway/);
    assert.match(warnings, /INDEX_EXPORT_START_HEIGHT/);
    assert.match(warnings, /unbundles nothing/);
  });

  it('keeps a header-check gateway already set', () => {
    const p = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nINDEX_EXPORT_HEADER_CHECK_URL=https://gw.example\nINDEX_EXPORT_START_HEIGHT=5',
      { publish: true },
    );
    assert.equal(valueOf(p, 'INDEX_EXPORT_HEADER_CHECK_URL'), undefined);
    assert.doesNotMatch(p.warnings.join('\n'), /START_HEIGHT/);
  });

  it('will not publish without a registered key and wallet', () => {
    const none = plan('', { publish: true });
    assert.match(none.errors.join('\n'), /observer key/);
    assert.match(none.errors.join('\n'), /AR_IO_WALLET/);
    const both = plan(
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k\nOBSERVER_PRIVATE_KEY=x\nAR_IO_WALLET=W',
      {
        publish: true,
      },
    );
    assert.match(both.errors.join('\n'), /not both|Keep one/);
  });

  it('asks for a role only when the operator opted out of the default subscription', () => {
    assert.deepEqual(plan('', { torrent: true }).errors, []);
    assert.match(
      plan('INDEX_SWARM_SUBSCRIBE=[]', { torrent: true }).errors.join('\n'),
      /Nothing to set up/,
    );
  });

  it('stops on an invalid existing subscription instead of overwriting it', () => {
    const p = plan('INDEX_SWARM_SUBSCRIBE=not-json', { subscribe: [TURBO] });
    assert.match(p.errors.join('\n'), /INDEX_SWARM_SUBSCRIBE is invalid/);
    assert.deepEqual(p.changes, []);
  });
});

describe('subscriberLookupOrder', () => {
  it('leaves an unset or blank order alone: the default is already right', () => {
    assert.equal(subscriberLookupOrder(undefined), undefined);
    assert.equal(subscriberLookupOrder(''), undefined);
    assert.equal(subscriberLookupOrder('  '), undefined);
  });

  it('keeps every other token, hyperbeam included', () => {
    assert.equal(
      subscriberLookupOrder('db,gateways,graphql,hyperbeam,cdb-remote'),
      'db,cdb,gateways,graphql,hyperbeam,cdb-remote',
    );
    assert.equal(
      subscriberLookupOrder('turbo,db,peers,gateways,hyperbeam'),
      'turbo,db,cdb,peers,gateways,hyperbeam,cdb-remote',
    );
  });

  it('puts cdb right after db, or first without db', () => {
    assert.equal(subscriberLookupOrder('db,cdb,x'), 'db,cdb,x,cdb-remote');
    assert.equal(
      subscriberLookupOrder('gateways,db'),
      'gateways,db,cdb,cdb-remote',
    );
    assert.equal(
      subscriberLookupOrder('gateways,graphql'),
      'cdb,gateways,graphql,cdb-remote',
    );
  });

  it('keeps cdb-remote where the order already has it', () => {
    assert.equal(
      subscriberLookupOrder('db,gateways,cdb-remote,graphql'),
      'db,cdb,gateways,cdb-remote,graphql',
    );
    // The gateway's own default is left exactly as it is.
    assert.equal(
      subscriberLookupOrder('db,cdb,gateways,graphql,hyperbeam,cdb-remote'),
      'db,cdb,gateways,graphql,hyperbeam,cdb-remote',
    );
  });

  it('adds cdb-remote last when the order lacks it, so cdb stays local', () => {
    // Without cdb-remote, cdb would also ask the shipped indexes (read from
    // Arweave) right after db.
    assert.equal(
      subscriberLookupOrder('db,gateways,graphql'),
      'db,cdb,gateways,graphql,cdb-remote',
    );
  });

  it('never repeats or drops cdb or cdb-remote', () => {
    assert.equal(
      subscriberLookupOrder('cdb-remote,db,cdb,gateways,cdb,cdb-remote'),
      'cdb-remote,db,cdb,gateways',
    );
    // Case does not matter to the gateway, so it does not here either.
    assert.equal(
      subscriberLookupOrder('DB,Gateways,CDB,CDB-Remote'),
      'DB,cdb,Gateways,CDB-Remote',
    );
  });

  it('is unchanged when applied twice', () => {
    for (const start of [
      'db,gateways',
      'gateways,graphql,cdb-remote,db',
      'db,cdb,gateways,graphql,hyperbeam,cdb-remote',
    ]) {
      const once = subscriberLookupOrder(start);
      assert.equal(subscriberLookupOrder(once!), once);
    }
  });
});

describe('subscriberSources', () => {
  it('moves an existing entry to the front instead of repeating it', () => {
    assert.equal(
      subscriberSources(`a,${INSTALLED_ROOT_TX_SOURCE},b`),
      `${INSTALLED_ROOT_TX_SOURCE},a,b`,
    );
  });
});
