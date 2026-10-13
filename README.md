# scagent × opencode

Runs [scagent-sdk](https://github.com/hussenmi/scagent-sdk), a single-cell RNA-seq analysis agent, inside the opencode TUI. opencode provides the interface and model loop; scagent-sdk provides the tools, floors, environments, and durable sessions.

## Use it (Iris)

```bash
module load scagent
cd ~/my-project
scagent
```

Your analyses are saved in `scagent_sessions/` inside the folder you start in. Run `scagent doctor` if anything looks wrong; it checks opencode, the tool server, the compute environments, the GPU, and every configured model server, and says what to do.

Not in the sail group? Add the module path once (`~/.bashrc`):

```bash
module use --append /usersoftware/collab002/sail/tools/Modules/modulefiles
```

GPU steps (scVI, CellBender, GPU clustering) need a GPU node, e.g. `srun --gres=gpu:1 --mem=64G --pty bash`.

```bash
scagent                    # open scagent in this folder
scagent run "MESSAGE"      # one request, no interface
scagent doctor [--full]    # check everything
scagent config             # settings and models in effect
scagent config edit        # change your settings
scagent state              # analyses in this folder
scagent watch [--once]     # follow the running compute step
scagent auth login         # add a cloud provider (Anthropic, OpenAI, ...)
```

## Models and settings

Settings are opencode config, in three layers; later wins:

| layer | file | who edits it |
|---|---|---|
| defaults | `scagent-sdk/configs/opencode/iris.json` | ships with each version |
| lab | `$SCAGENT_SITE_CONFIG` (set by the module) | the maintainer; takes effect on everyone's next launch, no rebuild |
| yours | `~/.config/scagent/opencode.json` | you (comments allowed) |

Switch models inside scagent with `/models`. To add a model server, add a `provider` entry to the lab file (for everyone) or to yours. The lab file's model list replaces the shipped one, so deleting a model there removes it for everyone; yours adds on top. The scagent tool server itself is always wired in and cannot be overridden.

## Where things go

- `<folder>/scagent_sessions/run_*/`: each analysis (state, artifacts, figures, report)
- `~/.local/state/scagent/workspaces/<folder>/`: which opencode chat belongs to which analysis
- `~/.config/scagent/opencode.json`: your settings

Folders used with an earlier version keep their `.scagent/` layout.

## Develop

Clone both repos into the same directory:

```bash
git clone git@github.com:hussenmi/scagent-sdk.git
git clone git@github.com:hussenmi/scagent-oc-spike.git
(cd scagent-sdk && source setup_gpu.sh)
ln -s "$PWD/scagent-oc-spike/scagent" ~/.local/bin/scagent
```

Tests: `bash tests/scagent-launcher.test.sh` and `BUN_BE_BUN=1 opencode tests/plugin-reporting.test.ts`.

## Release

```bash
release/build.sh --prefix /usersoftware/collab002/sail/tools/Modules/lib/scagent-X.Y.Z --version X.Y.Z
release/build.sh --prefix <same> --version X.Y.Z --seal      # read-only, after checking it
cp <prefix>/modulefile /usersoftware/collab002/sail/tools/Modules/modulefiles/scagent/X.Y.Z
echo X.Y.Z > /usersoftware/collab002/sail/tools/Modules/modulefiles/scagent/.version
```

A release is self-contained: both repos at a commit, its own Python, the agent `.venv`, and the compute environments built from `pixi.lock`. Users of an older version are unaffected until `.version` changes, and can keep loading the old one explicitly.
