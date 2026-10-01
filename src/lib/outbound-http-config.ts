/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Settings of the shared outbound HTTP agents (`http-agent.ts`), read from the
 * environment here rather than in `src/config.ts` so a process that only makes
 * outbound requests (the `ar-io-node` CLI, say) can use the agents without
 * loading the gateway's whole configuration. `src/config.ts` re-exports them,
 * so `config.X` is unchanged.
 */
import * as env from './env.js';

// Idle-socket timeout (ms) for the outbound trusted-gateway keep-alive agent.
// MUST be strictly less than the peer gateway's server keep-alive timeout
// (HTTP_KEEP_ALIVE_TIMEOUT_MS, default 60000). Equal timeouts cause a keep-alive
// reuse race: the client reuses an idle socket at the same moment the server
// sends its idle-close FIN, and the request stalls until the teardown resolves
// (observed as ~8-10s peer stalls that sometimes exceed
// TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS and are canceled before the request is
// ever sent). Keeping the client's idle timeout below the server's guarantees
// the client retires a socket before the server closes it.
export const GATEWAY_AGENT_IDLE_SOCKET_TIMEOUT_MS = env.positiveIntOrDefault(
  'GATEWAY_AGENT_IDLE_SOCKET_TIMEOUT_MS',
  50_000,
);

// Outbound gateway socket acquisitions (time from a request needing a socket to
// a socket being assigned) at or above this threshold are logged at `warn`.
// Surfaces keep-alive pool waits and socket-reuse stalls that are invisible in
// request/response timing (the request hasn't hit the wire yet).
export const GATEWAY_SLOW_SOCKET_ACQUISITION_LOG_THRESHOLD_MS =
  env.positiveIntOrDefault(
    'GATEWAY_SLOW_SOCKET_ACQUISITION_LOG_THRESHOLD_MS',
    1000,
  );

// Socket caps for the non-data outbound clients — root TX discovery sources and
// the GraphQL fan-out. These are low-volume metadata lookups against a handful
// of upstreams, so the caps are modest; the point of pooling here is not
// throughput but avoiding a per-request `dns.lookup()`, which queues on the
// libuv threadpool behind filesystem I/O (see src/lib/http-agent.ts). Node's
// Agent keys its pool by host:port, so these apply per origin.
export const OUTBOUND_MAX_SOCKETS_PER_HOST = env.positiveIntOrDefault(
  'OUTBOUND_MAX_SOCKETS_PER_HOST',
  16,
);
// Defaults to the same value as OUTBOUND_MAX_SOCKETS_PER_HOST, deliberately.
// maxFreeSockets bounds *idle* sockets: any concurrency above it means the
// excess sockets are destroyed once they go idle and reopened on the next
// request — and every reopen is a fresh `dns.lookup()`, the exact cost this
// pooling exists to avoid. The data path caps free sockets well below max
// because its objective is throughput management against many hosts; here the
// objective is maximizing reuse across a handful of upstreams, so holding the
// full set idle is the point. Cost is a few idle sockets per origin, retired
// anyway by the agent's idle timeout.
export const OUTBOUND_MAX_FREE_SOCKETS_PER_HOST = env.positiveIntOrDefault(
  'OUTBOUND_MAX_FREE_SOCKETS_PER_HOST',
  OUTBOUND_MAX_SOCKETS_PER_HOST,
);
