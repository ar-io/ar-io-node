# ANS-104 unbundle indefinite hang report (root-cause candidates)

## Scope
This report focuses on calls *inside* `Ans104Unbundler.unbundle()` and `Ans104Parser.parseBundle()` that can wait forever without settling, beyond the already-known “no end-to-end timeout” observation.

## Findings

### 1) `await this.contiguousDataSource.getData(...)` can block forever before stream timeout is even armed
`parseBundle()` awaits `contiguousDataSource.getData(...)` *before* it attaches stall timeout to the returned stream. If `getData()` never resolves/rejects, `parseBundle()` never reaches stream timeout setup and `unbundle()` holds the fastq worker forever.

Relevant call site:
- `Ans104Parser.parseBundle()` awaits `this.contiguousDataSource.getData(...)`.

Concrete hang path in configured sources:
- The unbundler uses `backgroundContiguousDataSource` (`ReadThroughDataCache -> SequentialDataSource -> backgroundDataSources`).
- One configured source is `TxChunksDataSource`, where `getData()` awaits:
  - `chainSource.getTxField(id, 'data_root', signal)`
  - `chainSource.getTxOffset(id, signal)`
- There is no local deadline around those two awaits in `TxChunksDataSource`; if chain RPC/HTTP never settles, `getData()` never settles.

Why this is distinct from “no overall timeout”:
- This is a specific pre-stream await that can hang even when stream stall timeout is correctly implemented, because the stall timeout is not armed yet.

### 2) `pipeline(data.stream, writeStream, cb)` can be live-locked by drip-feed streams
After `getData()`, `parseBundle()` writes to a temp file using `pipeline(...)`. The only watchdog here is `attachStallTimeout(stream, this.streamTimeout)`, which detects quiet/stalled streams.

If upstream emits bytes frequently enough to avoid “stall” but never terminates (`end`) and never errors (slow-loris/drip-feed behavior), then:
- stall timer never fires,
- pipeline callback never runs,
- parse job is never enqueued to worker pool,
- `parseBundle()` promise never resolves/rejects,
- unbundler slot remains occupied indefinitely.

This is a specific intra-method wait point (`pipeline` completion), not just a generic statement about missing global timeout.

### 3) Worker-pool starvation can happen from *message-level wedging*, not only process exits
The earlier analysis covered pool depletion on code-0 exits. There is another concrete indefinite wait path:

- Parent enqueues a parse job and calls `worker.postMessage(job.message)`.
- Job completion depends on the worker eventually posting `UNBUNDLE_COMPLETE` or `UNBUNDLE_ERROR`.
- If worker code reaches a state where it keeps running but never emits either terminal message (e.g., blocked in worker-side async I/O/CPU loop or stuck before terminal post), the parent-side `job` remains assigned forever.
- That worker stops taking new work (`if (!job && queue.length) ...`), effectively shrinking usable concurrency without emitting an `exit` signal/respawn.
- Repeat enough times and queue drains stop progressing even with nominal pool size > 0.

This is an explicit unresolved await dependency in `parseBundle()` on terminal worker messages.

## Remediation options

### Option A (high confidence): add bounded deadlines at each blocking boundary
1. Wrap `contiguousDataSource.getData(...)` in a dedicated timeout (`UNBUNDLE_GET_DATA_TIMEOUT_MS`).
2. Add a *total* transfer deadline around pipeline completion (`UNBUNDLE_STREAM_TOTAL_TIMEOUT_MS`) in addition to stall timeout.
3. Add worker job timeout in parent (`UNBUNDLE_WORKER_JOB_TIMEOUT_MS`): reject job if terminal message not received in time; terminate and respawn worker.

Pros: deterministically breaks all three hangs.
Cons: must tune defaults to avoid false positives on very large bundles/slow disks.

### Option B: abort propagation + per-source mandatory deadline contract
Define a `ContiguousDataSource` contract: every implementation must either
- honor provided `AbortSignal`, and
- enforce internal max request duration.

Then pass a controller from `parseBundle` and abort on parent-side timeout.

Pros: systematic and reusable.
Cons: larger refactor; needs audit across all data source implementations.

### Option C: harden worker supervision
1. Keep per-job watchdog map in `Ans104Parser` keyed by worker/job id.
2. On timeout, mark job failed, terminate worker thread, respawn regardless of exit code.
3. Track `worker_busy_ms`, `jobs_timed_out_total`, and `jobs_abandoned_total` metrics.

Pros: directly addresses silent “worker alive but non-responsive” state.
Cons: can lose partial work; needs idempotent downstream behavior (already largely true via retry path).

## Recommended rollout plan
1. **Immediate hotfix**: Option A timeouts with conservative defaults + metrics.
2. **Near-term hardening**: Option C watchdog/terminate/respawn.
3. **Medium-term cleanup**: Option B interface contract and source audit.

## Verification strategy
- Unit tests with controllable promises/streams:
  - `getData()` promise never settles -> parse rejects on timeout.
  - drip-feed stream (no end/error, periodic bytes) -> total-stream timeout triggers.
  - worker never posts terminal message -> job timeout triggers terminate+respawn.
- Integration soak test with tiny worker pool (`ANS104_UNBUNDLE_WORKERS=1..2`) and fault-injected sources.
- Confirm metrics behavior:
  - in-flight gauge no longer pins indefinitely under injected faults,
  - timeout counters increment with bounded retry behavior.
