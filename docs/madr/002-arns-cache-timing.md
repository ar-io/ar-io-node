# ArNS Cache Timing

- Status: proposed
- Deciders: [Ariel], [Dylan], [Karl]
- Date: 2024-12-09
- Authors: [David]

## Context and Problem Statement

ArNS resolution requires multiple network-process reads against the AR.IO
programs on Solana. During resolution, caches are used to reduce response
latency and RPC load. Aggressive resolution would exhaust an operator's RPC
quota (and add unnecessary latency) — so there is an intrinsic trade-off
between reducing response latency (and RPC load) and the freshness of ArNS
responses. To allow gateway operators to optimize this trade-off we need to
define the levels of caching involved and make them configurable. The purpose
of this ADR is to list the levels of caching and related timeouts involved.

*Note: this ADR was originally written against the AO-era architecture
(2024-12-09). The decision — multi-tier caching with operator-tunable
freshness — applies unchanged to the Solana-native implementation. The
"IO Process" / "ANT Process" references below are now the AR.IO Core
program and ANT programs reached via `@ar.io/sdk`.*

## Decision Outcome

### Resolution Flow

```mermaid
flowchart TD
    Start([Resolution Requested]) --> CDN[CDN]
    CDN --> CDNStatus{"CDN Cache Status"}
    CDNStatus -->|Hit| Resolution
    CDNStatus -->|Miss| NameCache

    subgraph Gateway ["AR.IO Gateway"]
        NameCache["Name List Cache"]

        NameCache --> ListStatus{"Name List Status"}
        ListStatus -->|Up-to-date| ANTCache["ANT State Cache"]
        ListStatus -->|"Stale (name list TTL expired)"| IO["AR.IO Core (Solana)"]
        ListStatus -->|Not Cached| IO

        ANTCache --> StateStatus{"ANT State Status"}
        StateStatus -->|"Stale (name TTL expired)"| ANT["ANT program (Solana)"]
        StateStatus -->|Not Cached| ANT

        IO -->|"Update Cache &lt;debounced&gt;"| NameCache
        ANT -->|"Update Cache &lt;debounced and concurrency limited&gt;"| ANTCache
    end

    StateStatus -->|Up-to-date| Resolution([Resolution Returned])

    style Start fill:#ff69b4,stroke:#333
    style CDN fill:#4169e1,stroke:#333
    style NameCache fill:#4169e1,stroke:#333
    style IO fill:#4169e1,stroke:#333
    style ANT fill:#4169e1,stroke:#333
    style ListStatus fill:#ff69b4,stroke:#333
    style ANTCache fill:#4169e1,stroke:#333
    style StateStatus fill:#ff69b4,stroke:#333
    style Resolution fill:#ff69b4,stroke:#333
    style CDNStatus fill:#ff69b4,stroke:#333

```

### Configurable Timeouts

- **Name list TTL** - The maximum interval between name list cache refreshes
  for names already in the cached name list. Suggested default: 1 hour.
- **Name list miss debounce interval** - The minimum amount of time between
  name list cache refreshes triggered by names not found in the cache.
  Suggested default: 60 seconds.
- **Name list hit debounce interval** - The maximum amount of time between
  name list cache refreshes triggered by names found in the cache. Suggested
  default: 1 hour.
- **ANT state TTL** - The maximum interval between individual ANT state cache
  refreshes when the ANT state is already cached. Suggested default: 1 hour.
- **ANT state miss debounce interval** - The minimum amount of time between ANT
  state cache refreshes triggered by missing ANT state. Suggested default: 10
  seconds.
- **ANT state hit debounce interval** - The maximum amount of time between ANT
  state cache refreshes triggered by names found in the ANT state cache.
  Suggested default: 5 minutes.
- **ANT state concurrency limit** - The maximum number of parallel in-flight
  ANT state requests to the network process. Suggested default: 10.

[Ariel]: https://github.com/arielmelendez
[David]: https://github.com/djwhitt
[Dylan]: https://github.com/dtfiedler
[Karl]: https://github.com/karlprieb
