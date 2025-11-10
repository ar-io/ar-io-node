/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import * as path from 'node:path';

interface TestReleaseOptions {
  releaseNumber: string;
  noCleanup: boolean;
  profile?: string;
}

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  containers?: string[];
}

class ReleaseTester {
  private git = simpleGit();
  private rootDir: string;
  private options: TestReleaseOptions;
  private testResults: TestResult[] = [];

  constructor(options: TestReleaseOptions) {
    this.rootDir = path.resolve(process.cwd());
    this.options = options;
  }

  async testRelease(): Promise<void> {
    console.log(`🧪 Testing release ${this.options.releaseNumber}...\n`);

    try {
      await this.validatePreConditions();

      if (this.options.profile) {
        await this.testSpecificProfile(this.options.profile);
      } else {
        await this.testDefaultProfile();
        await this.testClickhouseProfile();
        await this.testLitestreamProfile();
        await this.testOtelProfile();
        await this.testAOProfile();
      }

      if (!this.options.noCleanup) {
        await this.cleanup();
      }

      await this.displaySummary();

    } catch (error) {
      console.error(`\n❌ Error testing release: ${error}`);
      if (!this.options.noCleanup) {
        console.log('🧹 Cleaning up...');
        await this.cleanup();
      }
      throw error;
    }
  }

  private async validatePreConditions(): Promise<void> {
    console.log('🔍 Validating preconditions...');

    // Check if on develop branch
    const currentBranch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
    if (currentBranch.trim() !== 'develop') {
      throw new Error(`Must be on develop branch (currently on: ${currentBranch.trim()})`);
    }

    // Validate release number format
    if (!/^\d+$/.test(this.options.releaseNumber)) {
      throw new Error('Release number must be a positive integer');
    }

    // Check current version matches release number
    const currentVersion = await this.getCurrentVersion();
    if (currentVersion !== this.options.releaseNumber) {
      throw new Error(`Current version (${currentVersion}) should be ${this.options.releaseNumber}`);
    }

    // Check docker-compose.yaml has specific image SHAs (not "latest")
    const hasSpecificSHAs = await this.checkImageSHAs();
    if (!hasSpecificSHAs) {
      throw new Error('docker-compose.yaml should have specific image SHAs, not "latest". Run finalize-release first.');
    }

    // Check Docker is running
    try {
      await this.executeCommand('docker info > /dev/null 2>&1');
    } catch (error) {
      throw new Error('Docker is not running or accessible');
    }

    console.log('✅ Preconditions validated');
  }

