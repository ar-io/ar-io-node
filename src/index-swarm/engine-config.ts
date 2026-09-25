/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The qBittorrent settings the index swarm depends on, and how they are
 * written into the engine's configuration file.
 *
 * The engine is an upstream image. It has no environment variable for a Web
 * UI password, and without one it invents a temporary password on every
 * start, which nothing else can know. So a one-shot init container writes
 * these settings before each engine start. Only the keys listed here are
 * managed; everything else in the file, including what qBittorrent writes
 * itself, is left alone, so an operator's own tuning survives.
 *
 * Every managed setting has its reason recorded next to it: each is either
 * something measured on real engines or a default that would quietly break
 * the swarm.
 */
import crypto from 'node:crypto';

export interface EngineSettings {
  username: string;
  password: string;
  /** Where downloads land; the only directory the engine may write data to. */
  downloadDir: string;
  /** Upload cap in bytes per second; 0 is unlimited. */
  uploadLimitBytesPerSec: number;
  /** Web UI port inside the container. The sidecar must use this exact port. */
  webUiPort: number;
}

/** qBittorrent's PBKDF2 parameters for the Web UI password. */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES = 64;
const PBKDF2_SALT_BYTES = 16;

/** The `@ByteArray(salt:key)` value qBittorrent stores for a password. */
export function hashWebUiPassword(
  password: string,
  salt: Buffer = crypto.randomBytes(PBKDF2_SALT_BYTES),
): string {
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_BYTES,
    'sha512',
  );
  return `"@ByteArray(${salt.toString('base64')}:${key.toString('base64')})"`;
}

/** Whether a stored `@ByteArray(...)` value is the hash of `password`. */
export function webUiPasswordMatches(
  stored: string,
  password: string,
): boolean {
  const match = /^"?@ByteArray\(([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)\)"?$/.exec(
    stored.trim(),
  );
  if (match === null) return false;
  const salt = Buffer.from(match[1], 'base64');
  const expected = Buffer.from(match[2], 'base64');
  const actual = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    expected.length,
    'sha512',
  );
  return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}

/**
 * The managed keys, by section. Values are written verbatim, in the form
 * qBittorrent itself writes them.
 */
export function managedSettings(
  settings: EngineSettings,
  passwordValue: string,
): Record<string, Record<string, string>> {
  return {
    BitTorrent: {
      // DHT and peer exchange let peers find one another without the
      // publisher's tracker, which matters when that tracker restarts and
      // forgets its peers. Local service discovery stays off: it broadcasts
      // on the local network, which on a hosted server helps nobody.
      'Session\\DHTEnabled': 'true',
      'Session\\LSDEnabled': 'false',
      'Session\\PeXEnabled': 'true',
      // qBittorrent's queue lets only a handful of torrents be active at
      // once. A gateway seeds every band it holds, so a queue would silently
      // leave most of them unseeded.
      'Session\\QueueingSystemEnabled': 'false',
      // Downloads land in swarm/ and nowhere else. The image's default
      // config sends partial files to a temp path outside the mounts.
      'Session\\DefaultSavePath': settings.downloadDir,
      'Session\\TempPathEnabled': 'false',
      // Automatic management would move files to the default save path,
      // which for a seeded band means moving it out of published/.
      'Session\\DisableAutoTMMByDefault': 'true',
      'Session\\AddTorrentStopped': 'false',
      // qBittorrent's embedded tracker tracks any infohash anyone announces,
      // which on a published port would make the gateway a public tracker
      // for arbitrary swarms. Pinned off; the sidecar runs a closed one.
      TrackerEnabled: 'false',
      // KiB/s in the file; the setting is in bytes for the operator.
      'Session\\GlobalUPSpeedLimit': String(
        Math.ceil(settings.uploadLimitBytesPerSec / 1024),
      ),
    },
    Network: {
      PortForwardingEnabled: 'false',
    },
    Preferences: {
      'WebUI\\Port': String(settings.webUiPort),
      'WebUI\\Username': settings.username,
      'WebUI\\Password_PBKDF2': passwordValue,
      // The allowlist would exempt a whole subnet from the password; the
      // compose network is shared with the gateway and everything else.
      'WebUI\\AuthSubnetWhitelistEnabled': 'false',
      // Only the container's own healthcheck reaches the API over loopback;
      // it runs without the password.
      'WebUI\\LocalHostAuth': 'false',
      'WebUI\\UseUPnP': 'false',
    },
    LegalNotice: {
      Accepted: 'true',
    },
  };
}

interface IniSection {
  name: string;
  lines: string[];
}

function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [{ name: '', lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header !== null) {
      sections.push({ name: header[1], lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

const keyOf = (line: string): string | undefined => {
  const eq = line.indexOf('=');
  return eq > 0 ? line.slice(0, eq) : undefined;
};

/**
 * Merge the managed settings into an existing qBittorrent.conf, leaving
 * every other line exactly as it was. The password hash is kept when it
 * already matches, so an unchanged credential does not rewrite the file.
 */
export function renderEngineConfig(
  existing: string,
  settings: EngineSettings,
): string {
  const sections = parseIni(existing);
  const find = (name: string) => sections.find((s) => s.name === name);

  const stored = find('Preferences')
    ?.lines.find((l) => keyOf(l) === 'WebUI\\Password_PBKDF2')
    ?.slice('WebUI\\Password_PBKDF2='.length);
  const passwordValue =
    stored !== undefined && webUiPasswordMatches(stored, settings.password)
      ? stored
      : hashWebUiPassword(settings.password);

  for (const [name, values] of Object.entries(
    managedSettings(settings, passwordValue),
  )) {
    let section = find(name);
    if (section === undefined) {
      section = { name, lines: [] };
      sections.push(section);
    }
    const lines = section.lines;
    for (const [key, value] of Object.entries(values)) {
      const index = lines.findIndex((l) => keyOf(l) === key);
      const line = `${key}=${value}`;
      if (index >= 0) {
        lines[index] = line;
      } else {
        // Ahead of any trailing blank lines, so none end up mid-section.
        let at = lines.length;
        while (at > 0 && lines[at - 1].trim() === '') at--;
        lines.splice(at, 0, line);
      }
    }
  }

  const out: string[] = [];
  for (const section of sections) {
    const body = [...section.lines];
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    if (section.name === '' && body.length === 0) continue;
    if (section.name !== '') out.push(`[${section.name}]`);
    out.push(...body, '');
  }
  return out.join('\n');
}
