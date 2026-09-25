/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

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

  it('blocks every private range it names', () => {
    for (const range of [
      '10.0.0.0',
      '172.16.0.0',
      '192.168.0.0',
      '127.0.0.0',
      '169.254.0.0',
      '100.64.0.0',
      'fc00::',
    ]) {
      assert.ok(PRIVATE_RANGES_DAT.includes(`${range} - `), range);
    }
  });
});
