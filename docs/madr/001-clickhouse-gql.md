# ClickHouse as an additional GraphQL backend

- Status: draft
- Deciders: ...
- Date: 2024-07-26
- Authors: [David]

## Context and Problem Statement

The initial version of the ar-io-node used SQLite as its primary database
backend (KV stores are also used in specific cases). While SQLite generally
works well, it has limitations that necessitate an additional database backend
for specific use cases, particularly around handling historical Arweave data.
The new backend needs to handle massive datasets efficiently while providing
fast query performance and supporting industry-standard data formats.

Key requirements include:
- Ability to handle datasets of 10+ billion rows, with similar growth expected
  annually
- Support for smaller subset deployments (few million rows) for typical users
- Sub-second query response times for most queries
- Fast bulk ingest capability (millions to billions of rows)
- Real-time ingest support (thousands of rows per second)
- Support for arbitrary sorting and sorted indexes for range queries
- Native Parquet support for compression and compatibility with external tools

Since the historical data in Arweave never changes, ACID properties are not
required and eventual consistency is acceptable.

## Decision Drivers

- Horizontal and vertical scalability to handle 10+ billion rows with continued growth
- Batch loading performance for efficient bulk data ingestion
- Parquet support for:
  - Data compression
  - Direct querying by tools like Athena, Presto, and DuckDB
  - Compatibility with indexing protocol
- Flexible table sorting capabilities for optimal query performance
- Operational simplicity, particularly for smaller deployments
- Query performance (sub-second response time requirement)
- Support for eventual consistency model (ACID not required)

## Considered Options

- ClickHouse
- Druid
- DuckDB
- Elastic/OpenSearch

## Decision Outcome

TODO: summarize the decision

### Positive Consequences

- Fast batch Parquet loading
- Greater custom indexing flexibility
- Improved query performance with sub-second response times
- Efficient handling of large-scale historical data
- Compatibility with external analysis tools through Parquet support

### Negative Consequences

- Increased configuration and operational complexity
- Additional system requirements compared to SQLite

## Pros and Cons of the Options

### ClickHouse

- `+` Native Parquet ingest support with high compression
- `+` Extremely fast batch ingest (millions of rows per second)
- `+` Flexible table sorting capabilities for optimizing query patterns
- `+` Easily horizontally scalable for reads
- `+` Excellent vertical scalability for handling billion-row datasets
- `+` Relatively simple ops (easy single node setup) for smaller deployments
- `+` Compatible with eventual consistency model
- `-` Horizontal write scaling is doable, but more complex
- `-` No easy to use embedded version

### DuckDB

- `+` Embedded version
- `+` Very simple to run (embedded like SQLite)
- `+` Excellent Parquet support
- `-` No table sorting
- `-` Limited scalability (single node)
- `-` May not handle 10+ billion row datasets effectively

### Druid

- `+` Extremely scalable horizontal reads and writes
- `+` Can handle billion-row datasets
- `-` Only supports sorting by time
- `-` Complex to run and operate
- `-` More complex than needed given eventual consistency is acceptable

### Elastic/OpenSearch

- `+` Bulk loading API
- `+` Horizontally scalable
- `+` Good support for real-time ingest
- `-` Limited indexing flexibility
- `-` Limited sorting capabilities
- `-` No native Parquet support
- `-` More complex than needed given eventual consistency is acceptable

## Links

TODO: references, etc.

## Notes

The choice of database backend is heavily influenced by:
1. The need to handle very large datasets (10+ billion rows) efficiently
2. Requirement for flexible sorting and indexing capabilities
3. Importance of Parquet support for tool compatibility and compression
4. Sub-second query performance requirements
5. The historical, append-only nature of the data

TODO: add additional thoughts and conclusions here
