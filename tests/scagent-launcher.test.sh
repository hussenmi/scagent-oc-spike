#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SDK_CONFIG="$(cd -P "${SCAGENT_SDK_ROOT:-$ROOT/../scagent-sdk}" && pwd)/configs/opencode/iris.json"
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

WORKSPACE="$TMP/workspace"
FAKE="$TMP/opencode"
mkdir -p "$WORKSPACE"

cat >"$FAKE" <<'FAKEEOF'
#!/usr/bin/env bash
printf 'args='; printf '<%s>' "$@"; printf '\n'
printf 'runtime=%s\n' "$SCAGENT_RUNTIME_DIR"
printf 'config=%s\n' "${OPENCODE_CONFIG:-}"
printf 'config_dir=%s\n' "${OPENCODE_CONFIG_DIR:-}"
printf 'inline=%s\n' "$OPENCODE_CONFIG_CONTENT"
FAKEEOF
chmod +x "$FAKE"

out="$(SCAGENT_PYTHON=python3 SCAGENT_OPENCODE_BIN="$FAKE" "$ROOT/scagent" run --workspace "$WORKSPACE" hello)"
expected_runtime="$WORKSPACE/.scagent"

grep -Fq "args=<run><--dir><$WORKSPACE><hello>" <<<"$out"
grep -Fq "runtime=$expected_runtime" <<<"$out"
grep -Fq "config=$SDK_CONFIG" <<<"$out"
grep -Fq "config_dir=$ROOT/.opencode" <<<"$out"
grep -Fq "\"SCAGENT_SDK_SESSIONS_DIR\":\"$expected_runtime/scagent_sessions\"" <<<"$out"
test -d "$expected_runtime/session-map"
test -d "$expected_runtime/scagent_sessions"

legacy="$(cd "$ROOT" && SCAGENT_PYTHON=python3 SCAGENT_OPENCODE_BIN="$FAKE" "$ROOT/scagent" run hello)"
grep -Fq "runtime=$ROOT" <<<"$legacy"
grep -Fq "config=$SDK_CONFIG" <<<"$legacy"
grep -Fq "config_dir=$ROOT/.opencode" <<<"$legacy"

mkdir -p "$TMP/bin"
ln -s "$ROOT/scagent" "$TMP/bin/scagent"
linked="$(cd "$WORKSPACE" && SCAGENT_PYTHON=python3 SCAGENT_OPENCODE_BIN="$FAKE" "$TMP/bin/scagent" run hello)"
grep -Fq "config=$SDK_CONFIG" <<<"$linked"
grep -Fq "config_dir=$ROOT/.opencode" <<<"$linked"
grep -Fq "runtime=$expected_runtime" <<<"$linked"

state="$(SCAGENT_PYTHON=python3 SCAGENT_RUNTIME_DIR="$expected_runtime" "$ROOT/showstate.sh")"
grep -Fq "No scagent sessions found under $expected_runtime/scagent_sessions" <<<"$state"

echo "launcher tests passed"
