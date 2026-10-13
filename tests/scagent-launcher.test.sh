#!/usr/bin/env bash
# Launcher tests with a fake opencode: layout, config layers, and the env opencode receives.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SDK="$(cd -P "${SCAGENT_SDK_ROOT:-$ROOT/../scagent-sdk}" && pwd)"
PYTHON="${SCAGENT_PYTHON:-$SDK/.venv/bin/python}"
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

export XDG_CONFIG_HOME="$TMP/config" XDG_STATE_HOME="$TMP/state"
unset SCAGENT_WORKSPACE SCAGENT_SESSIONS_DIR SCAGENT_STATE_DIR SCAGENT_SITE_CONFIG OPENCODE_CONFIG_CONTENT
WORKSPACE="$TMP/workspace"
FAKE="$TMP/opencode"
mkdir -p "$WORKSPACE"

cat >"$FAKE" <<'FAKEEOF'
#!/usr/bin/env bash
printf 'args='; printf '<%s>' "$@"; printf '\n'
printf 'sessions=%s\n' "$SCAGENT_SESSIONS_DIR"
printf 'state=%s\n' "$SCAGENT_STATE_DIR"
printf 'config_dir=%s\n' "${OPENCODE_CONFIG_DIR:-}"
printf 'claude=%s share=%s\n' "${OPENCODE_DISABLE_CLAUDE_CODE:-}" "${OPENCODE_DISABLE_SHARE:-}"
printf 'path0=%s\n' "${PATH%%:*}"
printf 'inline=%s\n' "$OPENCODE_CONFIG_CONTENT"
FAKEEOF
chmod +x "$FAKE"
export SCAGENT_PYTHON="$PYTHON" SCAGENT_OPENCODE_BIN="$FAKE"

field() { sed -n "s/^$1=//p" <<<"$2"; }
inline_get() { "$PYTHON" -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2], {'d': d}))" "$(field inline "$1")" "$2"; }

# New folder: analyses visible in the workspace, bookkeeping in the user's state dir.
out="$("$ROOT/scagent" run --workspace "$WORKSPACE" hello)"
grep -Fq "args=<run><--dir><$WORKSPACE><hello>" <<<"$out"
test "$(field sessions "$out")" = "$WORKSPACE/scagent_sessions"
case "$(field state "$out")" in "$XDG_STATE_HOME/scagent/workspaces/"*) ;; *) echo "bad state dir"; exit 1;; esac
test -d "$(field state "$out")"
test ! -e "$WORKSPACE/.scagent"
test ! -e "$WORKSPACE/scagent_sessions"   # created by the first tool call, not by launching
grep -Fq "config_dir=$ROOT/.opencode" <<<"$out"
grep -Fq "claude=1 share=1" <<<"$out"
grep -Fq "path0=$ROOT" <<<"$out"
test "$(inline_get "$out" "d['mcp']['scagent']['environment']['SCAGENT_SDK_SESSIONS_DIR']")" = "$WORKSPACE/scagent_sessions"
test "$(inline_get "$out" "d['tools']['skill']")" = "False"
test "$(inline_get "$out" "d['model']")" = "iscp001/Qwen3.8-27B"
test -f "$XDG_CONFIG_HOME/scagent/opencode.json"   # personal config created on first launch

# Default folder is the current directory.
here="$(cd "$WORKSPACE" && "$ROOT/scagent" run hello)"
test "$(field sessions "$here")" = "$WORKSPACE/scagent_sessions"

# Config layers: lab file overrides defaults, personal file (with comments) overrides lab.
cat >"$TMP/site.json" <<'EOF'
{"model": "lab/model-a", "provider": {"lab": {"options": {"baseURL": "http://lab:1/v1"}, "models": {"model-a": {}}}}}
EOF
layered="$(SCAGENT_SITE_CONFIG="$TMP/site.json" "$ROOT/scagent" run -C "$WORKSPACE" hi)"
test "$(inline_get "$layered" "d['model']")" = "lab/model-a"
test "$(inline_get "$layered" "sorted(d['provider'])")" = "['lab']"   # lab list replaces shipped list
cat >"$XDG_CONFIG_HOME/scagent/opencode.json" <<'EOF'
// mine
{
  "model": "iscp001/Qwen3.8-27B", /* back to the default */
  "provider": {"mine": {"options": {"baseURL": "http://me:1/v1"}, "models": {"m": {}}}},
  "mcp": {"scagent": {"command": ["evil"]}},
}
EOF
mine="$(SCAGENT_SITE_CONFIG="$TMP/site.json" "$ROOT/scagent" run -C "$WORKSPACE" hi)"
test "$(inline_get "$mine" "d['model']")" = "iscp001/Qwen3.8-27B"
test "$(inline_get "$mine" "sorted(d['provider'])")" = "['lab', 'mine']"   # yours adds on top
test "$(inline_get "$mine" "d['mcp']['scagent']['command'][-1].endswith('mcp_server/server.py')")" = "True"

# Folders made by earlier versions keep their .scagent/ layout.
old="$TMP/old"
mkdir -p "$old/.scagent/scagent_sessions" "$old/.scagent/session-map"
legacy="$("$ROOT/scagent" run -C "$old" hi)"
test "$(field sessions "$legacy")" = "$old/.scagent/scagent_sessions"
test "$(field state "$legacy")" = "$old/.scagent/session-map"

# A symlinked launcher (e.g. ~/.local/bin/scagent or a release bin/) still finds everything.
mkdir -p "$TMP/bin"
ln -s "$ROOT/scagent" "$TMP/bin/scagent"
linked="$(cd "$WORKSPACE" && "$TMP/bin/scagent" run hello)"
grep -Fq "config_dir=$ROOT/.opencode" <<<"$linked"
grep -Fq "path0=$TMP/bin" <<<"$linked"

# state / config / help work without opencode.
state="$("$ROOT/scagent" state -C "$WORKSPACE")"
grep -Fq "No scagent sessions found under $WORKSPACE/scagent_sessions" <<<"$state"
"$ROOT/scagent" config -C "$WORKSPACE" | grep -Fq "Default model: iscp001/Qwen3.8-27B"
"$ROOT/scagent" help | grep -Fq "scagent doctor"
"$ROOT/scagent" config show -C "$WORKSPACE" | grep -Fq "$WORKSPACE/scagent_sessions"   # -C after other args
late="$("$ROOT/scagent" run hello -C "$WORKSPACE" -- -C literal)"
grep -Fq "args=<run><--dir><$WORKSPACE><hello><-C><literal>" <<<"$late"

echo "launcher tests passed"
