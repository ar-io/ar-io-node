#!/usr/bin/env bash
# shellcheck shell=bash
#
# AR.IO Gateway - L2 import job queue, sourced by clickhouse-auto-import.
#
# Defines process_l2_import_queue, which loads every job queued by
# `ar-io-node index-l2-import --target clickhouse` with the unchanged
# clickhouse-import, one at a time.

# The core image verifies parquet-l2 bands and queues each as a job in the
# Parquet exporter's layout under $l2_import_dir/queue/<job>/. This loop is
# ClickHouse's only writer of the staging tables (clickhouse-import truncates
# them, so two imports must never overlap), so it loads the jobs too, one at
# a time, between its own batches. A loaded job moves to done/ with
# loaded.json, keeping job.json and written.parquet for `--forget`; one that
# fails $l2_import_max_attempts times moves to failed/ with failed.txt, its
# Parquet data removed. The core reads both back into its ledger.
l2_import_dir="${ETL_STAGING_PATH:-./data/etl/staging}/l2-import"
l2_import_max_attempts=${CLICKHOUSE_AUTO_IMPORT_L2_MAX_ATTEMPTS:-3}
l2_import_poll_s=${CLICKHOUSE_AUTO_IMPORT_L2_POLL_INTERVAL:-60}
if ! [[ "$l2_import_poll_s" =~ ^[1-9][0-9]{0,5}$ ]]; then
    echo "Error: CLICKHOUSE_AUTO_IMPORT_L2_POLL_INTERVAL must be a whole number of seconds (1-999999), got '$l2_import_poll_s'" >&2
    exit 1
fi

process_l2_import_queue() {
    local queue="$l2_import_dir/queue"
    [ -d "$queue" ] || return 0
    local job_dir job partitions partition attempts started ok failed_partition
    for job_dir in "$queue"/*/; do
        [ -d "$job_dir" ] || continue
        job_dir=${job_dir%/}
        job=$(basename "$job_dir")
        if ! partitions=$(jq -er '.partitions[]' "$job_dir/job.json" 2>/dev/null); then
            echo "Warning: L2 import job $job has no readable job.json; moving it to failed/"
            mkdir -p "$l2_import_dir/failed"
            echo "unreadable job.json" >> "$job_dir/failed.txt"
            mv "$job_dir" "$l2_import_dir/failed/$job"
            echo "METRIC l2_import_job result=failed job=$job"
            continue
        fi
        echo "Loading L2 import job $job"
        started=$(date +%s)
        ok=true
        failed_partition=""
        for partition in $partitions; do
            import_args=(--input-dir "$job_dir" --partition "$partition")
            [ -n "${CLICKHOUSE_HOST:-}" ]     && import_args+=(--clickhouse-host "$CLICKHOUSE_HOST")
            [ -n "${CLICKHOUSE_PORT:-}" ]     && import_args+=(--clickhouse-port "$CLICKHOUSE_PORT")
            [ -n "${CLICKHOUSE_USER:-}" ]     && import_args+=(--clickhouse-user "$CLICKHOUSE_USER")
            [ -n "${CLICKHOUSE_PASSWORD:-}" ] && import_args+=(--clickhouse-password "$CLICKHOUSE_PASSWORD")
            # Keep every row transactions already holds: the gateway may have
            # exported an item of this band since the job was written.
            if ! CLICKHOUSE_IMPORT_KEEP_EXISTING=true \
                "${L2_IMPORT_CLICKHOUSE_IMPORT:-./scripts/clickhouse-import}" "${import_args[@]}"; then
                ok=false
                failed_partition=$partition
                break
            fi
        done
        if [ "$ok" = true ]; then
            mkdir -p "$l2_import_dir/done"
            # What --forget needs stays: job.json and written.parquet.
            rm -rf "$job_dir/blocks" "$job_dir/transactions" "$job_dir/tags"
            jq -n --arg job "$job" --argjson at "$(date +%s)" \
                '{job: $job, loadedAt: $at}' > "$job_dir/loaded.json"
            mv "$job_dir" "$l2_import_dir/done/$job"
            echo "METRIC l2_import_job result=loaded job=$job duration_s=$(( $(date +%s) - started ))"
        else
            attempts=$(( $(cat "$job_dir/attempts" 2>/dev/null || echo 0) + 1 ))
            echo "$attempts" > "$job_dir/attempts"
            if [ "$attempts" -ge "$l2_import_max_attempts" ]; then
                mkdir -p "$l2_import_dir/failed"
                echo "clickhouse-import failed on $failed_partition, attempt $attempts of $l2_import_max_attempts" >> "$job_dir/failed.txt"
                # Kept: job.json and written.parquet, so --forget finds rows
                # of partitions that did load. The band's data goes; the
                # gateway writes the band again later.
                rm -rf "$job_dir/blocks" "$job_dir/transactions" "$job_dir/tags"
                mv "$job_dir" "$l2_import_dir/failed/$job"
                echo "METRIC l2_import_job result=failed job=$job partition=$failed_partition"
            else
                echo "METRIC l2_import_job result=retry job=$job partition=$failed_partition attempt=$attempts"
            fi
            # A failing job may mean ClickHouse is unwell: leave the rest of
            # the queue for the next poll.
            return 0
        fi
    done
}
