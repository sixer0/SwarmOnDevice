// 1.3.4 T-12: a restart the desktop starts itself (menu Restart, accepted memory reopen) hands the running turns to the
// next launch. Without the hand-over a deliberate exit marks every lease stopped, so the relaunched server tidies the
// turns as aborted and the sessions stay idle (measured on 2026-11-18: more than 4 minutes until a person wrote).
// Each case runs in its own process, because hand-over is a one-way state of the process that is about to exit.
import { Global } from "@opencode-ai/core/global"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { RunLease } from "../../src/session/run-lease"

const dir = () => path.join(Global.Path.state, "runs")
const LEASE = path.resolve(import.meta.dir, "../../src/session/run-lease.ts")

// The child shares the test state folder through the environment the preload set.
function child(body: string, exitCode: number) {
  const script = `
    import { RunLease } from ${JSON.stringify(LEASE)}
    RunLease.enable()
    ${body}
    process.exit(${exitCode})
  `
  const run = Bun.spawnSync(["bun", "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" })
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() }
}

afterEach(() => rmSync(dir(), { recursive: true, force: true }))

describe("RunLease.handOver (T-12)", () => {
  test("without hand-over a deliberate exit marks the run stopped: it is tidied, not continued", () => {
    const r = child(`RunLease.begin({ sessionID: "ses_quit", directory: "/repo" })`, 0)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(path.join(dir(), "ses_quit.json"), "utf8")).stopped).toBe(true)
    const [item] = RunLease.claimInterrupted()
    expect(item?.action).toBe("stopped")
  })

  test("with hand-over the lease survives untouched, even through end() and a deliberate exit code", () => {
    const r = child(
      `RunLease.begin({ sessionID: "ses_keep", directory: "/repo" })
       console.log(RunLease.handOver())
       RunLease.end("ses_keep")`,
      0,
    )
    expect(r.code).toBe(0)
    expect(r.out).toBe("1")
    const lease = JSON.parse(readFileSync(path.join(dir(), "ses_keep.json"), "utf8"))
    expect(lease.stopped).toBeUndefined()
    const [item, ...rest] = RunLease.claimInterrupted()
    expect(rest).toEqual([])
    expect(item?.action).toBe("continue")
    expect(item?.lease).toMatchObject({ sessionID: "ses_keep", pid: process.pid, resumes: 1 })
    RunLease.end("ses_keep")
  })

  test("the sidecar's hand-over exit code 75 is not read as a stop", () => {
    const r = child(`RunLease.begin({ sessionID: "ses_75", directory: "/repo" }); RunLease.handOver()`, 75)
    expect(r.code).toBe(75)
    expect(RunLease.claimInterrupted().map((i) => i.action)).toEqual(["continue"])
    RunLease.end("ses_75")
  })

  test("hand-over with nothing running reports zero and leaves no file", () => {
    const r = child(`console.log(RunLease.handOver())`, 75)
    expect(r.out).toBe("0")
    expect(existsSync(dir()) ? RunLease.claimInterrupted() : []).toEqual([])
  })
})
