/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as net from 'node:net';

import { isPrivateAddress } from './torrent.js';
import {
  PRIVATE_RANGES_DAT,
  EngineSettings,
  hashWebUiPassword,
  renderEngineConfig,
  webUiPasswordMatches,
} from './engine-config.js';

/**
 * qBittorrent's own hash of its old default password, "adminadmin", as the
 * project has published it. Matching it proves the PBKDF2 parameters are
 * the ones qBittorrent uses, independently of this code.
 */
const QBITTORRENT_ADMINADMIN =
  '"@ByteArray(ARQ77eY1NUZaQsuDHbIMCA==:0WMRkYTUWVT9wVvdDtHAjU9b3b7uB8NR1Gur2hmQCvCDpm39Q+PsJRJPaCU51dEiz+dTzh8qbPsL8WkFljQYFQ==)"';

const SETTINGS: EngineSettings = {
  username: 'swarm',
  password: 'correct horse',
  downloadDir: '/app/data/indexes/swarm',
  uploadLimitBytesPerSec: 5 * 1024 * 1024,
  webUiPort: 8080,
};

/** What the engine image writes when it finds no config. */
const IMAGE_DEFAULT = `[BitTorrent]
Session\\DefaultSavePath=/downloads
Session\\Port=6881
Session\\TempPath=/downloads/temp
Session\\TempPathEnabled=true
[Meta]
MigrationVersion=9999
[Preferences]
WebUI\\Port=8080
`;

const value = (config: string, key: string) =>
  config
    .split('\n')
    .find((l) => l.startsWith(`${key}=`))
    ?.slice(key.length + 1);

