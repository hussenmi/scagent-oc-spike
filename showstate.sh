#!/usr/bin/env bash
# Show scagent-sdk's durable facts for every session in this workspace.
# State is owned entirely by scagent-sdk; this just pretty-prints state.json.
here="$(cd "$(dirname "$0")" && pwd -P)"
runtime_root="${SCAGENT_RUNTIME_DIR:-$here}"
root="$runtime_root/scagent_sessions"
PY="${SCAGENT_PYTHON:-/data1/peerd/ibrahih3/scagent-sdk/.venv/bin/python}"
found=0
for d in "$root"/*/; do
  [ -f "$d/state.json" ] || continue
  found=1
  echo "=== $(basename "$d") ==="
  "$PY" -c "import json,sys; s=json.load(open(sys.argv[1])); print('facts:', list(s.get('facts',{}))); print(json.dumps(s.get('facts',{}), indent=2, default=str)[:1200])" "$d/state.json"
  echo
done
[ "$found" -eq 1 ] || echo "No scagent sessions found under $root"
