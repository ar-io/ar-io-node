#!/usr/bin/env node
/**
 * AR.IO Node Architecture Review Generator
 *
 * Generates a comprehensive code structure analysis document
 * optimized for e-reader consumption (Kindle, etc.)
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

interface FileInfo {
  path: string;
  size: number;
  isTest: boolean;
  lineCount: number;
}

interface DirectoryAnalysis {
  name: string;
  totalFiles: number;
  testFiles: number;
  implFiles: number;
  files: FileInfo[];
  imports: string[];
  exports: string[];
}

interface TypeDefinition {
  name: string;
  type: 'interface' | 'type' | 'class';
  methods?: string[];
  properties?: string[];
}

interface SQLSchema {
  name: string;
  tables: Array<{
    name: string;
    columns: number;
    indexes: string[];
  }>;
  statements: Array<{
    file: string;
    count: number;
    operations: string[];
  }>;
}

class ArchitectureAnalyzer {
  private rootDir: string;
  private output: string[] = [];

  constructor(rootDir: string = '.') {
    this.rootDir = rootDir;
  }

  async generateReport(): Promise<void> {
    console.log('🔍 Analyzing AR.IO Node repository structure...');

    await this.addHeader();
    await this.addDependencyAnalysis();
    await this.addDirectoryStructure();
    await this.addTypeSystemAnalysis();
    await this.addDatabaseSchemas();
    await this.addModuleRelationships();
    await this.addAPIAnalysis();
    await this.addTestCoverageAnalysis();
    await this.addInternalToolsAnalysis();
    await this.addStatistics();

    await this.writeReport();
    console.log('✅ Architecture review generated: architecture-review.md');
  }

  private async addHeader(): Promise<void> {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));

    this.output.push(
      '# AR.IO Node: Code Structure Analysis',
      '',
      `**Generated:** ${new Date().toISOString().split('T')[0]}`,
      `**Version:** ${packageJson.version || 'unknown'}`,
      `**Description:** ${packageJson.description}`,
      '',
      '---',
      '',
      '## Table of Contents',
      '',
      '1. [Repository Overview](#repository-overview)',
      '2. [Directory Structure](#directory-structure)',
      '3. [Type System](#type-system)',
      '4. [Database Schemas](#database-schemas)',
      '5. [Module Relationships](#module-relationships)',
      '6. [API Surface](#api-surface)',
      '7. [Test Coverage](#test-coverage)',
      '8. [Internal Tools](#internal-tools)',
      '9. [Statistics](#statistics)',
      '',
      '---',
      ''
    );
  }

  private async addDependencyAnalysis(): Promise<void> {
    console.log('📦 Analyzing dependencies...');

    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));
    const deps = packageJson.dependencies || {};
    const devDeps = packageJson.devDependencies || {};

    this.output.push(
      '\\newpage',
      '',
      '## Repository Overview',
      '',
      '### Dependencies by Category',
      ''
    );

    const categories = {
      'Arweave/AR.IO': ['@ar.io/', 'arweave', '@dha-team/arbundles', '@permaweb/'],
      'Database': ['better-sqlite3', 'duckdb-async', '@clickhouse/', 'postgres', 'lmdb'],
      'Web Framework': ['express', 'apollo-server', 'cors', 'swagger'],
      'Testing': ['supertest', 'testcontainers', '@cucumber/', 'fast-check'],
      'Build/Dev': ['typescript', 'eslint', 'prettier', '@types/', 'nodemon'],
      'Observability': ['@opentelemetry/', 'winston', 'prom-client'],
      'Utilities': ['ramda', 'lru-cache', 'axios', 'yaml', 'fs-extra']
    };

    for (const [category, patterns] of Object.entries(categories)) {
      const matching = Object.keys(deps).filter(dep =>
        patterns.some(pattern => dep.includes(pattern))
      );

      if (matching.length > 0) {
        this.output.push(`**${category}** (${matching.length} packages):`, '');
        matching.forEach(dep => {
          this.output.push(`- ${dep}`);
        });
        this.output.push('');
      }
    }

    // Add glossary if it exists
    try {
      const glossary = await fs.readFile('docs/glossary.md', 'utf-8');
      const termCount = (glossary.match(/^##[^#]/gm) || []).length;
      this.output.push(
        '### Key Concepts',
        '',
        `📖 **Glossary Terms:** ${termCount} definitions available in \`docs/glossary.md\``,
        '',
        '---',
        ''
      );
    } catch {
      this.output.push('---', '');
    }
  }

  private async addDirectoryStructure(): Promise<void> {
    console.log('📁 Analyzing directory structure...');

    this.output.push(
      '\\newpage',
      '',
      '## Directory Structure',
      '',
      '### Source Code Organization',
      ''
    );

    const srcDirs = await this.getDirectories('src');
    const analysis: DirectoryAnalysis[] = [];

    for (const dir of srcDirs) {
      const dirPath = path.join('src', dir);
      const files = await this.analyzeDirectory(dirPath);
      analysis.push(files);
    }

    // Generate detailed tree view with full file structure
    await this.generateCompleteFileTree();
    this.output.push('');

    // Detailed breakdown
    this.output.push('### Directory Details', '');

    for (const dir of analysis.sort((a, b) => b.implFiles - a.implFiles)) {
      this.output.push(`**${dir.name}/** - ${dir.implFiles} implementation files, ${dir.testFiles} test files`, '');

      if (dir.files.length > 0) {
        const mainFile = dir.files.find(f => f.path.includes('index.ts')) ||
                        dir.files.filter(f => !f.isTest)[0];
        if (mainFile) {
          this.output.push(`- Primary: \`${mainFile.path.split('/').pop()}\``);
          this.output.push('');
        }
      }
    }

    this.output.push('---', '');
  }

  private async addTypeSystemAnalysis(): Promise<void> {
    console.log('🏗️ Analyzing type system...');

    this.output.push(
      '\\newpage',
      '',
      '## Type System',
      '',
      '### Core Type Definitions',
      ''
    );

    try {
      const typesContent = await fs.readFile('src/types.d.ts', 'utf-8');

      // Extract interfaces and types
      const interfaces = this.extractTypeDefinitions(typesContent, 'interface');
      const types = this.extractTypeDefinitions(typesContent, 'type');

      this.output.push(`**Interfaces:** ${interfaces.length} defined`);
      this.output.push(`**Type Aliases:** ${types.length} defined`);
      this.output.push('');

      // Group by category
      const categories = {
        'Arweave Data': interfaces.filter(i => i.name.includes('Block') || i.name.includes('Transaction')),
        'Database': interfaces.filter(i => i.name.includes('Database') || i.name.includes('Store')),
        'Network': interfaces.filter(i => i.name.includes('Peer') || i.name.includes('Client')),
        'Cache': interfaces.filter(i => i.name.includes('Cache') || i.name.includes('Index')),
        'Other': interfaces.filter(i => !['Block', 'Transaction', 'Database', 'Store', 'Peer', 'Client', 'Cache', 'Index'].some(term => i.name.includes(term)))
      };

      for (const [category, items] of Object.entries(categories)) {
        if (items.length > 0) {
          this.output.push(`**${category}:**`, '');
          items.forEach(item => {
            const methodCount = item.methods?.length || 0;
            const propCount = item.properties?.length || 0;
            this.output.push(`- \`${item.name}\``);
            this.output.push(`  - ${methodCount} methods, ${propCount} properties`);
          });
          this.output.push('');
        }
      }

    } catch (error) {
      this.output.push('*Type definitions file not found or not readable*', '');
    }

    this.output.push('---', '');
  }

  private async addDatabaseSchemas(): Promise<void> {
    console.log('🗄️ Analyzing database schemas...');

    this.output.push(
      '\\newpage',
      '',
      '## Database Schemas',
      '',
      '### Schema Files',
      ''
    );

    try {
      const testFiles = await fs.readdir('test');
      const schemaFiles = testFiles.filter(f => f.endsWith('-schema.sql'));

      for (const schemaFile of schemaFiles) {
        const schemaName = schemaFile.replace('-schema.sql', '');
        const content = await fs.readFile(path.join('test', schemaFile), 'utf-8');

        const tables = this.extractTables(content);
        const indexes = this.extractIndexes(content);

        this.output.push(`**${schemaName}.db** - ${tables.length} tables, ${indexes.length} indexes`, '');

        tables.forEach(table => {
          this.output.push(`- \`${table.name}\``);
          this.output.push(`  - ${table.columns} columns`);
        });
        this.output.push('');
      }

      // SQL statements analysis
      this.output.push('### SQL Statements by Schema', '');

      try {
        const sqlDirs = await fs.readdir('src/database/sql');

        for (const sqlDir of sqlDirs) {
          const sqlPath = path.join('src/database/sql', sqlDir);
          const sqlFiles = await fs.readdir(sqlPath);

          let totalStatements = 0;
          const operations = { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0, CREATE: 0 };

          for (const sqlFile of sqlFiles.filter(f => f.endsWith('.sql'))) {
            const content = await fs.readFile(path.join(sqlPath, sqlFile), 'utf-8');
            const statements = content.split('--').filter(s => s.trim().length > 0);
            totalStatements += statements.length;

            // Count operation types
            Object.keys(operations).forEach(op => {
              operations[op as keyof typeof operations] += (content.match(new RegExp(`\\b${op}\\b`, 'gi')) || []).length;
            });
          }

          this.output.push(`**${sqlDir}/**`, '');
          this.output.push(`- ${totalStatements} statements across ${sqlFiles.length} files`);

          const sortedOps = Object.entries(operations)
            .filter(([_, count]) => count > 0)
            .sort(([_, a], [__, b]) => b - a);

          if (sortedOps.length > 0) {
            this.output.push('- Operations:');
            sortedOps.forEach(([op, count]) => {
              this.output.push(`  - ${op}: ${count}`);
            });
          }
          this.output.push('');
        }
      } catch {
        this.output.push('*SQL directory analysis failed*', '');
      }

    } catch (error) {
      this.output.push('*Schema analysis failed*', '');
    }

    this.output.push('---', '');
  }

  private async addModuleRelationships(): Promise<void> {
    console.log('🔗 Analyzing module relationships...');

    this.output.push(
      '## Module Relationships',
      '',
      '### Import Dependencies',
      ''
    );

    // Analyze import patterns
    const modules = await this.getDirectories('src');
    const importMap = new Map<string, string[]>();

    for (const module of modules) {
      const imports = await this.getModuleImports(path.join('src', module));
      importMap.set(module, imports);
    }

    // Find most imported modules
    const importCounts = new Map<string, number>();
    for (const imports of importMap.values()) {
      imports.forEach(imp => {
        importCounts.set(imp, (importCounts.get(imp) || 0) + 1);
      });
    }

    const sortedImports = Array.from(importCounts.entries())
      .sort(([_, a], [__, b]) => b - a)
      .slice(0, 10);

    this.output.push('**Most Imported Modules:**');
    sortedImports.forEach(([module, count]) => {
      this.output.push(`- \`${module}\`: imported by ${count} modules`);
    });
    this.output.push('');

    // Dependency tree for key modules
    this.output.push('**Key Dependency Chains:**', '');
    this.output.push('```');
    this.output.push('app.ts');
    this.output.push('├─> routes/');
    this.output.push('│   ├─> middleware/');
    this.output.push('│   ├─> store/');
    this.output.push('│   └─> database/');
    this.output.push('├─> workers/');
    this.output.push('│   └─> database/');
    this.output.push('└─> arweave/');
    this.output.push('    └─> lib/');
    this.output.push('```');
    this.output.push('');

    this.output.push('---', '');
  }

  private async addAPIAnalysis(): Promise<void> {
    console.log('🌐 Analyzing API surface...');

    this.output.push(
      '## API Surface',
      '',
      '### HTTP Endpoints',
      ''
    );

    try {
      const routes = await this.extractRoutes();

      const routesByType = {
        'Data Retrieval': routes.filter(r => r.includes('/tx/') || r.includes('/data/')),
        'GraphQL': routes.filter(r => r.includes('graphql')),
        'Chunks': routes.filter(r => r.includes('chunk')),
        'Health/Status': routes.filter(r => r.includes('health') || r.includes('info')),
        'Other': routes.filter(r => !['tx', 'data', 'graphql', 'chunk', 'health', 'info'].some(term => r.includes(term)))
      };

      Object.entries(routesByType).forEach(([type, typeRoutes]) => {
        if (typeRoutes.length > 0) {
          this.output.push(`**${type}** (${typeRoutes.length} endpoints):`, '');
          typeRoutes.forEach(route => {
            this.output.push(`- \`${route}\``);
          });
          this.output.push('');
        }
      });

    } catch (error) {
      this.output.push('*Route analysis failed*', '');
    }

    this.output.push('---', '');
  }

  private async addTestCoverageAnalysis(): Promise<void> {
    console.log('🧪 Analyzing test coverage...');

    this.output.push(
      '\\newpage',
      '',
      '## Test Coverage',
      '',
      '### Test Distribution',
      ''
    );

    const srcFiles = await this.countFiles('src', '.ts', false);
    const testFiles = await this.countFiles('src', '.test.ts', true);
    const e2eFiles = await this.countFiles('test', '.test.ts', true);

    this.output.push(`**Implementation Files:** ${srcFiles}`);
    this.output.push(`**Unit Test Files:** ${testFiles}`);
    this.output.push(`**E2E Test Files:** ${e2eFiles}`);
    this.output.push(`**Test File Ratio:** ${Math.round((testFiles / srcFiles) * 100)}%`);
    this.output.push('');

    // Real test coverage
    const coverageData = await this.getTestCoverage();
    if (coverageData) {
      this.output.push('### Code Coverage (from test execution)', '');
      this.output.push(`**Overall Coverage:** ${coverageData.overall.lines}% lines, ${coverageData.overall.branches}% branches, ${coverageData.overall.functions}% functions`);
      this.output.push('');

      if (coverageData.byFile && coverageData.byFile.length > 0) {
        this.output.push('**Coverage by File (top 10 lowest):**');
        coverageData.byFile
          .sort((a, b) => a.lines - b.lines)
          .slice(0, 10)
          .forEach(file => {
            const bar = '█'.repeat(Math.floor(file.lines / 5)) + '░'.repeat(20 - Math.floor(file.lines / 5));
            this.output.push(`${file.name.padEnd(40)} ${bar} ${file.lines}%`);
          });
        this.output.push('');
      }
    } else {
      this.output.push('### Test File Coverage by Module', '');
      this.output.push('*(Note: This shows test file ratio, not execution coverage)*', '');

      const modules = await this.getDirectories('src');
      for (const module of modules) {
        const moduleImpl = await this.countFiles(path.join('src', module), '.ts', false);
        const moduleTests = await this.countFiles(path.join('src', module), '.test.ts', true);
        const coverage = moduleImpl > 0 ? Math.round((moduleTests / moduleImpl) * 100) : 0;

        const coverageBar = '█'.repeat(Math.floor(coverage / 5)) + '░'.repeat(20 - Math.floor(coverage / 5));
        this.output.push(`${module.padEnd(15)} ${coverageBar} ${coverage}%`);
      }
      this.output.push('');
    }

    // Test infrastructure
    try {
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));
      const testScripts = Object.entries(packageJson.scripts || {})
        .filter(([key]) => key.includes('test'))
        .map(([key, value]) => `- \`${key}\`: ${value}`);

      if (testScripts.length > 0) {
        this.output.push('### Test Scripts', '');
        testScripts.forEach(script => this.output.push(script));
        this.output.push('');
      }
    } catch {
      // Ignore if package.json can't be read
    }

    this.output.push('---', '');
  }

  private async addInternalToolsAnalysis(): Promise<void> {
    console.log('🛠️ Analyzing internal tools...');

    this.output.push(
      '\\newpage',
      '',
      '## Internal Tools',
      '',
      '### AI Configuration',
      ''
    );

    // Analyze .claude directory
    try {
      await fs.access('.claude');

      try {
        const agentFiles = await fs.readdir('.claude/agents');
        this.output.push(`**AI Agents:** ${agentFiles.length} configured`);

        for (const agentFile of agentFiles) {
          const agentName = agentFile.replace('.md', '');
          try {
            const content = await fs.readFile(path.join('.claude/agents', agentFile), 'utf-8');
            const purpose = this.extractAgentPurpose(content);
            this.output.push(`- \`${agentName}\`: ${purpose}`);
          } catch {
            this.output.push(`- \`${agentName}\`: Purpose not found`);
          }
        }
        this.output.push('');
      } catch {
        this.output.push('**AI Agents:** None configured', '');
      }

      try {
        const commandFiles = await fs.readdir('.claude/commands');
        this.output.push(`**Custom Commands:** ${commandFiles.length} available`);

        for (const commandFile of commandFiles) {
          const commandName = commandFile.replace('.sh', '').replace('.js', '').replace('.ts', '');
          this.output.push(`- \`/${commandName}\``);
        }
        this.output.push('');
      } catch {
        this.output.push('**Custom Commands:** None configured', '');
      }

    } catch {
      this.output.push('**AI Configuration:** Not found', '');
    }

    // Analyze project instructions
    try {
      const claudeMd = await fs.readFile('CLAUDE.md', 'utf-8');
      const sections = (claudeMd.match(/^##[^#]/gm) || []).length;
      this.output.push(`**Project Instructions:** ${sections} sections in CLAUDE.md`);

      // Extract key rules
      const rules = this.extractRules(claudeMd);
      if (rules.length > 0) {
        this.output.push('');
        this.output.push('**Key Development Rules:**');
        rules.slice(0, 5).forEach(rule => this.output.push(`- ${rule}`));
        if (rules.length > 5) {
          this.output.push(`- [${rules.length - 5} more rules...]`);
        }
      }
      this.output.push('');
    } catch {
      this.output.push('**Project Instructions:** Not found', '');
    }

    // Integration tools
    this.output.push('### External Integrations', '');

    try {
      const localMd = await fs.readFile('CLAUDE.local.md', 'utf-8');
      if (localMd.includes('Jira')) {
        const jiraSection = localMd.match(/## Jira Integration[\s\S]*?(?=##|$)/);
        if (jiraSection) {
          const projectKeys = (jiraSection[0].match(/\*\*([A-Z]+)\*\*/g) || []).map(m => m.replace(/\*\*/g, ''));
          this.output.push(`**Jira Integration:** ${projectKeys.length} project(s) - ${projectKeys.join(', ')}`);
        }
      }
    } catch {
      // Ignore if local instructions don't exist
    }

    this.output.push('**GitHub Integration:** Configured for PR management');
    this.output.push('**Release Process:** Tag-based (rN format)');
    this.output.push('');

    this.output.push('---', '');
  }

  private async addStatistics(): Promise<void> {
    console.log('📊 Generating statistics...');

    this.output.push(
      '\\newpage',
      '',
      '## Statistics',
      '',
      '### Repository Metrics',
      ''
    );

    const stats = await this.generateRepositoryStats();

    this.output.push('```');
    this.output.push('Code Metrics:');
    this.output.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.output.push(`Total TypeScript Files:    ${stats.totalFiles}`);
    this.output.push(`Implementation Files:      ${stats.implFiles}`);
    this.output.push(`Test Files:               ${stats.testFiles}`);
    this.output.push(`Total Lines of Code:      ${stats.totalLines}`);
    this.output.push(`Average File Size:        ${Math.round(stats.avgFileSize)} lines`);
    this.output.push(`Test Coverage Ratio:      ${Math.round(stats.testRatio * 100)}%`);
    this.output.push('');
    this.output.push('Database Metrics:');
    this.output.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.output.push(`Schema Files:             ${stats.schemaFiles}`);
    this.output.push(`SQL Statement Files:      ${stats.sqlFiles}`);
    this.output.push(`Migration Files:          ${stats.migrationFiles}`);
    this.output.push('');
    this.output.push('Configuration:');
    this.output.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.output.push(`Dependencies:             ${stats.dependencies}`);
    this.output.push(`Dev Dependencies:         ${stats.devDependencies}`);
    this.output.push(`NPM Scripts:              ${stats.scripts}`);
    this.output.push('```');
    this.output.push('');

    // Top files by size
    if (stats.largestFiles.length > 0) {
      this.output.push('### Largest Files', '');
      stats.largestFiles.forEach(file => {
        this.output.push(`- \`${file.path}\`: ${file.lines} lines`);
      });
      this.output.push('');
    }

    this.output.push('---');
    this.output.push('');
    this.output.push(`*Generated on ${new Date().toISOString()} by AR.IO Node Architecture Analyzer*`);
  }

  private async writeReport(): Promise<void> {
    const reportPath = 'architecture-review.md';
    await fs.writeFile(reportPath, this.output.join('\n'));
  }

  private async generateCompleteFileTree(): Promise<void> {
    this.output.push('```');

    try {
      // Use the tree command if available, otherwise build manually
      try {
        const treeOutput = execSync('tree src -I "*.test.ts" --dirsfirst -a', { encoding: 'utf-8' });
        this.output.push(treeOutput.trim());
      } catch {
        // Fallback to manual tree generation
        await this.generateManualTree('src', '', true);
      }
    } catch {
      this.output.push('src/ (unable to generate tree)');
    }

    this.output.push('```');
  }

  private async generateManualTree(dirPath: string, prefix: string = '', isLast: boolean = true): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      // Separate directories and files
      const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter(e => e.isFile() && e.name.endsWith('.ts')).sort((a, b) => a.name.localeCompare(b.name));

      const allEntries = [...dirs, ...files];

      for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        const isLastEntry = i === allEntries.length - 1;
        const connector = isLastEntry ? '└── ' : '├── ';
        const newPrefix = prefix + (isLastEntry ? '    ' : '│   ');

        if (entry.isDirectory()) {
          this.output.push(`${prefix}${connector}${entry.name}/`);
          await this.generateManualTree(path.join(dirPath, entry.name), newPrefix, isLastEntry);
        } else {
          // Show file with line count
          try {
            const filePath = path.join(dirPath, entry.name);
            const content = await fs.readFile(filePath, 'utf-8');
            const lineCount = content.split('\n').length;
            const isTest = entry.name.includes('.test.') || entry.name.includes('.spec.');
            const testLabel = isTest ? ' [TEST]' : '';
            this.output.push(`${prefix}${connector}${entry.name} (${lineCount} lines)${testLabel}`);
          } catch {
            this.output.push(`${prefix}${connector}${entry.name}`);
          }
        }
      }
    } catch {
      // Skip if can't read directory
    }
  }

  private async getTestCoverage(): Promise<{
    overall: { lines: number; branches: number; functions: number };
    byFile: Array<{ name: string; lines: number; branches: number; functions: number }>;
  } | null> {
    try {
      // Check if we should skip coverage generation
      const skipCoverage = process.env.SKIP_COVERAGE === 'true' || process.env.SKIP_COVERAGE === '1';

      let result: string;

      if (skipCoverage) {
        console.log('  Using cached coverage data (SKIP_COVERAGE=true)...');

        // Try to read from cached coverage file
        try {
          result = await fs.readFile('.coverage-cache.txt', 'utf-8');
          console.log('  Loaded cached coverage data');
        } catch {
          console.log('  No cached coverage found, running fresh analysis...');
          result = await this.runCoverageAnalysis();
          // Cache the results
          await fs.writeFile('.coverage-cache.txt', result);
        }
      } else {
        console.log('  Running test coverage analysis (this may take a while)...');
        result = await this.runCoverageAnalysis();
        // Cache the results for future use
        try {
          await fs.writeFile('.coverage-cache.txt', result);
        } catch {
          // Ignore cache write errors
        }
      }

      // Parse c8 output - look for summary lines
      const lines = result.split('\n');

      // Find overall coverage line (usually near the end)
      const summaryRegex = /All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/;
      let overall = { lines: 0, branches: 0, functions: 0 };

      for (const line of lines) {
        const match = line.match(summaryRegex);
        if (match) {
          overall = {
            lines: parseFloat(match[2]),
            branches: parseFloat(match[3]),
            functions: parseFloat(match[4])
          };
          break;
        }
      }

      // Parse individual file coverage
      const byFile: Array<{ name: string; lines: number; branches: number; functions: number }> = [];
      const fileRegex = /^\s*(.+\.ts)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/;

      for (const line of lines) {
        const match = line.match(fileRegex);
        if (match && !match[1].includes('All files')) {
          byFile.push({
            name: match[1].replace(/^.*\//, ''), // Just filename
            lines: parseFloat(match[2]),
            branches: parseFloat(match[3]),
            functions: parseFloat(match[4])
          });
        }
      }

      return { overall, byFile };

    } catch (error) {
      console.log('  Coverage analysis failed, falling back to test file ratio');
      return null;
    }
  }

  private async runCoverageAnalysis(): Promise<string> {
    return execSync('yarn test:coverage 2>/dev/null || npm run test:coverage 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 300000, // 5 minute timeout
      cwd: process.cwd()
    });
  }

  // Helper methods
  private async getDirectories(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      return [];
    }
  }

  private async analyzeDirectory(dirPath: string): Promise<DirectoryAnalysis> {
    const files: FileInfo[] = [];
    let totalFiles = 0;
    let testFiles = 0;

    try {
      const entries = await fs.readdir(dirPath, { recursive: true });

      for (const entry of entries) {
        if (typeof entry === 'string' && entry.endsWith('.ts')) {
          const fullPath = path.join(dirPath, entry);
          const isTest = entry.includes('.test.') || entry.includes('.spec.');

          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lineCount = content.split('\n').length;
            const stats = await fs.stat(fullPath);

            // Store relative path for better display
            const relativePath = entry;

            files.push({
              path: relativePath,
              size: stats.size,
              isTest,
              lineCount
            });

            totalFiles++;
            if (isTest) testFiles++;
          } catch {
            // Skip files we can't read
          }
        }
      }
    } catch {
      // Directory might not exist or be readable
    }

    return {
      name: path.basename(dirPath),
      totalFiles,
      testFiles,
      implFiles: totalFiles - testFiles,
      files,
      imports: [],
      exports: []
    };
  }

  private extractTypeDefinitions(content: string, type: 'interface' | 'type'): TypeDefinition[] {
    const regex = type === 'interface'
      ? /export\s+interface\s+(\w+)[^{]*{([^}]*)}/g
      : /export\s+type\s+(\w+)\s*=/g;

    const definitions: TypeDefinition[] = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      definitions.push({
        name: match[1],
        type,
        methods: type === 'interface' ? this.extractMethods(match[2] || '') : [],
        properties: type === 'interface' ? this.extractProperties(match[2] || '') : []
      });
    }

    return definitions;
  }

  private extractMethods(interfaceBody: string): string[] {
    const methodRegex = /(\w+)\s*\([^)]*\)\s*:/g;
    const methods: string[] = [];
    let match;

    while ((match = methodRegex.exec(interfaceBody)) !== null) {
      methods.push(match[1]);
    }

    return methods;
  }

  private extractProperties(interfaceBody: string): string[] {
    const propRegex = /(\w+)\s*:\s*[^;]+/g;
    const properties: string[] = [];
    let match;

    while ((match = propRegex.exec(interfaceBody)) !== null) {
      if (!interfaceBody.substring(match.index - 10, match.index).includes('(')) {
        properties.push(match[1]);
      }
    }

    return properties;
  }

  private extractTables(sqlContent: string): Array<{ name: string; columns: number }> {
    const tableRegex = /CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]*?)\);/gi;
    const tables: Array<{ name: string; columns: number }> = [];
    let match;

    while ((match = tableRegex.exec(sqlContent)) !== null) {
      const columnCount = (match[2].match(/,/g) || []).length + 1;
      tables.push({
        name: match[1],
        columns: columnCount
      });
    }

    return tables;
  }

  private extractIndexes(sqlContent: string): string[] {
    const indexRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/gi;
    const indexes: string[] = [];
    let match;

    while ((match = indexRegex.exec(sqlContent)) !== null) {
      indexes.push(match[1]);
    }

    return indexes;
  }

  private async getModuleImports(modulePath: string): Promise<string[]> {
    const imports: string[] = [];

    try {
      const files = await fs.readdir(modulePath);

      for (const file of files) {
        if (file.endsWith('.ts') && !file.includes('.test.')) {
          try {
            const content = await fs.readFile(path.join(modulePath, file), 'utf-8');
            const importMatches = content.match(/import.*from\s+['"]\.\.\/([^'"]+)['"]/g) || [];

            importMatches.forEach(imp => {
              const match = imp.match(/from\s+['"]\.\.\/([^'"]+)['"]/);
              if (match) {
                imports.push(match[1].split('/')[0]);
              }
            });
          } catch {
            // Skip files we can't read
          }
        }
      }
    } catch {
      // Module path might not exist
    }

    return [...new Set(imports)];
  }

  private async extractRoutes(): Promise<string[]> {
    const routes: string[] = [];

    try {
      const routesDir = 'src/routes';
      const files = await fs.readdir(routesDir, { recursive: true });

      for (const file of files) {
        if (typeof file === 'string' && file.endsWith('.ts') && !file.includes('.test.')) {
          try {
            const content = await fs.readFile(path.join(routesDir, file), 'utf-8');
            const routeMatches = content.match(/\.(?:get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi) || [];

            routeMatches.forEach(match => {
              const route = match.match(/['"`]([^'"`]+)['"`]/);
              if (route) {
                routes.push(route[1]);
              }
            });
          } catch {
            // Skip files we can't read
          }
        }
      }
    } catch {
      // Routes directory might not exist
    }

    return [...new Set(routes)];
  }

  private async countFiles(dir: string, extension: string, isTest: boolean): Promise<number> {
    let count = 0;

    try {
      const files = await fs.readdir(dir, { recursive: true });

      for (const file of files) {
        if (typeof file === 'string' && file.endsWith(extension)) {
          const fileIsTest = file.includes('.test.') || file.includes('.spec.');
          if (fileIsTest === isTest) {
            count++;
          }
        }
      }
    } catch {
      // Directory might not exist
    }

    return count;
  }

  private extractAgentPurpose(content: string): string {
    const purposeMatch = content.match(/Purpose:\s*(.+)/i) ||
                        content.match(/Use this agent to\s*(.+)/i) ||
                        content.match(/#\s*(.+)/);
    return purposeMatch ? purposeMatch[1].trim() : 'Purpose not specified';
  }

  private extractRules(content: string): string[] {
    const rules: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      if (line.trim().startsWith('- ') &&
          (line.toLowerCase().includes('must') ||
           line.toLowerCase().includes('never') ||
           line.toLowerCase().includes('always'))) {
        rules.push(line.replace(/^-\s*/, '').trim());
      }
    }

    return rules;
  }

  private async generateRepositoryStats(): Promise<any> {
    const stats = {
      totalFiles: 0,
      implFiles: 0,
      testFiles: 0,
      totalLines: 0,
      avgFileSize: 0,
      testRatio: 0,
      schemaFiles: 0,
      sqlFiles: 0,
      migrationFiles: 0,
      dependencies: 0,
      devDependencies: 0,
      scripts: 0,
      largestFiles: [] as Array<{ path: string; lines: number }>
    };

    // Count TypeScript files
    try {
      const files = await fs.readdir('src', { recursive: true });
      const allFiles: Array<{ path: string; lines: number; isTest: boolean }> = [];

      for (const file of files) {
        if (typeof file === 'string' && file.endsWith('.ts')) {
          try {
            const fullPath = path.join('src', file);
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n').length;
            const isTest = file.includes('.test.') || file.includes('.spec.');

            allFiles.push({ path: file, lines, isTest });
            stats.totalFiles++;
            stats.totalLines += lines;

            if (isTest) {
              stats.testFiles++;
            } else {
              stats.implFiles++;
            }
          } catch {
            // Skip files we can't read
          }
        }
      }

      stats.avgFileSize = stats.totalFiles > 0 ? stats.totalLines / stats.totalFiles : 0;
      stats.testRatio = stats.implFiles > 0 ? stats.testFiles / stats.implFiles : 0;

      // Find largest files
      stats.largestFiles = allFiles
        .filter(f => !f.isTest)
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 5);

    } catch {
      // Source directory might not exist
    }

    // Count database files
    try {
      const testFiles = await fs.readdir('test');
      stats.schemaFiles = testFiles.filter(f => f.endsWith('-schema.sql')).length;
    } catch {
      // Test directory might not exist
    }

    try {
      const sqlDirs = await fs.readdir('src/database/sql');
      for (const dir of sqlDirs) {
        const files = await fs.readdir(path.join('src/database/sql', dir));
        stats.sqlFiles += files.filter(f => f.endsWith('.sql')).length;
      }
    } catch {
      // SQL directory might not exist
    }

    try {
      const migrationFiles = await fs.readdir('migrations');
      stats.migrationFiles = migrationFiles.filter(f => f.endsWith('.sql')).length;
    } catch {
      // Migrations directory might not exist
    }

    // Count package.json entries
    try {
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));
      stats.dependencies = Object.keys(packageJson.dependencies || {}).length;
      stats.devDependencies = Object.keys(packageJson.devDependencies || {}).length;
      stats.scripts = Object.keys(packageJson.scripts || {}).length;
    } catch {
      // Package.json might not exist
    }

    return stats;
  }
}

// Main execution
async function main() {
  try {
    const analyzer = new ArchitectureAnalyzer();
    await analyzer.generateReport();

    console.log('\n🎯 Next steps:');
    console.log('1. Review architecture-review.md');
    console.log('2. Convert to PDF with: pandoc architecture-review.md -o architecture-review.pdf');
    console.log('3. Or use typst: typst compile architecture-review.typ architecture-review.pdf');

  } catch (error) {
    console.error('❌ Error generating architecture review:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}