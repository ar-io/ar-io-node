/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES } from '../../lib/root-tx-defaults.js';
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
  planSetup(new EnvFile(text), options(o), () => 'p'.repeat(48));

/** Apply a plan to the text, as the CLI does. */
const apply = (text: string, o: Partial<SetupOptions>) => {
  const env = new EnvFile(text);
  for (const change of planSetup(env, options(o), () => 'p'.repeat(48))
    .changes) {
    env.set(change.key, change.value, 'added');
  }
  return env.toString();
};

const valueOf = (p: ReturnType<typeof plan>, key: string) =>
  p.changes.find((c) => c.key === key)?.value;

describe('planSetup', () => {
  it('sets up a subscriber on a fresh .env: subscription, disk, sources, lookup order', () => {
    const p = plan('', { subscribe: [TURBO] });
    assert.deepEqual(p.errors, []);
    assert.equal(
      valueOf(p, 'INDEX_SWARM_SUBSCRIBE'),
      JSON.stringify([{ publisher: TURBO, name: 'root-tx-index' }]),
    );
    assert.equal(
      valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'),
      String(50 * 1024 ** 3),
    );
    assert.equal(
      valueOf(p, 'CDB64_ROOT_TX_INDEX_SOURCES'),
      `${INSTALLED_ROOT_TX_SOURCE},${DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES}`,
    );
    assert.equal(valueOf(p, 'ROOT_TX_LOOKUP_ORDER'), 'db,cdb,gateways,graphql');
    assert.equal(p.restartCore, true);
    assert.deepEqual(p.services, ['index-swarm']);
    assert.deepEqual(p.profiles, ['index-swarm']);
  });

  it("raises an existing subscriber's budget with --max-disk-gib alone, without restarting the gateway", () => {
    const existing = apply('', { subscribe: [TURBO] });
    const p = plan(
      existing.replace(String(50 * 1024 ** 3), String(25 * 1024 ** 3)),
      {
        maxDiskGiB: 60,
      },
    );
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.changes.map((c) => [c.key, c.value]),
      [['INDEX_SWARM_MAX_DISK_BYTES', String(60 * 1024 ** 3)]],
    );
    assert.equal(p.restartCore, false);
    assert.deepEqual(p.services, ['index-swarm']);
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
    assert.equal(valueOf(p, 'ROOT_TX_LOOKUP_ORDER'), 'db,cdb,gateways,turbo');
    assert.equal(valueOf(p, 'INDEX_SWARM_MAX_DISK_BYTES'), undefined, 'kept');
  });

  it('warns about hyperbeam in an explicit order, but never drops it', () => {
    const p = plan('ROOT_TX_LOOKUP_ORDER=db,gateways,hyperbeam,cdb', {
      subscribe: [TURBO],
    });
    assert.equal(
      valueOf(p, 'ROOT_TX_LOOKUP_ORDER'),
      'db,cdb,gateways,hyperbeam',
    );
    assert.match(p.warnings.join('\n'), /hyperbeam/);
  });

  it('leaves the gateway alone with --no-gateway', () => {
    const p = plan('', { subscribe: [TURBO], gateway: false });
    assert.equal(valueOf(p, 'CDB64_ROOT_TX_INDEX_SOURCES'), undefined);
    assert.equal(valueOf(p, 'ROOT_TX_LOOKUP_ORDER'), undefined);
    assert.equal(p.restartCore, false);
  });

  it('turns on torrents with a generated password it never displays', () => {
    const p = plan(`INDEX_SWARM_SUBSCRIBE='[{"publisher":"${TURBO}"}]'`, {
      torrent: true,
    });
    const auth = p.changes.find((c) => c.key === 'INDEX_SWARM_ENGINE_AUTH');
    assert.equal(auth?.value, `swarm:${'p'.repeat(48)}`);
    assert.equal(auth?.display?.includes('p'.repeat(8)), false);
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
      'INDEX_SWARM_SUBSCRIBE=[]\nINDEX_SWARM_ENGINE_AUTH=swarm:short',
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
    assert.match(p.notes.join('\n'), /tracker port 6969/);
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
    assert.doesNotMatch(p.notes.join('\n'), /tracker port/);
    assert.doesNotMatch(p.notes.join('\n'), /INDEXES_PUBLIC_URL/);
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

  it('never replaces an existing tracker list, and asks to open the port it names', () => {
    const base =
      'INDEX_SWARM_OBSERVER_KEYPAIR_FILE=/k.json\nAR_IO_WALLET=W\nARNS_ROOT_HOST=gateway.example\nINDEX_SWARM_TRACKERS=http://203.0.113.7:6969/announce';
    const p = plan(base, { publish: true, torrent: true });
    assert.equal(valueOf(p, 'INDEX_SWARM_TRACKERS'), undefined);
    assert.match(p.notes.join('\n'), /tracker port 6969/);
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
    assert.deepEqual(p.warnings, []);
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

  it('asks for a role when there is none', () => {
    assert.match(
      plan('', { torrent: true }).errors.join('\n'),
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
  it('puts cdb right after db, or first without db', () => {
    assert.equal(subscriberLookupOrder(undefined), 'db,cdb,gateways,graphql');
    assert.equal(subscriberLookupOrder('db,cdb,x'), 'db,cdb,x');
    assert.equal(subscriberLookupOrder('gateways,db'), 'gateways,db,cdb');
    assert.equal(
      subscriberLookupOrder('gateways,graphql'),
      'cdb,gateways,graphql',
    );
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
