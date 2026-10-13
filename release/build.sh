#!/usr/bin/env bash
# Build a self-contained scagent release that other people can run.
#
#   release/build.sh --prefix DIR --version X.Y.Z [--allow-dirty] [--seal]
#
# DIR ends up holding:
#   scagent-sdk/        scagent-sdk source + .venv (agent Python) + .pixi/envs (compute)
#   scagent-opencode/   this repo: launcher, MCP server, opencode plugin
#   python/             the interpreter the .venv runs on (nothing points into a home dir)
#   bin/scagent         the command users run
#   BUILD-INFO          version, source commits, builder, date
#   modulefile          an Lmod modulefile for this release (copy it into modulefiles/scagent/)
#
# Both repos are copied from their tracked files. The build refuses uncommitted changes
# unless --allow-dirty, so a release always matches a commit. --seal makes the release
# read-only (the sail convention, chmod -R a-w) once it has been checked.
#
# Tools, overridable: UV (default: shared sail uv), PIXI (default: pixi on PATH),
# OPENCODE_BIN (opencode the modulefile pins; default: shared sail opencode 1.18.33),
# SITE_CONFIG (the maintainer-editable lab config the modulefile points at).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
SDK_SRC="$(cd -P "${SCAGENT_SDK_ROOT:-$HERE/../scagent-sdk}" && pwd)"
SAIL=/usersoftware/collab002/sail/tools/Modules/lib
UV="${UV:-$SAIL/uv/0.12.9/bin/uv}"
PIXI="${PIXI:-$(command -v pixi || echo /usersoftware/peerd/$USER/.pixi/bin/pixi)}"
OPENCODE_BIN="${OPENCODE_BIN:-$SAIL/opencode/1.18.33/bin/opencode}"
SITE_CONFIG="${SITE_CONFIG:-$SAIL/scagent-site/opencode.json}"
PYTHON_VERSION=3.12.9
ENVIRONMENTS=(rapids cellbender diffxpy)

prefix="" version="" allow_dirty=0 seal=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --allow-dirty) allow_dirty=1; shift ;;
    --seal) seal=1; shift ;;
    *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$prefix" ] && [ -n "$version" ] || { sed -n '2,20s/^# \{0,1\}//p' "$0"; exit 2; }
for tool in "$UV" "$PIXI" "$OPENCODE_BIN"; do
  [ -x "$tool" ] || { echo "build.sh: missing tool $tool" >&2; exit 2; }
done

step() { printf '\n== %s\n' "$*"; }

if [ "$seal" = 1 ] && [ -d "$prefix/scagent-sdk/.venv" ]; then
  step "sealing existing build at $prefix"
