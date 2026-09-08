import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * scagent ⟷ opencode bridge.
 *
 * Deliberately THIN. Everything scientific and stateful — biology/tools, durable
 * state, floors, environments, and the SKILL.md context — comes from scagent-sdk,
 * exposed through the MCP server (mcp_server/server.py). opencode is only the TUI
 * and model loop. This plugin does the two things that must live on the opencode
 * side:
 *
 *  (1) SESSION CORRELATION — publish the opencode sessionID to a pointer file so
 *      the MCP server maps each opencode session to one durable scagent session.
 *      (opencode 1.18.22 does not forward tool.execute.before arg mutations to MCP
 *      tools, so correlation cannot ride on arg injection — hence the pointer.)
 *
 *  (2) SKILL CONTEXT + DURABLE CHECKPOINT — inject scagent-sdk's rendered SKILL.md
 *      instructions and its authoritative durable-state checkpoint (facts, decisions,
 *      artifact index keyed by execution id) into the system prompt every turn, so the
 *      biology *context* and the *state* both come from scagent-sdk.
 *
 *  (3) FIGURE / RESULT CLEANUP — scagent-sdk's compaction idea: the chat is disposable,
 *      the truth is on disk. Instead of letting opencode summarize old messages into
 *      prose, we drop aged figures and big tool outputs from the outgoing messages and
 *      leave a short note pointing back to the on-disk artifact (indexed by execution
 *      id in state.json). Keeps the context lean without a model-written summary.
 *
 *  (4) REPORTING CONTRACT — override opencode's compiled-in "be terse, one-word
 *      answers, avoid preamble" coding prompt, which otherwise turns a scientific
 *      analysis into silent tool-chaining with no interpretation between steps.
 *
 * Floors are NOT enforced here — the MCP server evaluates scagent-sdk's own
 * FloorEvaluator before every tool call, so the enforcement logic lives in one
 * place and cannot drift from a TS copy.
 */

// How many of the most recent messages to leave completely untouched.
const KEEP_RECENT_MESSAGES = 8
// How many of the most recent figures to keep in the chat; older ones become a note.
const KEEP_RECENT_FIGURES = 6
// Only shrink a tool's text output if it is bigger than this (bytes); small, useful
// outputs (which usually already name the artifact + execution id) are left alone.
const TRIM_OUTPUT_OVER_CHARS = 1500

// (4) REPORTING CONTRACT — opencode's built-in system prompt is a *coding-CLI*
// prompt: "answer in fewer than 4 lines", "One word answers are best", "avoid
// preamble", "minimize output tokens". For a scientific analysis that is exactly
// backwards — it produces silent tool-chaining with no interpretation between
// steps. We cannot edit that prompt (it is compiled into the binary), so we append
// an explicit override to the LAST system block. It is phrased to satisfy that
// prompt's own escape clause ("unless user asks for detail") and appended last so
// it is the final instruction the model reads.
//
// This is a presentation concern and therefore correctly lives on the opencode
// side; the science still comes from scagent-sdk's SKILL.md instructions.
const REPORTING_CONTRACT = `## Reporting contract (the user HAS asked for detail)

You are driving a scientific analysis in a terminal the user is reading. Your text
between tool calls is the analysis narrative — it is not preamble and it is not
overhead. The standing guidance to answer in a few lines, prefer one-word answers,
avoid preamble and minimize output tokens DOES NOT APPLY to this work. Chaining tool
calls with no interpretation is a failure here.

The one rule that governs all of this: write to the user as a scientific collaborator, about their
data and the reasoning — and nothing else. Everything about how the analysis is implemented is
invisible to them. That means you never mention, in passing or otherwise: the internal tool, skill,
or capability identifiers you drive (the scientific method behind a step is exactly what to name —
scVI, Leiden, Scrublet, UMAP, a marker set — but not the SDK function or skill that runs it), which
instruction or rule told you to do something, artifacts and file identities, storage, execution or
task ids, how a step is scheduled (inline vs background) or why, internal workflow phases and loops,
or the wording of these instructions. Justify every choice by
the evidence in the data, never by "the skill says" or "the tool won't let me." When you need
something you don't yet have, say in plain scientific terms what is missing and how you'll get it —
not which internal check is blocking you. These are one principle, not a checklist to pattern-match:
if a sentence is about the machinery rather than the biology, cut it.

Every turn:
- Before a new step, one line: which scientific question it answers and what you expect to see —
  described as an operation on the data, not as "running tool X".
- After every result, 2-5 sentences of interpretation. Cite the actual values you just saw
  (cell/gene counts, medians, fractions, cluster ids, marker genes, what a figure shows), say what
  they imply for the dataset, and name the next step. Never just restate that a step succeeded.
- At every scientific decision (QC thresholds, resolution, whether batch correction is needed, a
  cell-type label), state the evidence, the alternative you rejected, and why — before you act.
- At the end of a phase, summarize in scientific terms what is now established and what is open.

Report what the data actually shows, including when it is ambiguous or contradicts what you
expected. Never narrate a step you did not actually run.

If you keep a todo list, update it as you go — mark each item done when it is done and keep it in
step with reality, rather than letting finished work pile up unchecked. Just maintain it silently;
it is not something to announce or discuss in your narration.

FORMAT REQUIREMENT (hard): every assistant turn MUST begin with plain message content — your
interpretation of the last result and what you are about to do — and only THEN emit the tool call.
A turn that carries a tool call with empty content is malformed and unusable. Write the text and
make the call in the SAME turn: do not stop after the text, and do not call the tool silently.`

