import { plugin } from "../.opencode/plugin/scagent-bridge.ts"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const toolPart = (output: string) => ({ type: "tool", state: { status: "completed", output, attachments: [] } })
const msg = (...parts: any[]) => ({ parts })
let pass = 0, fail = 0
const check = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}`) }

const hooks: any = await plugin({ directory: new URL("..", import.meta.url).pathname } as any)
const run = async (messages: any[]) => { await hooks["experimental.chat.messages.transform"]({} as any, { messages } as any); return messages }

// 1+2: nudge lands on the newest tool result only
let m = await run([msg(toolPart("first result")), msg(toolPart("second result"))])
check("newest tool result carries the nudge", m[1].parts[0].state.output.includes("REPORTING REQUIREMENT"))
check("older tool result does not", !m[0].parts[0].state.output.includes("REPORTING REQUIREMENT"))

// 3: idempotent — re-running does not duplicate
m = await run(m)
check("idempotent (exactly one nudge)", m[1].parts[0].state.output.split("REPORTING REQUIREMENT").length - 1 === 1)

// 4: the nudge migrates when a newer result arrives, and the old one is cleaned
m.push(msg(toolPart("third result")))
m = await run(m)
check("nudge migrates to the new newest", m[2].parts[0].state.output.includes("REPORTING REQUIREMENT"))
check("stale nudge stripped from the previous newest", !m[1].parts[0].state.output.includes("REPORTING REQUIREMENT"))
check("stripping restores the original output", m[1].parts[0].state.output === "second result")

// 5: pending/non-tool parts are ignored
m = await run([msg({ type: "text", text: "hi" }, { type: "tool", state: { status: "pending" } }), msg(toolPart("done"))])
check("ignores non-tool and pending parts", m[1].parts[0].state.output.includes("REPORTING REQUIREMENT"))

// 5b: before any tool runs, the opening nudge rides on the user's own message
const userMsg = { role: "user", parts: [{ type: "text", text: "analyze this dataset" }] }
let om = await run([userMsg])
check("opening nudge on user message before any tool", om[0].parts[0].text.includes("OPENING NOTE"))
om = await run(om)
check("opening nudge idempotent", om[0].parts[0].text.split("OPENING NOTE").length - 1 === 1)
// once a tool result exists, the opening nudge is stripped and the reporting nudge takes over
om.push({ role: "assistant", parts: [toolPart("first result")] })
om = await run(om)
check("opening nudge removed once a tool has run", !om[0].parts[0].text.includes("OPENING NOTE"))
check("reporting nudge takes over on the tool result", om[1].parts[0].state.output.includes("REPORTING REQUIREMENT"))
check("opening nudge not on assistant messages", om[0].parts[0].text === "analyze this dataset")

// 6: system transform still includes the reporting contract and finishes with the
// background policy that follows it.
const sys = { system: ["opencode coding prompt"] }
await hooks["experimental.chat.system.transform"]({} as any, sys as any)
check("reporting contract appended", sys.system[0].includes("## How to narrate this analysis"))
check(
  "background policy follows reporting contract",
  sys.system[0].indexOf("## The few genuinely long computes") >
    sys.system[0].indexOf("## How to narrate this analysis"),
)
await hooks["experimental.chat.system.transform"]({} as any, sys as any)
check(
  "system transform idempotent",
  sys.system[0].split("## How to narrate this analysis").length - 1 === 1,
)

// 7: an explicitly selected runtime root owns correlation state even when the
// scientific workspace is elsewhere.
const runtime = mkdtempSync(join(tmpdir(), "scagent-plugin-runtime-"))
process.env.SCAGENT_RUNTIME_DIR = runtime
const runtimeHooks: any = await plugin({
  directory: "/an/external/scientific/workspace",
  client: { session: { get: async () => ({ data: {} }) } },
} as any)
await runtimeHooks["chat.message"]({ sessionID: "session-external" })
const pointer = join(runtime, "session-map", "current.txt")
check("runtime root owns session pointer", existsSync(pointer))
check("session pointer records active root", readFileSync(pointer, "utf8") === "session-external")
delete process.env.SCAGENT_RUNTIME_DIR
rmSync(runtime, { recursive: true, force: true })

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
