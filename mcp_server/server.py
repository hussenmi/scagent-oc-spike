"""scagent-sdk-backed MCP server for opencode.

Everything scientific and stateful comes from scagent-sdk; opencode is only the
TUI + model loop. This server exposes scagent-sdk's OWN capabilities (biology from
`scagent-sdk/.claude/skills`) as stdio MCP tools, driven by scagent-sdk's REAL
runtime — no toy reimplementation, nothing from cs_agent or global skills:

  * biology / tools  → CapabilityRegistry over scagent-sdk's skills
  * durable state     → AnalysisSession + SessionStore (real session folders,
                        events.jsonl, state.json, artifacts, lineage)
  * execution         → CapabilityExecutor (stage → commit), same as the SDK path
  * floors            → FloorEvaluator, evaluated server-side (so the enforcement
                        logic lives in exactly one place — scagent-sdk — and can't
                        drift from a TS copy)
  * environments      → EnvironmentBroker from scagent-sdk's own configs

Session correlation: the opencode plugin publishes the opencode sessionID to a
pointer file; each opencode session maps 1:1 to a durable scagent session.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from contextlib import suppress
from pathlib import Path

import mcp.types as mt
from mcp.server import Server
from mcp.server.stdio import stdio_server

from scagent_sdk.capabilities.executor import CapabilityExecutor
from scagent_sdk.capabilities.instructions import render_skill_instructions
from scagent_sdk.capabilities.registry import CapabilityRegistry
from scagent_sdk.execution import EnvironmentBroker, EnvironmentRegistry
from scagent_sdk.floors import FloorEvaluator
from scagent_sdk.runtime.resume import resume_context
from scagent_sdk.session import AnalysisSession

# --- roots / config (all overridable; default to scagent-sdk's own) ---------
_SDK = Path("/data1/peerd/ibrahih3/scagent-sdk")
SKILLS_ROOT = Path(os.environ.get("SCAGENT_SDK_SKILLS_DIR", str(_SDK / ".claude" / "skills")))
SESSIONS_ROOT = Path(
    os.environ.get("SCAGENT_SDK_SESSIONS_DIR", str(Path(__file__).resolve().parent.parent / "scagent_sessions"))
)
ENV_FILE = Path(
    os.environ.get("SCAGENT_SDK_ENVIRONMENTS_FILE", str(_SDK / "configs" / "environments" / "iris.toml"))
)
POINTER = os.environ.get("SCAGENT_SESSION_FILE")  # plugin writes the opencode sessionID here
SESSION_MAP = Path(
    os.environ.get("SCAGENT_SESSION_MAP", str(Path(__file__).resolve().parent.parent / "session-map" / "scagent-map.json"))
)
INSTRUCTIONS_OUT = os.environ.get("SCAGENT_INSTRUCTIONS_FILE")  # plugin injects this into the system prompt
CHECKPOINT_OUT = os.environ.get("SCAGENT_CHECKPOINT_FILE")  # durable-state checkpoint the plugin injects each turn

# --- discover scagent-sdk capabilities once ---------------------------------
REGISTRY = CapabilityRegistry(SKILLS_ROOT)
PACKAGES = REGISTRY.discover()
TOOLS: dict[str, tuple] = {}
for _pkg in PACKAGES:
    for _tool in _pkg.manifest.tools:
        TOOLS[_tool.name] = (_pkg, _tool)

BROKER = EnvironmentBroker(EnvironmentRegistry.from_path(ENV_FILE)) if ENV_FILE.is_file() else None
FLOORS = FloorEvaluator()

# Publish scagent-sdk's rendered SKILL.md instructions so the plugin can inject
# them as system context — the biology *context* also comes from scagent-sdk.
if INSTRUCTIONS_OUT:
    try:
        text = render_skill_instructions(REGISTRY.skills())
        Path(INSTRUCTIONS_OUT).parent.mkdir(parents=True, exist_ok=True)
        Path(INSTRUCTIONS_OUT).write_text(text)
    except Exception:
        pass

# One durable scagent session AND one executor per opencode session, cached
# in-process: the session lock is held once, and scagent-sdk's stage→commit
# executor keeps ownership of its pending root (a fresh executor per call would
# quarantine the previous call's staging).
_SESSIONS: dict[str, tuple[AnalysisSession, CapabilityExecutor]] = {}


def _write_checkpoint(session: AnalysisSession) -> None:
    """Render scagent-sdk's authoritative durable checkpoint and publish it for the plugin.

    This is the heart of the compaction contract: the model's working context is
    disposable prose, but the *authoritative* analysis — facts, decisions, and an
    artifact index keyed by execution id — lives on disk in state.json. We re-render
    scagent-sdk's own `resume_context` after every tool call so the plugin can inject
    the current, bounded checkpoint into the system prompt each turn. The agent is
    thereby steered to rely on state.json + execution ids, not on remembered prose.
    """
    if not CHECKPOINT_OUT:
        return
    try:
        store = session.store
        text = resume_context(
            store.metadata, store.state, events=list(store.events()), session_dir=session.directory
        )
        Path(CHECKPOINT_OUT).parent.mkdir(parents=True, exist_ok=True)
        Path(CHECKPOINT_OUT).write_text(text)
    except Exception:
        pass


def _opencode_sid() -> str:
    if POINTER and Path(POINTER).is_file():
        value = Path(POINTER).read_text().strip()
        if value:
            return value
    return "default"


def _session_executor() -> tuple[AnalysisSession, CapabilityExecutor]:
    sid = _opencode_sid()
    if sid in _SESSIONS:
        return _SESSIONS[sid]
    try:
        mapping = json.loads(SESSION_MAP.read_text())
    except Exception:
        mapping = {}
    # Session model:
    #   * A returning opencode session (already in the map) RESUMES its own durable
    #     run — opencode's session identity is the continuity key, so resuming an
    #     opencode conversation reloads that analysis's authoritative state.
    #   * A brand-new opencode session CREATES a new durable run. New is new.
    #   * SCAGENT_RESUME_SESSION is an explicit per-launch escape hatch only (e.g.
    #     `SCAGENT_RESUME_SESSION=run_… opencode …` to continue a specific analysis
    #     in a fresh conversation). It is intentionally NOT set in opencode.json —
    #     baking it in there forces every new session onto one run.
    run_id = mapping.get(sid) or os.environ.get("SCAGENT_RESUME_SESSION")
    session = None
    if run_id:
        try:
            session = AnalysisSession.resume(SESSIONS_ROOT, run_id)
        except Exception:
            session = None
    if session is None:
        session = AnalysisSession.create(SESSIONS_ROOT, title=f"opencode {sid}")
    mapping[sid] = session.session_id
    SESSION_MAP.parent.mkdir(parents=True, exist_ok=True)
    SESSION_MAP.write_text(json.dumps(mapping, indent=2))
    executor = CapabilityExecutor(session, environment_broker=BROKER)
    executor.recover_pending()  # once, at session open — not per call
    _SESSIONS[sid] = (session, executor)
    _write_checkpoint(session)  # publish the durable checkpoint for a fresh/resumed session
    return _SESSIONS[sid]


def _to_content(items) -> list:
    out = []
    for it in items or []:
        if isinstance(it, dict) and it.get("type") == "image":
            out.append(
                mt.ImageContent(
                    type="image",
                    data=it.get("data", ""),
                    mimeType=it.get("mimeType") or it.get("media_type") or "image/png",
                )
            )
        else:
            out.append(mt.TextContent(type="text", text=str((it or {}).get("text", ""))))
    if not out:
        out.append(mt.TextContent(type="text", text="(no content)"))
    return out


_WS = re.compile(r"\s+")


def _newest_committed_log(session_dir: Path) -> Path | None:
    """The execution.stdout.log of the capability that just committed (newest by mtime).

    Calls are serial per session, so after commit the freshest committed worker log belongs to
    the tool we just ran. Used to name the concrete on-disk log in the digest.
    """
    try:
        logs = list(session_dir.glob("artifacts/capabilities/*/execution.stdout.log"))
    except Exception:
        return None
    logs = [p for p in logs if p.is_file() and p.stat().st_size > 0]
    return max(logs, key=lambda p: p.stat().st_mtime, default=None)


def _progress_digest(frags: list[str], elapsed: float, session_dir: Path) -> str | None:
    """Digest of a worker's streamed progress (scVI epochs, tqdm, …), naming the log.

    opencode 1.18.x cannot render live MCP progress (it discards the notification `message` —
    see server.py heartbeat note), so for long GPU capabilities the user otherwise sees nothing
    about what the compute did. scagent-sdk already streams the worker's stdout through the
    executor's `progress` callback; we accumulate it and fold its tail into the tool RESULT, and
    name the concrete on-disk log so there is a file to open after the fact. Returns None for
    quick tools that stream nothing, so only real compute gets a digest.
    """
    lines = [_WS.sub(" ", f).strip() for f in frags]
    lines = [ln for ln in lines if ln]
    if not lines:
        return None
    tail = " | ".join(lines[-2:])[:240]
    parts = [f"[progress] {elapsed:.0f}s, {len(lines)} update(s) — last: {tail}"]
    log = _newest_committed_log(session_dir)
    if log is not None:
        parts.append(f"full log saved at: {log}")
    return "\n".join(parts)


async def _dispatch(name: str, arguments: dict) -> list:
    """Core call path — shared by the MCP handler and the headless self-test."""
    if name not in TOOLS:
        return [mt.TextContent(type="text", text=f"Unknown tool: {name}")]
    package, tool = TOOLS[name]
    session, executor = _session_executor()

    # Floors — scagent-sdk's own predicates, enforced before execution.
    failures = FLOORS.failures(session.store.state, tool.floors)
    if failures:
        reason = " ".join(f"[{f.floor}] {f.reason} {f.remediation}" for f in failures)
        session.store.record(
            "floor.denied", payload={"floors": [f.floor for f in failures], "reason": reason}
        )
        _write_checkpoint(session)
        return [mt.TextContent(type="text", text=f"BLOCKED by scagent floor. {reason}")]

    # Accumulate the worker's streamed stdout (scVI epoch bars, tqdm, scimilarity,
    # cellbender). The callback fires from the broker's reader threads; list.append is
    # safe under the GIL. Quick tools stream nothing → frags stays empty → no digest.
    frags: list[str] = []

    def _on_progress(text: str) -> None:
        if text and text.strip():
            frags.append(text)

    started = time.monotonic()
    response = await executor.execute(package, tool, arguments or {}, progress=_on_progress)
    elapsed = time.monotonic() - started
    if not response.get("is_error"):
        executor.commit_from_hook({"tool_response": response})
    _write_checkpoint(session)  # refresh authoritative checkpoint after every tool call
    content = _to_content(response.get("content"))
    digest = _progress_digest(frags, elapsed, session.directory)
    if digest:
        content.append(mt.TextContent(type="text", text=digest))
    return content


server = Server("scagent")


@server.list_tools()
async def list_tools() -> list:
    return [
        mt.Tool(name=name, description=tool.description, inputSchema=tool.input_schema)
        for name, (_pkg, tool) in TOOLS.items()
    ]


# Send a progress notification at least this often while a tool runs. opencode calls
# tools with resetTimeoutOnProgress:true, so each heartbeat resets its ~60s request
# timeout — this is what lets minutes-long GPU capabilities (e.g. cluster QC) finish
# instead of hitting an MCP request timeout.
HEARTBEAT_SECONDS = 15


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list:
    # Grab the progress token opencode attached to this request (it passes onprogress,
    # so a token is present). If absent, we simply run without heartbeats.
    token = None
    session = None
    try:
        ctx = server.request_context
        session = ctx.session
        token = ctx.meta.progressToken if ctx.meta else None
    except Exception:
        pass

    async def _heartbeat() -> None:
        progress = 0.0
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            progress += 1.0
            try:
                await session.send_progress_notification(
                    progress_token=token,
                    progress=progress,
                    total=None,
                    message=f"{name} still running…",
                )
            except Exception:
                return

    hb = asyncio.create_task(_heartbeat()) if token is not None and session is not None else None
    try:
        return await _dispatch(name, arguments)
    finally:
        if hb is not None:
            hb.cancel()
            with suppress(asyncio.CancelledError):
                await hb


async def _main() -> None:
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_main())