  private async getCurrentVersion(): Promise<string> {
    try {
      const versionFile = path.join(this.rootDir, 'src/version.ts');
      const content = await readFile(versionFile, 'utf-8');
      const match = content.match(/export const release = '([^']+)'/);
      return match?.[1] ?? 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  private async checkImageSHAs(): Promise<boolean> {
    try {
      const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
      const content = await readFile(dockerComposeFile, 'utf-8');

      // Check that core images are not using "latest"
      const coreImagePatterns = [
        /ENVOY_IMAGE_TAG:-([^}]+)/,
        /CORE_IMAGE_TAG:-([^}]+)/,
        /CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG:-([^}]+)/,
        /LITESTREAM_IMAGE_TAG:-([^}]+)/
      ];

      for (const pattern of coreImagePatterns) {
        const match = content.match(pattern);
        if (!match || match[1] === 'latest') {
          return false;
        }
        // Check if it looks like a git SHA (40 hex chars)
        if (!/^[a-f0-9]{40}$/.test(match[1])) {
          return false;
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  private async testSpecificProfile(profile: string): Promise<void> {
    console.log(`🧪 Testing ${profile} profile only...\n`);

    switch (profile) {
      case 'default':
        await this.testDefaultProfile();
        break;
      case 'clickhouse':
        await this.testClickhouseProfile();
        break;
      case 'litestream':
        await this.testLitestreamProfile();
        break;
      case 'otel':
        await this.testOtelProfile();
        break;
      case 'ao':
        await this.testAOProfile();
        break;
      default:
        throw new Error(`Unknown profile: ${profile}. Use: default, clickhouse, litestream, otel, ao`);
    }
  }

  private async testDefaultProfile(): Promise<void> {
    console.log('🔧 Testing default profile...');

    try {
      // Clean start
      await this.executeCommand('docker compose down > /dev/null 2>&1');

      // Start default profile
      console.log('  Starting containers...');
      await this.executeCommand('docker compose up -d');

      // Wait for containers to stabilize
      await this.waitWithProgress(30, 'Waiting for containers to stabilize');

      // Check core containers are running
      const runningContainers = await this.getRunningContainers();
      const requiredContainers = ['envoy', 'core', 'redis', 'observer'];
      const coreRunning = requiredContainers.filter(name =>
        runningContainers.some(container => container.includes(name))
      );

      if (coreRunning.length === requiredContainers.length) {
        console.log('  ✅ All core containers running');

        // Wait a bit more and check they're still running (not restarting)
        await this.sleep(15000);
        const stillRunning = await this.getRunningContainers();
        const stillRunningCore = requiredContainers.filter(name =>
          stillRunning.some(container => container.includes(name))
        );

        if (stillRunningCore.length === requiredContainers.length) {
          this.testResults.push({
            name: 'Default Profile',
            success: true,
            message: 'All core containers started and remained running',
            containers: coreRunning
          });
          console.log('  ✅ Containers remain stable');
        } else {
          throw new Error(`Some containers stopped running: missing ${requiredContainers.filter(name => !stillRunningCore.includes(name)).join(', ')}`);
        }
      } else {
        throw new Error(`Missing core containers: ${requiredContainers.filter(name => !coreRunning.includes(name)).join(', ')}`);
      }

    } catch (error) {
      this.testResults.push({
        name: 'Default Profile',
        success: false,
        message: `Failed: ${error}`
      });
      console.log(`  ❌ Failed: ${error}`);
    } finally {
      // Clean up after test
      await this.executeCommand('docker compose down > /dev/null 2>&1');
    }
  }

  private async testClickhouseProfile(): Promise<void> {
    console.log('🔧 Testing clickhouse profile...');

    try {
      // Clean start
      await this.executeCommand('docker compose down > /dev/null 2>&1');

      // Start clickhouse profile
      console.log('  Starting containers with clickhouse profile...');
      await this.executeCommand('docker compose --profile clickhouse up -d');

      // Wait for containers to stabilize
      await this.waitWithProgress(45, 'Waiting for clickhouse containers to stabilize');

      // Check containers are running
      const runningContainers = await this.getRunningContainers();
      const requiredContainers = ['envoy', 'core', 'redis', 'observer', 'clickhouse', 'clickhouse-auto-import'];
      const allRunning = requiredContainers.filter(name =>
        runningContainers.some(container => container.includes(name))
      );

      if (allRunning.length === requiredContainers.length) {
        this.testResults.push({
          name: 'Clickhouse Profile',
          success: true,
          message: 'All containers started successfully',
          containers: allRunning
        });
        console.log('  ✅ All containers running including clickhouse services');
      } else {
        throw new Error(`Missing containers: ${requiredContainers.filter(name => !allRunning.includes(name)).join(', ')}`);
      }

    } catch (error) {
      this.testResults.push({
        name: 'Clickhouse Profile',
        success: false,
        message: `Failed: ${error}`
      });
      console.log(`  ❌ Failed: ${error}`);
    } finally {
      // Clean up after test
      await this.executeCommand('docker compose --profile clickhouse down > /dev/null 2>&1');
    }
  }

  private async testLitestreamProfile(): Promise<void> {
    console.log('🔧 Testing litestream profile...');

    try {
      // Clean start
      await this.executeCommand('docker compose down > /dev/null 2>&1');

      // Start litestream profile
      console.log('  Starting containers with litestream profile...');
      await this.executeCommand('docker compose --profile litestream up -d');

      // Wait for containers to stabilize
      await this.waitWithProgress(30, 'Waiting for litestream containers to stabilize');

      // Check core containers are running (litestream may exit if S3 not configured)
      const runningContainers = await this.getRunningContainers();
      const coreContainers = ['envoy', 'core', 'redis', 'observer'];
      const coreRunning = coreContainers.filter(name =>
        runningContainers.some(container => container.includes(name))
      );

      if (coreRunning.length === coreContainers.length) {
        // Check if litestream container exists (may have exited)
        const allContainers = await this.getAllContainers();
        const litestreamExists = allContainers.some(container => container.includes('litestream'));

        if (litestreamExists) {
          this.testResults.push({
            name: 'Litestream Profile',
            success: true,
            message: 'Core containers running, litestream container created (may have exited due to S3 config)',
            containers: [...coreRunning, 'litestream']
          });
          console.log('  ✅ Core containers running, litestream container created');
        } else {
          throw new Error('Litestream container was not created');
        }
      } else {
        throw new Error(`Missing core containers: ${coreContainers.filter(name => !coreRunning.includes(name)).join(', ')}`);
      }

    } catch (error) {
      this.testResults.push({
        name: 'Litestream Profile',
        success: false,
        message: `Failed: ${error}`
      });
      console.log(`  ❌ Failed: ${error}`);
    } finally {
      // Clean up after test
      await this.executeCommand('docker compose --profile litestream down > /dev/null 2>&1');
    }
  }

  private async testOtelProfile(): Promise<void> {
    console.log('🔧 Testing otel profile...');

    try {
      // Clean start
      await this.executeCommand('docker compose down > /dev/null 2>&1');

      // Start otel profile
      console.log('  Starting containers with otel profile...');
      await this.executeCommand('docker compose --profile otel up -d');

      // Wait for containers to stabilize
      await this.waitWithProgress(30, 'Waiting for otel containers to stabilize');

      // Check core containers are running
      const runningContainers = await this.getRunningContainers();
      const coreContainers = ['envoy', 'core', 'redis', 'observer'];
      const coreRunning = coreContainers.filter(name =>
        runningContainers.some(container => container.includes(name))
      );

      if (coreRunning.length === coreContainers.length) {
        // Check if otel-collector container exists (may have exited due to missing config)
        const allContainers = await this.getAllContainers();
        const otelCollectorExists = allContainers.some(container => container.includes('otel-collector'));

        if (otelCollectorExists) {
          this.testResults.push({
            name: 'OTEL Profile',
            success: true,
            message: 'Core containers running, OTEL collector container created (may have exited due to missing endpoint config)',
            containers: [...coreRunning, 'otel-collector']
          });
          console.log('  ✅ Core containers running, OTEL collector container created');
        } else {
          throw new Error('OTEL collector container was not created');
        }
      } else {
        throw new Error(`Missing core containers: ${coreContainers.filter(name => !coreRunning.includes(name)).join(', ')}`);
      }

    } catch (error) {
      this.testResults.push({
        name: 'OTEL Profile',
        success: false,
        message: `Failed: ${error}`
      });
      console.log(`  ❌ Failed: ${error}`);
    } finally {
      // Clean up after test
      await this.executeCommand('docker compose --profile otel down > /dev/null 2>&1');
    }
  }

  private async testAOProfile(): Promise<void> {
    console.log('🔧 Testing AO integration...');

    try {
      // Start base containers first
      await this.executeCommand('docker compose down > /dev/null 2>&1');
      await this.executeCommand('docker compose up -d');

      // Wait a bit for base containers
      await this.sleep(15000);

      // Add AO containers
      console.log('  Adding AO containers...');
      await this.executeCommand('docker compose -f docker-compose.yaml -f docker-compose.ao.yaml up -d');

      // Wait for AO containers to stabilize
      await this.waitWithProgress(30, 'Waiting for AO containers to stabilize');

      // Check containers are running
      const runningContainers = await this.getRunningContainers();
      const coreContainers = ['envoy', 'core', 'redis', 'observer'];
      const coreRunning = coreContainers.filter(name =>
        runningContainers.some(container => container.includes(name))
      );

      // Check if ao-cu container exists (may restart if not configured)
      const allContainers = await this.getAllContainers();
      const aoCuExists = allContainers.some(container => container.includes('ao-cu'));

      if (coreRunning.length === coreContainers.length && aoCuExists) {
        this.testResults.push({
          name: 'AO Integration',
          success: true,
          message: 'Core containers running, AO CU container created (may restart due to config)',
          containers: [...coreRunning, 'ao-cu']
        });
        console.log('  ✅ Core containers running, AO CU container created');
      } else {
        const issues = [];
        if (coreRunning.length !== coreContainers.length) {
          issues.push(`Missing core containers: ${coreContainers.filter(name => !coreRunning.includes(name)).join(', ')}`);
        }
        if (!aoCuExists) {
          issues.push('AO CU container not created');
        }
        throw new Error(issues.join('; '));
      }

    } catch (error) {
      this.testResults.push({
        name: 'AO Integration',
        success: false,
        message: `Failed: ${error}`
      });
      console.log(`  ❌ Failed: ${error}`);
    } finally {
      // Clean up after test
      await this.executeCommand('docker compose -f docker-compose.yaml -f docker-compose.ao.yaml down > /dev/null 2>&1');
    }
  }

  private async getRunningContainers(): Promise<string[]> {
    try {
      const result = await this.executeCommand('docker ps --format "{{.Names}}"');
      return result.trim().split('\n').filter(name => name.length > 0);
    } catch (error) {
      return [];
    }
  }

  private async getAllContainers(): Promise<string[]> {
    try {
      const result = await this.executeCommand('docker ps -a --format "{{.Names}}"');
      return result.trim().split('\n').filter(name => name.length > 0);
    } catch (error) {
      return [];
    }
  }

  private async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up containers...');
    try {
      await this.executeCommand('docker compose -f docker-compose.yaml -f docker-compose.ao.yaml down > /dev/null 2>&1');
      console.log('✅ Cleanup completed');
    } catch (error) {
      console.log('⚠️  Cleanup had some issues (containers may still be running)');
    }
  }

  private async displaySummary(): Promise<void> {
    console.log('\n📊 Test Results Summary');
    console.log('========================');

    const successful = this.testResults.filter(r => r.success);
    const failed = this.testResults.filter(r => !r.success);

    for (const result of this.testResults) {
      const status = result.success ? '✅' : '❌';
      console.log(`${status} ${result.name}: ${result.message}`);
      if (result.containers) {
        console.log(`   Containers: ${result.containers.join(', ')}`);
      }
    }

    console.log(`\nOverall: ${successful.length}/${this.testResults.length} tests passed`);

    if (failed.length > 0) {
      console.log('\n⚠️  Some tests failed. Review the issues above before proceeding with the release.');
      process.exit(1);
    } else {
      console.log('\n🎉 All tests passed! Release is ready for tagging and deployment.');
    }
  }

  private async waitWithProgress(seconds: number, message: string): Promise<void> {
    process.stdout.write(`  ${message}`);
    for (let i = 0; i < seconds; i++) {
      await this.sleep(1000);
      process.stdout.write('.');
    }
    console.log(' Done');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async executeCommand(command: string): Promise<string> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(command);
    return stdout;
  }
}

function printUsage(): void {
  console.log('Usage: test-release <release-number> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --no-cleanup         Keep containers running after tests');
  console.log('  --profile <name>     Test specific profile only (default, clickhouse, litestream, otel, ao)');
  console.log('  --help, -h           Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  test-release 52');
  console.log('  test-release 52 --no-cleanup');
  console.log('  test-release 52 --profile clickhouse');
  console.log('');
  console.log('This script tests all docker compose profiles to verify:');
  console.log('- Containers start properly with finalized image SHAs');
  console.log('- Core services remain stable');
  console.log('- All profiles work as expected');
  console.log('- Release is ready for final tagging');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  if (args.length === 0) {
    console.error('❌ Error: Release number is required');
    printUsage();
    process.exit(1);
  }

  const releaseNumber = args[0];
  const noCleanup = args.includes('--no-cleanup');
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex !== -1 && profileIndex + 1 < args.length ? args[profileIndex + 1] : undefined;

  const tester = new ReleaseTester({ releaseNumber, noCleanup, profile });
  await tester.testRelease();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}