# AR.IO Node Routing Documentation

This document describes the routing architecture of the AR.IO Node, including both the Envoy proxy configuration and the TypeScript application routes.

## Overview

The AR.IO Node uses a two-layer routing architecture:
1. **Envoy Proxy** - Acts as the entry point, handling incoming requests on port 3000 and routing them to appropriate backend services
2. **Express Application** - Handles the actual request processing for AR.IO-specific functionality

## Envoy Routes

The Envoy proxy configuration defines the following route patterns:

### ArNS Resolution Routes

- **Domain**: `*.{ARNS_ROOT_HOST}`
- **Path**: `/` (all paths)
- **Backend**: `ario_gateways` cluster
- **Features**:
  - Timeout: Disabled (0s)
  - Retry policy: 5 retries on 5xx, reset, retriable-status-codes

### GraphQL Routes

- **Path**: `/graphql`
- **Backend**: `graphql_gateways` cluster
- **Features**:
  - Auto host rewrite enabled (for HTTPS connections)
  - Retry policy: 5 retries on 5xx, reset, retriable-status-codes, 404

### Bundler Routes

- **Paths**: `/bundler/`, `/bundler`
- **Backend**: `upload_service_cluster`
- **Features**:
  - Path rewrite: Removes `/bundler` prefix
  - Timeout: Disabled (0s)
  - Retry policy: 5 retries on 5xx, reset

### AO Compute Unit Routes

- **Paths**: `/ao/cu/`, `/ao/cu`
- **Backend**: `ao_service_cluster`
- **Features**:
  - Path rewrite: Removes `/ao/cu` prefix
  - Timeout: Disabled (0s)
  - Retry policy: 5 retries on 5xx, reset

### AR.IO Observer Routes

- **Path**: `/ar-io/observer`
- **Backend**: `observers` cluster
- **Features**:
  - Timeout: Disabled (0s)
  - Retry policy: 5 retries on 5xx, reset

### Legacy Gateway Routes

The following routes are proxied to legacy Arweave gateways with auto host rewrite and internal redirect support:

- `/info`
- `/current_block`
- `/height`
- `/tx/`, `/tx`
- `/unconfirmed_tx/`
- `/chunk/` (GET only)
- `/block/`
- `/price/`
- `/tx_anchor`
- `/wallet/`

**Features**:
- Auto host rewrite enabled
- Internal redirect policy: Max 10 redirects, allows cross-scheme
- Retry policy: 5 retries on 5xx, reset, retriable-status-codes

### Default Route

- **Path**: `/` (catch-all)
- **Backend**: `ario_gateways` cluster
- **Features**:
  - Cache-Control header: `public, max-age=30`
  - Retry policy: 5 retries on 5xx, reset, retriable-status-codes

## Express Application Routes

The Express application defines the following route modules:

### ArNS Routes (`/src/routes/arns.ts`)

- **GET `/ar-io/resolver/:name`** - Resolves ArNS names to transaction IDs
  - Returns: Transaction ID, TTL, process ID, resolution timestamp
  - Headers: `X-ArNS-Resolved-Id`, `X-ArNS-TTL-Seconds`, `X-ArNS-Process-Id`, etc.

### AR.IO Routes (`/src/routes/ar-io.ts`)

#### Public Endpoints

- **GET `/ar-io/healthcheck`** - Health status of the gateway
- **GET `/ar-io/info`** - Gateway information (wallet, process ID, filters, etc.)
- **GET `/ar-io/peers`** - List of connected gateways and Arweave nodes
- **GET `/ar-io/__gateway_metrics`** - Prometheus metrics endpoint

#### Admin Endpoints (require Bearer token authentication)

- **GET `/ar-io/admin/debug`** - Debug information
- **PUT `/ar-io/admin/block-data`** - Block access to specific data
- **PUT `/ar-io/admin/block-name`** - Block ArNS name resolution
- **PUT `/ar-io/admin/unblock-name`** - Unblock ArNS name resolution
- **POST `/ar-io/admin/queue-tx`** - Queue transaction for processing
- **POST `/ar-io/admin/queue-bundle`** - Queue bundle for processing
- **POST `/ar-io/admin/queue-data-item`** - Queue data items for indexing
- **GET `/ar-io/admin/bundle-status/:id`** - Get bundle processing status
- **POST `/ar-io/admin/export-parquet`** - Export data to Parquet format
- **GET `/ar-io/admin/export-parquet/status`** - Get Parquet export status
- **POST `/ar-io/admin/prune-stable-data-items`** - Prune stable data items

### Data Routes (`/src/routes/data/index.ts`)

- **GET `/:id`** - Retrieve data by transaction/data item ID
- **GET `/raw/:id`** - Retrieve raw data without processing
FIXME: this is under local I'm pretty sure
- **GET/POST `/farcaster/:id`** - Farcaster frame data support

### Chunk Routes (`/src/routes/chunk/index.ts`)

- **GET `/chunk/:offset`** - Retrieve chunk by offset (numeric only)
- **POST `/chunk`** - Submit new chunk data

### GraphQL Routes (`/src/routes/graphql/index.ts`)

- **`/graphql`** - GraphQL endpoint with Apollo Server
  - Playground available when introspection is enabled
  - Custom schema defined in `/schema/types.graphql`

### OpenAPI Routes (`/src/routes/openapi.ts`)

- **GET `/openapi.json`** - OpenAPI specification in JSON format
- **`/api-docs`** - Swagger UI documentation interface

FIXME: not sure this is a thing
### Root Route (`/src/routes/root.ts`)

- **GET `/`** - Returns gateway information (same as `/ar-io/info`)

## Route Priority Order

Routes are registered in the Express application in the following order:

1. ArNS routes (subdomain handling)
2. OpenAPI documentation
3. AR.IO specific routes
4. Chunk routes
5. Data routes
6. Root route

This order ensures that more specific routes are matched before general ones.

## Backend Clusters

The Envoy configuration defines the following backend clusters:

- **ario_gateways** - AR.IO gateway service (default: `localhost:4000`)
- **graphql_gateways** - GraphQL service (configurable host/port, supports HTTPS)
- **observers** - Observer service (configurable host/port)
- **legacy_gateways** - Legacy Arweave gateway (HTTPS, port 443)
- **upload_service_cluster** - Bundle upload service (port 5100)
- **ao_service_cluster** - AO compute unit service (port 6363)

## Security Features

- **CORS**: Enabled with exposed headers for browser compatibility
- **Admin Authentication**: Admin routes require Bearer token matching `ADMIN_API_KEY`
- **Content Validation**: Data blocking and name blocking capabilities
- **Rate Limiting**: Through retry policies and connection timeouts
- **TLS Support**: For external gateway connections

## Caching

- Default route responses include `Cache-Control: public, max-age=30` header
- ArNS resolutions include TTL information for client-side caching
