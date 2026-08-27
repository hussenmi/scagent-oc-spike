#!/usr/bin/env bash
# Back-compat shim — `./scagent start` is the real entry point now.
exec "$(dirname "$0")/scagent" start "$@"
