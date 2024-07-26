# ClickHouse as an additional GraphQL backend

- Status: draft
- Deciders: ...
- Date: 2024-07-26
- Authors: [David]

## Context and Problem Statement

The initial version of the ar-io-node used SQLite as its primary database
backend (KV stores are also used in specific cases). While SQLite generaly
works well, it has some limitations. It is difficult to scale up and out, has
mediocre batch loading performance, and does not have native suport for Parquet
(needed for our indexing protocol). In order to address these issues, we intend
to implement a new GQL backend that can be used in combination with SQLite (and
other future DB backends). This decision record documents the evaluation of
database options for this new backend.

TODO: expand on the specific the specific issues with SQLite and the problem
constraints

## Decision Drivers

- Horizontal and vertical scalability
- Batch loading performance
- Parquet support (for batch loading convenience and indexing protocol)
- Table sorting (for optimal query performance)
- Operational simplicity
- Data compression
- Query performance

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
- Improved query performance

### Negative Consequences

- Increased configuration and operational complexity

## Pros and Cons of the Options

TODO: replace or augment with a table

### ClickHouse

- `+` Native Parquet ingest support
- `+` Extremely fast batch ingest (millions of rows per second)
- `+` Table sorting
- `+` Easily horizontally scalability for reads
- `+` Excellent vertical scalability
- `+` Relatively simple ops (easy single node setup)
- `-` Horizontal write scaling is doable, but more complex
- `-` No easy to use embedded version

### DuckDB

- `+` Embedded version
- `+` Very simple to run (embedded like SQLite)
- `-` No table sorting
- `-` Limited scalability (single node)

### Druid

- `+` Extremely scalable horizontal reads and writes
- `-` Only supports sorting by time
- `-` Complex to run and operate

### Elastic/OpenSearch

- `+` Bulk loading API
- `+` Horizontally scalabilit
- `+`
- `-` Limited indexing flexibility (difficult to tailor to specific use cases)
- `-` Limited sorting capabilities
- `-` No native Parquet support

## Links

TODO: references, etc.

## Notes

TODO: add high level thoughts and conclusions here
