// Row 273 unit lane — estate delivery must hold its DECLARED file modes exactly, whatever the
// caller's umask is.
//
// The failure this encodes (row 215 attempt 1, verification/s6_11_evidence/transcript.txt): the
// operator script ran swarm-setup under `umask 077`; atomicWriteText passed the mode only at create,
// so the umask masked 0644 to 0600, and verifyUnits (estate/scoped_commit.ts) — which demands the
// exact declared mode — refused with DELIVER_VERIFY_MISMATCH "mode 600 != 644" and rolled back.
//
// What each describe pins:
//   primitive  -> atomicWriteText lands the exact mode under umask 077 and 022, on create AND on
//                 overwrite, and the mode is set on the temp file BEFORE the rename (source order)
//   deliver    -> in-process deliverEstate of both stacks under process.umask(0o077): OK, every
//                 artefact at its declared mode, every secret still 0600
//   apply      -> applyEstate (same primitive, "sequential" schedule) rewrites a 0644 artefact under
//                 077 without a verify mismatch, and its rollback restores the prior mode exactly
//   child      -> a fresh process started by `/bin/sh -c 'umask 077; exec bun …'` delivers both
//                 stacks at declared modes (the real shape of the row-215 failure), 022 as control
//
// E7/E21: every write is under a mkdtemp sandbox with HOME pinned and VERIFIED before any write; the
// child is spawned with `env -i HOME=<sandbox>`. process.umask is restored in `finally` every time.
// Collected by the package's declared command (`bun test` from packages/setup) — rule E14.

import { describe, it, expect } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteText } from "../src/atomic.ts"
import { validateLock } from "../src/lockfile.ts"
import { defaultState, type StateFile } from "../src/state.ts"
import { createStepKit } from "../src/stepkit.ts"
import { homeDir } from "../src/paths.ts"
import { deliverEstate } from "../src/estate/deliver.ts"
import { applyEstate } from "../src/estate/apply.ts"
import { rollbackScopedUnits } from "../src/estate/scoped_commit.ts"
import { createLanesFileAtSetup, lanesPath } from "../src/composefiles/lanes.ts"
import type { DockerResult } from "../src/stacklib.ts"

const LOCK = (() => {
  const r = validateLock(JSON.parse(readFileSync(join(import.meta.dir, "..", "tools.lock.json"), "utf8")))
  if (!r.ok) throw new Error(`r273 test lock invalid: ${r.error}`)
  return r.lock
})()

const modeOf = (p: string): number => statSync(p).mode & 0o777
const toolsRootOf = (home: string): string => join(home, ".swarm", "tools")

/** Run `fn` with the process umask set to `mask`, restoring the previous mask in `finally`. */
async function withUmask<T>(mask: number, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.umask(mask)
  try {
    return await fn()
  } finally {
    process.umask(prev)
  }
}

/** E7-safe sandbox: pin HOME, VERIFY the resolved path before the body may write, restore after. */
async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const saved = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "r273-"))
  process.env.HOME = home
  if (homeDir() !== home) {
    process.env.HOME = saved
    throw new Error(`E7: HOME pin did not take effect (homeDir()=${homeDir()})`)
  }
  try {
    return await fn(home)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
}

function kitFor(component: "searxng" | "firecrawl", state: StateFile) {
  return createStepKit({ componentId: component, lock: LOCK, state, dryRun: false })
}

/** Declared modes of the rendered estate (same table as test/estate_delivery.test.ts). */
const DECLARED: Record<string, number> = {
  "searxng/compose/searxng.yml": 0o644,
  "searxng/settings.yml": 0o600,
  "searxng/searxng.env": 0o600,
  "firecrawl/compose/firecrawl.yml": 0o644,
  "firecrawl/nginx/default.conf.template": 0o600,
  "firecrawl/squid/squid.conf": 0o644,
  "firecrawl/compose/bin/fc-env.sh": 0o600,
  "firecrawl/compose/bin/redis-start.sh": 0o600,
  "firecrawl/compose/bin/nuq-postgres-start.sh": 0o600,
  "firecrawl/compose/bin/fc-nginx-env.envsh": 0o700,
}
const SECRETS = [
  "searxng/secrets/secret_key",
  "firecrawl/secrets/proxy_token",
  "firecrawl/secrets/postgres_password",
  "firecrawl/secrets/bull_auth_key",
  "firecrawl/secrets/redis_auth",
]

