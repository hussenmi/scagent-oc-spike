<title>scagent × opencode</title>

# scagent-sdk on opencode

opencode is used as **only** the snappy TUI + model loop. **Everything scientific and
stateful comes from `scagent-sdk`** — no cs_agent, no global `~/.claude` skills, no toy
reimplementations:

| Concern | Owner | How |
|---|---|---|
| Biology / tools (52 of them) | scagent-sdk | `CapabilityRegistry` over `scagent-sdk/.claude/skills`, exposed as MCP tools |
| Durable state / sessions | scagent-sdk | `AnalysisSession` + `SessionStore` → real `run_*/` folders (events.jsonl, state.json, artifacts, lineage) |
| Execution | scagent-sdk | `CapabilityExecutor` (stage → commit), the same path the Claude Agent SDK runtime uses |
| Floors | scagent-sdk | `FloorEvaluator`, evaluated **server-side** before each call — one source of truth, no TS copy to drift |
| Environments | scagent-sdk | `EnvironmentBroker` from `scagent-sdk/configs/environments/iris.toml` |
| SKILL.md context | scagent-sdk | `render_skill_instructions`, injected into the system prompt by the plugin |
| TUI, model loop, conversation store | opencode | unchanged |

## Architecture

```
opencode (Bun TUI, model loop)                         <-- the only non-scagent piece
  │
  ├── MCP server   mcp_server/server.py                <-- thin adapter, ~180 lines
  │     imports scagent_sdk; on each call:
  │       resolve opencode session → durable scagent AnalysisSession
  │       FloorEvaluator.failures(state, tool.floors)  → deny before execute
  │       CapabilityExecutor.execute(...) → commit_from_hook(...)
  │     list_tools() = scagent-sdk's 52 capability tools, exact input schemas
  │
  └── plugin   .opencode/plugin/scagent-bridge.ts      <-- thin, ~50 lines
        chat.message:                       publish opencode sessionID (correlation)
        experimental.chat.system.transform: inject scagent-sdk's SKILL.md context
```

The server runs on scagent-sdk's own venv (`scagent-sdk/.venv/bin/python`), which has
`scagent_sdk` + the `mcp` SDK. Durable sessions land in `scagent_sessions/` here; state,
floors, and environments are 100% scagent-sdk.

## Why the adapter is small

scagent-sdk already separates its runtime from its science. The only thing bound to the
Claude Agent SDK is the `sdk.tool(...)` / `create_sdk_mcp_server(...)` wrapping in
`capabilities/assembly.py`. The adapter replaces exactly that wrapping with the low-level
MCP `Server`, and reuses `CapabilityRegistry`, `CapabilityExecutor`, `AnalysisSession`,
`FloorEvaluator`, and `EnvironmentBroker` verbatim. Floors move from PreToolUse **hooks**
to a server-side check before `execute` — same predicates, same remediation text.

## Run it

`scagent` launches the scAgent-enabled OpenCode; `opencode` remains the ordinary
coding agent. From the directory where the analysis should live:

```bash
scagent
```

The current directory becomes the scientific workspace. No dataset is required
at launch; provide or discuss the dataset normally after the agent opens. Durable
state is written beneath `.scagent/` in that workspace.

The repository-local form remains available:

```bash
cd /data1/peerd/ibrahih3/scagent-oc-spike
./scagent start                    # existing spike workspace
```

The launcher can keep the integration here while the scientific analysis lives
in any independent workspace:

```bash
/data1/peerd/ibrahih3/scagent-oc-spike/scagent start \
  --workspace /data1/peerd/ibrahih3/projects/my-analysis

/data1/peerd/ibrahih3/scagent-oc-spike/scagent run \
  --workspace /data1/peerd/ibrahih3/projects/my-analysis \
  "Analyze data/input.h5ad"
```

External workspaces store their durable runtime under `.scagent/`; existing
sessions in this spike retain the historical `scagent_sessions/` and
`session-map/` locations. Ordinary `opencode` is unchanged and does not acquire
the scagent integration merely because this launcher exists.

