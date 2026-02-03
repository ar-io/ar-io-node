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
| [CDB64 Overview](cdb64.md) | Introduction, architecture, and quick start |
| [CDB64 Operator Guide](cdb64-guide.md) | Configuration, deployment, and troubleshooting |
| [CDB64 Tools Reference](cdb64-tools.md) | CLI tools for creating indexes |
| [CDB64 Format Specification](cdb64-format.md) | Technical file format details |

### Rate Limiting & Payments

| Document | Description |
|----------|-------------|
| [x402 and Rate Limiting](x402-and-rate-limiting.md) | Rate limiter configuration and x402 payment protocol |

### Filters

| Document | Description |
|----------|-------------|
| [Filters](filters.md) | Transaction and bundle filter syntax |

## Data Export

| Document | Description |
|----------|-------------|
| [Parquet and ClickHouse](parquet-and-clickhouse-usage.md) | Exporting data to Parquet format |
| [Parquet Export with Iceberg](parquet-export-iceberg.md) | Apache Iceberg integration |

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

## Processes

| Document | Description |
|----------|-------------|
| [Release Process](processes/release.md) | How to create and publish releases |

## Database Schemas

SQLite schema documentation is in the [sqlite/](sqlite/) directory.

## Diagrams

Architecture and flow diagrams are in the [diagrams/](diagrams/) directory.