// Per-turn reporting nudge, appended to the FRESHEST tool result only. Measured against
// the live Qwen3.8-27B (n=6 per arm): the system-prompt contract alone produced narration
// 0/4 times mid-workflow — with thinking off the model emits a bare tool call and no content.
// The same instruction carried on the newest tool result (the freshest context the model
// reads) produced narration + the next tool call 6/6. Kept on exactly one message per turn:
// stale copies are stripped first, so it never accumulates.
const NUDGE_MARKER = "[REPORTING REQUIREMENT"
const REPORTING_NUDGE =
  `\n\n${NUDGE_MARKER} — the user is reading your messages, not this tool output. Your next ` +
  "turn MUST begin with 2-5 sentences of plain message content interpreting this result (cite the " +
  "actual values). Then take the next action IF there is one: normally make the next tool call in the " +
  "same turn (a tool call with empty message content is malformed and shows the user nothing). BUT if " +
  "you just launched a background job, or are waiting on one, or the next step depends on a result that " +
  "does not exist yet — do NOT force a tool call. Say what you started and that you will report back, " +
  "then end the turn and wait. Stopping to wait is correct there, not silent tool-chaining.]"

const FIGURE_NOTE = (name: string) =>
  `[figure aged out of the chat to save context${name ? ` — saved as ${name}` : ""}. ` +
  `It is on disk under the session's artifacts and indexed by execution id in state.json. ` +
  `Re-read it from disk if you need it again.]`

const RESULT_NOTE =
  "[older tool output trimmed to save context. The full result is on disk: the analysis " +
  "state is in state.json and the artifact is indexed by its execution id. Re-read it if needed.]"

