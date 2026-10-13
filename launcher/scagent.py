"""scagent — the single-cell analysis agent, in the opencode TUI.

`scagent` opens opencode in the current folder with scagent-sdk's runtime connected through
the MCP server in ../mcp_server. Everything here is setup; nothing scientific happens in this
file. The bash wrapper next to it finds the agent Python and runs this with `-I`, so it uses
only the standard library plus the scagent-sdk virtualenv it was started with.

Where things go
---------------
  <folder you launched in>/scagent_sessions/   your analyses (created on the first tool call)
  ~/.local/state/scagent/workspaces/<folder>/   bookkeeping: which opencode chat is which run
  ~/.config/scagent/opencode.json               your settings (models, default model, ...)

Config layers, later wins
-------------------------
  1. defaults  scagent-sdk/configs/opencode/iris.json (shipped with this version)
  2. lab       $SCAGENT_SITE_CONFIG (set by the module; the maintainer edits it, no rebuild).
               Its "provider" list replaces the shipped one, so removing a model there works.
  3. yours     ~/.config/scagent/opencode.json
  4. wiring    the scagent MCP server itself, which cannot be overridden
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path(os.environ["SCAGENT_HOME"])  # this integration (set by the bash wrapper)
SDK = Path(os.environ["SCAGENT_SDK_ROOT"])  # scagent-sdk checkout or release copy
PY = Path(sys.executable)
PLUGIN_DIR = HOME / ".opencode"
SERVER = HOME / "mcp_server" / "server.py"

XDG_CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
XDG_STATE = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
USER_CONFIG = XDG_CONFIG / "scagent" / "opencode.json"
DEFAULT_CONFIG = Path(
    os.environ.get("SCAGENT_DEFAULT_CONFIG") or SDK / "configs" / "opencode" / "iris.json"
)
ENVIRONMENTS_FILE = Path(
    os.environ.get("SCAGENT_ENVIRONMENTS_FILE") or SDK / "configs" / "environments" / "iris.toml"
)

USER_CONFIG_TEMPLATE = """\
// Your personal scagent settings. Anything you set here overrides the lab defaults.
// Same format as opencode.json (https://opencode.ai/docs/config); comments are allowed.
// See what is in effect with `scagent config`, check model servers with `scagent doctor`.
//
// Examples (copy inside the braces below):
//
//   Your default model:
//     "model": "iscp001/Qwen3.8-27B"
//
//   Another model server (any OpenAI-compatible endpoint, e.g. your own vLLM job):
//     "provider": {
//       "my-vllm": {
//         "npm": "@ai-sdk/openai-compatible",
//         "name": "My vLLM",
//         "options": { "baseURL": "http://<node>:8000/v1", "apiKey": "local-no-auth" },
//         "models": { "<served-model-name>": { "name": "My model" } }
//       }
//     }
//
// Cloud models (Anthropic, OpenAI, ...): run `scagent auth login`, then pick them with /models.
{
}
"""

USAGE = """\
scagent: single-cell analysis agent

  scagent                 open scagent in this folder (same as `scagent start`)
  scagent run "MESSAGE"   run one request without the interface
  scagent doctor          check that everything scagent needs is working
  scagent config          show which settings and models are in effect
  scagent config edit     edit your settings (models, default model)
  scagent state           list the analyses in this folder
  scagent watch [--once]  follow the compute step that is running now
  scagent auth login      add a cloud model provider (Anthropic, OpenAI, ...)
  scagent version         show the version

