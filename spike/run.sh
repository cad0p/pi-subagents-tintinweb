#!/usr/bin/env bash
# Drives the spike extension in a hermetic agent dir. Typos in PI_SPIKE_* are the only knobs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="${PI_SPIKE_RUN_DIR:-/tmp/pi-spike-run}"
agent_dir="${PI_SPIKE_AGENT_DIR:-/tmp/pi-spike-agent}"
log="${PI_SPIKE_LOG:-/tmp/pi-spike.log}"
mkdir -p "$run_dir/sessions" "$agent_dir"
PI_CODING_AGENT_DIR="$agent_dir" PI_SPIKE_LOG="$log" PI_SPIKE_SLEEP="${PI_SPIKE_SLEEP:-40}" \
  exec pi --no-extensions \
    -e "$here/spike/spike-ext.ts" \
    -e "$here/src/index.ts" \
    --provider faux --model faux/faux-1 \
    --session-dir "$run_dir/sessions"
