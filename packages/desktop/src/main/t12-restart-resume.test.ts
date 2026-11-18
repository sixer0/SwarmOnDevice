/**
 * 1.3.4 T-12: Restart from the menu and the accepted memory reopen keep the running agent turns going. The sidecar gets
 * `{ type: "stop", resume: true }`, hands its run leases over and exits 75; every other stop stays a real stop.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseSidecarCommand } from "./sidecar-start"

const read = (name: string) => readFileSync(path.join(import.meta.dir, name), "utf8").replace(/\/\/.*$/gm, "")

describe("T-12 restart with resume", () => {
  test("the stop command carries resume only when it is exactly true", () => {
    expect(parseSidecarCommand({ type: "stop", resume: true })).toEqual({ type: "stop", resume: true })
    expect(parseSidecarCommand({ type: "stop" })).toEqual({ type: "stop" })
    expect(parseSidecarCommand({ type: "stop", resume: "yes" })).toEqual({ type: "stop" })
    expect(parseSidecarCommand({ type: "stop", resume: 1 })).toEqual({ type: "stop" })
  })

  test("the sidecar hands over on resume and exits 75; a plain stop still stops the server", () => {
    const sidecar = read("sidecar.ts")
    expect(sidecar).toMatch(/if \(command\.resume\) handOver\(\)\s*else void stop\(\)/)
    expect(sidecar).toContain("runLease?.handOver()")
    expect(sidecar).toContain("process.exit(75)")
    // owner U4: the consent the person gave is carried once, written before the exit
    expect(sidecar).toContain("scopes = consentCarry?.write() ?? 0")
    expect(sidecar.indexOf("consentCarry?.write()")).toBeLessThan(sidecar.indexOf("process.exit(75)"))
    expect(sidecar).toMatch(/async function stop\(\)[\s\S]*await listener\?\.stop\(\)[\s\S]*process\.exit\(0\)/)
  })

  test("only the menu Restart and the memory reopen resume; quit and the other relaunches do not", () => {
    const index = read("index.ts")
    expect(index).toContain("const relaunchAndResume = () => relaunch({ resume: true })")
    // memory watch
    expect(index).toMatch(/showMessageBox: \(options\) => patchMessageBox\(patchWindow\(\), options\),\s*relaunch: relaunchAndResume,/)
    // application menu (Restart)
    expect(index).toMatch(/install DATUM Studio for Claude failed", error\)\),\s*relaunch: relaunchAndResume,/)
    expect(index.match(/relaunchAndResume/g)?.length).toBe(3)
    // quit never resumes
    expect(index).toMatch(/const quit = \(\) => \{\s*setAppQuitting\(\)\s*void stopSidecars\(\)\.finally/)
  })

  test("server.ts forwards resume to the sidecar message", () => {
    const server = read("server.ts")
    expect(server).toContain('child.postMessage(options?.resume ? { type: "stop", resume: true } : { type: "stop" })')
  })
})