else
  step "checking sources"
  for repo in "$HERE" "$SDK_SRC"; do
    if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
      if [ "$allow_dirty" = 1 ]; then
        echo "  warning: $repo has uncommitted changes (included because of --allow-dirty)"
      else
        echo "build.sh: $repo has uncommitted changes; commit them or pass --allow-dirty" >&2
        exit 1
      fi
    fi
  done
  if [ -e "$prefix" ] && [ -n "$(ls -A "$prefix" 2>/dev/null)" ]; then
    echo "build.sh: $prefix already exists and is not empty" >&2
    exit 1
  fi
  mkdir -p "$prefix"
  prefix="$(cd "$prefix" && pwd -P)"

  copy_tracked() { # repo -> dest, working-tree contents of tracked files
    mkdir -p "$2"
    git -C "$1" ls-files -z | (cd "$1" && xargs -0 cp --parents -t "$2")
  }
  step "copying scagent-sdk and scagent-opencode"
  copy_tracked "$SDK_SRC" "$prefix/scagent-sdk"
  copy_tracked "$HERE" "$prefix/scagent-opencode"

  step "agent Python $PYTHON_VERSION + .venv (uv)"
  export UV_PYTHON_INSTALL_DIR="$prefix/python" UV_LINK_MODE=copy UV_PYTHON_PREFERENCE=only-managed
  "$UV" python install "$PYTHON_VERSION"
  (cd "$prefix/scagent-sdk" && "$UV" sync --frozen --no-dev --no-editable --all-extras --no-extra dev --python "$PYTHON_VERSION")
  "$prefix/scagent-sdk/.venv/bin/python" -I -c "import scagent_sdk, mcp; print('  scagent_sdk + mcp import')"

  step "compute environments (pixi, from pixi.lock)"
  # A throwaway package cache inside the release: pixi hard-links installed files from its
  # cache, and a personal cache would tie the release's files to the builder's own folders.
  export PIXI_CACHE_DIR="$prefix/.build-cache"
  # Seed it with a real copy of the builder's cached packages: some locked packages have
  # since been removed from their channel (e.g. libxgboost-3.2.0 on rapidsai, 404 in
  # 2026-10) and now exist only in caches that downloaded them before.
  SEED_CACHE="${SEED_CACHE:-/usersoftware/peerd/$USER/pixi-cache/scagent-sdk/pkgs}"
  if [ -d "$SEED_CACHE" ]; then
    mkdir -p "$PIXI_CACHE_DIR/pkgs"
    cp -a "$SEED_CACHE/." "$PIXI_CACHE_DIR/pkgs/"
    rm -f "$PIXI_CACHE_DIR"/pkgs/*.lock
  fi
  "$PIXI" config set --local --manifest-path "$prefix/scagent-sdk/pixi.toml" \
    detached-environments false >/dev/null
  for env in "${ENVIRONMENTS[@]}"; do
    PIXI_CACHE_NETFS_REDIRECT=never "$PIXI" install --locked --environment "$env" \
      --manifest-path "$prefix/scagent-sdk/pixi.toml"
    [ -x "$prefix/scagent-sdk/.pixi/envs/$env/bin/python" ] || {
      echo "build.sh: environment $env did not land in $prefix/scagent-sdk/.pixi/envs" >&2
      exit 1
    }
  done
  rm -rf "$PIXI_CACHE_DIR"

  step "command, build info, modulefile"
  mkdir -p "$prefix/bin"
  ln -sfn ../scagent-opencode/scagent "$prefix/bin/scagent"
  {
    echo "scagent $version"
    echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ) by $USER on $(hostname -s)"
    for repo in "$HERE" "$SDK_SRC"; do
      dirty=""; [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ] && dirty=" (+ uncommitted changes)"
      echo "$(basename "$repo"): $(git -C "$repo" rev-parse --short HEAD)$dirty"
    done
    echo "opencode: $("$OPENCODE_BIN" --version) ($OPENCODE_BIN)"
  } >"$prefix/BUILD-INFO"
  sed -e "s|@VERSION@|$version|g" -e "s|@PREFIX@|$prefix|g" \
      -e "s|@OPENCODE_BIN@|$OPENCODE_BIN|g" -e "s|@SITE_CONFIG@|$SITE_CONFIG|g" \
      "$HERE/release/modulefile.tcl" >"$prefix/modulefile"
  cat "$prefix/BUILD-INFO"
fi

step "permissions (readable by everyone who can reach this folder)"
chmod -R a+rX "$prefix"
if [ "$seal" = 1 ]; then
  chmod -R a-w "$prefix"
  echo "  sealed read-only"
fi

step "checking the release"
SCAGENT_SDK_ROOT= SCAGENT_PYTHON= SCAGENT_OPENCODE_BIN="$OPENCODE_BIN" SCAGENT_SITE_CONFIG="$SITE_CONFIG" \
  "$prefix/bin/scagent" doctor --full -C "${TMPDIR:-/tmp}" || {
  echo "build.sh: doctor reported problems (see above)" >&2
  exit 1
}
echo
echo "Built $prefix"
echo "Module: cp $prefix/modulefile <modulefiles>/scagent/$version"