Options: --workspace DIR (-C DIR) uses DIR instead of the current folder.
Your analyses are saved in ./scagent_sessions/ inside the folder you start in.
"""


# --------------------------------------------------------------------------- layout


def _slug(path: Path) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", str(path).strip("/")).strip("-")
    digest = hashlib.sha1(str(path).encode()).hexdigest()[:8]
    return f"{text[-80:]}-{digest}"


def layout(workspace: Path) -> dict[str, Path]:
    """Where this workspace's analyses and bookkeeping live.

    Analyses go in a visible `scagent_sessions/` in the workspace. Bookkeeping (the
    opencode-chat-to-run map, the pointer the plugin writes, the rendered skill text) is
    per user, so it lives in the user's state directory, keyed by workspace path. Folders
    created by an earlier scagent keep the layout they already have.
    """
    if os.environ.get("SCAGENT_SESSIONS_DIR") and os.environ.get("SCAGENT_STATE_DIR"):
        return {
            "sessions": Path(os.environ["SCAGENT_SESSIONS_DIR"]),
            "state": Path(os.environ["SCAGENT_STATE_DIR"]),
        }
    old = workspace / ".scagent"
    if (old / "scagent_sessions").is_dir():
        return {"sessions": old / "scagent_sessions", "state": old / "session-map"}
    if (workspace / "session-map").is_dir() and (workspace / "scagent_sessions").is_dir():
        return {"sessions": workspace / "scagent_sessions", "state": workspace / "session-map"}
    return {
        "sessions": workspace / "scagent_sessions",
        "state": XDG_STATE / "scagent" / "workspaces" / _slug(workspace),
    }


# --------------------------------------------------------------------------- config


def _strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments and trailing commas, leaving strings untouched."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def read_config(path: Path) -> dict:
    try:
        text = path.read_text()
    except FileNotFoundError:
        return {}
    try:
        data = json.loads(_strip_jsonc(text) or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"scagent: {path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"scagent: {path} must contain a JSON object")
    return data


def _merge(base: dict, override: dict) -> dict:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value
    return base


def site_config() -> Path | None:
    raw = os.environ.get("SCAGENT_SITE_CONFIG")
    return Path(raw) if raw else None


def config_layers() -> list[tuple[str, Path | None]]:
    return [("defaults", DEFAULT_CONFIG), ("lab", site_config()), ("yours", USER_CONFIG)]


def wiring(paths: dict[str, Path]) -> dict:
    """The part of the config that makes scagent scagent; applied last."""
    state = paths["state"]
    return {
        "mcp": {
            "scagent": {
                "type": "local",
                "command": [str(PY), str(SERVER)],
                "environment": {
                    "SCAGENT_SDK_PROJECT_ROOT": str(SDK),
                    "SCAGENT_SDK_SKILLS_DIR": str(SDK / ".claude" / "skills"),
                    "SCAGENT_SDK_SESSIONS_DIR": str(paths["sessions"]),
                    "SCAGENT_SDK_ENVIRONMENTS_FILE": str(ENVIRONMENTS_FILE),
                    "SCAGENT_SESSION_FILE": str(state / "current.txt"),
                    "SCAGENT_SESSION_MAP": str(state / "scagent-map.json"),
                    "SCAGENT_INSTRUCTIONS_FILE": str(state / "skill-instructions.txt"),
                },
                "enabled": True,
            }
        },
        # opencode's own skill tool would load skills from outside scagent-sdk.
        "tools": {"skill": False},
    }


def merged_config(paths: dict[str, Path]) -> dict:
    try:
        config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT") or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"scagent: invalid OPENCODE_CONFIG_CONTENT: {exc}") from exc
    # Updates come with a new scagent version, not from opencode replacing itself.
    _merge(config, {"autoupdate": False})
    for name, path in config_layers():
        if path is not None:
            layer = read_config(path)
            # Old configs carried their own scagent wiring with absolute paths; ours wins.
            layer.get("mcp", {}).pop("scagent", None)
            # The lab file is the lab's model list: deleting a model there removes it for
            # everyone, so its providers replace the shipped ones instead of adding to them.
            if name == "lab" and "provider" in layer:
                config.pop("provider", None)
            _merge(config, layer)
    return _merge(config, wiring(paths))


def ensure_user_config() -> None:
    if USER_CONFIG.exists():
        return
    try:
        USER_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        USER_CONFIG.write_text(USER_CONFIG_TEMPLATE)
    except OSError:
        pass


# --------------------------------------------------------------------------- opencode


def opencode_bin() -> Path | None:
    for candidate in (
        os.environ.get("SCAGENT_OPENCODE_BIN"),
        shutil.which("opencode"),
        str(Path.home() / ".opencode" / "bin" / "opencode"),
    ):
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return Path(candidate)
    return None


def require_opencode() -> Path:
    found = opencode_bin()
    if found is None:
        raise SystemExit(
            "scagent: opencode was not found.\n"
            "  On Iris: module load scagent   (it brings a tested opencode)\n"
            "  Elsewhere: curl -fsSL https://opencode.ai/install | bash"
        )
    return found


def launch_env(workspace: Path, paths: dict[str, Path], *, mode: str) -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "SCAGENT_WORKSPACE": str(workspace),
            "SCAGENT_SESSIONS_DIR": str(paths["sessions"]),
            "SCAGENT_STATE_DIR": str(paths["state"]),
            "SCAGENT_PYTHON": str(PY),
            "OPENCODE_CONFIG_DIR": str(PLUGIN_DIR),
            "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS": "true",
            # Keep a user's own Claude Code setup (CLAUDE.md, ~/.claude/skills) out of scagent.
            "OPENCODE_DISABLE_CLAUDE_CODE": "1",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
            # Analyses can involve patient data; never offer to upload a conversation.
            "OPENCODE_DISABLE_SHARE": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
        }
    )
    if mode == "agent":
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(merged_config(paths), separators=(",", ":"))
        env.pop("OPENCODE_CONFIG", None)
    # The agent runs `scagent watch --once` from opencode's shell; make sure it resolves here.
    launcher_dir = os.environ.get("SCAGENT_LAUNCHER_DIR")
    if launcher_dir:
        env["PATH"] = f"{launcher_dir}{os.pathsep}{env.get('PATH', '')}"
    return env


# --------------------------------------------------------------------------- commands


def cmd_start(workspace: Path, args: list[str], *, headless: bool) -> None:
    paths = layout(workspace)
    paths["state"].mkdir(parents=True, exist_ok=True)
    ensure_user_config()
    opencode = require_opencode()
    env = launch_env(workspace, paths, mode="agent")
    if headless:
        argv = [str(opencode), "run", "--dir", str(workspace), *args]
    else:
        argv = [str(opencode), str(workspace), *args]
    os.execve(argv[0], argv, env)


def cmd_script(workspace: Path, script: str, args: list[str]) -> None:
    paths = layout(workspace)
    env = launch_env(workspace, paths, mode="script")
    argv = [str(HOME / script), *args]
    os.execve(argv[0], argv, env)


def cmd_auth(args: list[str]) -> None:
    opencode = require_opencode()
    argv = [str(opencode), "auth", *args]
    os.execve(argv[0], argv, dict(os.environ))


def _models(config: dict) -> list[tuple[str, str, dict]]:
    rows = []
    for provider_id, provider in (config.get("provider") or {}).items():
        for model_id, model in ((provider or {}).get("models") or {}).items():
            rows.append((f"{provider_id}/{model_id}", (model or {}).get("name", ""), provider or {}))
    return rows


def cmd_config(workspace: Path, args: list[str]) -> None:
    sub = args[0] if args else ""
    paths = layout(workspace)
    if sub == "edit":
        ensure_user_config()
        editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "nano"
        os.execvp(editor, [editor, str(USER_CONFIG)])
    config = merged_config(paths)
    if sub == "show":
        print(json.dumps(config, indent=2))
        return
    if sub == "path":
        print(USER_CONFIG)
        return
    if sub:
        raise SystemExit(f"scagent config: unknown option '{sub}' (try: edit | show | path)")
    print("Settings, later ones win:")
    for name, path in config_layers():
        if path is None:
            print(f"  {name:<9} (none)")
        else:
            note = "" if path.exists() else "   (not created yet)"
            print(f"  {name:<9} {path}{note}")
    print(f"\nDefault model: {config.get('model', '(opencode picks one)')}")
    rows = _models(config)
    if rows:
        print("Model servers configured here (switch with /models inside scagent):")
        width = max(len(r[0]) for r in rows)
        for ref, name, _ in rows:
            print(f"  {ref:<{width}}  {name}")
    print("Cloud providers you have logged into with `scagent auth login` are listed too.")
    print(f"\nThis folder's analyses: {paths['sessions']}")
    print("Edit your settings: scagent config edit    Full merged config: scagent config show")


def cmd_version() -> None:
    info = HOME.parent / "BUILD-INFO"
    if info.is_file():
        print(info.read_text().strip())
        return
    for name, repo in (("scagent-opencode", HOME), ("scagent-sdk", SDK)):
        try:
            rev = subprocess.run(
                ["git", "-C", str(repo), "describe", "--always", "--dirty"],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            rev = ""
        print(f"{name}: {rev or 'unknown'} ({repo})")


# --------------------------------------------------------------------------- doctor


class Report:
    def __init__(self) -> None:
        self.failed = 0
        self.warned = 0

    def ok(self, text: str) -> None:
        print(f"  \u2713 {text}")

    def warn(self, text: str, fix: str = "") -> None:
        self.warned += 1
        print(f"  ! {text}")
        if fix:
            print(f"      \u2192 {fix}")

    def fail(self, text: str, fix: str = "") -> None:
        self.failed += 1
        print(f"  \u2717 {text}")
        if fix:
            print(f"      \u2192 {fix}")

    def section(self, title: str) -> None:
        print(f"\n{title}")


def _probe_endpoint(base_url: str, api_key: str | None) -> tuple[bool, str, list[str]]:
    url = base_url.rstrip("/") + "/models"
    request = urllib.request.Request(url)
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return False, "the server is up but rejected the API key", []
        return False, f"HTTP {exc.code}", []
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return False, "not responding", []
    served = [str(m.get("id")) for m in body.get("data", []) if isinstance(m, dict)]
    return True, "", served


def _check_mcp(report: Report, paths: dict[str, Path]) -> None:
    """Start the real MCP server exactly as opencode would, and list its tools."""
    import tempfile

    env = dict(os.environ)
    with tempfile.TemporaryDirectory() as tmp:
        server_env = wiring({"sessions": Path(tmp) / "sessions", "state": Path(tmp)})
        env.update(server_env["mcp"]["scagent"]["environment"])
        code = (
            "import asyncio, sys\n"
            "from mcp import ClientSession, StdioServerParameters\n"
            "from mcp.client.stdio import stdio_client\n"
            "async def main():\n"
            "    params = StdioServerParameters(command=sys.argv[1], args=[sys.argv[2]], env=None)\n"
            "    async with stdio_client(params) as (r, w):\n"
            "        async with ClientSession(r, w) as s:\n"
            "            await s.initialize()\n"
            "            print(len((await s.list_tools()).tools))\n"
            "asyncio.run(main())\n"
        )
        try:
            result = subprocess.run(
                [str(PY), "-c", code, str(PY), str(SERVER)],
                capture_output=True, text=True, timeout=120, env=env,
            )
        except subprocess.TimeoutExpired:
            report.fail("scagent tool server did not start within 2 minutes")
            return
    if result.returncode == 0 and result.stdout.strip().isdigit():
        report.ok(f"scagent tool server starts and offers {result.stdout.strip()} tools")
    else:
        tail = (result.stderr or result.stdout).strip().splitlines()[-3:]
        report.fail("scagent tool server failed to start", " | ".join(tail))


def _check_environments(report: Report, full: bool) -> None:
    try:
        # Same import order as the MCP server: scagent_sdk.execution has an import cycle
        # with scagent_sdk.capabilities when it is imported first.
        import scagent_sdk.capabilities.registry  # noqa: F401
        from scagent_sdk.execution.profile import EnvironmentRegistry

        registry = EnvironmentRegistry.from_path(ENVIRONMENTS_FILE)
    except Exception as exc:  # noqa: BLE001 - report, never crash the doctor
        report.fail(f"cannot read compute environments from {ENVIRONMENTS_FILE}: {exc}")
        return
    for runtime in registry.runtimes():
        name = runtime.name
        python = Path(runtime.python)
        if not (python.is_file() and os.access(python, os.X_OK)):
            report.fail(f"compute environment '{name}' is missing ({python})")
            continue
        if not full:
            report.ok(f"compute environment '{name}'")
            continue
        modules = ", ".join(runtime.probe_modules) or "sys"
        env = runtime.build_environment()
        probe = subprocess.run(
            [str(python), "-c", f"import {modules}"],
            capture_output=True, text=True, timeout=600, env=env,
        )
        if probe.returncode == 0:
            report.ok(f"compute environment '{name}' imports {modules}")
        else:
            last = (probe.stderr.strip().splitlines() or ["unknown error"])[-1]
            report.fail(f"compute environment '{name}' cannot import its packages", last)
    reference_paths = set()
    for profile in registry.profiles():
        for key, value in profile.environment.items():
            if key.endswith("_MODEL_PATH") or key.endswith("_MODEL_PATH_MOUSE"):
                reference_paths.add(value)
    for value in sorted(reference_paths):
        if os.access(value, os.R_OK | os.X_OK):
            report.ok(f"reference model readable: {value}")
        else:
            report.warn(
                f"reference model not readable: {value}",
                "reference-based annotation (SCimilarity) will not work; ask the scagent maintainer",
            )


def cmd_doctor(workspace: Path, args: list[str]) -> None:
    full = "--full" in args
    report = Report()
    paths = layout(workspace)
    print("scagent doctor" + ("  (full)" if full else "  (add --full to also test package imports)"))

    report.section("Install")
    info = HOME.parent / "BUILD-INFO"
    if info.is_file():
        first = info.read_text().splitlines()[0] if info.read_text().strip() else "unknown"
        report.ok(first)
    else:
        report.ok(f"development checkout: {HOME}")
    opencode = opencode_bin()
    if opencode is None:
        report.fail(
            "opencode not found",
            "module load scagent (on Iris), or: curl -fsSL https://opencode.ai/install | bash",
        )
    else:
        try:
            version = subprocess.run(
                [str(opencode), "--version"], capture_output=True, text=True, timeout=30
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            version = "?"
        report.ok(f"opencode {version}  ({opencode})")
    try:
        import mcp  # noqa: F401
        import scagent_sdk  # noqa: F401

        report.ok(f"agent Python {sys.version.split()[0]}  ({PY})")
    except ImportError as exc:
        report.fail(f"agent Python is missing a package: {exc}")
    _check_mcp(report, paths)

    report.section("Compute")
    _check_environments(report, full)
    gpus = []
    if shutil.which("nvidia-smi"):
        listing = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True)
        gpus = [line for line in listing.stdout.splitlines() if line.startswith("GPU")]
    if gpus:
        report.ok(f"{len(gpus)} GPU(s) on this node")
    else:
        report.warn(
            "no GPU on this node",
            "GPU steps (clustering on GPU, scVI, CellBender) need a GPU node, "
            "e.g. srun --gres=gpu:1 --mem=64G --pty bash",
        )

    report.section("Models")
    try:
        config = merged_config(paths)
    except SystemExit as exc:
        report.fail(str(exc))
        config = {}
    default = config.get("model")
    by_provider: dict[str, list[str]] = {}
    providers = config.get("provider") or {}
    for ref, _name, _provider in _models(config):
        by_provider.setdefault(ref.split("/", 1)[0], []).append(ref.split("/", 1)[1])
    default_up = None
    for provider_id, model_ids in by_provider.items():
        options = (providers.get(provider_id) or {}).get("options") or {}
        base = options.get("baseURL")
        if not base:
            continue
        up, why, served = _probe_endpoint(base, options.get("apiKey"))
        for model_id in model_ids:
            ref = f"{provider_id}/{model_id}"
            mark = "  (default)" if ref == default else ""
            if up and (not served or model_id in served):
                report.ok(f"{ref}{mark}")
                if ref == default:
                    default_up = True
            elif up:
                report.warn(
                    f"{ref}{mark}: the server at {base} is up but serves {', '.join(served)}",
                    "fix the model name in the config",
                )
                if ref == default:
                    default_up = False
            else:
                report.warn(
                    f"{ref}{mark}: {why} at {base}",
                    "that model server is probably not running; pick another with /models",
                )
                if ref == default:
                    default_up = False
    if default and "/" in default and default.split("/", 1)[0] not in by_provider:
        report.ok(f"{default}  (default, a cloud provider; needs `scagent auth login`)")
    elif default_up is False:
        report.fail(
            f"the default model {default} is not available",
            "set another default with `scagent config edit`, or pick one with /models",
        )
    elif not default:
        report.warn("no default model set", "set \"model\" with `scagent config edit`")

    report.section("This folder")
    report.ok(f"workspace: {workspace}")
    existing = sorted(paths["sessions"].glob("run_*")) if paths["sessions"].is_dir() else []
    report.ok(f"analyses: {paths['sessions']}  ({len(existing)} so far)")
    if not os.access(workspace, os.W_OK):
        report.fail("you cannot write to this folder", "start scagent in a folder you own")

    print()
    if report.failed:
        print(f"{report.failed} problem(s) need fixing before scagent will work.")
        raise SystemExit(1)
    print("Ready." + (f"  ({report.warned} warning(s) above)" if report.warned else ""))


# --------------------------------------------------------------------------- main


def main(argv: list[str]) -> None:
    cmd = argv[0] if argv and not argv[0].startswith("-") else "start"
    rest = argv[1:] if argv and not argv[0].startswith("-") else list(argv)
    workspace_raw = os.environ.get("SCAGENT_WORKSPACE") or os.getcwd()
    # --workspace/-C may appear anywhere before a `--`; everything else passes through.
    kept: list[str] = []
    while rest:
        arg = rest.pop(0)
        if arg == "--":
            kept.extend(rest)
            break
        if arg in ("--workspace", "-C"):
            if not rest:
                raise SystemExit(f"scagent: {arg} needs a folder")
            workspace_raw = rest.pop(0)
            # An explicit folder beats the one inherited from a running scagent session.
            for key in ("SCAGENT_WORKSPACE", "SCAGENT_SESSIONS_DIR", "SCAGENT_STATE_DIR"):
                os.environ.pop(key, None)
        else:
            kept.append(arg)
    rest = kept

    if cmd in ("-h", "--help", "help"):
        print(USAGE, end="")
        return
    if cmd in ("version", "--version"):
        cmd_version()
        return
    if cmd == "auth":
        cmd_auth(rest)
        return

    workspace = Path(workspace_raw).expanduser()
    if cmd in ("start", "run"):
        workspace.mkdir(parents=True, exist_ok=True)
    if not workspace.is_dir():
        raise SystemExit(f"scagent: {workspace} is not a folder")
    workspace = workspace.resolve()

    if cmd == "start":
        cmd_start(workspace, rest, headless=False)
    elif cmd == "run":
        cmd_start(workspace, rest, headless=True)
    elif cmd == "doctor":
        cmd_doctor(workspace, rest)
    elif cmd == "config":
        cmd_config(workspace, rest)
    elif cmd == "state":
        cmd_script(workspace, "showstate.sh", rest)
    elif cmd == "watch":
        cmd_script(workspace, "watchprogress.sh", rest)
    else:
        raise SystemExit(f"scagent: unknown command '{cmd}'\n\n{USAGE}")


if __name__ == "__main__":
    main(sys.argv[1:])
