/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface HedgedRequestOptions<T> {
  candidates: string[];
  execute: (candidate: string, signal: AbortSignal) => Promise<T>;
  canAttempt?: (candidate: string) => boolean;
  acquire?: (candidate: string) => boolean;
  onRelease?: (candidate: string) => void;
  hedgeDelayMs: number;
  maxConcurrent: number;
  signal?: AbortSignal;
}

export async function executeHedgedRequest<T>(
  options: HedgedRequestOptions<T>,
): Promise<T> {
  const {
    candidates,
    execute,
    canAttempt,
    acquire,
    onRelease,
    hedgeDelayMs,
    maxConcurrent,
    signal,
  } = options;

  // Fail fast if client already aborted
  signal?.throwIfAborted();

  const loserController = new AbortController();
  const errors: Error[] = [];
  const activePromises = new Set<Promise<void>>();
  let resolved = false;
  let inFlight = 0;
  let candidateIndex = 0;
  let saturated = false;
  let pendingHedgeTimer: ReturnType<typeof setTimeout> | null = null;

  // Build the combined signal for each attempt
  function makeAttemptSignal(): AbortSignal {
    if (signal) {
      return AbortSignal.any([loserController.signal, signal]);
    }
    return loserController.signal;
  }

  return new Promise<T>((resolve, reject) => {
    function tryResolve(value: T) {
      if (resolved) return;
      resolved = true;
      loserController.abort();
      resolve(value);
    }

    function checkDone() {
      if (resolved) return;
      if (activePromises.size === 0 && candidateIndex >= candidates.length) {
        resolved = true;
        loserController.abort();
        reject(
          new AggregateError(errors, 'All hedged request candidates failed'),
        );
      }
    }

    function launchNext(): boolean {
      if (resolved) return false;

      // Check client abort
      if (signal?.aborted) {
        if (!resolved) {
          resolved = true;
          loserController.abort();
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }
        return false;
      }

      // Find next eligible candidate
      while (candidateIndex < candidates.length) {
        const candidate = candidates[candidateIndex];
        candidateIndex++;

        // Capacity check first — don't run acquire if we have no room
        if (inFlight >= maxConcurrent) {
          candidateIndex--; // put it back
          saturated = true;
          return false;
        }

        // Pure filter (no side effects)
        if (canAttempt && !canAttempt(candidate)) {
          continue;
        }

        // Atomic check-and-acquire
        if (acquire && !acquire(candidate)) {
          continue;
        }

        saturated = false;
        inFlight++;

        const attemptSignal = makeAttemptSignal();
        const promise = execute(candidate, attemptSignal)
          .then((result) => {
            tryResolve(result);
          })
          .catch((err) => {
            if (!resolved) {
              errors.push(err instanceof Error ? err : new Error(String(err)));
              // On immediate failure, try to launch next candidate right away
              // (don't wait for hedge delay); re-arm the timer from this new
              // launch so subsequent candidates maintain proper hedgeDelayMs
              // spacing rather than bursting close together
              if (launchNext()) {
                scheduleNextHedge();
              }
            }
          })
          .finally(() => {
            inFlight--;
            onRelease?.(candidate);
            activePromises.delete(promise);

            // Resume hedge chain if it was paused by saturation
            if (saturated && !resolved) {
              if (launchNext()) {
                scheduleNextHedge();
              }
            }

            checkDone();
          });

        activePromises.add(promise);
        return true;
      }

      return false;
    }

    // Listen for client abort
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          if (!resolved) {
            resolved = true;
            loserController.abort();
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          }
        },
        { once: true },
      );
    }

    // Launch first candidate immediately
    if (!launchNext()) {
      // No eligible candidates at all
      if (!resolved) {
        checkDone();
        if (!resolved) {
          resolved = true;
          reject(new Error('No eligible candidates available'));
        }
      }
      return;
    }

    // Sequential mode: hedgeDelayMs = 0 means only advance on failure
    if (hedgeDelayMs === 0) {
      return;
    }

    // Schedule hedge launches
    function scheduleNextHedge() {
      if (resolved) return;
      if (hedgeDelayMs === 0) return;
      if (candidateIndex >= candidates.length) return;

      // Cancel any existing timer so we re-arm from the most recent launch,
      // preventing burst when a candidate fails just before the timer fires
      if (pendingHedgeTimer !== null) {
        clearTimeout(pendingHedgeTimer);
        pendingHedgeTimer = null;
      }

      const timer = setTimeout(() => {
        pendingHedgeTimer = null;
        if (resolved) return;
        // Only continue the chain if a candidate was actually launched;
        // if saturated, .finally() will resume when a slot frees
        if (launchNext()) {
          scheduleNextHedge();
        }
      }, hedgeDelayMs);

      pendingHedgeTimer = timer;

      // Clean up timer if we resolve before it fires
      const cleanup = () => clearTimeout(timer);
      loserController.signal.addEventListener('abort', cleanup, { once: true });
    }

    scheduleNextHedge();
  });
}
