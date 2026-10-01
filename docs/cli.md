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
