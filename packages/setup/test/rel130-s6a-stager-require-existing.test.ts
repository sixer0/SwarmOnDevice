// 1.3.0 row 132a (AC-S6a contributor, folded F3 / S13-02). The desktop refreshes an already staged
// swarm-web-proxy at launch (row 132). It must never create ~/.swarm on its own (no consent screen is
// bypassed), and it must not write through a parent directory another user or a symlink controls. So
// `stageProxyBinary` gains `requireExisting: true`:
//   - target absent (or any parent absent) -> `{ ok: true, staged: false }`, no dir, no temp file, no setup.log;
//   - `~/.swarm`, `~/.swarm/setup`, `~/.swarm/setup/bin` must each be a real directory (not a symlink), owned
//     by the current uid, with `mode & 0o022 === 0`; otherwise refused with `PROXY_REFRESH_UNSAFE_DIR`;
//   - existing regular target -> the stager's usual content rule (equal -> no-op, differs -> atomic replace).
// Synthetic fixtures in a throwaway HOME only (never the user's).
//
// Run TARGETED: cd packages/setup && bun test test/rel130-s6a-stager-require-existing.test.ts

import { describe, it, expect, afterAll } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stageProxyBinary } from "../src/wiring/proxy_stage.ts"
import { PROXY_BINARY_NAME } from "../src/mcpproxy/register.ts"

const UNSAFE = "PROXY_REFRESH_UNSAFE_DIR"
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) {
    // a 0777 / 0757 fixture dir is still removable by its owner; restore modes first for safety
    try {
      chmodSync(d, 0o700)
    } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})

function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function sha(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex")
}

const NEW_BYTES = "#!/bin/sh\necho swarm-web-proxy fixture 1.3.0\n"
const OLD_BYTES = "#!/bin/sh\necho swarm-web-proxy fixture old\n"

function program(): { dir: string; sha: string } {
  const dir = fresh("r132a-prog-")
  writeFileSync(join(dir, PROXY_BINARY_NAME), NEW_BYTES, { mode: 0o644 })
  return { dir, sha: sha(Buffer.from(NEW_BYTES)) }
}

const swarmDir = (h: string) => join(h, ".swarm")
const setupDir = (h: string) => join(h, ".swarm", "setup")
const binDir = (h: string) => join(h, ".swarm", "setup", "bin")
const target = (h: string) => join(binDir(h), PROXY_BINARY_NAME)
const setupLog = (h: string) => join(setupDir(h), "setup.log")

/** A HOME with the chain at 0700 and, optionally, an old staged proxy. */
function homeWithChain(withTarget: boolean): string {
  const home = fresh("r132a-home-")
  mkdirSync(binDir(home), { recursive: true, mode: 0o700 })
  for (const d of [swarmDir(home), setupDir(home), binDir(home)]) chmodSync(d, 0o700)
  if (withTarget) writeFileSync(target(home), OLD_BYTES, { mode: 0o755 })
  return home
}

describe("absent target under requireExisting -> nothing written", () => {
  it("no ~/.swarm at all: staged false, no dir created, no setup.log", () => {
    const home = fresh("r132a-home-")
    const prog = program()
    const r = stageProxyBinary({ base: home, programDir: prog.dir, requireExisting: true })
    expect(r).toMatchObject({ ok: true, staged: false })
    expect(existsSync(swarmDir(home))).toBe(false)
    expect(readdirSync(home)).toEqual([])
  })

  it("chain present, target absent: staged false, bin stays empty (no temp), no setup.log", () => {
    const home = homeWithChain(false)
    const prog = program()
    const r = stageProxyBinary({ base: home, programDir: prog.dir, requireExisting: true })
    expect(r).toMatchObject({ ok: true, staged: false })
    expect(readdirSync(binDir(home))).toEqual([])
    expect(existsSync(setupLog(home))).toBe(false)
  })
})