// Background-offload policy. opencode runs a subagent in the background (task background=true) and
// notifies us on completion; the subagent's scagent work correlates to THIS analysis (see rootOf)
// and commits by its own execution id. The policy is deliberately a SHORT ALLOW-LIST rather than a
// "judge how slow it looks" heuristic: given the heuristic, the model backgrounded ~1-minute steps
// (Scrublet) and then advanced the head in the foreground, so the stale-base guard refused the
// commit; the retry with branch_from landed the evidence off the active line, where the evidence
// floor would not accept it — four runs of the same job to get one usable result. Concurrency is
// safe at the storage layer (isolated staging, snapshotted state, commits serialized under an
// exclusive lock with an RFC-7396 deep merge + stale-base guard) — it is the LINEAGE that is not.
// Hence: only the four multi-minute jobs go to the background, and nothing advances the head while
// one is in flight. Never poll the subagent via the task channel, and never re-launch a job.
const BACKGROUND_OFFLOAD = `## The few genuinely long computes — offload those, and only those

This is an internal execution decision with no scientific meaning — never narrate it to the user.
Do not tell them a step is running inline or in the background, or why one is or is not on the
offload list; just run it and describe what it does for the analysis.

Almost every capability runs INLINE, in the foreground, as a normal tool call. That is the default
and it is right even for a step that takes a couple of minutes — a short wait costs you nothing,
while a backgrounded step you then have to wait for anyway costs you a whole extra round trip and
puts the commit at risk (see the head rule below).

Offload to the background ONLY these — the multi-minute model-training and large-reference jobs:

- \`train_scvi_latent\`  (scVI integration training)
- \`remove_ambient_background\`  (CellBender)
- \`run_scimilarity_annotation\`
- \`run_celltypist_annotation\`

That is the list. Nothing else. Do not extend it by reasoning that some other step "might be slow":
QC, normalization, HVG, PCA, neighbors, UMAP, clustering, doublet scoring, cluster QC, batch
investigation, DE, scoring, plots and every review call all run INLINE, however large the dataset
looks. Those steps finish in seconds to a couple of minutes on GPU, and backgrounding them has
repeatedly cost more time than it saved.

To offload one of the four: call the \`task\` tool with subagent_type "scagent-compute",
background true, and a prompt naming the exact capability and its arguments. It returns immediately,
records its result into THIS analysis (same run, its own execution id), and you are notified
automatically when it finishes.

**The head rule — this is what actually goes wrong.** A background job computes against the active
artifact as it was WHEN YOU LAUNCHED IT, and commits when it finishes. If you advance the active
head in the meantime, its commit is REFUSED ("derived from head X but the active head is now Y").
Working around that refusal with \`branch_from\` is worse, not better: the result lands off the
active line, and evidence floors only accept evidence on the active line, so the review that
consumes it will be blocked. Therefore, while a background job is in flight, run NOTHING that
advances the head — no capability that transforms or re-commits the working matrix.

Since the four offloadable jobs are exactly the steps the pipeline continues from, in practice this
means: after you launch one, STOP and wait. Post one short line — what is running, that you will
report when it lands — and END YOUR TURN. A message-only turn is correct here; it is not "silent
tool-chaining." Do not re-check the log, re-run anything, or narrate step by step.

The one safe parallel case: two annotation methods (SCimilarity and CellTypist) read the current
clustering and each write a SEPARATE result without advancing the head, so those two may run at
once. Nothing else pairs.

While a background job is running:
- Check progress only when the USER asks. Then run \`./watchprogress.sh --once\` ONCE and report what
  it says (running + elapsed, or the latest epoch). That is a plain FILE/PROCESS READ — not a scagent
  tool call and not "polling the subagent" — so it is allowed, but on request, not in a loop.
- NEVER re-launch a job. If a check says nothing is running, it almost always FINISHED (a long
  compute does not silently die) — find its result in the durable state / committed artifacts BY
  EXECUTION ID and report THAT. Never start a second copy of the same compute.
- Do NOT message or "poll" the SUBAGENT through the task channel; completion is pushed to you.

When a completion notice arrives, read that job's durable result (by execution id) and carry the
workflow forward.`

