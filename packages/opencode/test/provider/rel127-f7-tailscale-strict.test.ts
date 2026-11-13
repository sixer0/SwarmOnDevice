// 1.2.7 F-7 (C8, D-13; N7-112): on macOS every VPN client makes a `utunN`, and some of them use the same
// 100.64.0.0/10 space as Tailscale. A utun now counts as Tailscale only when one of its addresses is also an address
// the Tailscale CLI reports as this machine's own. CLI missing or silent: not verified, so the warning shows.
// Everything is stubbed (probe, interface addresses, self lookup, sink, clock): no route command and no Tailscale CLI
// runs. Synthetic 100.64.0.0/10 addresses only.
import { afterEach, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"

const CODE = "PROVIDER_ROUTE_UNVERIFIED"
const HOST = "100.100.9.9"
const IFACE_ADDRESS = "100.100.1.2"
const OTHER_VPN_SELF = "100.64.0.9"

// Loaded dynamically, and the new seam called optionally, so that at the base the behaviour assertions fail
// (red class A) instead of the import or the call.
const loadRoute = () => import("@/provider/route-check").then((m) => m.ProviderRoute)

afterEach(async () => {
  ;(await loadRoute()).reset()
})

type Stub = { iface: string; addresses?: string[]; self?: string[] | undefined }

const run = async (stub: Stub, calls = 1) => {
  const route = await loadRoute()
  const warned: { code: string; iface?: string; message: string }[] = []
  let selfCalls = 0
  let t = 1_000_000
  route.setClock(() => t)
  route.setSink((w) => warned.push({ code: w.code, iface: w.iface, message: w.message }))
  route.setProbe(async () => stub.iface)
  route.setAddresses(async () => stub.addresses)
  ;(route as { setTailscaleSelf?: (next: () => Promise<string[] | undefined>) => void }).setTailscaleSelf?.(
    async () => (selfCalls++, stub.self),
  )
  for (let i = 0; i < calls; i++) {
    route.check(HOST)
    await route.settled()
    t += 1_000
  }
  return { warned, selfCalls: () => selfCalls }
}

test("F-7 case 1: another VPN's utun in 100.64/10 whose address the Tailscale CLI does not report warns", async () => {
  const { warned } = await run({ iface: "utun5", addresses: [IFACE_ADDRESS], self: [OTHER_VPN_SELF] })
  expect(warned.length).toBe(1)
  expect(warned[0]!.code).toBe(CODE)
  expect(warned[0]!.iface).toBe("utun5")
})

test("F-7 case 2: a utun whose address the Tailscale CLI reports as its own does not warn", async () => {
  const { warned } = await run({ iface: "utun5", addresses: [IFACE_ADDRESS], self: [IFACE_ADDRESS] })
  expect(warned.length).toBe(0)
})

test("F-7 case 3: Tailscale CLI missing or silent (no self address) warns", async () => {
  const { warned } = await run({ iface: "utun5", addresses: [IFACE_ADDRESS], self: undefined })
  expect(warned.length).toBe(1)
  expect(warned[0]!.iface).toBe("utun5")
})

test("F-7 case 4: an interface named by Tailscale does not warn and the CLI is not asked", async () => {
  const { warned, selfCalls } = await run({ iface: "tailscale0", self: [OTHER_VPN_SELF] })
  expect(warned.length).toBe(0)
  expect(selfCalls()).toBe(0)
})

test("F-7 case 5: a non-tunnel interface warns and the CLI is not asked", async () => {
  const { warned, selfCalls } = await run({ iface: "en0", addresses: [IFACE_ADDRESS], self: [IFACE_ADDRESS] })
  expect(warned.length).toBe(1)
  expect(warned[0]!.iface).toBe("en0")
  expect(selfCalls()).toBe(0)
})

test("F-7 case 6: 20 checks within CACHE_MS ask the Tailscale CLI once", async () => {
  const route = await loadRoute()
  expect((route as { setTailscaleSelf?: unknown }).setTailscaleSelf).toBeDefined()
  const { warned, selfCalls } = await run({ iface: "utun5", addresses: [IFACE_ADDRESS], self: [IFACE_ADDRESS] }, 20)
  expect(20 * 1_000).toBeLessThan(route.CACHE_MS)
  expect(selfCalls()).toBe(1)
  expect(warned.length).toBe(0)
})

test("F-7 the self address never reaches the warning", async () => {
  const { warned } = await run({ iface: "utun5", addresses: [IFACE_ADDRESS], self: [OTHER_VPN_SELF] })
  expect(warned.length).toBe(1)
  expect(JSON.stringify(warned)).not.toContain(OTHER_VPN_SELF)
  expect(JSON.stringify(warned)).not.toContain(IFACE_ADDRESS)
})

// N7-122 and N7-120: absolute macOS CLI paths in order, called through execFile with `ip -4` and TAILSCALE_BE_CLI=1
// (pinned from the source, so that no Tailscale CLI is run by this test).
test("F-7 the macOS CLI candidates are absolute, in order, and the call is execFile `ip -4` without a shell", async () => {
  const route = (await loadRoute()) as { TAILSCALE_CLI_PATHS?: readonly string[]; osTailscaleSelf?: unknown }
  expect(route.TAILSCALE_CLI_PATHS).toEqual([
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
  ])
  expect(typeof route.osTailscaleSelf).toBe("function")
  const source = await readFile(path.join(import.meta.dir, "../../src/provider/route-check.ts"), "utf8")
  expect(source).toContain('run(bin, ["ip", "-4"], { ...process.env, TAILSCALE_BE_CLI: "1" })')
  expect(source).toContain("execFile(cmd, args, {")
  expect(source).not.toMatch(/(?<![.\w])(?:exec|execSync|spawn|spawnSync)\(|shell:\s*true/)
})
