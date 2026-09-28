# scagent × opencode

Runs [scagent-sdk](https://github.com/hussenmi/scagent-sdk), a single-cell RNA-seq analysis agent, inside the opencode TUI. opencode provides the interface and model loop; scagent-sdk provides the tools, floors, environments, and durable sessions.

## Setup

Clone both repos into the same directory, then:

```bash
git clone git@github.com:hussenmi/scagent-sdk.git
git clone git@github.com:hussenmi/scagent-oc-spike.git
(cd scagent-sdk && source setup_gpu.sh)
ln -s "$PWD/scagent-oc-spike/scagent" ~/.local/bin/scagent
```

Requires opencode at `~/.opencode/bin/opencode`. Set `SCAGENT_SDK_ROOT` if scagent-sdk lives elsewhere.

## Run

```bash
scagent                      # current directory becomes the workspace
scagent start --workspace DIR
scagent run "MESSAGE"        # headless
scagent state                # show durable state
```

Sessions are written under `<workspace>/.scagent/`.
