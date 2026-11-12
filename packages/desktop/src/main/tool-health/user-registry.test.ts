// TH-01 (1.2.6 row 90): spec 01c 11.2, C7 / DP-2 field lock, U21 (user argv allowed, no approval).
// Red class B at e363918a69 (the module is new); behaviour runs through loadUserRegistry / resolveToolHealthRegistry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  USER_REGISTRY_MAX_BYTES,
  loadUserRegistry,
  mergeToolHealthRegistry,
  resolveToolHealthRegistry,
  userRegistryIssueMessage,
  userRegistryPath,
} from "./user-registry"
import { createToolHealthRegistry } from "./registry"

let home: string
let bin: string
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0)

const flux = (w: string) => ({
  label: "FLUX 3 image service",
  probe: {
    kind: "http",
    url: "http://127.0.0.1:7863/health",
    expectStatus: 200,
    expectJson: { weights_downloaded: true },
    timeoutMs: 3000,
  },
  revive: {
    argv: [bin, "kickstart", "gui/501/local.flux3-image-klein"],
    fallbackArgv: [bin, "submit", "-l", "local.flux3-image-klein", "--", `${w}/.venv/bin/python`, "-m", "uvicorn"],
  },
  startup: "probe",
  consent: "auto",
  installedWhen: { path: `${w}/.venv/bin/python` },
  reviveTimeoutMs: 30000,
  watch: [{ path: `${w}/server.py`, sha256: "a".repeat(64) }],
})

function writeRegistry(value: unknown, mode = 0o600) {
  const dir = join(home, ".config", "swarm")
  mkdirSync(dir, { recursive: true })
  const file = userRegistryPath(home)
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
  chmodSync(file, mode)
  return file
}

