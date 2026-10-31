import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SessionProcessor } from "../../src/session/processor"
import { RunLease } from "../../src/session/run-lease"

const dir = () => path.join(Global.Path.state, "runs")

// A pid that is guaranteed dead: the process has already been reaped.
const deadPid = () => {
  const child = Bun.spawnSync(["sh", "-c", "echo $$"])
  return Number(child.stdout.toString().trim())
}

const leave = (lease: Partial<RunLease.Lease> & { sessionID: string }) => {
  mkdirSync(dir(), { recursive: true })
  const target = path.join(dir(), `${lease.sessionID}.json`)
  writeFileSync(target, JSON.stringify({ version: 1, directory: "/repo", pid: deadPid(), resumes: 0, ...lease }))
  return target
}

beforeAll(() => RunLease.enable())
afterEach(() => rmSync(dir(), { recursive: true, force: true }))

describe("RunLease", () => {
  test("a run that ends normally leaves nothing to resume", () => {
    RunLease.begin({ sessionID: "ses_a", directory: "/repo" })
    expect(readdirSync(dir())).toEqual(["ses_a.json"])
    RunLease.end("ses_a")
    expect(readdirSync(dir())).toEqual([])
    expect(RunLease.claimInterrupted()).toEqual([])
  })

  test("a run owned by a live process is never claimed", () => {
    RunLease.begin({ sessionID: "ses_mine", directory: "/repo" })
    leave({ sessionID: "ses_other", pid: process.ppid })
    expect(RunLease.claimInterrupted()).toEqual([])
    expect(readdirSync(dir()).sort()).toEqual(["ses_mine.json", "ses_other.json"])
    RunLease.end("ses_mine")
  })

  test("a dead owner's run is claimed once, and the claim counts as a resume", () => {
    leave({ sessionID: "ses_b", parentID: "ses_p" })
    const [item, ...rest] = RunLease.claimInterrupted()
    expect(rest).toEqual([])
    expect(item.action).toBe("continue")
    expect(item.lease).toMatchObject({ sessionID: "ses_b", parentID: "ses_p", pid: process.pid, resumes: 1 })
    expect(RunLease.claimInterrupted()).toEqual([])
    RunLease.begin({ sessionID: "ses_b", directory: "/repo" })
    expect(JSON.parse(readFileSync(path.join(dir(), "ses_b.json"), "utf8")).resumes).toBe(1)
    RunLease.end("ses_b")
  })

  test("a crash loop stops being resumed", () => {
    leave({ sessionID: "ses_c", resumes: RunLease.MAX_RESUMES })
    const [item] = RunLease.claimInterrupted()
    expect(item.action).toBe("exhausted")
    expect(existsSync(path.join(dir(), "ses_c.json"))).toBe(false)
  })

  test("a run left too long ago is not started again unasked", () => {
    const target = leave({ sessionID: "ses_d" })
    const old = new Date(Date.now() - RunLease.MAX_AGE - 1000)
    utimesSync(target, old, old)
    expect(RunLease.claimInterrupted()[0].action).toBe("exhausted")
  })

  test("quitting means stop", () => {
    leave({ sessionID: "ses_e", stopped: true })
    expect(RunLease.claimInterrupted()[0].action).toBe("stopped")
  })

  test("a host tied to one project leaves other projects' runs for their own host", () => {
    leave({ sessionID: "ses_f", directory: "/other" })
    leave({ sessionID: "ses_g", directory: "/repo" })
    expect(RunLease.claimInterrupted({ only: "/repo" }).map((item) => item.lease.sessionID)).toEqual(["ses_g"])
    expect(readdirSync(dir())).toContain("ses_f.json")
  })
})


describe("identicalCalls", () => {
  const tool = (index: number, output: string, input: Record<string, unknown> = { command: "npm test" }) =>
    ({
      id: `prt_${index}`,
      type: "tool",
      tool: "bash",
      callID: `call_${index}`,
      messageID: `msg_${index}`,
      sessionID: "ses",
      state: { status: "completed", input, output, title: "", metadata: {}, time: { start: 0, end: 1 } },
    }) as unknown as SessionV1.ToolPart

  // Each step of a run is its own assistant message, which is what the old guard missed.
  const step = (index: number, part: SessionV1.ToolPart) =>
    ({ info: { id: `msg_${index}`, role: "assistant" }, parts: [part] }) as unknown as SessionV1.WithParts
  const user = (text: string, synthetic = false) =>
    ({
      info: { id: "msg_u", role: "user" },
      parts: [{ id: "p", type: "text", text, synthetic }],
    }) as unknown as SessionV1.WithParts

  test("counts the same call and result across separate steps", () => {
    const steps = [0, 1, 2, 3].map((index) => step(index, tool(index, "FAIL")))
    expect(SessionProcessor.identicalCalls([user("fix it"), ...steps]).count).toBe(4)
  })

  test("changing output is polling, not a loop", () => {
    const steps = [step(0, tool(0, "pending")), step(1, tool(1, "pending")), step(2, tool(2, "ready"))]
    expect(SessionProcessor.identicalCalls(steps).count).toBe(1)
  })

  test("changing input breaks the streak", () => {
    const steps = [step(0, tool(0, "FAIL")), step(1, tool(1, "FAIL", { command: "npm test -- a" })), step(2, tool(2, "FAIL"))]
    expect(SessionProcessor.identicalCalls(steps).count).toBe(1)
  })

  test("a new instruction from the person starts the count again, a synthetic one does not", () => {
    const before = [step(0, tool(0, "FAIL")), step(1, tool(1, "FAIL"))]
    const after = [step(2, tool(2, "FAIL"))]
    expect(SessionProcessor.identicalCalls([...before, user("try again"), ...after]).count).toBe(1)
    expect(SessionProcessor.identicalCalls([...before, user("note", true), ...after]).count).toBe(3)
  })

  test("the call being made is not counted against itself", () => {
    const steps = [step(0, tool(0, "FAIL")), step(1, tool(1, "FAIL"))]
    expect(SessionProcessor.identicalCalls(steps, "call_1").count).toBe(1)
  })
})
