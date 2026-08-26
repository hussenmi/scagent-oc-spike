#!/usr/bin/env bash
# Live-tail the worker output of whatever scagent capability is running RIGHT NOW.
#
# The opencode TUI cannot show live progress from an MCP tool call (opencode 1.18.x
# discards MCP progress-notification `message` — it uses progress only to reset the
# request timeout). But scagent-sdk streams the worker's stdout (scVI epoch bars,
# tqdm, scimilarity, cellbender) UNBUFFERED to a log on disk as it runs:
#     <run>/runtime/capabilities/pending/<execution_id>/execution.stdout.log
# while the tool is executing, then moves it under artifacts/capabilities/ on commit.
#
# This watcher follows that live log in a SIDE terminal so you can watch progress
# while the model sits blocked on the (synchronous) MCP call. It auto-switches to
# the next capability when a new execution starts, and labels each by its tool name
# (read from the staging .worker-input.json).
#
# Usage:
#   ./watchprogress.sh              # follow the ACTIVE opencode session's run
#   ./watchprogress.sh <run_id>     # follow a specific run_*  (e.g. run_2026...)
#   ./watchprogress.sh --newest     # follow the newest run_* on disk
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/scagent_sessions"
PY=/data1/peerd/ibrahih3/scagent-sdk/.venv/bin/python
POLL=0.5
# A live worker keeps writing to its log, so its mtime stays recent. Failed/quarantined
# staging dirs linger in pending/ with old, empty logs (one per capability.execution_failed)
# — this freshness gate ignores them so we only follow a capability that is actually running.
# A committing capability MOVES its staging out of pending/ atomically, so the log simply
# vanishes and we go idle; FRESH only needs to exclude stale leftovers, not detect commit.
FRESH=120

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

RUN="$(resolve_run "${1:-}")"
if [ -z "${RUN:-}" ] || [ ! -d "$RUN" ]; then
  echo "watchprogress: no run found under $ROOT" >&2
  exit 1
fi
RUN="${RUN%/}"
PENDING="$RUN/runtime/capabilities/pending"
echo "watchprogress: following $(basename "$RUN")  (Ctrl-C to stop)"
echo "               $PENDING"
echo

# Newest *live* worker log: a pending execution.stdout.log touched within FRESH seconds.
# The freshness gate skips stale failed/quarantined staging dirs (old, untouched logs).
newest_pending_log() {
  find "$PENDING" -mindepth 2 -maxdepth 2 -name execution.stdout.log \
       -newermt "-${FRESH} seconds" -printf '%T@\t%p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -f2-
}

label_for() { # staging_dir -> "tool_name  (exec_id short)"
  local d="$1" wi="$1/.worker-input.json"
  local tool exec
  tool="$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1])).get('tool_name',''))" "$wi" 2>/dev/null)"
  exec="$(basename "$d")"
  echo "${tool:-?}  [${exec:0:8}]"
}

cur=""      # log file currently being tailed
tailpid=""
cleanup() { [ -n "$tailpid" ] && kill "$tailpid" 2>/dev/null; }
trap 'cleanup; echo; echo "watchprogress: stopped."; exit 0' INT TERM

while true; do
  log="$(newest_pending_log)"
  if [ -n "$log" ] && [ "$log" != "$cur" ]; then
    cleanup
    cur="$log"
    stg="$(dirname "$log")"
    echo "──────────────────────────────────────────────────────────────"
    echo "▶ $(label_for "$stg")"
    echo "──────────────────────────────────────────────────────────────"
    # -F follows across truncation/rotation; start from the top of this fresh log.
    tail -n +1 -F "$log" 2>/dev/null &
    tailpid=$!
  elif [ -z "$log" ] && [ -n "$cur" ]; then
    # the running capability committed (pending emptied); detach and wait for the next.
    cleanup; tailpid=""; cur=""
    echo
    echo "· idle — waiting for the next capability …"
  fi
  sleep "$POLL"
done