describe("unsafe parent chain -> PROXY_REFRESH_UNSAFE_DIR, target untouched", () => {
  it("bin is a symlink to a real directory: refused, link and the linked copy untouched, no setup.log", () => {
    const home = fresh("r132a-home-")
    mkdirSync(setupDir(home), { recursive: true, mode: 0o700 })
    chmodSync(swarmDir(home), 0o700)
    chmodSync(setupDir(home), 0o700)
    const elsewhere = fresh("r132a-elsewhere-")
    writeFileSync(join(elsewhere, PROXY_BINARY_NAME), OLD_BYTES, { mode: 0o755 })
    symlinkSync(elsewhere, binDir(home))
    const prog = program()

    const r = stageProxyBinary({ base: home, programDir: prog.dir, requireExisting: true })
    expect(r).toMatchObject({ ok: false, code: UNSAFE })
    expect(lstatSync(binDir(home)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(binDir(home))).toBe(elsewhere)
    expect(readFileSync(join(elsewhere, PROXY_BINARY_NAME), "utf8")).toBe(OLD_BYTES)
    expect(readdirSync(elsewhere)).toEqual([PROXY_BINARY_NAME])
    expect(existsSync(setupLog(home))).toBe(false)
  })

  it("bin mode 0777: refused, old copy untouched, no temp", () => {
    const home = homeWithChain(true)
    chmodSync(binDir(home), 0o777)
    const prog = program()
    const r = stageProxyBinary({ base: home, programDir: prog.dir, requireExisting: true })
    expect(r).toMatchObject({ ok: false, code: UNSAFE })
    expect(readFileSync(target(home), "utf8")).toBe(OLD_BYTES)
    expect(readdirSync(binDir(home))).toEqual([PROXY_BINARY_NAME])
    expect(existsSync(setupLog(home))).toBe(false)
  })

  it("~/.swarm/setup group-writable (0770): refused", () => {
    const home = homeWithChain(true)
    chmodSync(setupDir(home), 0o770)
    const r = stageProxyBinary({ base: home, programDir: program().dir, requireExisting: true })
    expect(r).toMatchObject({ ok: false, code: UNSAFE })
    expect(readFileSync(target(home), "utf8")).toBe(OLD_BYTES)
  })

  it("~/.swarm world-writable (0757): refused", () => {
    const home = homeWithChain(true)
    chmodSync(swarmDir(home), 0o757)
    const r = stageProxyBinary({ base: home, programDir: program().dir, requireExisting: true })
    expect(r).toMatchObject({ ok: false, code: UNSAFE })
    expect(readFileSync(target(home), "utf8")).toBe(OLD_BYTES)
  })

  it("~/.swarm is a symlink: refused, nothing written through it", () => {
    const home = fresh("r132a-home-")
    const real = fresh("r132a-realswarm-")
    mkdirSync(join(real, "setup", "bin"), { recursive: true, mode: 0o700 })
    writeFileSync(join(real, "setup", "bin", PROXY_BINARY_NAME), OLD_BYTES, { mode: 0o755 })
    symlinkSync(real, swarmDir(home))
    const r = stageProxyBinary({ base: home, programDir: program().dir, requireExisting: true })
    expect(r).toMatchObject({ ok: false, code: UNSAFE })
    expect(readFileSync(join(real, "setup", "bin", PROXY_BINARY_NAME), "utf8")).toBe(OLD_BYTES)
    expect(readdirSync(join(real, "setup", "bin"))).toEqual([PROXY_BINARY_NAME])
  })
})

describe("existing regular target under requireExisting -> content rule", () => {
  it("differs -> replaced atomically, hash equal to the source, mode 0755", () => {
    const home = homeWithChain(true)
    const prog = program()
    const r = stageProxyBinary({ base: home, programDir: prog.dir, requireExisting: true })
    expect(r).toMatchObject({ ok: true, staged: true, changed: true, sha256: prog.sha })
    expect(sha(readFileSync(target(home)))).toBe(prog.sha)
    expect(lstatSync(target(home)).mode & 0o777).toBe(0o755)
    expect(readdirSync(binDir(home))).toEqual([PROXY_BINARY_NAME])
  })

  it("equal -> no-op (changed false)", () => {
    const home = homeWithChain(false)
    writeFileSync(target(home), NEW_BYTES, { mode: 0o755 })
    chmodSync(target(home), 0o755)
    const prog = program()
    const r = stageProxyBinary({ base: home, programDir: prog.dir, requireExisting: true })
    expect(r).toMatchObject({ ok: true, staged: true, changed: false, sha256: prog.sha })
  })

  it("target a symlink -> refused, link untouched", () => {
    const home = homeWithChain(false)
    const elsewhere = fresh("r132a-elsewhere-")
    writeFileSync(join(elsewhere, "x"), OLD_BYTES)
    symlinkSync(join(elsewhere, "x"), target(home))
    const r = stageProxyBinary({ base: home, programDir: program().dir, requireExisting: true })
    expect(r.ok).toBe(false)
    expect(lstatSync(target(home)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(elsewhere, "x"), "utf8")).toBe(OLD_BYTES)
  })
})

describe("without requireExisting (install path) the stager still creates the chain", () => {
  it("absent target -> staged into a new 0700 bin", () => {
    const home = fresh("r132a-home-")
    const prog = program()
    const r = stageProxyBinary({ base: home, programDir: prog.dir })
    expect(r).toMatchObject({ ok: true, staged: true, changed: true })
    expect(sha(readFileSync(target(home)))).toBe(prog.sha)
  })
})
