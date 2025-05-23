# AR.IO Node Routing Flow - Mermaid Diagrams

This document provides Mermaid flowcharts illustrating the routing logic of the AR.IO Node with proper decision nodes and control flow.

## High-Level Request Routing Flow

```mermaid
flowchart TD
    A[Client Request<br/>Port 3000] --> B{Envoy Proxy}
    
    B --> C{Is ArNS<br/>Subdomain?}
    C -->|Yes: *.ARNS_ROOT_HOST| D[Route to AR.IO Gateway]
    C -->|No| E{Check Path}
    
    E --> F{/graphql?}
    F -->|Yes| G[GraphQL Service]
    F -->|No| H{/bundler/*?}
    
    H -->|Yes| I[Upload Service<br/>Port 5100]
    H -->|No| J{/ao/cu/*?}
    
    J -->|Yes| K[AO CU Service<br/>Port 6363]
    J -->|No| L{/ar-io/observer?}
    
    L -->|Yes| M[Observer Service]
    L -->|No| N{Legacy Route?}
    
    N -->|Yes: /tx/*, /block/*, etc| O[Legacy Gateway<br/>HTTPS]
    N -->|No| P[Default Route<br/>AR.IO Gateway]
    
    D --> Q[Express App<br/>Port 4000]
    P --> Q
```

## Express Application Routing Flow

```mermaid
flowchart TD
    A[Express App<br/>Port 4000] --> B{Route Matching}
    
    B --> C{ArNS Router<br/>Match?}
    C -->|Yes| D[ArNS Handler]
    C -->|No| E{OpenAPI Router<br/>Match?}
    
    E -->|Yes: /openapi.json, /api-docs| F[OpenAPI Handler]
    E -->|No| G{AR.IO Router<br/>Match?}
    
    G -->|Yes: /ar-io/*| H{Admin Route?}
    H -->|Yes: /ar-io/admin/*| I{Has Bearer<br/>Token?}
    H -->|No| J[Public AR.IO Handler]
    
    I -->|Yes| K{Token Valid?}
    I -->|No| L[401 Unauthorized]
    K -->|Yes| M[Admin Handler]
    K -->|No| L
    
    G -->|No| N{Chunk Router<br/>Match?}
    N -->|Yes: /chunk/*| O[Chunk Handler]
    N -->|No| P{Data Router<br/>Match?}
    
    P -->|Yes: /:id, /raw/:id| Q[Data Handler]
    P -->|No| R{GraphQL?}
    
    R -->|Yes: /graphql| S[Apollo Server]
    R -->|No| T[Root Handler<br/>Default /]
```

## ArNS Resolution Flow

```mermaid
flowchart TD
    A[ArNS Request<br/>name.arweave.net/path] --> B{Is Subdomain<br/>Request?}
    
    B -->|Yes| C[Extract Name]
    B -->|No| D[Not ArNS]
    
    C --> E{Name Blocked?}
    E -->|Yes| F[Return 404]
    E -->|No| G{Check Name<br/>Format}
    
    G --> H{Has Undername?}
    H -->|Yes: name_under| I[Parse Undername]
    H -->|No| J[Simple Name]
    
    I --> K[Name Resolution]
    J --> K
    
    K --> L{Resolution<br/>Source?}
    L -->|Cache Hit| M[Return Cached]
    L -->|Cache Miss| N[Resolve Name]
    
    N --> O{Resolver Type}
    O -->|Composite| P[Composite Resolver]
    O -->|On-Demand| Q[On-Demand Resolver]
    O -->|Trusted GW| R[Trusted Gateway]
    
    P --> S[Get TX ID]
    Q --> S
    R --> S
    
    S --> T{Found TX ID?}
    T -->|No| U[Return 404]
    T -->|Yes| V{Is Manifest?}
    
    V -->|Yes| W[Resolve Path<br/>in Manifest]
    V -->|No| X[Return Data]
    
    W --> Y{Path Found?}
    Y -->|Yes| Z[Return Path Data]
    Y -->|No| AA{Has Fallback?}
    
    AA -->|Yes| AB[Return Fallback]
    AA -->|No| AC[Custom 404]
```

## Data Request Flow

```mermaid
flowchart TD
    A[Data Request] --> B{Request Type?}
    
    B -->|GET /:id| C[Regular Data]
    B -->|GET /raw/:id| D[Raw Data]
    B -->|GET/POST /farcaster/:id| E[Farcaster Frame]
    
    C --> F{Data Blocked?}
    D --> F
    E --> F
    
    F -->|Yes| G[Return 404]
    F -->|No| H{Check Index}
    
    H --> I{In Index?}
    I -->|No| J[Return 404]
    I -->|Yes| K{Raw Request?}
    
    K -->|Yes| L[Skip Processing]
    K -->|No| M{Is Manifest?}
    
    L --> N[Fetch Data]
    M -->|Yes| O[Process Manifest]
    M -->|No| P{Needs Sandbox?}
    
    O --> Q[Resolve Path]
    P -->|Yes| R[Add Sandbox Headers]
    P -->|No| S[Regular Headers]
    
    N --> T{Data Source?}
    T -->|Cache| U[Return from Cache]
    T -->|S3| V[Fetch from S3]
    T -->|Arweave| W[Fetch from Arweave]
    
    Q --> X[Return Resolved]
    R --> Y[Return Sandboxed]
    S --> Z[Return Data]
```

