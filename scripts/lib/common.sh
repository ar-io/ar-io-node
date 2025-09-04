#!/usr/bin/env bash

# AR.IO Gateway - Common Library Functions
# Shared utilities for AR.IO scripts to reduce code duplication

# Load environment variables from .env file
# Usage: load_env [path_to_env_file]
load_env() {
    local env_file="${1:-.env}"
    if [ -f "$env_file" ]; then
        set -a  # automatically export all variables
        # shellcheck disable=SC1090
        source "$env_file"
        set +a
    fi
}

# Load API key from file if ADMIN_API_KEY_FILE is set
# Usage: load_admin_api_key
load_admin_api_key() {
    if [ -n "${ADMIN_API_KEY_FILE:-}" ]; then
        if [ -f "${ADMIN_API_KEY_FILE}" ]; then
            ADMIN_API_KEY="$(tr -d '\n' < "${ADMIN_API_KEY_FILE}")"
            export ADMIN_API_KEY
        else
            echo "Error: ADMIN_API_KEY_FILE specified but file not found: ${ADMIN_API_KEY_FILE}" >&2
            return 1
        fi
    fi
}

# Load ClickHouse configuration with defaults
# Usage: load_clickhouse_config
load_clickhouse_config() {
    export CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-localhost}"
    export CLICKHOUSE_PORT="${CLICKHOUSE_PORT:-9000}"
    export CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
    export CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
}

# Log timing information (simple version for DEBUG mode)
# Usage: log_timing "operation_name" start_time_seconds end_time_seconds
log_timing() {
    if [ -n "${DEBUG:-}" ]; then
        local step_name="$1"
        local start_time="$2"
        local end_time="${3:-$(date +%s)}"
        local duration_s=$(( end_time - start_time ))
        local duration_min=$(( duration_s / 60 ))
        local duration_sec=$(( duration_s % 60 ))
        
        echo "TIMING: $step_name - ${duration_min}m ${duration_sec}s (total: ${duration_s}s)" >&2
    fi
}

# Log timing with millisecond precision (for detailed timing)
# Usage: log_timing_ms "operation_name" start_time_ns end_time_ns [show_always]
log_timing_ms() {
    local operation="$1"
    local start_time="$2"
    local end_time="${3:-$(date +%s%N)}"
    local show_always="${4:-false}"
    
    # Check if bc is available for precision timing
    if command -v bc >/dev/null 2>&1; then
        local duration=$(echo "scale=3; ($end_time - $start_time) / 1000000000" | bc)
        local duration_display="${duration}s"
    else
        # Fallback to second precision
        local start_s=$((start_time / 1000000000))
        local end_s=$((end_time / 1000000000))
        local duration=$((end_s - start_s))
        local duration_display="${duration}s"
    fi
    
    if [[ "$show_always" == "true" ]] || [[ "${SHOW_TIMING:-false}" == "true" ]] || [[ -n "${DEBUG:-}" ]]; then
        echo "  [TIMING] $operation: ${duration_display}" >&2
    fi
}

# Check for required commands
# Usage: require_commands command1 command2 ...
require_commands() {
    local missing=()
    for cmd in "$@"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done
    
    if [ ${#missing[@]} -gt 0 ]; then
        echo "Error: Required command(s) not found: ${missing[*]}" >&2
        echo "Please install the missing dependencies and try again." >&2
        return 1
    fi
}

# Create directory if it doesn't exist
# Usage: ensure_dir directory_path
ensure_dir() {
    local dir="$1"
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir" || {
            echo "Error: Failed to create directory: $dir" >&2
            return 1
        }
    fi
}

# Clean up function to be used with trap
# Usage: trap cleanup EXIT
cleanup() {
    local exit_code=$?
    if [ -n "${CLEANUP_DIRS:-}" ]; then
        for dir in $CLEANUP_DIRS; do
            if [ -d "$dir" ]; then
                echo "Cleaning up: $dir" >&2
                rm -rf "$dir"
            fi
        done
    fi
    exit $exit_code
}

# Log message with timestamp
# Usage: log "message"
log() {
    echo "[$(date -Iseconds)] $*"
}

# Log error message to stderr with timestamp
# Usage: log_error "error message"
log_error() {
    echo "[$(date -Iseconds)] ERROR: $*" >&2
}

# Log warning message to stderr with timestamp
# Usage: log_warn "warning message"
log_warn() {
    echo "[$(date -Iseconds)] WARN: $*" >&2
}

# Check if running in CI environment
# Usage: if is_ci; then ... fi
is_ci() {
    [ -n "${CI:-}" ] || [ -n "${CONTINUOUS_INTEGRATION:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]
}

# Get script directory (works even with symlinks)
# Usage: SCRIPT_DIR=$(get_script_dir)
get_script_dir() {
    local source="${BASH_SOURCE[0]}"
    while [ -h "$source" ]; do
        local dir="$(cd -P "$(dirname "$source")" && pwd)"
        source="$(readlink "$source")"
        [[ $source != /* ]] && source="$dir/$source"
    done
    cd -P "$(dirname "$source")" && pwd
}

# Export common paths
export SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROJECT_ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"