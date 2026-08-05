/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import winston from 'winston';

import * as config from '../config.js';
import * as metrics from '../metrics.js';

/**
 * Base keep-alive agent options shared by every outbound HTTP client.
 *
 * Reusing TCP+TLS connections across requests avoids per-request handshake
 * cost, slashes kernel TIME_WAIT churn, and — the reason this module exists —
 * avoids a per-request `dns.lookup()`.
 *
 * Node resolves hostnames through `dns.lookup()`, which dispatches
 * `getaddrinfo` to the **libuv threadpool**, the same pool that serves all
 * filesystem I/O. On a data-serving node the fs load can saturate that pool,
 * at which point DNS lookups queue behind it and requests time out *before a
 * socket is ever opened* — the client's timeout fires while the lookup is
 * still queued. A pooled connection skips resolution entirely on every request
 * after the first, which removes the hot path from the threadpool's reach.
 * Requests addressed by IP literal are unaffected either way, because Node
 * skips `getaddrinfo` for them.
 */
export const BASE_AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  // Idle-socket timeout: must stay strictly below the peer's server keep-alive
  // timeout (HTTP_KEEP_ALIVE_TIMEOUT_MS, default 60s) so this client retires an
  // idle keep-alive socket before the peer closes it. Equal timeouts race — the
  // client reuses a socket the server is simultaneously FIN-closing — stalling
  // the request until the teardown resolves. See
  // GATEWAY_AGENT_IDLE_SOCKET_TIMEOUT_MS in config.ts.
  timeout: config.GATEWAY_AGENT_IDLE_SOCKET_TIMEOUT_MS,
} as const;

export interface AgentPairOptions {
  /**
   * Max concurrent sockets **per origin**. Node's Agent keys its socket pool by
   * host:port, so one agent instance yields a per-host cap even when the client
   * talks to several hosts.
   */
  maxSockets?: number;
  /** Max idle keep-alive sockets retained per origin. */
  maxFreeSockets?: number;
}

export interface AgentPair {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

/**
 * Instruments an agent's socket lifecycle so outbound-side stalls that never
 * reach the wire are visible.
 *
 * Node calls `Agent.addRequest` when a ClientRequest needs a socket; the
 * request's `socket` event fires once one is assigned (immediately when the
 * pool has a free socket, or after a wait when it is at capacity or a reused
 * socket is being torn down). Timing `addRequest` → `socket` isolates the
 * keep-alive pool/reuse phase from the request/response phase; connect time is
 * measured separately for newly opened sockets.
 *
 * @param agent - the agent to wrap (mutated in place).
 * @param observe - receives each measurement; callers map it onto whichever
 *   metric carries the right labels for their call site.
 * @param isTls - whether to measure to `secureConnect` (TCP + TLS) rather than
 *   `connect` (TCP only).
 */
export function instrumentAgent({
  agent,
  observe,
  isTls,
}: {
  agent: http.Agent | https.Agent;
  observe: (sample: {
    acquisitionSeconds: number;
    reused: boolean;
    connectSeconds?: number;
  }) => void;
  isTls: boolean;
}): void {
  // `addRequest` is not in the public type surface; wrap it on the instance.
  const agentAny = agent as unknown as {
    addRequest: (req: http.ClientRequest, ...rest: unknown[]) => void;
  };
  const originalAddRequest = agentAny.addRequest.bind(agent);
  agentAny.addRequest = function (
    req: http.ClientRequest,
    ...rest: unknown[]
  ): void {
    const requestedAt = performance.now();
    req.once('socket', (socket: import('node:net').Socket) => {
      const acquisitionSeconds = (performance.now() - requestedAt) / 1000;
      const isNewSocket = socket.connecting === true;
      observe({ acquisitionSeconds, reused: !isNewSocket });
      if (isNewSocket) {
        const connectStartedAt = performance.now();
        socket.once(isTls ? 'secureConnect' : 'connect', () => {
          observe({
            acquisitionSeconds,
            reused: false,
            connectSeconds: (performance.now() - connectStartedAt) / 1000,
          });
        });
      }
    });
    return originalAddRequest(req, ...rest);
  };
}

/**
 * Creates a matched http/https keep-alive agent pair for a single outbound
 * client, ready to hand to `axios.create({ httpAgent, httpsAgent })`.
 *
 * A *pair* rather than a per-host pool: these clients each talk to a handful of
 * upstreams over one axios instance and may mix schemes (an internal `http://`
 * peer alongside a public `https://` endpoint), and axios selects the agent by
 * the request's protocol. Node's Agent already pools per origin internally, so
 * one pair gives per-host socket caps without a pool keyed by URL.
 *
 * Both agents are instrumented under `client`, a low-cardinality label naming
 * the calling component (not the destination host).
 *
 * @param client - stable component name used as the metric label.
 * @param log - optional logger for the slow-acquisition warning. Omit it where
 *   the call site has no logger in scope; metrics are emitted either way and
 *   they, not the log line, are the primary signal.
 * @param options - per-origin socket caps; sensible defaults when omitted.
 */
export function createAgentPair({
  client,
  log,
  options = {},
}: {
  client: string;
  log?: winston.Logger;
  options?: AgentPairOptions;
}): AgentPair {
  const agentOptions = {
    ...BASE_AGENT_OPTIONS,
    maxSockets: options.maxSockets ?? config.OUTBOUND_MAX_SOCKETS_PER_HOST,
    maxFreeSockets:
      options.maxFreeSockets ?? config.OUTBOUND_MAX_FREE_SOCKETS_PER_HOST,
  };

  const httpAgent = new http.Agent(agentOptions);
  const httpsAgent = new https.Agent(agentOptions);
  const slowThresholdMs =
    config.GATEWAY_SLOW_SOCKET_ACQUISITION_LOG_THRESHOLD_MS;

  for (const [agent, isTls] of [
    [httpAgent, false],
    [httpsAgent, true],
  ] as const) {
    instrumentAgent({
      agent,
      isTls,
      observe: ({ acquisitionSeconds, reused, connectSeconds }) => {
        if (connectSeconds !== undefined) {
          metrics.outboundSocketConnectSeconds.observe(
            { client },
            connectSeconds,
          );
          return;
        }
        metrics.outboundSocketAcquisitionSeconds.observe(
          { client, reused: String(reused) },
          acquisitionSeconds,
        );
        if (acquisitionSeconds * 1000 >= slowThresholdMs) {
          log?.warn('Slow outbound socket acquisition', {
            client,
            acquisitionMs: Math.round(acquisitionSeconds * 1000),
            reused,
          });
        }
      },
    });
  }

  return { httpAgent, httpsAgent };
}