## Admin Authentication Flow

```mermaid
flowchart TD
    A[Admin Request<br/>/ar-io/admin/*] --> B{Has Authorization<br/>Header?}
    
    B -->|No| C[401 Unauthorized]
    B -->|Yes| D{Is Bearer<br/>Token?}
    
    D -->|No| C
    D -->|Yes| E[Extract Token]
    
    E --> F{Token Matches<br/>ADMIN_API_KEY?}
    F -->|No| C
    F -->|Yes| G{Route Type?}
    
    G -->|block-data| H[Block Data Handler]
    G -->|block-name| I[Block Name Handler]
    G -->|queue-tx| J[Queue TX Handler]
    G -->|queue-bundle| K[Queue Bundle Handler]
    G -->|export-parquet| L[Export Handler]
    G -->|Other| M[Other Admin Handler]
    
    H --> N[Update Block List]
    I --> O[Update Name Blocks]
    J --> P[Add to Queue]
    K --> Q{Bypass Filter?}
    
    Q -->|Yes| R[Direct Queue]
    Q -->|No| S[Normal Queue]
```

## Manifest Processing Flow

```mermaid
flowchart TD
    A[Manifest Request] --> B{Manifest Version?}
    
    B -->|0.1.0| C[V0.1 Parser]
    B -->|0.2.0| D[V0.2 Parser]
    B -->|Unknown| E[Error]
    
    C --> F[Parse Manifest]
    D --> F
    
    F --> G{Valid Manifest?}
    G -->|No| H[Return Error]
    G -->|Yes| I{Has Requested<br/>Path?}
    
    I -->|No| J{Has Index?}
    I -->|Yes| K[Get Path Entry]
    
    J -->|No| L{Has Fallback?}
    J -->|Yes| M[Use Index Path]
    
    L -->|No| N[404 Not Found]
    L -->|Yes| O[Use Fallback]
    
    K --> P{Path Exists?}
    P -->|No| L
    P -->|Yes| Q[Get Path TX ID]
    
    M --> Q
    O --> Q
    
    Q --> R{Protected Route?}
    R -->|Yes| S[Apply Protection]
    R -->|No| T[Fetch Data]
    
    S --> T
    T --> U[Return Data]
```

## Service Communication Overview

```mermaid
flowchart LR
    subgraph Envoy["Envoy Proxy (Port 3000)"]
        EP[Route Matcher]
    end
    
    subgraph Internal["Internal Services"]
        ARIO[AR.IO Gateway<br/>Port 4000]
        GQL[GraphQL Service]
        OBS[Observer Service]
    end
    
    subgraph External["External Services"]
        BUNDLE[Upload Service<br/>Port 5100]
        AO[AO CU Service<br/>Port 6363]
        LEGACY[Legacy Gateway<br/>HTTPS]
    end
    
    EP -->|ArNS & Default| ARIO
    EP -->|/graphql| GQL
    EP -->|/ar-io/observer| OBS
    EP -->|/bundler/*| BUNDLE
    EP -->|/ao/cu/*| AO
    EP -->|Legacy Routes| LEGACY
```

## Routing Decision Tree

```mermaid
flowchart TD
    A[Incoming Request] --> B{Domain Type?}
    
    B -->|Subdomain| C{*.ARNS_ROOT_HOST?}
    B -->|Apex| D{Path Analysis}
    
    C -->|Yes| E[ArNS Resolution]
    C -->|No| F[Regular Subdomain]
    
    D --> G{Special Route?}
    G -->|Yes| H{Route Type?}
    G -->|No| I{Legacy Route?}
    
    H -->|/graphql| J[GraphQL Handler]
    H -->|/bundler/*| K[Bundler Proxy]
    H -->|/ao/cu/*| L[AO Proxy]
    H -->|/ar-io/*| M[AR.IO Routes]
    
    I -->|Yes: /tx/*, etc| N[Legacy Proxy]
    I -->|No| O{Data Route?}
    
    O -->|Yes: /:id| P[Data Handler]
    O -->|No| Q[Default Handler]
    
    E --> R{Manifest?}
    R -->|Yes| S[Manifest Router]
    R -->|No| T[Direct Data]
    
    S --> U{Protected?}
    U -->|Yes| V[Sandbox Response]
    U -->|No| W[Regular Response]
```

## Error Handling Flow

```mermaid
flowchart TD
    A[Request Processing] --> B{Error Type?}
    
    B -->|Not Found| C[404 Response]
    B -->|Unauthorized| D[401 Response]
    B -->|Server Error| E[500 Response]
    B -->|Bad Request| F[400 Response]
    
    C --> G{Has Custom 404?}
    G -->|Yes| H[Custom 404 Page]
    G -->|No| I[Default 404]
    
    D --> J[WWW-Authenticate Header]
    E --> K{Retry Available?}
    
    K -->|Yes| L[Retry Request]
    K -->|No| M[Return Error]
    
    L --> N{Retry Count?}
    N -->|< 5| O[Retry]
    N -->|>= 5| M
```

## Notes

- Decision nodes (diamonds) represent conditional logic
- Process nodes (rectangles) represent actions or handlers
- The flows show the actual control logic implemented in the AR.IO Node
- Protected routes include special handling for sandboxing and security
- Custom 404s can be configured for ArNS names (current) and will support ANTs (future)
- All admin routes require Bearer token authentication
- The system supports multiple resolver types for flexibility and performance