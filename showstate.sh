#!/usr/bin/env bash
# Show scagent-sdk's durable facts for every session under scagent_sessions/.
# State is owned entirely by scagent-sdk; this just pretty-prints state.json.
root="$(cd "$(dirname "$0")" && pwd)/scagent_sessions"
PY=/data1/peerd/ibrahih3/scagent-sdk/.venv/bin/python
for d in "$root"/*/; do
  [ -f "$d/state.json" ] || continue
  echo "=== $(basename "$d") ==="
  "$PY" -c "import json,sys; s=json.load(open(sys.argv[1])); print('facts:', list(s.get('facts',{}))); print(json.dumps(s.get('facts',{}), indent=2, default=str)[:1200])" "$d/state.json"
  echo
done
