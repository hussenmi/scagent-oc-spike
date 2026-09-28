# scagent × opencode

Runs [scagent-sdk](https://github.com/hussenmi/scagent-sdk), a single-cell RNA-seq analysis agent, inside the opencode TUI. opencode provides the interface and model loop; scagent-sdk provides the tools, floors, environments, and durable sessions.

## Run

```bash
scagent                      # current directory becomes the workspace
scagent start --workspace DIR
scagent run "MESSAGE"        # headless
scagent state                # show durable state
```

Sessions are written under `<workspace>/.scagent/`.

## Layout

- `scagent` — launcher
- `mcp_server/server.py` — exposes scagent-sdk capabilities as MCP tools
- `.opencode/plugin/scagent-bridge.ts` — session correlation and context injection

Config comes from `scagent-sdk/configs/opencode/iris.json`.
