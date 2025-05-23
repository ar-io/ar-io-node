# AR.IO Node Routing Flow Diagram

This document provides ASCII diagrams illustrating the routing logic flow of the AR.IO Node.

## High-Level Routing Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                               Client Request (Port 3000)                          │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                  ENVOY PROXY                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │ Route Matching (in order):                                                   │ │
│  │                                                                              │ │
│  │ 1. ArNS Subdomain → *.{ARNS_ROOT_HOST}                                     │ │
│  │ 2. GraphQL        → /graphql                                               │ │
│  │ 3. Bundler        → /bundler/*                                             │ │
│  │ 4. AO CU          → /ao/cu/*                                               │ │
│  │ 5. Observer       → /ar-io/observer                                        │ │
│  │ 6. Legacy         → /info, /tx/*, /block/*, etc.                          │ │
│  │ 7. Default        → /* (everything else)                                   │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────┬─────────────────────────────────────────────────────────────┘
                     │
      ┌──────────────┴──────────────┬────────────────┬───────────────┬──────────────┐
      │                             │                │               │              │
      ▼                             ▼                ▼               ▼              ▼
┌─────────────┐           ┌─────────────────┐ ┌──────────┐  ┌──────────┐  ┌────────────┐
│   AR.IO     │           │ Legacy Gateway  │ │ Bundler  │  │  AO CU   │  │  Observer  │
│  Gateway    │           │  (External)     │ │ Service  │  │ Service  │  │  Service   │
│ (Port 4000) │           │                 │ │          │  │          │  │            │
└─────┬───────┘           └─────────────────┘ └──────────┘  └──────────┘  └────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           EXPRESS APPLICATION (Port 4000)                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │ Route Registration Order:                                                    │ │
│  │                                                                              │ │
│  │ 1. ArNS Router     → Subdomain handling & /ar-io/resolver/:name            │ │
│  │ 2. OpenAPI Router  → /openapi.json, /api-docs                              │ │
│  │ 3. AR.IO Router    → /ar-io/* (health, info, admin)                        │ │
│  │ 4. Chunk Router    → /chunk/:offset, POST /chunk                           │ │
│  │ 5. Data Router     → /:id, /raw/:id, /farcaster/:id                        │ │
│  │ 6. Root Router     → /                                                     │ │
│  │ 7. GraphQL         → /graphql (Apollo Server)                              │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## ArNS Resolution Flow

```
┌─────────────────────────────────────────────┐
│  Request: name.arweave.net/path/to/file    │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │ Envoy: ArNS Domain? │
         └─────────┬───────────┘
                   │ Yes (*.{ARNS_ROOT_HOST})
                   ▼
         ┌─────────────────────┐
         │  ArNS Middleware    │
         └─────────┬───────────┘
                   │
                   ▼
         ┌─────────────────────┐     ┌──────────────────┐
         │  Name Resolution    │────▶│ Blocked Names?   │
         └─────────┬───────────┘     └────────┬─────────┘
                   │                           │ No
                   ▼                           ▼
         ┌─────────────────────┐     ┌──────────────────┐
         │  Get Transaction ID │     │ Resolve via:     │
         └─────────┬───────────┘     │ - Composite      │
                   │                 │ - On-demand      │
                   ▼                 │ - Trusted GW     │
         ┌─────────────────────┐     └──────────────────┘
         │  Manifest?          │
         └────┬──────────┬─────┘
              │ Yes      │ No
              ▼          ▼
     ┌────────────┐  ┌──────────┐
     │  Resolve   │  │  Return  │
     │   Path     │  │   Data   │
     └────────────┘  └──────────┘
```

## Data Request Flow

```
┌──────────────────────────────────────┐
│    Request: /txId or /raw/txId      │
└─────────────┬────────────────────────┘
              │
              ▼
    ┌─────────────────────┐
    │  Envoy: Default     │
    │  Route → AR.IO GW   │
    └─────────┬───────────┘
              │
              ▼
    ┌─────────────────────┐     ┌──────────────────┐
    │  Data Router        │────▶│ Blocked Data?    │
    └─────────┬───────────┘     └────────┬─────────┘
              │                           │ No
              ▼                           ▼
    ┌─────────────────────┐     ┌──────────────────┐
    │  Raw Request?       │     │ Check Index      │
    └────┬──────────┬─────┘     └──────────────────┘
         │ Yes      │ No                  │
         ▼          ▼                     ▼
   ┌──────────┐ ┌────────────┐  ┌──────────────────┐
   │  Return  │ │  Process   │  │ Fetch from:      │
   │ Raw Data │ │ (manifest, │  │ - Cache          │
   └──────────┘ │  sandbox)  │  │ - S3             │
                └────────────┘  │ - Arweave        │
                                └──────────────────┘
```

## Admin Route Authentication Flow

```
┌────────────────────────────────────┐
│  Request: /ar-io/admin/*          │
└──────────────┬────────────────────┘
               │
               ▼
     ┌─────────────────────┐
     │  Bearer Token?      │
     └────┬──────────┬─────┘
          │ Yes      │ No
          ▼          ▼
  ┌───────────────┐  ┌─────────────┐
  │ Match API Key?│  │  Return 401 │
  └───┬─────┬─────┘  │ Unauthorized│
      │ Yes │ No     └─────────────┘
      ▼     ▼
┌──────────┐└─────────────┐
│ Process  │              │
│ Request  │              │
└──────────┘              │
                          ▼
                    ┌─────────────┐
                    │  Return 401 │
                    │ Unauthorized│
                    └─────────────┘
```

## Routing Dimensions

Based on the test file comments, the routing system handles multiple dimensions:

```
┌─────────────────────────────────────────────────────────────────┐
│                     ROUTING DIMENSIONS                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. SANDBOXING                                                  │
│     └─> Isolates content based on protocol/domain              │
│                                                                 │
│  2. SUBDOMAINS (ArNS)                                         │
│     ├─> Non-undername: name.arweave.net                       │
│     └─> Undername: name_undername.arweave.net                 │
│                                                                 │
│  3. APEX DOMAINS                                               │
│     ├─> Direct TX ID: arweave.net/txId                        │
│     └─> Names: arweave.net/name or /name_undername            │
│                                                                 │
│  4. MANIFESTS                                                   │
│     ├─> Versions: 0.1.0, 0.2.0                                │
│     ├─> Fallback handling                                      │
│     ├─> Index paths                                            │
│     └─> Path resolution                                         │
│                                                                 │
│  5. SPECIAL ROUTES                                             │
│     ├─> Built-in: /ar-io/*, /graphql, etc.                    │
│     ├─> Legacy: /tx/*, /block/*, etc.                         │
│     └─> External: /bundler/*, /ao/cu/*                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Route Priority Decision Tree

```
                        ┌────────────────┐
                        │ Incoming Request│
                        └────────┬───────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Is Subdomain Request?   │
                    │ (*.{ARNS_ROOT_HOST})    │
                    └────┬──────────────┬─────┘
                         │ Yes          │ No
                         ▼              ▼
                ┌────────────────┐ ┌─────────────────┐
                │ ArNS Resolution│ │ Check Path      │
                └────────────────┘ └────────┬────────┘
                                            │
                           ┌────────────────┴────────────────┐
                           │                                 │
                  ┌────────▼────────┐              ┌─────────▼────────┐
                  │ Special Routes? │              │ Legacy Routes?   │
                  │ (/graphql, etc) │              │ (/tx/*, etc)    │
                  └────────┬────────┘              └─────────┬────────┘
                           │ No                              │ No
                           ▼                                 ▼
                  ┌─────────────────┐              ┌──────────────────┐
                  │ Data Routes     │              │ Default Route    │
                  │ (/:id)          │              │ (catch-all)      │
                  └─────────────────┘              └──────────────────┘
```

## Service Communication Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              ENVOY PROXY                                │
│                                                                         │
│  ┌─────────────┐  ┌────────────┐  ┌──────────┐  ┌─────────┐  ┌──────┐ │
│  │ GraphQL     │  │  Bundler   │  │   AO CU  │  │ Observer│  │Legacy│ │
│  │  Cluster    │  │  Cluster   │  │  Cluster │  │ Cluster │  │ GW   │ │
│  └──────┬──────┘  └─────┬──────┘  └────┬─────┘  └────┬────┘  └───┬──┘ │
│         │               │              │              │            │     │
└─────────┼───────────────┼──────────────┼──────────────┼────────────┼─────┘
          │               │              │              │            │
          ▼               ▼              ▼              ▼            ▼
    ┌───────────┐  ┌─────────────┐ ┌─────────┐  ┌──────────┐  ┌─────────┐
    │ GraphQL   │  │Upload Service│ │  AO CU  │  │ Observer │  │ Legacy  │
    │ Service   │  │  (5100)     │ │ (6363)  │  │ Service  │  │Gateway  │
    └───────────┘  └─────────────┘ └─────────┘  └──────────┘  │ (HTTPS) │
                                                                └─────────┘
```