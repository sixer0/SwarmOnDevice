// N13-341 (1.3.0 row 132, AC-S6a, folded F1 / F3 / F4). The desktop refreshes an already staged swarm-web-proxy
// from the app bundle once per packaged launch, before tool-health and before the sidecar spawn. Mirrors
// packages/setup/test/proxy_stage.test.ts. Synthetic fixtures in throwaway temp dirs only (never the user's HOME):
// every HOME and program dir is an mkdtemp folder passed in explicitly.
//
// Run TARGETED: cd packages/desktop && bun test src/main/rel130-s6-proxy-refresh.test.ts

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refreshStagedProxy } from "./proxy-refresh"
import { PROXY_MAX_BYTES } from "../../../setup/src/wiring/proxy_stage"

const CODES = ["PROXY_REFRESHED", "PROXY_CURRENT", "PROXY_ABSENT", "PROXY_REFUSED", "PROXY_FAILED"]
const NAME = "swarm-web-proxy"
const NEW_BYTES = "#!/bin/sh\necho swarm-web-proxy fixture 1.3.0\n"
const OLD_BYTES = "#!/bin/sh\necho swarm-web-proxy fixture 1.2.9\n" // same length as NEW_BYTES, other bytes
const SHORT_OLD = "#!/bin/sh\necho old\n"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) {
    try {
      fs.chmodSync(join(d, ".swarm", "setup", "bin"), 0o700)
    } catch {}
    fs.rmSync(d, { recursive: true, force: true })
  }
})
afterEach(() => mock.restore())

