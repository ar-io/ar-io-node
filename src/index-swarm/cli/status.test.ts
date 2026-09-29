/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  engineChecks,
  parseMetrics,
  publisherChecks,
  subscriberChecks,
} from './status.js';

const TURBO = '34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5';

const sidecar = parseMetrics(`
# HELP index_swarm_installed_bands x
index_swarm_installed_bands{index="root-tx-index"} 5
index_subscription_sequence{publisher="${TURBO}",index="root-tx-index"} 11
index_subscription_manifest_age_seconds{publisher="${TURBO}",index="root-tx-index"} 7200
index_subscription_total{publisher="${TURBO}",index="root-tx-index",transport="torrent",result="installed"} 2
index_swarm_upload_today_bytes 42000000
index_swarm_upload_throttled 0
index_publish_bands{index="root-tx-index"} 3
index_publish_seeding_bands{index="root-tx-index"} 3
`);

const gateway = (extra = '') =>
  parseMetrics(`
cdb64_root_tx_index_readers{source="data/indexes/installed/root-tx-index",release="84"} 5
root_tx_lookup_total{source="cdb64",status="found",has_offsets="true",has_size="true",release="84"} 30
root_tx_lookup_total{source="cdb64",status="not_found",has_offsets="false",has_size="false",release="84"} 70
${extra}`);

const levels = (checks: Array<{ level: string }>) => checks.map((c) => c.level);

describe('parseMetrics', () => {
  it('reads names, labels and values, skipping comments', () => {
    const [sample] = parseMetrics('# x\nfoo{a="1",b="q\\"x"} 2.5\n');
    assert.deepEqual(sample, {
      name: 'foo',
      labels: { a: '1', b: 'q"x' },
      value: 2.5,
    });
  });
});

describe('subscriberChecks', () => {
  it('is all ok when bands are installed, loaded and answering', () => {
    const checks = subscriberChecks(
      sidecar,
      gateway(),
      [{ publisher: TURBO }],
      19e9,
    );
    assert.deepEqual(levels(checks), ['ok', 'ok', 'ok', 'ok']);
    assert.match(checks[0].text, /sequence 11, published 2\.0 h ago/);
    assert.match(checks[1].text, /5 bands installed \(19\.0 GB\)/);
    assert.match(checks[3].text, /found 30 of 100/);
  });

  it('fails when the gateway does not read the installed directory, and says how to fix it', () => {
    const checks = subscriberChecks(
      sidecar,
      parseMetrics('root_tx_lookup_total{source="gateways",status="found"} 9'),
      [{ publisher: TURBO }],
      undefined,
    );
    const failed = checks.find((c) => c.level === 'fail');
    assert.match(failed?.text ?? '', /does not read/);
    assert.match(failed?.fix ?? '', /index-swarm-setup --restart/);
  });

  it('warns when lookups never reach the bands', () => {
    const noCdb = parseMetrics(`
cdb64_root_tx_index_readers{source="data/indexes/installed/root-tx-index"} 5
root_tx_lookup_total{source="gateways",status="found"} 9`);
    const checks = subscriberChecks(
      sidecar,
      noCdb,
      [{ publisher: TURBO }],
      undefined,
    );
    assert.match(checks.at(-1)?.text ?? '', /never asks the installed bands/);
    assert.equal(checks.at(-1)?.level, 'warn');
  });

  it('fails on a security-relevant subscription result', () => {
    const bad = [
      ...sidecar,
      ...parseMetrics(
        `index_subscription_total{publisher="${TURBO}",index="root-tx-index",transport="http",result="signature_failed"} 1`,
      ),
    ];
    assert.ok(
      subscriberChecks(bad, gateway(), [{ publisher: TURBO }], undefined).some(
        (c) => c.level === 'fail' && /signature_failed/.test(c.text),
      ),
    );
  });

  it('warns when bands were skipped for the disk budget, and says how to raise it', () => {
    const skipped = [
      ...sidecar,
      ...parseMetrics(
        `index_subscription_total{publisher="${TURBO}",index="root-tx-index",transport="http",result="skipped_disk_budget"} 3`,
      ),
    ];
    const warning = subscriberChecks(
      skipped,
      gateway(),
      [{ publisher: TURBO }],
      undefined,
      25 * 1024 ** 3,
    ).find((c) => /exceed INDEX_SWARM_MAX_DISK_BYTES/.test(c.text));
    assert.equal(warning?.level, 'warn');
    assert.match(warning?.text ?? '', /skipped 3 times/);
    assert.match(warning?.text ?? '', /\(26\.8 GB\)/);
    assert.match(warning?.fix ?? '', /--max-disk-gib <n> --restart/);
  });

  it('warns when installed bands fill most of the disk budget, and not before', () => {
    const near = subscriberChecks(
      sidecar,
      gateway(),
      [{ publisher: TURBO }],
      23e9,
      25 * 1024 ** 3,
    );
    const warning = near.find((c) => /of the .* budget/.test(c.text));
    assert.equal(warning?.level, 'warn');
    assert.match(warning?.text ?? '', /23\.0 GB of the 26\.8 GB/);

    const roomy = subscriberChecks(
      sidecar,
      gateway(),
      [{ publisher: TURBO }],
      23e9,
      50 * 1024 ** 3,
    );
    assert.deepEqual(levels(roomy), ['ok', 'ok', 'ok', 'ok']);
  });

  it('warns, not fails, before the first publication', () => {
    const checks = subscriberChecks(
      [],
      gateway(),
      [{ publisher: 'x'.repeat(43) }],
      undefined,
    );
    assert.equal(checks[0].level, 'warn');
    assert.match(checks[0].text, /no publication accepted yet/);
  });
});

describe('publisherChecks', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');

  it('reports sequence, expiry and seeding', () => {
    const checks = publisherChecks(
      sidecar,
      { sequence: 12, expiresAt: '2026-09-28T08:00:00Z' },
      now,
    );
    assert.deepEqual(levels(checks), ['ok', 'ok']);
    assert.match(
      checks[0].text,
      /sequence 12 with 3 bands, expires in 20\.0 h/,
    );
  });

  it('fails on an expired or missing document', () => {
    assert.equal(
      publisherChecks(
        sidecar,
        { sequence: 1, expiresAt: '2026-09-27T11:00:00Z' },
        now,
      )[0].level,
      'fail',
    );
    assert.equal(publisherChecks(sidecar, undefined, now)[0].level, 'fail');
  });
});

describe('engineChecks', () => {
  it('reports reachability from what the engine says of itself', () => {
    const connected = engineChecks(
      sidecar,
      { available: true, torrents: 7, connection: 'connected' },
      6881,
      1e11,
    );
    assert.deepEqual(levels(connected), ['ok', 'ok', 'ok']);
    assert.match(connected[2].text, /42\.0 MB today of 100\.0 GB/);
    const firewalled = engineChecks(
      sidecar,
      { available: true, torrents: 7, connection: 'firewalled' },
      6881,
      1e11,
    );
    assert.equal(firewalled[1].level, 'warn');
    assert.match(firewalled[1].fix ?? '', /Open 6881 TCP and UDP/);
  });

  it('fails, with the command to start it, when the engine is down', () => {
    const [check] = engineChecks(sidecar, { available: false }, 6881, 1e11);
    assert.equal(check.level, 'fail');
    assert.match(check.fix ?? '', /index-swarm-engine-init index-swarm-engine/);
  });
});