describe('engine config', () => {
  describe('Web UI password', () => {
    it('verifies qBittorrent’s own hash', () => {
      assert.equal(
        webUiPasswordMatches(QBITTORRENT_ADMINADMIN, 'adminadmin'),
        true,
      );
      assert.equal(
        webUiPasswordMatches(QBITTORRENT_ADMINADMIN, 'adminadmim'),
        false,
      );
    });

    it('produces hashes that verify, with a fresh salt each time', () => {
      const a = hashWebUiPassword('pw');
      const b = hashWebUiPassword('pw');
      assert.notEqual(a, b);
      assert.equal(webUiPasswordMatches(a, 'pw'), true);
      assert.equal(webUiPasswordMatches(b, 'pw'), true);
    });

    it('rejects anything that is not a stored hash', () => {
      assert.equal(webUiPasswordMatches('', 'pw'), false);
      assert.equal(webUiPasswordMatches('adminadmin', 'adminadmin'), false);
    });
  });

  describe('renderEngineConfig', () => {
    it('overrides the image defaults that would break the swarm', () => {
      const config = renderEngineConfig(IMAGE_DEFAULT, SETTINGS);
      assert.equal(
        value(config, 'Session\\DefaultSavePath'),
        '/app/data/indexes/swarm',
      );
      assert.equal(value(config, 'Session\\TempPathEnabled'), 'false');
      assert.equal(value(config, 'Session\\QueueingSystemEnabled'), 'false');
      // No ratio or seeding-time limit stops a seeded band.
      for (const limit of [
        'Session\\GlobalMaxRatio',
        'Session\\GlobalMaxSeedingMinutes',
        'Session\\GlobalMaxInactiveSeedingMinutes',
      ]) {
        assert.equal(value(config, limit), '-1', limit);
      }
      assert.equal(value(config, 'Session\\DHTEnabled'), 'true');
      assert.equal(value(config, 'Session\\PeXEnabled'), 'true');
      assert.equal(value(config, 'Session\\LSDEnabled'), 'false');
      assert.equal(value(config, 'TrackerEnabled'), 'false');
      assert.equal(value(config, 'Session\\DisableAutoTMMByDefault'), 'true');
      assert.equal(value(config, 'Session\\GlobalUPSpeedLimit'), '5120');
      assert.equal(value(config, 'WebUI\\Username'), 'swarm');
      assert.equal(
        webUiPasswordMatches(
          value(config, 'WebUI\\Password_PBKDF2')!,
          'correct horse',
        ),
        true,
      );
    });

    it('leaves every line it does not manage alone', () => {
      const config = renderEngineConfig(IMAGE_DEFAULT, SETTINGS);
      assert.equal(value(config, 'Session\\Port'), '6881');
      assert.equal(value(config, 'Session\\TempPath'), '/downloads/temp');
      assert.match(config, /\[Meta\]\nMigrationVersion=9999\n/);
    });

    it('is stable: a second run changes nothing, so the file is not rewritten', () => {
      const once = renderEngineConfig(IMAGE_DEFAULT, SETTINGS);
      assert.equal(renderEngineConfig(once, SETTINGS), once);
    });

    it('rehashes when the password changes', () => {
      const once = renderEngineConfig(IMAGE_DEFAULT, SETTINGS);
      const changed = renderEngineConfig(once, {
        ...SETTINGS,
        password: 'new',
      });
      const stored = value(changed, 'WebUI\\Password_PBKDF2')!;
      assert.equal(webUiPasswordMatches(stored, 'new'), true);
      assert.equal(webUiPasswordMatches(stored, 'correct horse'), false);
    });

    it('writes a complete config from nothing', () => {
      const config = renderEngineConfig('', SETTINGS);
      for (const section of [
        '[BitTorrent]',
        '[Network]',
        '[Preferences]',
        '[LegalNotice]',
      ]) {
        assert(config.includes(section), section);
      }
      assert.doesNotMatch(config, /\n\n\n/);
    });

    it('treats an unlimited upload as 0', () => {
      const config = renderEngineConfig('', {
        ...SETTINGS,
        uploadLimitBytesPerSec: 0,
      });
      assert.equal(value(config, 'Session\\GlobalUPSpeedLimit'), '0');
    });
  });

  it('filters private ranges for peers and trackers when given a filter file', () => {
    const on = renderEngineConfig('', {
      ...SETTINGS,
      ipFilterPath: '/config/qBittorrent/private-ranges.dat',
    });
    assert.match(on, /Session\\IPFilteringEnabled=true/);
    assert.match(on, /Session\\TrackerFilteringEnabled=true/);
    assert.match(
      on,
      /Session\\IPFilter=\/config\/qBittorrent\/private-ranges.dat/,
    );
    const off = renderEngineConfig(on, SETTINGS);
    assert.match(off, /Session\\IPFilteringEnabled=false/);
  });

  it('asks for the password on loopback too', () => {
    assert.match(renderEngineConfig('', SETTINGS), /WebUI\\LocalHostAuth=true/);
  });

  it('blocks exactly what the sidecar treats as private', () => {
    // The engine gets these as ranges, the sidecar checks with
    // isPrivateAddress; they must agree, at every edge and just past it.
    // One list per family, as libtorrent keeps them: Node's BlockList
    // would otherwise apply the IPv4-mapped IPv6 range to every IPv4
    // address.
    const lists = { ipv4: new net.BlockList(), ipv6: new net.BlockList() };
    const lines = PRIVATE_RANGES_DAT.split('\n').filter((l) => l !== '');
    const probes: string[] = [];
    const step = (ip: string, by: number): string | undefined => {
      if (!net.isIPv4(ip)) return undefined;
      const n = ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0) + by;
      if (n < 0 || n > 0xffffffff) return undefined;
      return [24, 16, 8, 0]
        .map((sh) => Math.floor(n / 2 ** sh) % 256)
        .join('.');
    };
    for (const line of lines) {
      const [start, end] = line
        .split(',')[0]
        .split(' - ')
        .map((x) => x.trim());
      const family = net.isIPv6(start) ? 'ipv6' : 'ipv4';
      lists[family].addRange(start, end, family);
      probes.push(start, end);
      for (const p of [step(start, -1), step(end, 1)]) {
        if (p !== undefined) probes.push(p);
      }
    }
    // Known private addresses, so a range missing from the file shows too.
    probes.push(
      '10.20.30.40',
      '100.100.1.1',
      '127.1.2.3',
      '169.254.9.9',
      '172.20.0.1',
      '192.168.200.1',
      '224.0.0.1',
      '0.1.2.3',
      '::1',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      'feb0::1',
      'ff02::1',
      // And public ones.
      '8.8.8.8',
      '1.1.1.1',
      '2001:db8::1',
      '2606:4700::1111',
    );
    for (const ip of probes) {
      const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
      assert.equal(lists[family].check(ip, family), isPrivateAddress(ip), ip);
    }
  });
});
