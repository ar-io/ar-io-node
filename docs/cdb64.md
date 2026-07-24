# CDB64 Root Transaction Index

CDB64 is the AR.IO Gateway's solution for fast, offline lookups of data item to
root transaction mappings. It enables O(1) retrieval of nested bundle data
without external API dependencies.

## Why CDB64?

When a client requests a data item nested inside an ANS-104 bundle, the gateway
needs to know which root transaction contains it and where within that
transaction the data resides. CDB64 indexes provide:

- **Instant lookups**: Hash-based O(1) access, no database queries
- **Offline operation**: No external API calls for indexed items
- **Flexible deployment**: Local files, HTTP endpoints, or Arweave-stored
  indexes
- **Hot reloading**: Add/remove indexes without gateway restart
- **Scalability**: Partitioned indexes for datasets exceeding billions of
  records

## Documentation

| Document                                    | Audience          | Description                                                    |
| ------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| **[Operator Guide](cdb64-guide.md)**        | Gateway operators | Configuration, deployment, performance tuning, troubleshooting |
| **[Tools Reference](cdb64-tools.md)**       | Developers        | CLI tools for creating and managing CDB64 indexes              |
| **[Format Specification](cdb64-format.md)** | Implementers      | Technical specification of the CDB64 file format               |

## Quick Start

### 1. Enable CDB64 Lookups

Add `cdb` to your lookup order:

```bash
ROOT_TX_LOOKUP_ORDER=cdb,db,gateways,graphql
```

### 2. Add Index Files

Place `.cdb` files in the default directory:

```bash
mkdir -p data/cdb64-root-tx-index
cp my-index.cdb data/cdb64-root-tx-index/
```

Or configure a custom source:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/indexes/,https://cdn.example.com/index.cdb
```

### 3. Verify

Check the logs for successful initialization:

```text
CDB64 root TX index initialized { sourceCount: 1, readerCount: 3, watching: true }
```

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                     Data Request                            │
│                   GET /raw/{dataItemId}                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Root TX Lookup Order                       │
│                                                             │
│   ┌─────────┐   ┌─────────┐   ┌──────────┐   ┌─────────┐   │
│   │  CDB64  │ → │   DB    │ → │ Gateways │ → │ GraphQL │   │
│   │ Indexes │   │ (local) │   │ (remote) │   │ (remote)│   │
│   └─────────┘   └─────────┘   └──────────┘   └─────────┘   │
│        │                                                    │
│        ▼                                                    │
│   ┌─────────────────────────────────────────┐              │
│   │          CDB64 Source Chain             │              │
│   │                                         │              │
│   │  Local Dir → HTTP CDN → Arweave TX      │              │
│   │  (watched)   (cached)   (cached)        │              │
│   └─────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Root TX Info Retrieved                         │
│                                                             │
│   { rootTxId, rootOffset, rootDataOffset, path }           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Byte-Range Data Retrieval                      │
│                                                             │
│   Fetch data at offset from root transaction                │
└─────────────────────────────────────────────────────────────┘
```

## Key Concepts

### Root Transaction Mapping

Each data item ID maps to information about its location:

| Field            | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `rootTxId`       | The L1 Arweave transaction containing the data         |
| `rootOffset`     | Byte offset of the data item header within the root TX |
| `rootDataOffset` | Byte offset of the data payload within the root TX     |
| `path`           | Bundle traversal path for nested bundles               |

### Source Priority

Multiple CDB64 sources are searched in configuration order. First match wins:

```bash
# Search order: local directory, then CDN, then Arweave backup
CDB64_ROOT_TX_INDEX_SOURCES=/local/indexes/,https://cdn.example.com/index.cdb,ArweaveTxId
```

### Lookup Short-Circuiting

The composite root TX index (`ROOT_TX_LOOKUP_ORDER`) stops probing sources as
soon as one returns an **actionable** result, so a CDB64 hit early in the order
avoids the remaining (often remote and expensive) sources such as GraphQL. A
result is actionable when the caller can proceed without further lookups:

| Exit reason        | Condition                                             | Notes                                             |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------- |
| `complete_offsets` | `rootOffset` + `rootDataOffset` + `size` + `dataSize` | Full offsets; no header parse needed              |
| `l1_root`          | `rootTxId === id`                                     | Definitive L1 root; passthrough                   |
| `offsets`          | `rootOffset` + `rootDataOffset` present               | The CDB64 case; size is read from the item header |
| `path`             | non-empty `path`                                      | Enables path-guided bundle navigation             |

A caller may override this decision by passing an `accept` predicate to
`getRootTx` (short-circuiting on whatever it deems sufficient — e.g. any
`rootTxId` it will resolve offsets from locally); such short-circuits are
recorded with the `caller_accept` exit reason.

A bare `rootTxId` with no path or offsets is **not** actionable — it is saved as
a fallback and the search continues, so a later source (e.g. CDB64) can supply a
path or offsets. If no source is actionable, the saved fallback is returned
(`fallback`), or `undefined` if nothing resolved (`not_found`).

CDB64 values carry offsets (`rootOffset`/`rootDataOffset`) but not `size`, so
CDB64 hits terminate with the `offsets` (or `path`) reason rather than
`complete_offsets`.

Observability (per-node Prometheus metrics):

- `composite_root_tx_exit_reason_total{reason,winning_source}` — one increment
  per lookup, labelled with the exit reason above. A healthy CDB64 deployment
  shows most CDB64-won lookups exiting on `offsets`/`path`.
- `composite_root_tx_sources_probed` — summary of how many sources were queried
  before returning. Effective short-circuiting keeps this low.
- `root_tx_lookup_total{source="graphql"}` — total GraphQL probes; falls sharply
  once early local sources (db/cdb) short-circuit.

### Partitioned Indexes

For large datasets, indexes can be split into 256 partitions by key prefix:

```text
index/
  manifest.json   # Metadata and partition locations
  00.cdb          # Keys starting with 0x00
  01.cdb          # Keys starting with 0x01
  ...
  ff.cdb          # Keys starting with 0xff
```

Partitions can be stored across different locations (local, HTTP, Arweave).

## Common Configurations

### Development (Local Only)

```bash
ROOT_TX_LOOKUP_ORDER=cdb,db
CDB64_ROOT_TX_INDEX_SOURCES=data/cdb64-root-tx-index
```

### Production (Local + CDN Backup)

```bash
ROOT_TX_LOOKUP_ORDER=cdb,db,gateways
CDB64_ROOT_TX_INDEX_SOURCES=/data/indexes/,https://cdn.example.com/indexes/manifest.json
CDB64_ROOT_TX_INDEX_WATCH=false
```

### Fully Decentralized (Arweave-Stored)

```bash
ROOT_TX_LOOKUP_ORDER=cdb,db
CDB64_ROOT_TX_INDEX_SOURCES=ArweaveManifestTxId:manifest
```

## Next Steps

- **Operators**: Start with the [Operator Guide](cdb64-guide.md)
- **Creating indexes**: See the [Tools Reference](cdb64-tools.md)
- **Understanding the format**: Read the [Format Specification](cdb64-format.md)
