#!/usr/bin/env bash
# Show the progress of whatever scagent capability is running RIGHT NOW.
#
# Detection is by the live WORKER PROCESS, not by a log file — a job is "running" iff its worker
# process is alive, so this never false-negatives a job that is mid-setup or silent (an earlier
# version keyed off the on-disk log, which scagent-sdk only wrote AT COMPLETION, so it wrongly
# reported "nothing running" during a train and the agent then re-launched duplicates). scagent-sdk
# now tees the worker's stdout to the log live, so once detected we can also show the tail (epochs).
#
#   ./watchprogress.sh [--once] [<run_id>|--newest]
#     (no --once) stream progress, switching capabilities as they start; Ctrl-C to stop
#     --once      print the current job's status + log tail once and exit (agent-facing check)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/scagent_sessions"
PY=/data1/peerd/ibrahih3/scagent-sdk/.venv/bin/python
POLL=0.5

resolve_run() {
  # explicit run id / path
  if [ "${1:-}" != "" ] && [ "${1:-}" != "--newest" ]; then
    [ -d "$1" ] && { echo "$1"; return; }
    [ -d "$ROOT/$1" ] && { echo "$ROOT/$1"; return; }
  fi
  # active opencode session -> its durable run (session-map/current.txt + scagent-map.json)
  if [ "${1:-}" != "--newest" ]; then
    local run
    run="$("$PY" - "$HERE" <<'PYEOF' 2>/dev/null
import json, sys
from pathlib import Path
here = Path(sys.argv[1])
sid = (here / "session-map" / "current.txt")
sid = sid.read_text().strip() if sid.is_file() else ""
mp = here / "session-map" / "scagent-map.json"
m = json.loads(mp.read_text()) if mp.is_file() else {}
print(m.get(sid, ""))
PYEOF
)"
    [ -n "$run" ] && [ -d "$ROOT/$run" ] && { echo "$ROOT/$run"; return; }
  fi
  # fallback: newest run_* by mtime
  ls -dt "$ROOT"/run_*/ 2>/dev/null | head -1
}

ONCE=0
if [ "${1:-}" = "--once" ]; then ONCE=1; shift; fi

RUN="$(resolve_run "${1:-}")"
if [ -z "${RUN:-}" ] || [ ! -d "$RUN" ]; then
  echo "watchprogress: no run found under $ROOT" >&2
  exit 1
fi
RUN="${RUN%/}"
PENDING="$RUN/runtime/capabilities/pending"
if [ "$ONCE" != "1" ]; then
  echo "watchprogress: following $(basename "$RUN")  (Ctrl-C to stop)"
  echo "               $PENDING"
  echo
fi

# The staging dir whose worker PROCESS is alive right now (ground truth). Its execution id (the
# dir name) appears in the worker's command line, so pgrep on it is exact. Picks the most recently
# started if several. Killed/quarantined staging dirs have no live process, so they are skipped.
live_staging() {
  local d exec best="" bestmt=0 mt
  for d in "$PENDING"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"; exec="$(basename "$d")"
    [ -f "$d/.worker-input.json" ] || continue
    pgrep -f -- "$exec" >/dev/null 2>&1 || continue
    mt=$(stat -c %Y "$d/.worker-input.json" 2>/dev/null || echo 0)
    if [ "$mt" -ge "$bestmt" ]; then bestmt=$mt; best="$d"; fi
  done
  [ -n "$best" ] && printf '%s\n' "$best"
}

label_for() { # staging_dir -> "tool_name  [exec_id short]"
  local d="$1"
  local tool; tool="$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1])).get('tool_name',''))" "$d/.worker-input.json" 2>/dev/null)"
  echo "${tool:-?}  [$(basename "$d" | cut -c1-8)]"
}

elapsed_of() { # mtime of $1 -> "Nm SSs"
  local mt now s; mt=$(stat -c %Y "$1" 2>/dev/null || echo 0)
  [ "$mt" -eq 0 ] && { echo "?"; return; }
  now=$(date +%s); s=$((now - mt)); printf '%dm%02ds' $((s / 60)) $((s % 60))
}

if [ "$ONCE" = "1" ]; then
  stg="$(live_staging)"
  if [ -n "$stg" ]; then
    echo "▶ RUNNING: $(label_for "$stg")  ($(basename "$RUN"), elapsed $(elapsed_of "$stg/.worker-input.json"))"
    log="$stg/execution.stdout.log"
    if [ -s "$log" ]; then
      tail -n 25 "$log"
    else
      echo "(worker is running but has printed nothing yet — still loading data / in model setup)"
    fi
  else
    echo "No compute is currently running in $(basename "$RUN")."
    echo "If a background job was launched, it likely already finished — check the run's committed"
    echo "artifacts / durable state for the result. Do NOT relaunch it."
  fi
  exit 0
fi

cur=""      # staging dir currently being tailed
tailpid=""
cleanup() { [ -n "$tailpid" ] && kill "$tailpid" 2>/dev/null; }
trap 'cleanup; echo; echo "watchprogress: stopped."; exit 0' INT TERM

while true; do
  stg="$(live_staging)"
  if [ -n "$stg" ] && [ "$stg" != "$cur" ]; then
    cleanup
    cur="$stg"
    echo "──────────────────────────────────────────────────────────────"
    echo "▶ $(label_for "$stg")  (elapsed $(elapsed_of "$stg/.worker-input.json"))"
    echo "──────────────────────────────────────────────────────────────"
    tail -n +1 -F "$stg/execution.stdout.log" 2>/dev/null &
    tailpid=$!
  elif [ -z "$stg" ] && [ -n "$cur" ]; then
    cleanup; tailpid=""; cur=""
    echo
    echo "· idle — no compute running; waiting for the next capability …"
  fi
  sleep "$POLL"
done