export const plugin: Plugin = async ({ directory, client }) => {
  const mapDir = join(directory, "session-map")
  if (!existsSync(mapDir)) mkdirSync(mapDir, { recursive: true })
  const pointer = join(mapDir, "current.txt")
  const instructionsFile = join(mapDir, "skill-instructions.txt")
  const sessionMapFile = join(mapDir, "scagent-map.json")
  const sessionsDir = join(directory, "scagent_sessions")

  const readOr = (p: string): string => {
    try {
      return readFileSync(p, "utf8")
    } catch {
      return ""
    }
  }

  // Resolve a session to its ROOT session (walk parentID to the top). A background subagent runs
  // in its own child session, but its scagent work must land in the PARENT analysis's durable run
  // — so we correlate every call by the root, not the raw calling session. opencode records the
  // parent link at child creation and the server exposes it via client.session.get. The child→root
  // mapping is immutable, so we cache it. On any failure we fall back to the session itself, which
  // is exactly the pre-existing (single-session) behavior — never worse.
  const rootCache = new Map<string, string>()
  const rootOf = async (sessionID: string): Promise<string> => {
    const cached = rootCache.get(sessionID)
    if (cached) return cached
    let id = sessionID
    try {
      for (let hop = 0; hop < 16; hop++) {
        const res: any = await client.session.get({ path: { id } })
        const parent = res?.data?.parentID
        if (!parent) break
        id = parent
      }
    } catch {
      // Transient lookup failure (e.g. session not registered yet): fall back to the session
      // itself for THIS call but do NOT cache it — the parent link is immutable, so a later call
      // must be free to resolve the real root instead of being stuck on a poisoned fallback.
      return sessionID
    }
    rootCache.set(sessionID, id)
    return id
  }

  // The durable checkpoint the model is grounded on each turn — read PER RUN, for THIS session's
  // own analysis. The server writes it into the run's directory; we map session → root → run (via
  // the server-maintained session map) and read that run's checkpoint. A brand-new session has no
  // run yet → we inject nothing (rather than leaking the previous run's checkpoint, which made the
  // model think prior artifacts existed and then report the state as "reset"). A resuming session
  // already maps to its run, whose checkpoint is on disk, so it is restored correctly.
  const runCheckpointFor = async (sessionID: string): Promise<string> => {
    try {
      const root = await rootOf(sessionID)
      const map = JSON.parse(readOr(sessionMapFile) || "{}")
      const run = map?.[root]
      if (!run) return ""
      return readOr(join(sessionsDir, run, "durable-checkpoint.txt"))
    } catch {
      return ""
    }
  }

  return {
    // (1) publish which durable analysis a call belongs to. The MCP server maps the
    // pointer's session id to a durable scagent run (creating one on first use).
    //
    // We write the ROOT session id (not the raw calling session), so a background
    // subagent's compute lands in its PARENT analysis's run instead of splitting off
    // a new one. For an ordinary top-level session root === itself, so this is a no-op
    // versus the previous behavior. We assert it BOTH on each user message and — crucially
    // — right before every tool call (which fires per-call with the calling sessionID, and
    // is awaited before the MCP call runs). Parent and child both resolve to the same root,
    // so concurrent writes carry the same value and do not split the analysis. (Two *different*
    // root analyses running at once can still race the single pointer — run one at a time.)
    "chat.message": async (input) => {
      try {
        writeFileSync(pointer, await rootOf(input.sessionID))
      } catch {}
    },

    "tool.execute.before": async (input) => {
      try {
        writeFileSync(pointer, await rootOf(input.sessionID))
      } catch {}
    },

    // (2) inject, each turn, scagent-sdk's SKILL.md context AND the authoritative
    // durable-state checkpoint (facts, decisions, artifact index keyed by execution
    // id — the server re-renders it after every tool call). This is the compaction
    // contract: the conversation prose is disposable; the agent relies on the on-disk
    // state and execution ids, which are re-presented here fresh every turn.
    //
    // Fold into the FIRST system block — adding a new system entry makes some vLLM
    // chat templates reject the request ("System message must be at the beginning").
    "experimental.chat.system.transform": async (input, output) => {
      // Inject the checkpoint for THIS session's run. Prefer the hook's sessionID; fall back to
      // the active-session pointer (which holds the current root) when it is absent.
      const sid = (input?.sessionID || readOr(pointer).trim()).trim()
      const checkpoint = (sid ? await runCheckpointFor(sid) : "").trim()
      const instructions = readOr(instructionsFile).trim()
      const inject = [checkpoint, instructions].filter(Boolean).join("\n\n")
      // Reporting contract + background-offload policy both ride at the END of the system
      // prompt; bundle them so the marker guard covers both.
      const contract = [REPORTING_CONTRACT, BACKGROUND_OFFLOAD].join("\n\n")
      if (output.system.length === 0) {
        output.system.push([inject, contract].filter(Boolean).join("\n\n"))
        return
      }
      // scagent context goes in FRONT of opencode's own prompt ...
      if (inject) output.system[0] = `${inject}\n\n${output.system[0]}`
      // ... and the reporting contract goes at the very END, so it is the last thing
      // the model reads and overrides opencode's "be terse" coding guidance. Appended
      // to the existing last block rather than pushed as a new one: some vLLM chat
      // templates reject a system message that is not the first message.
      const last = output.system.length - 1
      if (!output.system[last].includes("## Reporting contract")) {
        output.system[last] = `${output.system[last]}\n\n${contract}`
      }
    },

    // (3) figure/result cleanup on the outgoing messages, scagent-sdk style.
    // Runs every turn, before the messages go to the model. It edits payloads in
    // place (never removes a part, so tool_call/tool_result pairing stays intact)
    // and is idempotent — re-running finds nothing new to trim.
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output.messages
      if (!Array.isArray(msgs) || msgs.length === 0) return
      const lastTrimmable = msgs.length - KEEP_RECENT_MESSAGES // messages before this may be trimmed

      // Pass 1: find every figure (image attachment on a completed tool part), in order.
      type Slot = { attachments: any[]; index: number; msgIdx: number; name: string }
      const figures: Slot[] = []
      msgs.forEach((m, msgIdx) => {
        for (const part of m.parts as any[]) {
          if (part?.type !== "tool" || part?.state?.status !== "completed") continue
          const atts = part.state.attachments
          if (!Array.isArray(atts)) continue
          atts.forEach((a, index) => {
            if (typeof a?.mime === "string" && a.mime.startsWith("image/")) {
              figures.push({ attachments: atts, index, msgIdx, name: a.filename || "" })
            }
          })
        }
      })
      // Keep the most recent KEEP_RECENT_FIGURES; older ones (and only in older
      // messages) get their bytes dropped and a note left on the tool output.
      const keepFrom = Math.max(0, figures.length - KEEP_RECENT_FIGURES)
      figures.forEach((fig, order) => {
        if (order >= keepFrom || fig.msgIdx >= lastTrimmable) return
        fig.attachments[fig.index] = { ...fig.attachments[fig.index], _evicted: true }
      })

      // Pass 2: for older messages, drop evicted image bytes and shrink big outputs.
      msgs.forEach((m, msgIdx) => {
        if (msgIdx >= lastTrimmable) return // protect the recent tail
        for (const part of m.parts as any[]) {
          if (part?.type !== "tool" || part?.state?.status !== "completed") continue
          const state = part.state
          // remove evicted figures, remembering their names for the note
          const evictedNames: string[] = []
          if (Array.isArray(state.attachments)) {
            state.attachments = state.attachments.filter((a: any) => {
              if (a?._evicted) {
                evictedNames.push(a.filename || "")
                return false
              }
              return true
            })
          }
          if (typeof state.output !== "string") continue
          // shrink a big text output first (unless it's already been trimmed) ...
          let out = state.output
          if (out.length > TRIM_OUTPUT_OVER_CHARS && !out.includes(RESULT_NOTE)) {
            out = RESULT_NOTE
          }
          // ... then keep the figure note(s) so the pointer to disk survives.
          if (evictedNames.length) {
            const notes = evictedNames.map((n) => FIGURE_NOTE(n)).join(" ")
            if (!out.includes("figure aged out")) out = `${out}\n\n${notes}`
          }
          state.output = out
        }
      })

      // Pass 3: carry the reporting requirement on the newest tool result. The system
      // contract is not enough on its own for a thinking-disabled model, and this is the
      // freshest thing in context. Strip stale copies first so exactly one is ever present.
      let newest: any = null
      for (const m of msgs) {
        for (const part of m.parts as any[]) {
          if (part?.type !== "tool" || part?.state?.status !== "completed") continue
          if (typeof part.state.output !== "string") continue
          const at = part.state.output.indexOf(NUDGE_MARKER)
          if (at >= 0) part.state.output = part.state.output.slice(0, at).trimEnd()
          newest = part
        }
      }
      if (newest) newest.state.output = `${newest.state.output}${REPORTING_NUDGE}`
    },
  }
}