describe("r273 atomicWriteText holds the declared mode exactly under any umask", () => {
  for (const mask of [0o077, 0o022, 0o027]) {
    for (const mode of [0o644, 0o600, 0o700, 0o400, 0o755]) {
      it(`r273 umask ${mask.toString(8).padStart(3, "0")} mode ${mode.toString(8)}: create and overwrite land exactly`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "r273-aw-"))
        try {
          await withUmask(mask, () => {
            const p = join(dir, "sub", "f.txt")
            atomicWriteText(p, "one\n", mode)
            expect(modeOf(p)).toBe(mode)
            expect(readFileSync(p, "utf8")).toBe("one\n")
            // Overwrite an existing file that carries a DIFFERENT mode: the rename replaces the inode,
            // so the result must be the newly declared mode, not the old one and not the masked one.
            if (mode & 0o200) {
              chmodSync(p, 0o600)
              atomicWriteText(p, "two\n", mode)
              expect(modeOf(p)).toBe(mode)
              expect(readFileSync(p, "utf8")).toBe("two\n")
            }
          })
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  }

  it("r273 the mode is fixed on the TEMP file before the rename (never chmod after commit)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "atomic.ts"), "utf8")
    const body = src.slice(src.indexOf("export function atomicWriteText"), src.indexOf("export function atomicWriteJson"))
    // Row 273b moved the mode-set onto the temp's open fd (fchmod); the ordering this test pins is unchanged.
    const chmodAt = body.indexOf("fchmodSync(fd, exactMode)")
    const fsyncAt = body.indexOf("fsyncSync(fd)")
    const renameAt = body.indexOf("renameSync(tmp, absPath)")
    expect(chmodAt).toBeGreaterThan(-1)
    expect(chmodAt).toBeLessThan(fsyncAt)
    expect(fsyncAt).toBeLessThan(renameAt)
    expect(body.slice(renameAt).includes("chmod")).toBe(false)
    expect(body.includes("chmodSync(absPath")).toBe(false) // never the committed path
  })

  it("r273 leaves no temp sibling behind and never widens a 0600 secret under umask 022", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r273-aw-"))
    try {
      await withUmask(0o022, () => {
        const p = join(dir, "secret")
        atomicWriteText(p, "x\n", 0o600)
        expect(modeOf(p)).toBe(0o600)
        expect(statSync(dir).isDirectory()).toBe(true)
        expect(readdirSync(dir)).toEqual(["secret"])
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("r273 deliverEstate under process.umask(0o077) (the row-215 failure, in-process)", () => {
  it("r273 delivers both stacks OK with every artefact at its declared mode and secrets 0600", async () => {
    await withHome(async (home) => {
      await withUmask(0o077, () => {
        const state = defaultState(LOCK.version)
        const sx = deliverEstate({ kit: kitFor("searxng", state), home })
        expect(sx.message).not.toContain("DELIVER_VERIFY_MISMATCH")
        expect(sx.token).toBe("OK")
        const fc = deliverEstate({ kit: kitFor("firecrawl", state), home })
        expect(fc.message).not.toContain("DELIVER_VERIFY_MISMATCH")
        expect(fc.token).toBe("OK")
      })
      for (const [rel, mode] of Object.entries(DECLARED)) expect([rel, modeOf(join(toolsRootOf(home), rel))]).toEqual([rel, mode])
      for (const rel of SECRETS) expect([rel, modeOf(join(toolsRootOf(home), rel))]).toEqual([rel, 0o600])
    })
  })

  it("r273 a re-delivery under 077 over a 022-delivered estate is a no-write (modes already exact)", async () => {
    await withHome(async (home) => {
      const state = defaultState(LOCK.version)
      await withUmask(0o022, () => {
        expect(deliverEstate({ kit: kitFor("searxng", state), home }).token).toBe("OK")
      })
      const yml = join(toolsRootOf(home), "searxng", "compose", "searxng.yml")
      const before = statSync(yml).mtimeMs
      await withUmask(0o077, () => {
        expect(deliverEstate({ kit: kitFor("searxng", state), home }).token).toBe("OK")
      })
      expect(modeOf(yml)).toBe(0o644)
      expect(statSync(yml).mtimeMs).toBe(before)
    })
  })
})

/** Minimal runner: context inspect fails, so apply stops right AFTER its commit+verify phase with
 *  APPLY_CONTEXT_UNAVAILABLE — reaching that code proves the commit's read-back verify passed. */
const unreachableRunner = async (args: readonly string[]): Promise<DockerResult> =>
  args.join(" ").includes("context inspect")
    ? { exitCode: 1, stdout: "", stderr: `context "colima-swarm" not found` }
    : { exitCode: 0, stdout: "", stderr: "" }

function applyOpts(home: string, extra: Record<string, unknown> = {}) {
  let tick = 0
  return {
    component: "searxng",
    lock: LOCK,
    home,
    run: unreachableRunner,
    readiness: async () => ({ ok: true, detail: "r273" }),
    sleep: async () => {},
    clock: () => (tick += 1),
    healthDeadlineMs: 50,
    healthIntervalMs: 1,
    ...extra,
  }
}

describe("r273 applyEstate under process.umask(0o077) (shares the commit primitive)", () => {
  it("r273 rewrites searxng.yml at 0644 under 077 and passes its read-back verify", async () => {
    await withHome(async (home) => {
      await withUmask(0o022, () => {
        createLanesFileAtSetup(home)
        expect(deliverEstate({ kit: kitFor("searxng", defaultState(LOCK.version)), home }).token).toBe("OK")
      })
      // A real change: clear the stored tuple so the environment block leaves searxng.yml.
      writeFileSync(lanesPath(home), JSON.stringify({ version: 1, lanes: {} }) + "\n", { mode: 0o600 })
      chmodSync(lanesPath(home), 0o600)
      const yml = join(toolsRootOf(home), "searxng", "compose", "searxng.yml")
      const bytesBefore = readFileSync(yml, "utf8")
      const r = await withUmask(0o077, () => applyEstate(applyOpts(home) as never))
      expect(r.message).not.toContain("mode 600 != 644")
      expect(r.code).toBe("APPLY_CONTEXT_UNAVAILABLE")
      expect(readFileSync(yml, "utf8")).not.toBe(bytesBefore) // the write was real, not a no-op
      expect(modeOf(yml)).toBe(0o644)
      expect(modeOf(join(toolsRootOf(home), "searxng", "secrets", "secret_key"))).toBe(0o600)
    })
  })

  it("r273 apply's rollback under 077 restores the prior bytes AND the prior 0644 mode exactly", async () => {
    await withHome(async (home) => {
      const yml = join(toolsRootOf(home), "searxng", "compose", "searxng.yml")
      await withUmask(0o022, () => {
        createLanesFileAtSetup(home)
        expect(deliverEstate({ kit: kitFor("searxng", defaultState(LOCK.version)), home }).token).toBe("OK")
        writeFileSync(yml, "OLD PLANTED BYTES\n")
        chmodSync(yml, 0o644)
      })
      const r = await withUmask(0o077, () =>
        applyEstate(
          applyOpts(home, {
            disturbWrite: (absPath: string) => {
              if (absPath === yml) throw new Error("r273 scripted mid-pass failure")
            },
          }) as never,
        ),
      )
      expect(r.code).toBe("APPLY_WRITE_FAILED")
      expect(readFileSync(yml, "utf8")).toBe("OLD PLANTED BYTES\n")
      expect(modeOf(yml)).toBe(0o644)
    })
  })
})

describe("r273 child process started with umask 077 (the operator-script shape)", () => {
  const driver = join(import.meta.dir, "umask_r273.driver.ts")
  for (const mask of ["077", "022"]) {
    it(`r273 child umask ${mask}: both stacks deliver OK at declared modes`, () => {
      const home = mkdtempSync(join(tmpdir(), "r273-child-"))
      try {
        const proc = Bun.spawnSync(
          [
            "/usr/bin/env",
            "-i",
            `HOME=${home}`,
            `TMPDIR=${tmpdir()}`,
            "PATH=/usr/bin:/bin",
            "no_proxy=*",
            "/bin/sh",
            "-c",
            `umask ${mask}; exec "$0" run "$1"`,
            process.execPath, // E22: the bun running this suite, by absolute path
            driver,
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        const stdout = proc.stdout.toString().trim()
        const last = stdout.split("\n").pop() ?? ""
        expect([proc.exitCode, proc.stderr.toString().slice(0, 400)]).toEqual([0, proc.stderr.toString().slice(0, 400)])
        const out = JSON.parse(last) as { umask: string; home: string; searxng: { token: string; message: string }; firecrawl: { token: string; message: string }; modes: Record<string, string> }
        expect(out.home).toBe(home)
        expect(out.umask).toBe(mask)
        expect(out.searxng).toEqual({ token: "OK", message: "" })
        expect(out.firecrawl).toEqual({ token: "OK", message: "" })
        expect(out.modes).toEqual({
          "searxng/compose/searxng.yml": "644",
          "searxng/settings.yml": "600",
          "searxng/searxng.env": "600",
          "searxng/secrets/secret_key": "600",
          "firecrawl/compose/firecrawl.yml": "644",
          "firecrawl/squid/squid.conf": "644",
          "firecrawl/compose/bin/fc-nginx-env.envsh": "700",
          "firecrawl/secrets/proxy_token": "600",
        })
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})

// --- r273b: mode hardening on top of row 273 (row 265e F1/F2/F3, review F-264d-4/-9) ----------------------
//
// F1  the declared mode is set through the temp's OPEN fd (fchmod), so a symlink swapped in at the temp
//     name cannot redirect the mode change onto another file. Pinned twice: by source shape, and by a real
//     race — a child process watches the target directory and, the moment the temp name appears, renames
//     it aside and plants a symlink to a victim file at that name. Path-based chmod (row 273) follows the
//     symlink and changes the victim's mode; fchmod cannot.
// F2  the mode is masked to permission bits inside atomicWriteText.
// F3  apply/deliver rollback never restores group/other write bits (a planted 0666 prior comes back 0644).
// F-264d-9  no path re-open: a declared mode without owner-read lands instead of throwing, and a write
//     that fails before the rename removes its own temp.

const atomicBody = (): string => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "atomic.ts"), "utf8")
  return src.slice(src.indexOf("export function atomicWriteText"), src.indexOf("export function atomicWriteJson"))
}
const tmpSiblings = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith(".tmp-"))

/** The attacker: started before the write, it swaps the first `.tmp-*` it sees for a symlink to `victim`.
 *  Its paths are baked into the script text, not passed through the spawn's env: under a filtered whole-
 *  package run a spawn spy leaked by another file drops spawn options (review F-264c-4), measured here as
 *  `R273B_READY` arriving undefined. */
const swapperScript = (cfg: { dir: string; victim: string; ready: string; done: string }): string => `
import { readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const cfg = ${JSON.stringify(cfg)}
writeFileSync(cfg.ready, "ready")
const deadline = Date.now() + 20000
while (Date.now() < deadline) {
  let names = []
  try { names = readdirSync(cfg.dir) } catch { continue }
  const t = names.find((n) => n.startsWith(".tmp-"))
  if (!t) continue
  try {
    renameSync(join(cfg.dir, t), join(cfg.dir, "moved" + t))
    symlinkSync(cfg.victim, join(cfg.dir, t))
    writeFileSync(cfg.done, "swapped " + t)
  } catch (e) {
    writeFileSync(cfg.done, "ERR " + e.message)
  }
  process.exit(0)
}
process.exit(3)
`

describe("r273b F1: the mode change goes through the fd, never the temp path", () => {
  it("r273b source shape: exclusive create, one fd for write+fchmod+fsync, no path chmod, no re-open", () => {
    const body = atomicBody()
    expect(body).toContain('openSync(tmp, "wx", 0o600)')
    expect(body).toContain("writeSync(fd,")
    expect(body).toContain("fchmodSync(fd, exactMode)")
    expect(body.includes("chmodSync(tmp")).toBe(false) // no mode change by temp path
    expect(/[^f]chmodSync\(/.test(body)).toBe(false) // no path chmod of any name
    expect(body.includes('openSync(tmp, "r"')).toBe(false) // no re-resolution of the temp name to fsync
    expect(body.indexOf("fchmodSync(fd, exactMode)")).toBeLessThan(body.indexOf("fsyncSync(fd)"))
    expect(body.indexOf("fsyncSync(fd)")).toBeLessThan(body.indexOf("renameSync(tmp, absPath)"))
  })

  it("r273b a symlink swapped in at the temp name cannot redirect the mode change to another file", async () => {
    const root = mkdtempSync(join(tmpdir(), "r273b-race-"))
    try {
      let swapped = ""
      let attempt = 0
      // Retry only when the attacker did not get its swap in at all; a won race is the measured case.
      for (attempt = 1; attempt <= 5 && !swapped; attempt++) {
        const dir = join(root, `t${attempt}`, "target")
        const victimDir = join(root, `t${attempt}`, "victim")
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        mkdirSync(victimDir, { recursive: true, mode: 0o700 })
        const victim = join(victimDir, "victim.txt")
        writeFileSync(victim, "victim\n")
        chmodSync(victim, 0o600)
        const ready = join(root, `t${attempt}`, "ready")
        const done = join(root, `t${attempt}`, "done")
        const script = join(root, `t${attempt}`, "swapper.mjs")
        writeFileSync(script, swapperScript({ dir, victim, ready, done }))
        // The child writes only inside `root` (explicit paths above); it never resolves HOME.
        const child = Bun.spawn([process.execPath, "run", script], { stdout: "ignore", stderr: "ignore" })
        try {
          for (let i = 0; i < 2000 && !existsSync(ready); i++) await Bun.sleep(5)
          expect(existsSync(ready)).toBe(true)
          // Large enough that the write takes many milliseconds: the swap lands while bytes are in flight.
          atomicWriteText(join(dir, "f.txt"), "x".repeat(48 * 1024 * 1024), 0o644)
        } finally {
          const killer = setTimeout(() => child.kill(), 25_000)
          await child.exited
          clearTimeout(killer)
        }
        const outcome = existsSync(done) ? readFileSync(done, "utf8") : ""
        expect(outcome.startsWith("ERR")).toBe(false)
        if (!outcome.startsWith("swapped ")) continue
        swapped = outcome
        const moved = join(dir, "moved" + outcome.slice("swapped ".length))
        // The victim the symlink pointed at keeps its own mode: the mode change did not follow the name.
        expect(modeOf(victim)).toBe(0o600)
        expect(readFileSync(victim, "utf8")).toBe("victim\n")
        // ...and it landed on the inode the writer actually created (now renamed aside by the attacker).
        expect(lstatSync(moved).isFile()).toBe(true)
        expect(modeOf(moved)).toBe(0o644)
      }
      expect(swapped.startsWith("swapped ")).toBe(true) // the race was really run, not skipped
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})

describe("r273b F2: special bits are masked off inside atomicWriteText", () => {
  it("r273b source shape: the declared mode is masked & 0o777 before it reaches fchmod", () => {
    const body = atomicBody()
    expect(body).toContain("const exactMode = mode & 0o777")
    expect(body).toContain("fchmodSync(fd, exactMode)")
  })

  for (const [declared, landed] of [
    [0o4755, 0o755],
    [0o2755, 0o755],
    [0o1644, 0o644],
    [0o7777, 0o777],
  ] as const) {
    it(`r273b declared ${declared.toString(8)} lands as exactly ${landed.toString(8)} (no setuid/setgid/sticky)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "r273b-sp-"))
      try {
        await withUmask(0o022, () => {
          const p = join(dir, "f")
          atomicWriteText(p, "x\n", declared)
          expect(statSync(p).mode & 0o7777).toBe(landed)
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe("r273b F-264d-9: no temp-path re-open, and a failed write cleans up its own temp", () => {
  for (const mode of [0o200, 0o000]) {
    it(`r273b a declared mode without owner-read (${mode.toString(8).padStart(3, "0")}) lands instead of throwing`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "r273b-nr-"))
      try {
        await withUmask(0o077, () => {
          const p = join(dir, "f")
          atomicWriteText(p, "x\n", mode)
          expect(modeOf(p)).toBe(mode)
          expect(tmpSiblings(dir)).toEqual([])
        })
      } finally {
        chmodSync(dir, 0o700)
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it("r273b a rename that fails (target is a directory) leaves no temp sibling behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "r273b-rf-"))
    try {
      const target = join(dir, "occupied")
      mkdirSync(join(target, "child"), { recursive: true })
      expect(() => atomicWriteText(target, "x\n", 0o644)).toThrow()
      expect(tmpSiblings(dir)).toEqual([])
      expect(statSync(target).isDirectory()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("r273b F3: a rollback never re-publishes group/other write bits", () => {
  for (const mask of [0o022, 0o077]) {
    it(`r273b rollbackScopedUnits under umask ${mask.toString(8).padStart(3, "0")}: 0666->0644, 0777->0755, declared modes exact`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "r273b-rb-"))
      try {
        await withUmask(mask, () => {
          const cases = [
            [0o666, 0o644],
            [0o777, 0o755],
            [0o664, 0o644],
            [0o646, 0o644],
            [0o644, 0o644],
            [0o600, 0o600],
            [0o700, 0o700],
          ] as const
          const entries = cases.map(([prior], i) => ({ absPath: join(dir, `f${i}`), prior: { bytes: `prior ${prior.toString(8)}\n`, mode: prior } }))
          for (const e of entries) writeFileSync(e.absPath, "NEW BYTES OF THE FAILED PASS\n")
          expect(rollbackScopedUnits(entries)).toEqual(entries.map((e) => e.absPath))
          for (const [i, [prior, restored]] of cases.entries()) {
            const p = join(dir, `f${i}`)
            expect([prior.toString(8), modeOf(p).toString(8)]).toEqual([prior.toString(8), restored.toString(8)])
            expect(readFileSync(p, "utf8")).toBe(`prior ${prior.toString(8)}\n`)
          }
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it("r273b apply's rollback restores a planted 0666 prior as 0644 (bytes exact)", async () => {
    await withHome(async (home) => {
      const yml = join(toolsRootOf(home), "searxng", "compose", "searxng.yml")
      await withUmask(0o022, () => {
        createLanesFileAtSetup(home)
        expect(deliverEstate({ kit: kitFor("searxng", defaultState(LOCK.version)), home }).token).toBe("OK")
        writeFileSync(yml, "OLD PLANTED BYTES\n")
        chmodSync(yml, 0o666)
      })
      expect(modeOf(yml)).toBe(0o666) // the widened prior is really on disk
      const r = await withUmask(0o077, () =>
        applyEstate(
          applyOpts(home, {
            disturbWrite: (absPath: string) => {
              if (absPath === yml) throw new Error("r273b scripted mid-pass failure")
            },
          }) as never,
        ),
      )
      expect(r.code).toBe("APPLY_WRITE_FAILED")
      expect(readFileSync(yml, "utf8")).toBe("OLD PLANTED BYTES\n")
      expect(modeOf(yml)).toBe(0o644)
    })
  })
})
