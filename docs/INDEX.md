# AR.IO Gateway Documentation

Welcome to the AR.IO Gateway documentation. This index provides an overview of all available documentation.

## Getting Started

| Document | Description |
|----------|-------------|
| [Linux Setup](linux-setup.md) | Installation and setup guide for Linux |
| [Windows Setup](windows-setup.md) | Installation and setup guide for Windows |
| [Environment Variables](envs.md) | Complete reference for all configuration options |

## Core Features

### CDB64 Root Transaction Index

Fast, offline lookups for data item to root transaction mappings.

| Document | Description |
|----------|-------------|
| [CDB64 Root-TX Index](cdb64.md) | How the gateway uses CDB64 indexes: lookup order, configuration, sources, watching, troubleshooting |
| [CDB64 Tools Reference](cdb64-tools.md) | CLI tools for creating indexes |
| [CDB64 Format Specification](cdb64-format.md) | Technical file format details |

### Index Sharing

Gateways publish signed index bands and subscribe to each other's.

| Document | Description |
|----------|-------------|
| [Index Sharing: the `index-swarm` sidecar](index-swarm.md) | Publishing and subscribing over HTTP and BitTorrent: setup and status scripts, lookup order, running behind nginx, the torrent engine, metrics |
| [Index export](index-export.md) | Building root-TX and L1 bands with the `index-export` service: checks, running it, L1 layouts and lookup files, adoption, alerting |
| [Index Sharing: the publication protocol](index-publication.md) | Discovering, verifying and reading bands without the sidecar: the signed document, byte routes, L1 bands, lookup files, querying over HTTP, a reference client |

### Rate Limiting & Payments

| Document | Description |
|----------|-------------|
| [x402 and Rate Limiting](x402-and-rate-limiting.md) | Rate limiter configuration and x402 payment protocol |

### Filters

| Document | Description |
|----------|-------------|
| [Filters](filters.md) | Transaction and bundle filter syntax |

### Chunk Ingest Cache

| Document | Description |
|----------|-------------|
| [Optimistic Chunk Ingest Cache](chunk-ingest-cache.md) | Validating and caching chunks posted to the gateway, with confirmation-driven cleanup |

### Data Cache Cleanup

| Document | Description |
|----------|-------------|
| [Contiguous Data Cache Cleanup](cache-cleanup.md) | The two disk-pressure reclaimers (filesystem-walk worker vs. index evictor) and their shared watermark semantics; plus the index evictor's LRU ordering, tier promotion, and backfill |

## Data Export

| Document | Description |
|----------|-------------|
| [Parquet and ClickHouse](parquet-and-clickhouse-usage.md) | Exporting data to Parquet format |
| [ClickHouse Pipeline Architecture](clickhouse-pipeline.md) | SQLite → Parquet → ClickHouse pipeline and GraphQL routing |
| [ClickHouse Schema and Query Optimizations](clickhouse-schema.md) | Table layout, indexes, projections, and GraphQL query shape |

## Deployment

| Document | Description |
|----------|-------------|
| [Deployment Topologies](deployment-topologies.md) | Proxy edge, shared ClickHouse, partitioning, and app-split topologies |
| [The `ar-io-node` CLI](cli.md) | The gateway's command-line tool: building, checking and exporting index bands (`index-band-build`, `index-band-verify`, `index-band-export`), bootstrapping an L1 index from published bands and checking it against the chain (`index-l1-import`, `index-l1-verify`, `index-l1-audit`), and every `ar.io` CLI command, run in the core image through `tools/ar-io-node` |

## Reference

| Document | Description |
|----------|-------------|
| [Glossary](glossary.md) | Definitions of terms and concepts |
| [OpenAPI Specification](openapi.yaml) | REST API specification |

## Arweave Internals

Technical details about Arweave data structures.

| Document | Description |
|----------|-------------|
| [Merkle Tree Structure](arweave/merkle-tree-structure.md) | How Arweave merkle trees work |
| [Transaction and Chunk Offsets](arweave/transaction-and-chunk-offsets.md) | Offset calculations for data retrieval |

## Architecture Decision Records

| Document | Description |
|----------|-------------|
| [001 - ClickHouse GQL](madr/001-clickhouse-gql.md) | GraphQL with ClickHouse backend |
| [002 - ArNS Cache Timing](madr/002-arns-cache-timing.md) | ArNS resolution caching strategy |
| [003 - ArNS Undername Limits](madr/003-arns-undername-limits.md) | Undername resolution limits |
| [004 - Optimistic L1 Transaction Indexing](madr/004-optimistic-l1-tx-indexing.md) | Index a signed L1 tx before it mines + the never-serve-as-permanent guard |
| [005 - Chunk Data Cache Indexed Eviction](madr/005-chunk-data-cache-indexed-eviction.md) | Per-dataRoot SQLite eviction index for the chunk cache, with a derived ingest-confirmation age floor |
| [006 - qBittorrent as the Torrent Engine](madr/006-qbittorrent-torrent-engine.md) | Why Index Sharing drives qBittorrent rather than Transmission or rqbit |

## Testing

| Document | Description |
|----------|-------------|
| [Auto-Verify](auto-verify.md) | Cross-source indexing verification (SQLite / Parquet / bundle-parser / ClickHouse) |

## Developer Tools

| Document | Description |
|----------|-------------|
| [Tools README](../tools/README.md) | CLI tools for development, debugging, and testing (fetch-with-hint, queue-missing-bundles, test-clickhouse-graphql, release/worktree tooling, etc.) |

## Processes

| Document | Description |
|----------|-------------|
| [Release Process](processes/release.md) | How to create and publish releases |

## Database Schemas

SQLite schema documentation is in the [sqlite/](sqlite/) directory.

## Diagrams

Architecture diagrams, rendered from the PlantUML sources in
[diagrams/src/](diagrams/src/):

| Diagram | Shows |
|---------|-------|
| [Gateway](diagrams/Gateway.svg) | The gateway's services and stores, including Index Sharing |
| [Chain API](diagrams/Chain_API.svg) | Chain requests through Envoy to Arweave |
| [Data API](diagrams/Data_API.svg) | Data retrieval and caching |
| [GraphQL API](diagrams/GraphQL_API.svg) | GraphQL query routing |