const fresh = (prefix: string) => {
  const d = fs.mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")
const swarmDir = (h: string) => join(h, ".swarm")
const binDir = (h: string) => join(h, ".swarm", "setup", "bin")
const target = (h: string) => join(binDir(h), NAME)

/** An app bundle: <resources>/swarm-setup/swarm-web-proxy. */
function resources(bytes: string | null = NEW_BYTES): string {
  const r = fresh("r132-res-")
  fs.mkdirSync(join(r, "swarm-setup"), { mode: 0o700 })
  if (bytes !== null) fs.writeFileSync(join(r, "swarm-setup", NAME), bytes, { mode: 0o755 })
  return r
}
const bundled = (r: string) => join(r, "swarm-setup", NAME)

/** A HOME with the chain at 0700 and, optionally, a staged proxy. */
function home(staged: string | null): string {
  const h = fresh("r132-home-")
  fs.mkdirSync(binDir(h), { recursive: true, mode: 0o700 })
  for (const d of [swarmDir(h), join(h, ".swarm", "setup"), binDir(h)]) fs.chmodSync(d, 0o700)
  if (staged !== null) fs.writeFileSync(target(h), staged, { mode: 0o755 })
  return h
}

type Line = { level: string; code: string; context: { ms: number } }
function run(h: string, r: string, extra: Partial<Parameters<typeof refreshStagedProxy>[0]> = {}) {
  const lines: Line[] = []
  const code = refreshStagedProxy({
    isPackaged: true,
    resourcesPath: r,
    home: h,
    log: (level, code, context) => lines.push({ level, code, context }),
    ...extra,
  })
  return { code, lines }
}
const binEntries = (h: string) => fs.readdirSync(binDir(h)).sort()

describe("content decides (F1)", () => {
  test("differs (other size) -> replaced, hash equal to the bundle, mode 0755", () => {
    const h = home(SHORT_OLD)
    const r = resources()
    const { code, lines } = run(h, r)
    expect(code).toBe("PROXY_REFRESHED")
    expect(sha(fs.readFileSync(target(h)))).toBe(sha(fs.readFileSync(bundled(r))))
    expect(fs.lstatSync(target(h)).mode & 0o777).toBe(0o755)
    expect(binEntries(h)).toEqual([NAME]) // no temp left
    expect(lines.map((l) => l.code)).toEqual(["PROXY_REFRESHED"])
  })

  test("equal -> no write (same inode, same mtime)", () => {
    const h = home(NEW_BYTES)
    const r = resources()
    const before = fs.statSync(target(h))
    const { code } = run(h, r)
    expect(code).toBe("PROXY_CURRENT")
    const after = fs.statSync(target(h))
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test("(g) same size, different bytes, mtime copied from the bundle -> replaced", () => {
    const h = home(OLD_BYTES)
    const r = resources()
    expect(fs.statSync(target(h)).size).toBe(fs.statSync(bundled(r)).size)
    const st = fs.statSync(bundled(r))
    fs.utimesSync(target(h), st.atime, st.mtime)
    const { code } = run(h, r)
    expect(code).toBe("PROXY_REFRESHED")
    expect(fs.readFileSync(target(h), "utf8")).toBe(NEW_BYTES)
  })

  test("(h) a sparse target larger than PROXY_MAX_BYTES -> replaced without being read", () => {
    const h = home(null)
    const fd = fs.openSync(target(h), "w", 0o755)
    fs.ftruncateSync(fd, PROXY_MAX_BYTES + 4096) // sparse: no data blocks
    fs.closeSync(fd)
    fs.chmodSync(target(h), 0o755)
    const r = resources()
    const t = target(h)
    const touches = (calls: unknown[][]) => calls.filter((c) => c[0] === t).length
    const readFile = spyOn(fs, "readFileSync")
    const open = spyOn(fs, "openSync")
    const { code } = run(h, r)
    const readsOfTarget = touches(readFile.mock.calls) + touches(open.mock.calls)
    mock.restore()
    expect(code).toBe("PROXY_REFRESHED")
    expect(readsOfTarget).toBe(0)
    expect(fs.statSync(t).size).toBe(Buffer.byteLength(NEW_BYTES))
  })
})

describe("nothing is created when setup never ran (F3)", () => {
  test("no ~/.swarm at all -> PROXY_ABSENT, HOME stays empty", () => {
    const h = fresh("r132-home-")
    const { code } = run(h, resources())
    expect(code).toBe("PROXY_ABSENT")
    expect(fs.readdirSync(h)).toEqual([])
  })

  test("chain present, target absent -> PROXY_ABSENT, bin stays empty", () => {
    const h = home(null)
    const { code } = run(h, resources())
    expect(code).toBe("PROXY_ABSENT")
    expect(binEntries(h)).toEqual([])
  })

  test("target deleted between the check and the copy (injected lstat) -> no file, no temp", () => {
    const h = home(SHORT_OLD)
    const t = target(h)
    const realLstat = fs.lstatSync
    let seen = 0
    spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realLstat(p, o as never)
      if (String(p) === t && ++seen === 1) fs.rmSync(t) // the gate saw it; it is gone before the content step
      return st
    }) as typeof fs.lstatSync)
    const { code } = run(h, resources())
    mock.restore()
    expect(seen).toBeGreaterThanOrEqual(1)
    expect(code).toBe("PROXY_ABSENT")
    expect(binEntries(h)).toEqual([])
  })

  test("source absent in the bundle -> PROXY_ABSENT, staged copy untouched", () => {
    const h = home(SHORT_OLD)
    const before = fs.statSync(target(h))
    const { code } = run(h, resources(null))
    expect(code).toBe("PROXY_ABSENT")
    expect(fs.readFileSync(target(h), "utf8")).toBe(SHORT_OLD)
    expect(fs.statSync(target(h)).mtimeMs).toBe(before.mtimeMs)
  })

  test("not packaged -> the stager is never called and nothing is logged", () => {
    const h = home(SHORT_OLD)
    let calls = 0
    const lines: unknown[] = []
    const code = refreshStagedProxy({
      isPackaged: false,
      resourcesPath: resources(),
      home: h,
      log: (...a) => lines.push(a),
      stage: () => {
        calls++
        return { ok: true, staged: false, reason: "x" }
      },
    })
    expect(code).toBeUndefined()
    expect(calls).toBe(0)
    expect(lines).toEqual([])
    expect(fs.readFileSync(target(h), "utf8")).toBe(SHORT_OLD)
  })
})

