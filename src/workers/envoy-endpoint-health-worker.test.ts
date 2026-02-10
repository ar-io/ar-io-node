/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

import { EnvoyEndpointHealthWorker } from './envoy-endpoint-health-worker.js';
import { createTestLogger } from '../../test/test-logger.js';

describe('EnvoyEndpointHealthWorker', () => {
  let log: ReturnType<typeof createTestLogger>;
  let edsDirectory: string;
  let chainIndex: { getMaxHeight: () => Promise<number> };

  before(() => {
    log = createTestLogger({ suite: 'EnvoyEndpointHealthWorker' });
  });

  beforeEach(async () => {
    edsDirectory = path.join(
      os.tmpdir(),
      `eds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.promises.mkdir(edsDirectory, { recursive: true });
    chainIndex = { getMaxHeight: mock.fn(async () => 1000) };
  });

  afterEach(async () => {
    mock.restoreAll();
    // Clean up temp directory
    await fs.promises.rm(edsDirectory, { recursive: true, force: true });
  });

  function createWorker(
    overrides: Partial<{
      dnsRecords: string[];
      port: number;
      useTls: boolean;
      maxHeightLag: number;
      maxHeightLead: number;
      minConsensusCount: number;
      fullSyncThreshold: number;
      intervalMs: number;
    }> = {},
  ): EnvoyEndpointHealthWorker {
    return new EnvoyEndpointHealthWorker({
      log,
      chainIndex: chainIndex as any,
      dnsRecords: overrides.dnsRecords ?? ['test.example.com'],
      port: overrides.port ?? 1984,
      useTls: overrides.useTls ?? false,
      maxHeightLag: overrides.maxHeightLag ?? 5,
      maxHeightLead: overrides.maxHeightLead ?? 5,
      minConsensusCount: overrides.minConsensusCount ?? 2,
      fullSyncThreshold: overrides.fullSyncThreshold ?? 100,
      intervalMs: overrides.intervalMs ?? 30000,
      edsDirectory,
    });
  }

  describe('computeReferenceHeight', () => {
    it('should find consensus among majority of nodes', async () => {
      const worker = createWorker({ minConsensusCount: 2, maxHeightLag: 5 });
      chainIndex.getMaxHeight = async () => 0;

      // 3 nodes near 1000, 1 rogue node at 2000
      const peers = [
        { ip: '1.1.1.1', height: 1000, blocks: 1000 },
        { ip: '2.2.2.2', height: 1001, blocks: 1001 },
        { ip: '3.3.3.3', height: 999, blocks: 999 },
        { ip: '4.4.4.4', height: 2000, blocks: 2000 },
      ];

      const height = await worker.computeReferenceHeight(peers);
      // Sorted desc: 2000, 1001, 1000, 999
      // 2000: nodes within 5 of 2000 = just 2000 = 1, not >= 2
      // 1001: nodes within 5 of 1001 = 1001, 1000, 999 = 3, >= 2 ✓
      assert.equal(height, 1001);
    });

    it('should ignore rogue node far ahead', async () => {
      const worker = createWorker({ minConsensusCount: 2, maxHeightLag: 5 });
      chainIndex.getMaxHeight = async () => 0;

      const peers = [
        { ip: '1.1.1.1', height: 100, blocks: 100 },
        { ip: '2.2.2.2', height: 101, blocks: 101 },
        { ip: '3.3.3.3', height: 50000, blocks: 50000 },
      ];

      const height = await worker.computeReferenceHeight(peers);
      // 50000: only 1 node near, 101: 2 nodes (101, 100), consensus = 101
      assert.equal(height, 101);
    });

    it('should fall back to max height when no consensus', async () => {
      const worker = createWorker({ minConsensusCount: 3, maxHeightLag: 1 });
      chainIndex.getMaxHeight = async () => 0;

      // All nodes spread far apart, no group of 3
      const peers = [
        { ip: '1.1.1.1', height: 100, blocks: 100 },
        { ip: '2.2.2.2', height: 200, blocks: 200 },
        { ip: '3.3.3.3', height: 300, blocks: 300 },
      ];

      const height = await worker.computeReferenceHeight(peers);
      assert.equal(height, 300);
    });

    it('should use local chain height when higher than consensus', async () => {
      const worker = createWorker({ minConsensusCount: 2, maxHeightLag: 5 });
      chainIndex.getMaxHeight = async () => 2000;

      const peers = [
        { ip: '1.1.1.1', height: 1000, blocks: 1000 },
        { ip: '2.2.2.2', height: 1001, blocks: 1001 },
      ];

      const height = await worker.computeReferenceHeight(peers);
      assert.equal(height, 2000);
    });
  });

  describe('classifyPeers', () => {
    it('should classify full nodes correctly', () => {
      const worker = createWorker({
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
      });

      const peers = [
        { ip: '1.1.1.1', height: 1000, blocks: 950 }, // blocks >= 1000+1-100=901 → full
      ];

      const result = worker.classifyPeers(peers, 1000);
      assert.equal(result.full.length, 1);
      assert.equal(result.partial.length, 0);
      assert.equal(result.excluded.length, 0);
    });

    it('should classify partial nodes correctly', () => {
      const worker = createWorker({
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
      });

      const peers = [
        { ip: '1.1.1.1', height: 1000, blocks: 500 }, // blocks < 901 → partial
      ];

      const result = worker.classifyPeers(peers, 1000);
      assert.equal(result.full.length, 0);
      assert.equal(result.partial.length, 1);
      assert.equal(result.excluded.length, 0);
    });

    it('should exclude peers too far behind', () => {
      const worker = createWorker({
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
      });

      const peers = [
        { ip: '1.1.1.1', height: 990, blocks: 990 }, // 990 < 1000 - 5 → excluded
      ];

      const result = worker.classifyPeers(peers, 1000);
      assert.equal(result.full.length, 0);
      assert.equal(result.partial.length, 0);
      assert.equal(result.excluded.length, 1);
    });

    it('should exclude peers too far ahead', () => {
      const worker = createWorker({
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
      });

      const peers = [
        { ip: '1.1.1.1', height: 1010, blocks: 1010 }, // 1010 > 1000 + 5 → excluded
      ];

      const result = worker.classifyPeers(peers, 1000);
      assert.equal(result.full.length, 0);
      assert.equal(result.partial.length, 0);
      assert.equal(result.excluded.length, 1);
    });

    it('should accept peers at boundary heights', () => {
      const worker = createWorker({
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
      });

      const peers = [
        { ip: '1.1.1.1', height: 995, blocks: 950 }, // exactly at lower boundary
        { ip: '2.2.2.2', height: 1005, blocks: 960 }, // exactly at upper boundary
      ];

      const result = worker.classifyPeers(peers, 1000);
      assert.equal(result.excluded.length, 0);
      assert.equal(result.full.length + result.partial.length, 2);
    });

    it('should classify a mix of peers correctly', () => {
      const worker = createWorker({
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
      });

      const peers = [
        { ip: '1.1.1.1', height: 1000, blocks: 950 }, // full (blocks >= 901)
        { ip: '2.2.2.2', height: 1000, blocks: 500 }, // partial (blocks < 901)
        { ip: '3.3.3.3', height: 990, blocks: 990 }, // excluded (behind)
        { ip: '4.4.4.4', height: 1010, blocks: 1010 }, // excluded (ahead)
      ];

      const result = worker.classifyPeers(peers, 1000);
      assert.equal(result.full.length, 1);
      assert.equal(result.partial.length, 1);
      assert.equal(result.excluded.length, 2);
    });
  });

  describe('EDS JSON output', () => {
    it('should write valid EDS JSON files', async () => {
      const worker = createWorker();

      await worker.writeEdsFiles(
        [
          { address: '1.1.1.1', port: 1984 },
          { address: '2.2.2.2', port: 1984 },
        ],
        [{ address: '3.3.3.3', port: 1984 }],
      );

      const fullContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_full_nodes.json'),
          'utf-8',
        ),
      );

      assert.ok(fullContent.version_info);
      assert.equal(fullContent.resources.length, 1);
      assert.equal(
        fullContent.resources[0]['@type'],
        'type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment',
      );
      assert.equal(fullContent.resources[0].cluster_name, 'arweave_full_nodes');
      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints.length,
        2,
      );
      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints[0].endpoint.address
          .socket_address.address,
        '1.1.1.1',
      );
      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints[0].endpoint.address
          .socket_address.port_value,
        1984,
      );
      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints[0].health_status,
        'HEALTHY',
      );

      const partialContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_partial_nodes.json'),
          'utf-8',
        ),
      );

      assert.equal(
        partialContent.resources[0].cluster_name,
        'arweave_partial_nodes',
      );
      assert.equal(
        partialContent.resources[0].endpoints[0].lb_endpoints.length,
        1,
      );
    });

    it('should write empty endpoint list when no peers of a type', async () => {
      const worker = createWorker();

      await worker.writeEdsFiles(
        [{ address: '1.1.1.1', port: 1984 }],
        [], // no partial nodes
      );

      const partialContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_partial_nodes.json'),
          'utf-8',
        ),
      );

      assert.equal(
        partialContent.resources[0].endpoints[0].lb_endpoints.length,
        0,
      );
    });
  });

  describe('DNS resolution', () => {
    it('should collect unique IPs from multiple DNS records', async () => {
      const worker = createWorker({
        dnsRecords: ['host1.example.com', 'host2.example.com'],
      });

      mock.method(dns.promises, 'resolve4', async (hostname: string) => {
        if (hostname === 'host1.example.com') return ['1.1.1.1', '2.2.2.2'];
        if (hostname === 'host2.example.com') return ['2.2.2.2', '3.3.3.3'];
        return [];
      });

      const ips = await worker.resolveAllDns();
      assert.equal(ips.length, 3);
      assert.ok(ips.includes('1.1.1.1'));
      assert.ok(ips.includes('2.2.2.2'));
      assert.ok(ips.includes('3.3.3.3'));
    });

    it('should continue when one DNS record fails', async () => {
      const worker = createWorker({
        dnsRecords: ['good.example.com', 'bad.example.com'],
      });

      mock.method(dns.promises, 'resolve4', async (hostname: string) => {
        if (hostname === 'good.example.com') return ['1.1.1.1'];
        throw new Error('DNS resolution failed');
      });

      const ips = await worker.resolveAllDns();
      assert.equal(ips.length, 1);
      assert.equal(ips[0], '1.1.1.1');
    });

    it('should return empty array when all DNS resolution fails', async () => {
      const worker = createWorker({
        dnsRecords: ['bad1.example.com', 'bad2.example.com'],
      });

      mock.method(dns.promises, 'resolve4', async () => {
        throw new Error('DNS resolution failed');
      });

      const ips = await worker.resolveAllDns();
      assert.equal(ips.length, 0);
    });
  });

  describe('graceful degradation', () => {
    it('should retain previous EDS files when DNS fails completely', async () => {
      const worker = createWorker({
        dnsRecords: ['bad.example.com'],
      });

      // Write initial files
      await worker.writeEdsFiles(
        [{ address: '1.1.1.1', port: 1984 }],
        [{ address: '2.2.2.2', port: 1984 }],
      );

      // Mock DNS failure
      mock.method(dns.promises, 'resolve4', async () => {
        throw new Error('DNS resolution failed');
      });

      // Run cycle - should not overwrite files
      await worker.runCycle();

      // Verify files still have the original content
      const fullContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_full_nodes.json'),
          'utf-8',
        ),
      );
      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints[0].endpoint.address
          .socket_address.address,
        '1.1.1.1',
      );
    });

    it('should retain previous EDS files when all health checks fail', async () => {
      const worker = createWorker({
        dnsRecords: ['test.example.com'],
      });

      // Write initial files
      await worker.writeEdsFiles(
        [{ address: '1.1.1.1', port: 1984 }],
        [{ address: '2.2.2.2', port: 1984 }],
      );

      // Mock DNS success but health check failure
      mock.method(dns.promises, 'resolve4', async () => ['3.3.3.3']);

      // Mock fetch to fail
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('Connection refused');
      });

      await worker.runCycle();

      // Verify files still have the original content
      const fullContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_full_nodes.json'),
          'utf-8',
        ),
      );
      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints[0].endpoint.address
          .socket_address.address,
        '1.1.1.1',
      );
    });
  });

  describe('full runCycle', () => {
    it('should resolve DNS, health check, classify, and write EDS files', async () => {
      const worker = createWorker({
        dnsRecords: ['test.example.com'],
        maxHeightLag: 5,
        maxHeightLead: 5,
        fullSyncThreshold: 100,
        minConsensusCount: 2,
      });
      chainIndex.getMaxHeight = async () => 0;

      mock.method(dns.promises, 'resolve4', async () => [
        '1.1.1.1',
        '2.2.2.2',
        '3.3.3.3',
      ]);

      mock.method(globalThis, 'fetch', async (url: string) => {
        const ip = new URL(url).hostname;
        const data: Record<string, { height: number; blocks: number }> = {
          '1.1.1.1': { height: 1000, blocks: 950 }, // full
          '2.2.2.2': { height: 1001, blocks: 500 }, // partial
          '3.3.3.3': { height: 1000, blocks: 980 }, // full
        };
        return {
          ok: true,
          json: async () => data[ip],
        };
      });

      await worker.runCycle();

      const fullContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_full_nodes.json'),
          'utf-8',
        ),
      );
      const partialContent = JSON.parse(
        await fs.promises.readFile(
          path.join(edsDirectory, 'arweave_partial_nodes.json'),
          'utf-8',
        ),
      );

      assert.equal(
        fullContent.resources[0].endpoints[0].lb_endpoints.length,
        2,
      );
      assert.equal(
        partialContent.resources[0].endpoints[0].lb_endpoints.length,
        1,
      );
    });
  });
});
