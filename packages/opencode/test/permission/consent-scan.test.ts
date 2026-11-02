import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConsentScan } from "../../src/permission/consent-scan"
import type { InstanceContext } from "../../src/project/instance-context"

let root: string
let instance: InstanceContext
const write = (relative: string, body = "x") => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "consent-scan-")))
  instance = { directory: root, worktree: root, project: { vcs: "git" } } as unknown as InstanceContext
  write(".env", "TOKEN=synthetic")
  write("config/.env.local")
  write("api/.env.production")
  write("certs/server.pem")
  write(".github/workflows/ci.yml")
  write("src/index.ts")
  write("node_modules/pkg/.env")
  write(".git/config")
  // Unreadable on purpose: the scan works from names, so a file nobody can open is listed all the same.
  fs.chmodSync(path.join(root, ".env"), 0o000)
})

afterAll(() => {
  fs.chmodSync(path.join(root, ".env"), 0o600)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("ConsentScan.scan", () => {
  test("constants match the addendum", () => {
    expect(ConsentScan.CONSENT_SCAN_MAX_FILES).toBe(2000)
    expect(ConsentScan.CONSENT_SCAN_MAX_MS).toBe(2000)
    expect(ConsentScan.CONSENT_LIST_MAX).toBe(50)
  })

  test("groups secret and sensitive names, skips node_modules and .git, and opens no file", async () => {
    const read = spyOn(fsp, "readFile")
    const result = await ConsentScan.scan({ instance, mission: ["fix the login form"] })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]))
    expect(byId["secret:.env*"].files).toEqual(
      [".env", "api/.env.production", "config/.env.local"].map((file) => path.join(root, file)),
    )
    expect(byId["secret:*.pem"].files).toEqual([path.join(root, "certs/server.pem")])
    expect(byId["sensitive:.github/**"].files).toEqual([path.join(root, ".github/workflows/ci.yml")])
    const all = result.items.flatMap((item) => item.files)
    expect(all.some((file) => file.includes("node_modules"))).toBe(false)
    expect(all.some((file) => file.includes(`${path.sep}.git${path.sep}`))).toBe(false)
    expect(all).not.toContain(path.join(root, "src/index.ts"))
    expect(result.items.every((item) => !item.checked)).toBe(true)
    expect(result.stopped).toBeUndefined()
    expect(result.dropped).toBe(0)
  })

  test("what the mission names is ticked and listed first", async () => {
    const result = await ConsentScan.scan({ instance, mission: ["deploy with `certs/server.pem`, keep .github as is."] })
    expect(result.items.slice(0, 2).map((item) => item.id)).toEqual(["secret:*.pem", "sensitive:.github/**"])
    expect(result.items.slice(0, 2).every((item) => item.named && item.checked)).toBe(true)
    expect(result.items.find((item) => item.id === "secret:.env*")!.checked).toBe(false)
  })

  test("a secret path outside that the mission names is listed; a readable one is not", async () => {
    const result = await ConsentScan.scan({ instance, mission: ["use ~/.ssh/id_ed25519 and read /usr/share/dict/words"] })
    const outside = result.items.filter((item) => item.kind === "outside")
    expect(outside.map((item) => item.pattern)).toEqual(["~/.ssh/id_ed25519"])
    expect(outside[0].files).toEqual([path.join(os.homedir(), ".ssh/id_ed25519")])
    expect(outside[0].checked).toBe(true)
  })

  test("destinations: named ones ticked, a broad one never", async () => {
    const result = await ConsentScan.scan({
      instance,
      mission: [],
      destinations: [
        { id: "git:origin", label: "git push origin", named: true },
        { id: "web", label: "Web fetch, any host", named: true, broad: true },
        { id: "rclone:nas", label: "rclone nas", named: false },
      ],
    })
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]))
    expect(byId["destination:git:origin"].checked).toBe(true)
    expect(byId["destination:web"].checked).toBe(false)
    expect(byId["destination:rclone:nas"].checked).toBe(false)
  })

  test("stops at the file limit and at the time limit", async () => {
    const files = await ConsentScan.scan({ instance, mission: [], maxFiles: 3 })
    expect(files.stopped).toBe("files")
    expect(files.scanned).toBe(3)
    let tick = 0
    const time = await ConsentScan.scan({ instance, mission: [], maxMs: 2, now: () => tick++ })
    expect(time.stopped).toBe("time")
  })

  test("at most 50 items, named first, the rest reported as dropped", async () => {
    const destinations = Array.from({ length: 60 }, (_, index) => ({
      id: `d${String(index).padStart(2, "0")}`,
      label: `dest ${String(index).padStart(2, "0")}`,
      named: index === 59,
    }))
    const result = await ConsentScan.scan({ instance, mission: [], destinations })
    expect(result.items).toHaveLength(50)
    expect(result.items[0].id).toBe("destination:d59")
    expect(result.dropped).toBe(60 + 3 - 50)
  })

  test("the same list gives the same hash, and a change gives another", async () => {
    const a = await ConsentScan.scan({ instance, mission: ["x"] })
    const b = await ConsentScan.scan({ instance, mission: ["x"] })
    const c = await ConsentScan.scan({ instance, mission: [".env"] })
    expect(a.hash).toBe(b.hash)
    expect(c.hash).not.toBe(a.hash)
  })
})
