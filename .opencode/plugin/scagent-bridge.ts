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

Every turn:
- Before starting a new step, one line: what you are about to run and which question it answers.
- After every tool result, 2-5 sentences of interpretation. Cite the actual values you just saw
  (cell/gene counts, medians, fractions, cluster ids, marker genes, what a figure shows), say what
  they imply for the dataset, and name the next step. Never just restate that the tool succeeded.
- At every scientific decision (QC thresholds, resolution, whether batch correction is needed, a
  cell-type label), state the evidence, the alternative you rejected, and why — before you act.
- When a floor blocks a call, say in plain language what is missing and how you will satisfy it.
- At the end of a phase, summarize what is now established (with execution ids) and what is open.

Report what the data actually shows, including when it is ambiguous or contradicts what you
expected. Never narrate a step you did not actually run.

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
  "actual values) and naming your next step, and MUST then make the next tool call in that same turn. " +
  "A tool call with empty message content is malformed and shows the user nothing.]"

const FIGURE_NOTE = (name: string) =>
  `[figure aged out of the chat to save context${name ? ` — saved as ${name}` : ""}. ` +
  `It is on disk under the session's artifacts and indexed by execution id in state.json. ` +
  `Re-read it from disk if you need it again.]`

const RESULT_NOTE =
  "[older tool output trimmed to save context. The full result is on disk: the analysis " +
  "state is in state.json and the artifact is indexed by its execution id. Re-read it if needed.]"

export const plugin: Plugin = async ({ directory }) => {
  const mapDir = join(directory, "session-map")
  if (!existsSync(mapDir)) mkdirSync(mapDir, { recursive: true })
  const pointer = join(mapDir, "current.txt")
  const instructionsFile = join(mapDir, "skill-instructions.txt")
  const checkpointFile = join(mapDir, "durable-checkpoint.txt")

  const readOr = (p: string): string => {
    try {
      return readFileSync(p, "utf8")
    } catch {
      return ""
    }
  }

  return {
    // (1) publish which opencode session is active; the MCP server maps it to a
    // durable scagent session (run_...), creating one on first use.
    //
    // We assert the pointer BOTH on each user message and — crucially — right
    // before every tool call. opencode 1.18.x does not forward tool arg mutations
    // to MCP tools, so correlation rides a shared pointer file; writing it only
    // once per message let a *second* active opencode session clobber it and split
    // one analysis across two scagent sessions. Re-asserting in tool.execute.before
    // (which fires per-call with the right sessionID, and is awaited before the MCP
    // call runs) keeps a single active session correct. (Truly simultaneous tool
    // calls from two sessions can still race — run one analysis at a time.)
    "chat.message": async (input) => {
      try {
        writeFileSync(pointer, input.sessionID)
      } catch {}
    },

    "tool.execute.before": async (input) => {
      try {
        writeFileSync(pointer, input.sessionID)
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
    "experimental.chat.system.transform": async (_input, output) => {
      const checkpoint = readOr(checkpointFile).trim()
      const instructions = readOr(instructionsFile).trim()
      const inject = [checkpoint, instructions].filter(Boolean).join("\n\n")
      if (output.system.length === 0) {
        output.system.push([inject, REPORTING_CONTRACT].filter(Boolean).join("\n\n"))
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
        output.system[last] = `${output.system[last]}\n\n${REPORTING_CONTRACT}`
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
