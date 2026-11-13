// AC-R5 (1.2.8 row 51a): a fixed --proxy-server must not take the app's own loopback traffic.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const indexSource = () => readFileSync(join(import.meta.dir, "index.ts"), "utf8")

describe("AC-R5 loopback proxy bypass", () => {
  test("main never subtracts Chromium's implicit loopback bypass", () => {
    const source = indexSource()
    expect(source.includes(`"<-loopback>"`)).toBe(false)
    expect(/applyLoopbackProxyBypass\(app\.commandLine\)/.test(source)).toBe(true)
  })

  test("the bypass list holds every loopback host and no <-loopback>", async () => {
    const { loopbackProxyBypassList, LOOPBACK_PROXY_BYPASS } = await import("./proxy-bypass")
    const items = loopbackProxyBypassList("").split(";")
    expect(items.length).toBe(LOOPBACK_PROXY_BYPASS.length)
    for (const host of ["localhost", "127.0.0.1/8", "[::1]"]) expect(items.includes(host)).toBe(true)
    expect(items.some((item) => item.toLowerCase() === "<-loopback>")).toBe(false)
  })

  test("entries the person passed stay; <-loopback> from the command line is dropped; no duplicates", async () => {
    const { loopbackProxyBypassList, LOOPBACK_PROXY_BYPASS } = await import("./proxy-bypass")
    const items = loopbackProxyBypassList("*.corp.example, 10.0.0.0/8;<-LOOPBACK>;localhost").split(";")
    expect(items.slice(0, 2)).toEqual(["*.corp.example", "10.0.0.0/8"])
    expect(items.includes("<-LOOPBACK>")).toBe(false)
    expect(items.filter((item) => item === "localhost").length).toBe(1)
    expect(items.length).toBe(2 + LOOPBACK_PROXY_BYPASS.length)
  })

  test("applyLoopbackProxyBypass sets the switch from the existing value", async () => {
    const { applyLoopbackProxyBypass } = await import("./proxy-bypass")
    const switches = new Map<string, string>([["proxy-bypass-list", "intranet.example"]])
    const calls: string[] = []
    const value = applyLoopbackProxyBypass({
      getSwitchValue: (name) => switches.get(name) ?? "",
      appendSwitch: (name, v) => {
        calls.push(name)
        switches.set(name, v ?? "")
      },
    })
    expect(calls).toEqual(["proxy-bypass-list"])
    expect(switches.get("proxy-bypass-list")).toBe(value)
    expect(value.startsWith("intranet.example;")).toBe(true)
    expect(value.includes("127.0.0.1/8")).toBe(true)
  })
})