describe("refusals", () => {
  test("symlink target -> PROXY_REFUSED, link untouched", () => {
    const h = home(null)
    const elsewhere = join(fresh("r132-other-"), "real")
    fs.writeFileSync(elsewhere, SHORT_OLD)
    fs.symlinkSync(elsewhere, target(h))
    const { code } = run(h, resources())
    expect(code).toBe("PROXY_REFUSED")
    expect(fs.lstatSync(target(h)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(target(h))).toBe(elsewhere)
    expect(fs.readFileSync(elsewhere, "utf8")).toBe(SHORT_OLD)
  })

  test("bin a symlink -> PROXY_REFUSED, nothing written through it", () => {
    const h = home(null)
    const realBin = fresh("r132-realbin-")
    fs.writeFileSync(join(realBin, NAME), SHORT_OLD, { mode: 0o755 })
    fs.rmdirSync(binDir(h))
    fs.symlinkSync(realBin, binDir(h))
    const { code } = run(h, resources())
    expect(code).toBe("PROXY_REFUSED")
    expect(fs.readdirSync(realBin)).toEqual([NAME])
    expect(fs.readFileSync(join(realBin, NAME), "utf8")).toBe(SHORT_OLD)
  })

  test("bin mode 0777 -> PROXY_REFUSED, staged copy untouched", () => {
    const h = home(SHORT_OLD)
    fs.chmodSync(binDir(h), 0o777)
    const { code } = run(h, resources())
    expect(code).toBe("PROXY_REFUSED")
    expect(fs.readFileSync(target(h), "utf8")).toBe(SHORT_OLD)
  })

  test("a throwing stager -> PROXY_FAILED, never throws into the launch", () => {
    const h = home(SHORT_OLD)
    const { code, lines } = run(h, resources(), {
      stage: () => {
        throw new Error(`boom at ${target(h)}`)
      },
    })
    expect(code).toBe("PROXY_FAILED")
    expect(lines).toHaveLength(1)
    expect(lines[0]!.level).toBe("error")
  })
})

describe("fixed log codes only (F4)", () => {
  test("every outcome logs exactly one line: a fixed code and the elapsed ms, no path or reason", () => {
    const cases: Array<[string, () => { h: string; r: string }]> = [
      ["refreshed", () => ({ h: home(SHORT_OLD), r: resources() })],
      ["current", () => ({ h: home(NEW_BYTES), r: resources() })],
      ["absent", () => ({ h: home(null), r: resources() })],
      [
        "refused",
        () => {
          const h = home(SHORT_OLD)
          fs.chmodSync(binDir(h), 0o777)
          return { h, r: resources() }
        },
      ],
      ["failed", () => ({ h: home(SHORT_OLD), r: resources("") })], // empty source: implausible size
    ]
    const seen = new Set<string>()
    for (const [, make] of cases) {
      const { h, r } = make()
      const { lines } = run(h, r)
      expect(lines).toHaveLength(1)
      const line = lines[0]!
      expect(CODES).toContain(line.code)
      expect(Object.keys(line.context)).toEqual(["ms"])
      expect(typeof line.context.ms).toBe("number")
      const text = JSON.stringify(line)
      expect(text).not.toContain(h)
      expect(text).not.toContain(r)
      expect(text).not.toContain(NAME)
      seen.add(line.code)
    }
    expect([...seen].sort()).toEqual([...CODES].sort())
  })

  test("proxy-refresh.ts logs no string other than the five codes", () => {
    const src = fs.readFileSync(join(import.meta.dir, "proxy-refresh.ts"), "utf8")
    expect(src).toContain("opts.log(LEVEL[code], code, { ms })")
    expect(src.match(/\.log\(/g)).toHaveLength(1)
    expect(src).not.toMatch(/\breason\b[^\n]*opts\.log|opts\.log\([^\n]*reason/)
    for (const c of CODES) expect(src).toContain(`"${c}"`)
    expect(src.match(/"PROXY_[A-Z_]+"/g)!.filter((c) => !CODES.includes(c.slice(1, -1)))).toEqual([])
  })
})

describe("launch order and single caller (F4)", () => {
  const indexSrc = fs.readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  const at = (needle: string) => {
    const i = indexSrc.indexOf(needle)
    expect(i).toBeGreaterThan(-1)
    return i
  }

  test("the refresh is synchronous: nothing after its call in index.ts can start before it finished", () => {
    const h = home(SHORT_OLD)
    const order: string[] = []
    const code = refreshStagedProxy({
      isPackaged: true,
      resourcesPath: resources(),
      home: h,
      log: () => order.push("refresh"),
    })
    order.push("spawner") // the injected next step of the launch: tool-health / sidecar spawn
    expect(code).toBe("PROXY_REFRESHED")
    expect(typeof (code as unknown as { then?: unknown })?.then).toBe("undefined")
    expect(order).toEqual(["refresh", "spawner"])
  })

  test("index.ts calls it once, before tool-health runStartup and before every sidecar spawn", () => {
    expect(indexSrc.match(/refreshStagedProxy\(/g)).toHaveLength(1)
    const call = at("refreshStagedProxy(")
    expect(call).toBeLessThan(at("createToolHealth({"))
    expect(call).toBeLessThan(at("toolHealth.runStartup()"))
    expect(call).toBeLessThan(at("spawnLocalServer(hostname"))
    expect(call).toBeLessThan(at("startBackgroundCli(logger"))
    expect(call).toBeLessThan(at("wslServers.initialize()"))
    const args = indexSrc.slice(call, indexSrc.indexOf(")", indexSrc.indexOf("})", call)) + 1)
    expect(args).toContain("isPackaged: app.isPackaged")
    expect(args).toContain("resourcesPath: process.resourcesPath")
    expect(args).toContain("home: homedir()")
    expect(args).not.toContain("process.env")
    expect(args).not.toContain("stage:")
  })

  test("no other desktop source calls or wires it (no IPC, menu or renderer trigger)", () => {
    const root = join(import.meta.dir, "..")
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (
          /\.tsx?$/.test(e.name) &&
          !/\.(test|d)\.tsx?$/.test(e.name) &&
          fs.readFileSync(p, "utf8").includes("proxy-refresh")
        )
          hits.push(p.slice(root.length + 1))
      }
    }
    walk(root)
    expect(hits).toEqual(["main/index.ts"])
  })
})

describe("setup-proxy-stage.d.ts stays equal to proxy_stage.ts (C110 drift)", () => {
  const dts = fs.readFileSync(join(import.meta.dir, "setup-proxy-stage.d.ts"), "utf8")
  const real = fs.readFileSync(join(import.meta.dir, "../../../setup/src/wiring/proxy_stage.ts"), "utf8")
  const exportsOf = (src: string) =>
    [...src.matchAll(/^export\s+(?:declare\s+)?(?:function|const|interface|type)\s+(\w+)/gm)].map((m) => m[1]!)
  const block = (src: string, head: RegExp) => {
    const start = src.search(head)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf("\n}", start))
  }
  const optionKeys = (src: string) =>
    [...block(src, /export interface ProxyStageOptions \{/).matchAll(/^\s*readonly (\w+)\?:\s*(\w+)/gm)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort()
  const resultVariants = (src: string) =>
    block(src, /export type ProxyStageResult =/)
      .split("\n")
      .filter((l) => l.trim().startsWith("|"))
      .map((l) => l.replace(/\s+/g, " ").trim())

  test("every name the .d.ts declares is exported by proxy_stage.ts", () => {
    const declared = exportsOf(dts)
    expect(declared.sort()).toEqual(["PROXY_REFRESH_UNSAFE_DIR", "ProxyStageOptions", "ProxyStageResult", "stageProxyBinary"])
    const exported = exportsOf(real)
    for (const name of declared) expect(exported).toContain(name)
  })

  test("option keys and types are equal", () => {
    expect(optionKeys(dts)).toEqual(optionKeys(real))
    expect(optionKeys(dts)).toEqual(["base:string", "programDir:string", "requireExisting:boolean"])
  })

  test("result variants are equal", () => {
    expect(resultVariants(dts)).toEqual(resultVariants(real))
    expect(resultVariants(dts)).toHaveLength(3)
  })

  test("runtime values match the declared ones", async () => {
    const mod = await import("../../../setup/src/wiring/proxy_stage")
    expect(typeof mod.stageProxyBinary).toBe("function")
    expect(mod.PROXY_REFRESH_UNSAFE_DIR).toBe("PROXY_REFRESH_UNSAFE_DIR")
    expect(dts).toContain('PROXY_REFRESH_UNSAFE_DIR: "PROXY_REFRESH_UNSAFE_DIR"')
  })

  test("tsconfig maps the alias to the .d.ts first and the real source second; vite aliases the real source", () => {
    const tsconfig = JSON.parse(fs.readFileSync(join(import.meta.dir, "../../tsconfig.json"), "utf8"))
    expect(tsconfig.compilerOptions.paths["@swarm-setup/proxy-stage"]).toEqual([
      "./src/main/setup-proxy-stage",
      "../setup/src/wiring/proxy_stage.ts",
    ])
    const vite = fs.readFileSync(join(import.meta.dir, "../../electron.vite.config.ts"), "utf8")
    expect(vite).toContain(`"@swarm-setup/proxy-stage": path.resolve("../setup/src/wiring/proxy_stage.ts")`)
  })
})
