# The `ar-io-node` CLI

`ar-io-node` is the gateway's command-line tool. Its first commands build and
check [index bands](index-swarm.md#producing-bands); every other command is a
command of the `ar.io` CLI from `@ar.io/sdk`, run with the same arguments.

It follows the `ar.io` CLI's conventions, so the two behave alike:

- flat, kebab-case command names (`index-band-build`, `get-gateway`);
- a command's result is printed as indented JSON on **stdout**, with exit code
  `0`;
- an error's message goes to **stderr** (its stack trace with `--debug`), with
  exit code `1`. A check that fails prints its full result, as JSON, on stderr;
- logs go to stderr too, so stdout can be parsed.

## Running it

From the gateway's directory (where `.env` and `docker-compose.yaml` are),
`tools/ar-io-node` runs it in the core image named by `CORE_IMAGE_TAG`, so the
host needs only Docker:

```bash
./tools/ar-io-node --help
./tools/ar-io-node network-help        # the ar.io commands it runs for you
```

The wrapper mounts only what a command needs:

| Commands | Mounted |
| --- | --- |
| `index-band-*` | `INDEX_SWARM_DATA_PATH` (default `./data/indexes`) at `data/indexes`, and the gateway's Docker network (`DOCKER_NETWORK_NAME`, default `ar-io-network`), so `--gateway-url http://core:4000` reaches the gateway |
| any `ar.io` command | Nothing, except the file a `--wallet-file` (`-w`) names, read-only. A relative path is taken from where you ran the wrapper |

It runs as your user, so what it writes is yours, and
`data/indexes/published/<index>` must be writable by you. A band command
refuses a `--publish-dir` or `--work-dir` outside `data/indexes`: anything
else would be written inside the container and lost with it. Ctrl-C stops a
command; a build interrupted that way leaves its scratch copy in
`data/indexes/export/.band-build-*`, which the next build removes once it is a
day old (or delete it yourself).

Band commands never take a key. For `ar.io` commands that sign, prefer
`--wallet-file` to `--private-key`: an inline key is visible in `ps` and
`docker inspect`.

Set `AR_IO_NODE_CLI_IMAGE` to run another image. From a checkout, run
`node --import ./register.js src/cli/cli.ts <command>`.

## `index-band-build`

Builds one band from CSV records, checks a sample of its headers against
their root transactions, and publishes it:

```bash
./tools/ar-io-node index-band-build \
  --publisher <this gateway's wallet> --kind d --height-range 2010500,tip \
  --gateway-url http://core:4000 --input - < records.csv
```

The band is built under `--work-dir` (default `data/indexes/export`) and
renamed into `--publish-dir` (default
`data/indexes/published/root-tx-index`), where the index-swarm sidecar
publishes it. Both must be on one filesystem. An existing band is never
overwritten: building the same records again reports `"unchanged": true`.

**Input:** CSV in the columns of `tools/generate-cdb64-root-tx-index`, plus a
height:

```text
data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size,height
```

Only the first two columns are required. `path` must be empty: bands don't
carry nested bundle paths yet. When one ID appears more than once, the
highest height wins; at equal heights a record with offsets beats one
without, and any remaining tie is broken the same way whatever the input
order, so a rebuild gives the same band id. A malformed row fails the build
with its line number; a well-formed record the band can't use (offsets that
don't frame a header, say) is dropped and counted.

| Option | Meaning |
| --- | --- |
| `--input <path>` | The CSV, or `-` for stdin. Required. Through `tools/ar-io-node`, only `data/indexes` is mounted, so pipe the CSV in on stdin or put it under `data/indexes` |
| `--skip-header` | Skip the CSV's first line |
| `--publisher <wallet>` | The publishing gateway's registered wallet; band ids are unique to it. Required |
| `--kind <kind>` | `d` (delta), `r` (recent), `h` (history), or another short name. Required |
| `--height-range <from,to>` | The heights the band covers; `tip` as the end for a band that follows the tip. Required |
| `--supersedes <ids>` | Comma-separated ids of the bands this one replaces |
| `--metadata <json>` | A JSON object of extra band metadata |
| `--gateway-url <url>` | The gateway that range-reads root transactions for the header check. Required unless `--skip-header-check` |
| `--skip-header-check` | Publish without the header check |
| `--sample-size <n>` | Entries the check samples (default 150) |
| `--dry-run` | Build and check, but publish nothing |

**The header check** samples entries with offsets and range-reads each one's
root transaction. A band fails if any header is wrong (its signature hash
isn't the ID, or it doesn't end where the payload starts, or the offsets run
past the end of the root), if fewer than 80% of the sample could be checked
and passed, or if the band has fewer than 1,000 entries. A failed band is not
published, and the command exits 1 with the result on stderr.

**Output:** the band's id and directory, whether it was published or already
was, its record counts (`records`, `rootOnly`, `duplicates`, `dropped`,
`sizeDropped`), its height range, what it supersedes, its content digest and
the header check's result.

## `index-band-verify`

Runs the header check on a built or installed band:

```bash
./tools/ar-io-node index-band-verify \
  --band-dir data/indexes/published/root-tx-index/<band> \
  --gateway-url http://core:4000
```

It prints the result (`passed`, `checked`, `ok`, and the `wrong` and
unchecked entries) and exits 1 if the band fails. `--sample-size` sets the
sample (default 150).

## For scripts and agents

Every `ar-io-node` command is non-interactive and answers in one shape, so a
script or an agent can drive it without parsing prose.

### The contract

| | Success | Failure |
| --- | --- | --- |
| Exit code | `0` | `1` (`130` when interrupted with Ctrl-C) |
| stdout | Exactly one JSON value, the command's result | Empty |
| stderr | Log lines (`info:`, `warn:`) only | Log lines, then either one line of error text, or (for a band refused by the header check, or a failed verify) the result as JSON |

- **Read stdout, branch on the exit code.** Never parse stderr for success;
  log lines may change.
- `--help`, `--version` and `network-help` print text, not JSON. Each
  command's `--help` ends with an example and this contract.
- **No prompts.** Band commands never ask for confirmation and never take a
  key. (`ar.io` commands that write do prompt unless given
  `--skip-confirmation`; see the SDK's own help.)
- **Safe to retry.** A band's id is derived from its content, publisher,
  kind and heights, so building the same records again gives the same id and
  reports `"unchanged": true` without writing. A build that fails or is
  interrupted publishes nothing.
- **No network** except range reads of root transactions from
  `--gateway-url` during the header check. Band commands make no Solana RPC
  calls.

### `index-band-build` result

```json
{
  "id": "d-h2010500-tip-f5b1208c-0dac038f25bc",
  "dir": "data/indexes/published/root-tx-index/d-h2010500-tip-f5b1208c-0dac038f25bc",
  "published": true,
  "unchanged": false,
  "dryRun": false,
  "records": 4000,
  "rootOnly": 0,
  "duplicates": 0,
  "dropped": 0,
  "sizeDropped": 0,
  "heightRange": [2010500, null],
  "supersedes": [],
  "contentDigest": "…",
  "headerCheck": {
    "passed": true,
    "reasons": [],
    "totalRecords": 4000,
    "checked": 150,
    "ok": 150,
    "wrong": [],
    "errors": []
  }
}
```

| Field | Meaning |
| --- | --- |
| `id`, `dir` | The band's id, and where it is (`null` on a dry run) |
| `published` / `unchanged` | `published` when this run published it; `unchanged` when an identical band was already there. A band is in place when either is true |
| `records` | Entries written. `rootOnly` of them have no offsets; `duplicates` were superseded by a better record for the same ID |
| `dropped` / `sizeDropped` | Records refused as invalid, and records whose size was dropped while their offsets were kept |
| `headerCheck` | The check's result; `"already-published"` when an identical band was already there (nothing is checked or written again); `"skipped"` with `--skip-header-check` |

A band the check refuses exits `1` and prints this object on stderr, with
`published: false` and a `rejected` array of reasons.

### `index-band-verify` result

`{ "bandDir", "passed", "reasons", "totalRecords", "checked", "ok", "wrong", "errors" }`.
`wrong` lists entries whose header doesn't match (`id`, `reason`); `errors`
lists entries the gateway couldn't serve (`id`, `error`), which count against
the 80% pass ratio but are not evidence the band is wrong. Exit `1`, with the
object on stderr, when `passed` is false.

### Example

```bash
out=$(./tools/ar-io-node index-band-build --input - --skip-header \
  --publisher "$WALLET" --kind d --height-range "$FROM,tip" \
  --gateway-url https://turbo-gateway.com < records.csv) || {
  echo "band refused or failed; see stderr" >&2; exit 1; }
id=$(jq -r .id <<<"$out")
jq -e '.published or .unchanged' <<<"$out" >/dev/null
```

### Choosing `--gateway-url`

The check range-reads up to 150 root transactions. A gateway that has to
fetch them from the network itself can time out on many of them, and the
band is then refused for being under 80% checked, not for being wrong (the
reason says how many couldn't be read, and why). Use a gateway that already
holds the roots, typically the one whose index produced the records, or
`https://turbo-gateway.com`; or raise `--read-timeout`. Measured on
2026-10-01 with 4,000 recent records: `http://core:4000` on a gateway without
those roots cached timed out on 42 of 150 reads at the 30 s default.

### Errors and what to do

| stderr says | Cause | Fix |
| --- | --- | --- |
| `--input … is required` (or `--publisher`, `--kind`, `--height-range`) | A required option is missing | Pass it |
| `--gateway-url is required unless --skip-header-check` | No gateway for the check | Pass `--gateway-url`, or `--skip-header-check` to publish unchecked |
| `--input X cannot be read; through tools/ar-io-node, pipe it on stdin …` | The wrapper mounts only `data/indexes` | `--input - < X`, or put X under `data/indexes` |
| `Line N: data_item_id is not a 43-character ID (a header line? use --skip-header)` | A header line, or a malformed ID | `--skip-header`, or fix line N |
| `Line N: nested bundle paths are not supported in bands yet` | The `path` column is set | Leave it empty |
| `Invalid --height-range: …` | Not `<from>,<to>` or `<from>,tip`, or `to` below `from` | Fix the range |
| `--publish-dir … is outside data/indexes …` | Through the wrapper, only `data/indexes` is mounted | Use a directory under it |
| `… checked entries passed, under 80%; N could not be read …` | The gateway couldn't serve enough roots | See [Choosing `--gateway-url`](#choosing---gateway-url) |
| `N of M checked entries are wrong` | Offsets that don't point at the item's header | Fix the source of the records; don't publish |
| `… exists but is not a band …` | Something else is at the band's path | Remove it |
| `workDir … and publishDir … must be on the same filesystem` | The final rename can't cross filesystems | Put both under one mount (the defaults are) |
| `ar-io-node: … predates this tool` | `CORE_IMAGE_TAG` names an image without the CLI | Upgrade, or set `AR_IO_NODE_CLI_IMAGE` |

## `ar.io` commands

Any command `ar-io-node` doesn't own runs as the `ar.io` CLI of the
`@ar.io/sdk` the gateway depends on (`ar-io-node --version` shows which), with
the same arguments, output and exit code:

```bash
./tools/ar-io-node get-gateway --address <wallet>
./tools/ar-io-node help get-gateway     # that command's help
./tools/ar-io-node network-help
```

They are the SDK's commands, unchanged: they read from Solana through the
SDK's own defaults (`--rpc-url` and the program-id options), not through the
gateway's settings, and the gateway itself never runs them.
