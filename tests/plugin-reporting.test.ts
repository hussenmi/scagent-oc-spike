import { plugin } from "../.opencode/plugin/scagent-bridge.ts"

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

// 6: system transform still folds context in front and the contract at the end
const sys = { system: ["opencode coding prompt"] }
await hooks["experimental.chat.system.transform"]({} as any, sys as any)
check("contract appended at the very end", sys.system[0].trimEnd().endsWith("do not call the tool silently."))
await hooks["experimental.chat.system.transform"]({} as any, sys as any)
check("system transform idempotent", sys.system[0].split("## Reporting contract").length - 1 === 1)

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
