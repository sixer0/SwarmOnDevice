// 1.2.7 row 47g (M1-15, N7-122): on Linux the Tailscale self lookup runs only absolute CLI paths, never a PATH lookup.
// A fake `tailscale` planted first on PATH must not run. The real CLI is never run: no candidate exists in the test,
// and the planted fake only writes a marker file. Synthetic addresses only.
import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { existsSync } from "fs"
import os from "os"
import path from "path"

const load = () => import("@/provider/route-check")
const platform = Object.getOwnPropertyDescriptor(process, "platform")!
const savedPath = process.env.PATH
let dir: string | undefined

afterEach(async () => {
  Object.defineProperty(process, "platform", platform)
  process.env.PATH = savedPath
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

test("M1-15 a tailscale planted on PATH is not executed on Linux", async () => {
  const route = await load()
  const linux = (route as { TAILSCALE_LINUX_CLI_PATHS?: readonly string[] }).TAILSCALE_LINUX_CLI_PATHS
  // Safety: never run a real CLI from the test.
  for (const p of linux ?? []) expect(existsSync(p)).toBe(false)
  dir = await mkdtemp(path.join(os.tmpdir(), "r47g-"))
  const marker = path.join(dir, "ran")
  const fake = path.join(dir, "tailscale")
  await writeFile(fake, `#!/bin/sh\necho ran > "${marker}"\necho 100.64.0.9\n`)
  await chmod(fake, 0o755)
  process.env.PATH = `${dir}:${savedPath}`
  Object.defineProperty(process, "platform", { value: "linux" })
  const self = await route.osTailscaleSelf()
  expect(existsSync(marker)).toBe(false)
  expect(self).toBeUndefined()
})

test("M1-15 the Linux candidates are absolute and the call has no PATH lookup", async () => {
  const route = (await load()) as { TAILSCALE_LINUX_CLI_PATHS?: readonly string[] }
  expect(route.TAILSCALE_LINUX_CLI_PATHS).toEqual(["/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale"])
  const source = await readFile(path.join(import.meta.dir, "../../src/provider/route-check.ts"), "utf8")
  expect(source).not.toContain('? "tailscale"')
})