const ctx = () => ({ home, platform: "darwin", isPackaged: true, resourcesPath: join(home, "res"), appPath: join(home, "app") })

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "th-user-")))
  mkdirSync(join(home, "bin"))
  bin = join(home, "bin", "launcher")
  writeFileSync(bin, "#!/bin/sh\nexit 0\n")
  chmodSync(bin, 0o755)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("TH-01 user registry (01c 11.2)", () => {
  test("absent file: shipped registry only", () => {
    const user = loadUserRegistry({ home })
    expect(user.state).toBe("absent")
    expect(user.issues).toEqual([])
    const { components } = resolveToolHealthRegistry(ctx())
    expect(components.map((c) => c.id)).toEqual(["runtime", "searxng", "firecrawl", "render-bridge", "layout-runtime"])
    expect(components.every((c) => c.source === "shipped")).toBe(true)
  })

  test("1: a valid flux3 entry loads with source user", () => {
    writeRegistry({ components: { flux3: flux(join(home, "w")) } })
    const { components, user } = resolveToolHealthRegistry(ctx())
    expect(user.state).toBe("loaded")
    expect(user.issues).toEqual([])
    const f = components.find((c) => c.id === "flux3")!
    expect(f.source).toBe("user")
    expect(f.label).toBe("FLUX 3 image service")
    expect(f.probe).toEqual({
      kind: "http",
      url: "http://127.0.0.1:7863/health",
      expectStatus: 200,
      expectJson: { weights_downloaded: true },
      timeoutMs: 3000,
    })
    expect(f.revive).toEqual(flux(join(home, "w")).revive)
    expect(f.installedWhen).toEqual({ path: join(home, "w", ".venv", "bin", "python") })
    expect(f.reviveTimeoutMs).toBe(30000)
    expect(f.watch).toEqual([{ path: join(home, "w", "server.py"), sha256: "a".repeat(64) }])
    expect(components.at(-1)!.id).toBe("flux3")
  })

  test("1b: a missing revive program is kept (fails at revive time, not at load)", () => {
    const entry = flux(join(home, "w"))
    entry.revive.argv[0] = join(home, "w", ".venv", "bin", "not-yet")
    writeRegistry({ components: { flux3: entry } })
    const user = loadUserRegistry({ home })
    expect(user.components.map((c) => c.id)).toEqual(["flux3"])
  })

  test("1c: probe-only user entry (graphviz example) with defaults", () => {
    writeRegistry({ components: { graphviz: { label: "Graphviz dot", probe: { kind: "file", path: "/opt/homebrew/bin/dot" } } } })
    const user = loadUserRegistry({ home })
    expect(user.components).toEqual([
      { id: "graphviz", label: "Graphviz dot", probe: { kind: "file", path: "/opt/homebrew/bin/dot" }, startup: "probe", consent: "auto" },
    ])
  })

  test("2: mode 0666 refuses the whole file USER_REGISTRY_UNSAFE; shipped registry alone", () => {
    writeRegistry({ components: { flux3: flux(join(home, "w")) } }, 0o666)
    const { components, user } = resolveToolHealthRegistry(ctx())
    expect(user.state).toBe("refused")
    expect(user.issues.map((i) => i.code)).toEqual(["USER_REGISTRY_UNSAFE"])
    expect(components.map((c) => c.id)).not.toContain("flux3")
    expect(components).toHaveLength(5)
    expect(userRegistryIssueMessage(user.issues[0]!)).toContain("~/.config/swarm/tool-health.json was ignored")
  })

  test("2b: group-writable (0620) and a foreign owner are refused", () => {
    writeRegistry({ components: { flux3: flux(join(home, "w")) } }, 0o620)
    expect(loadUserRegistry({ home }).issues[0]!.code).toBe("USER_REGISTRY_UNSAFE")
    writeRegistry({ components: { flux3: flux(join(home, "w")) } }, 0o600)
    const foreign = loadUserRegistry({ home, getuid: () => uid() + 1 })
    expect(foreign.state).toBe("refused")
    expect(foreign.issues[0]!.code).toBe("USER_REGISTRY_UNSAFE")
    expect(foreign.issues[0]!.why).toContain("owned by another user")
    expect(loadUserRegistry({ home, getuid: uid }).state).toBe("loaded")
  })

  test("2c: a symlink leaving ~/.config/swarm is refused; one inside is followed", () => {
    const outside = join(home, "elsewhere.json")
    writeFileSync(outside, JSON.stringify({ components: {} }))
    chmodSync(outside, 0o600)
    mkdirSync(join(home, ".config", "swarm"), { recursive: true })
    symlinkSync(outside, userRegistryPath(home))
    const out = loadUserRegistry({ home })
    expect(out.state).toBe("refused")
    expect(out.issues[0]!.code).toBe("USER_REGISTRY_UNSAFE")
    rmSync(userRegistryPath(home))
    const inside = join(home, ".config", "swarm", "real.json")
    writeFileSync(inside, JSON.stringify({ components: { graphviz: { label: "dot", probe: { kind: "file", path: "/usr/bin/dot" } } } }))
    chmodSync(inside, 0o600)
    symlinkSync(inside, userRegistryPath(home))
    expect(loadUserRegistry({ home }).components.map((c) => c.id)).toEqual(["graphviz"])
  })

  test("3: over 64 KiB is refused; invalid JSON is refused USER_REGISTRY_INVALID", () => {
    writeRegistry(JSON.stringify({ components: {}, pad: "x".repeat(USER_REGISTRY_MAX_BYTES) }))
    const big = loadUserRegistry({ home })
    expect(big.state).toBe("refused")
    expect(big.issues[0]!.code).toBe("USER_REGISTRY_UNSAFE")
    writeRegistry("{ not json")
    const bad = loadUserRegistry({ home })
    expect(bad.state).toBe("refused")
    expect(bad.issues[0]!.code).toBe("USER_REGISTRY_INVALID")
    writeRegistry({ flux3: {} })
    expect(loadUserRegistry({ home }).issues[0]!.code).toBe("USER_REGISTRY_INVALID")
  })

  test("4: each bad entry is dropped alone with its reason; the others load", () => {
    const good = { label: "Good", probe: { kind: "http", url: "http://localhost:7000/", expectStatus: [200, 204] } }
    writeRegistry({
      components: {
        good,
        "remote-probe": { label: "Remote", probe: { kind: "http", url: "http://10.0.0.5/health", expectStatus: 200 } },
        "https-probe": { label: "Tls", probe: { kind: "http", url: "https://127.0.0.1/", expectStatus: 200 } },
        "relative-argv": { label: "Rel", probe: { kind: "file", path: "/opt/x" }, revive: { argv: ["launchctl", "kickstart"] } },
        "builtin-user": { label: "Builtin", probe: { kind: "file", path: "/opt/x" }, revive: { builtin: "compose-start" } },
        "unknown-key": { label: "Unknown", probe: { kind: "file", path: "/opt/x" }, shell: true },
        "unknown-requires": { label: "Req", probe: { kind: "file", path: "/opt/x" }, requires: ["nope"] },
        "cycle-a": { label: "A", probe: { kind: "file", path: "/opt/a" }, requires: ["cycle-b"] },
        "cycle-b": { label: "B", probe: { kind: "file", path: "/opt/b" }, requires: ["cycle-a"] },
        "needs-cycle": { label: "C", probe: { kind: "file", path: "/opt/c" }, requires: ["cycle-a"] },
        "needs-runtime": { label: "D", probe: { kind: "file", path: "/opt/d" }, requires: ["runtime", "good"] },
        "process-kind": { label: "P", probe: { kind: "process", check: "render-bridge" } },
        Bad_Id: { label: "X", probe: { kind: "file", path: "/opt/x" } },
      },
    })
    const user = loadUserRegistry({ home })
    expect(user.state).toBe("loaded")
    expect(user.components.map((c) => c.id).sort()).toEqual(["good", "needs-runtime"])
    const reasons = Object.fromEntries(user.issues.map((i) => [i.id, i.code]))
    expect(reasons).toEqual({
      "remote-probe": "PROBE_URL_NOT_LOOPBACK",
      "https-probe": "PROBE_URL_NOT_LOOPBACK",
      "relative-argv": "ENTRY_INVALID",
      "builtin-user": "REVIVE_BUILTIN_IN_USER_FILE",
      "unknown-key": "ENTRY_INVALID",
      "unknown-requires": "ENTRY_INVALID",
      "cycle-a": "ENTRY_INVALID",
      "cycle-b": "ENTRY_INVALID",
      "needs-cycle": "ENTRY_INVALID",
      "process-kind": "ENTRY_INVALID",
      Bad_Id: "ENTRY_INVALID",
    })
    expect(user.issues.find((i) => i.id === "cycle-a")!.why).toContain("cycle")
    expect(userRegistryIssueMessage(user.issues.find((i) => i.id === "remote-probe")!)).toBe(
      'tool-health.json entry "remote-probe" ignored: PROBE_URL_NOT_LOOPBACK: probe.url must be http on 127.0.0.1, localhost or [::1].',
    )
  })

  test("4b: a world-writable revive program drops the entry", () => {
    chmodSync(bin, 0o777)
    writeRegistry({ components: { flux3: flux(join(home, "w")) } })
    const user = loadUserRegistry({ home })
    expect(user.components).toEqual([])
    expect(user.issues[0]).toMatchObject({ code: "ENTRY_INVALID", id: "flux3" })
  })

  test("5: shipped id: revive override ignored SHIPPED_FIELD_LOCKED, startup off applied", () => {
    writeRegistry({
      components: {
        searxng: {
          startup: "off",
          consent: "manual",
          reviveTimeoutMs: 5000,
          revive: { argv: [bin, "evil"] },
          probe: { url: "http://127.0.0.1:1/", timeoutMs: 1500 },
          installedWhen: { path: "/opt/none" },
          requires: [],
          label: "Hijack",
        },
      },
    })
    const { components, user } = resolveToolHealthRegistry(ctx())
    const locked = user.issues.filter((i) => i.code === "SHIPPED_FIELD_LOCKED").map((i) => i.field)
    expect(locked.sort()).toEqual(["installedWhen", "label", "probe.url", "requires", "revive"].sort())
    expect(user.issues.every((i) => i.id === "searxng")).toBe(true)
    const shipped = createToolHealthRegistry(ctx()).find((c) => c.id === "searxng")!
    const s = components.find((c) => c.id === "searxng")!
    expect(s.source).toBe("shipped")
    expect(s.startup).toBe("off")
    expect(s.consent).toBe("manual")
    expect(s.reviveTimeoutMs).toBe(5000)
    expect(s.revive).toEqual({ builtin: "compose-start" })
    expect(s.label).toBe(shipped.label)
    expect(s.installedWhen).toEqual({ setupComponent: "searxng" })
    expect(s.requires).toEqual(["runtime"])
    expect(s.probe).toEqual({ ...shipped.probe, timeoutMs: 1500 })
    expect(components.filter((c) => c.id === "searxng")).toHaveLength(1)
    expect(userRegistryIssueMessage(user.issues[0]!)).toContain('tool-health.json entry "searxng" ignored: SHIPPED_FIELD_LOCKED')
  })

  test("5b: an invalid value for an overridable field drops that override only", () => {
    writeRegistry({ components: { firecrawl: { startup: "sometimes" }, runtime: { consent: "manual" } } })
    const { components, user } = resolveToolHealthRegistry(ctx())
    expect(user.issues).toEqual([expect.objectContaining({ code: "ENTRY_INVALID", id: "firecrawl" })])
    expect(components.find((c) => c.id === "firecrawl")!.startup).toBe("probe")
    expect(components.find((c) => c.id === "runtime")!.consent).toBe("manual")
  })

  test("merge never mutates the shipped array", () => {
    const shipped = createToolHealthRegistry(ctx())
    const before = JSON.stringify(shipped)
    mergeToolHealthRegistry(shipped, { components: [], overrides: { searxng: { startup: "off", probeTimeoutMs: 10 } } })
    expect(JSON.stringify(shipped)).toBe(before)
  })
})