OpenCode's resolved configuration can be inspected for a selected workspace:

```bash
./scagent config --workspace /path/to/analysis
```

- Point it at an `.h5ad` (there's a tiny fixture at `data/tiny_raw.h5ad`, or the real
  `/data1/peerd/ibrahih3/cs_agent/test_data/salcher/Reyfman_all_raw.h5ad`).
- The model drives scagent-sdk's real tools (`inspect_dataset`, `calculate_single_cell_qc`,
  `cluster_single_cells`, `evaluate_cluster_qc`, `finalize_analysis`, …).
- Try `finalize_analysis` early → blocked by scagent-sdk's real floors
  (`current_cell_qc_review`, `current_cluster_qc`, …) with real remediation.

Inspect durable state and the session folder:

```bash
./scagent state --workspace /path/to/analysis
./scagent watch --workspace /path/to/analysis --once
ls -R /path/to/analysis/.scagent/scagent_sessions/
```

Headless checks:

```bash
./scagent run "call inspect_dataset on data/tiny_raw.h5ad then finalize_analysis"
```

## Context handling / compaction — the durable-state contract

The point of compaction here is **not** to summarize prose. It is that the *authoritative*
analysis lives on disk — `state.json` facts/decisions and an artifact index keyed by
**execution id** — and the agent relies on those, not on conversation memory. That is exactly
scagent-sdk's model, and it is wired in:

- Every tool result's real payload is already persisted by `CapabilityExecutor` as an artifact
  under `artifacts/capabilities/<skill>--<execution_id>/`, with `state.json` updated. Inline
  tool output is bounded (scagent-sdk's 48 KiB limit); the bulk stays on disk.
- After **every** tool call the server re-renders scagent-sdk's own `resume_context` — the
  bounded durable checkpoint (facts, decisions, `artifact_index` keyed by execution id,
  `authoritative_files`) with its preamble: *"Recent turn handoff is model narrative, not
  authoritative evidence… verify referenced artifacts before mutating them."*
- The plugin injects that checkpoint into the system prompt each turn. So even as opencode's
  own conversation trims or drops old messages, the agent is re-grounded every turn on the
  on-disk state and execution ids — prose is disposable.
- The agent can also read current truth on demand via scagent-sdk's `query-analysis-state`
  tool and by reading a named artifact by its execution id.

Files: server writes `session-map/durable-checkpoint.txt` (`_write_checkpoint` → `resume_context`);
plugin folds it into the first system block in `experimental.chat.system.transform`.

**Figure / result cleanup (built).** Rather than let opencode summarize old messages into prose,
the plugin's `experimental.chat.messages.transform` trims the outgoing messages every turn,
scagent-sdk style: it keeps the most recent messages and figures untouched, and for older
messages it drops the figure image bytes and shrinks big tool outputs, leaving a short note
that points back to the on-disk artifact (indexed by execution id in state.json). It edits
payloads in place (never removes a part, so tool-call/result pairing stays intact) and is
idempotent. This keeps the context lean — especially of accumulated figure images — without a
model-written summary, so opencode's own overflow summarizer rarely needs to fire. Tunables at
the top of the plugin: `KEEP_RECENT_MESSAGES`, `KEEP_RECENT_FIGURES`, `TRIM_OUTPUT_OVER_CHARS`.

Also still to do: resume/fork session selection (currently one scagent session per opencode
session), and surfacing scagent's readiness probes in the TUI.

## Files

- `mcp_server/server.py` — the adapter: scagent-sdk capabilities → MCP tools, real session + floors + broker.
- `.opencode/plugin/scagent-bridge.ts` — session correlation + SKILL.md context injection.
- `opencode.json` — vLLM providers + the scagent MCP server (points at scagent-sdk's venv & configs).
- `showstate.sh` — pretty-prints scagent-sdk facts per session.
- `data/tiny_raw.h5ad` — small real .h5ad fixture for fast runs.
