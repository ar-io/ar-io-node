# ClickHouse as a Supplemental GraphQL Backend

- Status: accepted
- Deciders: [David]
- Date: 2024-07-26
- Authors: [David]

## Context and Problem Statement

The ar-io-node uses SQLite as its primary database backend. SQLite was chosen
because it supports rapid development iteration, is easy to deploy and simple
to operate, runs well on low resource hardware, and supports the transactional
updates needed to index unstable chain data. However, it has limited built-in
horizontal scalability, data compression, and support for batch loading. This
makes bootstrapping new gateways slow and constrains scaling. One way to
mitigate these limitations is by combining SQLite with another DB that is used
for older stable data. This resembles a "Lambda architecture" where SQLite
serves as the "speed layer", the secondary DB as the "batch layer", and the
gateway as the "serving layer". The purpose of this ADR is to evaluate options
and propose a secondary "batch layer" DB.

Because it will only store unchanging stable data, the "batch layer" DB does
not need transactional updates. Eventual consistency and duplicate data are
tolerable because the bundle import process itself is eventually consistent
(serialized bundle imports aren't scalable) and deduplication can be handled at
query time.

The "batch layer" DB should also not attempt to make all queries fast without
any customization. As the size of any DB grows, optimal data layout
increasingly depends on query patterns. Attempting to provide fast generalized
queries means queries for any given app or protocol will be significantly
slower than optimal. This slowness increases the resources needed to run the DB
and thus significantly increases the minimum requirements needed to serve these
queries. Instead of generalized query optimization, the "batch layer" DB should
focus on ease of specialization given that's the solution apps and protocols
will ultimately require.

## Decision Drivers

- Support for rapidly batch loading millions to billions of rows of data to
  enable fast gateway bootstrapping
- Support for batch loading from Parquet to facilitate efficient compressed
  index sharing and integration with common data processing tools and services
- Support for sorting data sets by arbitrary values during ingest to avoid
  random access and sorting at query execution time
- Support for nested data types in order to avoid the need for joins
- Sub-second query response time when retrieving favorably sorted data to
  enable efficient protocol and application specific gateways
- Data compression capabilities to reduce storage costs and improve query
  performance
- Ease of setup and operation

## Considered Options

- ClickHouse
- Druid
- DuckDB
- Elastic/OpenSearch

## Decision Outcome

ClickHouse was selected due to its unique-in-class data sorting capabilities,
Parquet batch loading functionality and performance, horizontal scalability,
and relative ease of operation.

### Positive Consequences

- Faster initial bootstrapping via batch loading
- Improved indexing flexibility
- Improved query performance
- Reduced storage requirements
- Increased horizontal and vertical scaling options

### Negative Consequences

- Increased configuration and operational complexity due to the addition of the
  ClickHouse service.

## Pros and Cons of the Options

### ClickHouse

- `+` Native Parquet ingest support
- `+` Extremely fast batch ingest (millions of rows per second)
- `+` Table sorting
- `+` Easy horizontal scalability for reads
- `+` Excellent vertical scalability (multi-core support)
- `+` Relatively simple ops (easy containerized single node setup)
- `-` Horizontal write scaling is more complex than read scaling
- `-` No easy to use embedded version (unlike DuckDB)

### DuckDB

- `+` Native Parquet ingest and query support
- `+` Embedded (similar to SQLite)
- `-` No support for table sorting
- `-` Limited scalability (single node only)

### Druid

- `+` Extremely scalable horizontal reads and writes
- `-` Only supports sorting by time
- `-` Complex to run and operate (requires multiple services)

### Elastic/OpenSearch

- `+` Bulk loading API
- `+` Horizontal scalability
- `-` No native Parquet support
- `-` Limited indexing flexibility (difficult to tailor to specific use cases)
- `-` Limited index sorting capabilities

## Links

- [ClickHouse Distinctive Features](https://clickhouse.com/docs/en/about-us/distinctive-features)
- [OpenSearch Bulk API](https://opensearch.org/docs/latest/api-reference/document-apis/bulk/)
- [Elastic Index Sorting](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules-index-sorting.html)
- [Why DuckDB](https://duckdb.org/why_duckdb)
- [Introduction to Apache Druid](https://druid.apache.org/docs/latest/design/)
