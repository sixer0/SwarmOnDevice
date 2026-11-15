import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as fsPromises from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Registry from "./obsidian-registry"
import {
  fakeObsidianHome,
  lsappinfoOutputs,
  registryCaseAlias,
  registryNestedChild,
  registrySymlinked,
  registryTooLarge,
  registryUnregistered,
  registryUnsafeRoot,
  singletonLockPresent,
} from "./rel1210-obsidian-registry.fixture"

// 1.2.10 row 44 (AC-P1c, N10-162; 01a §3.1 S4-S12, §3.4; 01_specs AC-P1c folds S10-02/03/04/06/08/09/10/14/15(P1);
// C12, C17 Q1-2, C29, C39, C44). Desktop main writes Obsidian's vault list only when Obsidian is closed by two signals
// (the keyed lsappinfo find is empty with exit 0 AND no SingletonLock), checks that again right before the rename,
// refuses unsafe roots, case-only aliases and nested vaults, and never writes while unsure. Every refusal: the
// documented result and reason, no rename, the fake registry's sha256 equal, no tmp file left. The detection runner is
// always a fake (row 39 N10-225) or a fake execFile; the home and Obsidian data folder are row 39's mkdtemp fakes.
// Nothing is launched and nothing on the machine is enumerated (c15-c17 pin that by grep).

const reg = Registry as Record<string, any>
const BACKUP = "obsidian.json.swarm-backup"

type Fixture = ReturnType<typeof fakeObsidianHome>
type Output = keyof typeof lsappinfoOutputs
const made: Fixture[] = []
afterEach(() => {
  while (made.length) {
    const fixture = made.pop()!
    if (existsSync(fixture.configDir)) {
      chmodSync(fixture.configDir, 0o700)
      expect(tmpFiles(fixture)).toEqual([])
    }
    fixture.cleanup()
  }
})

function keep<T extends Fixture>(fixture: T): T {
  made.push(fixture)
  return fixture
}

function tmpFiles(fixture: Fixture) {
  return readdirSync(fixture.configDir).filter((name) => name.startsWith("obsidian.json.swarm-") && name.endsWith(".tmp"))
}

/** A fake runner whose output can be switched between calls (c14 b); counts its calls. */
function switchable(start: Output = "closed") {
  const runner = Object.assign(
    () => {
      runner.calls++
      return lsappinfoOutputs[runner.output]()
    },
    { calls: 0, output: start as Output },
  )
  return runner
}

function sha(file: string) {
  if (!existsSync(file)) return null
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

async function press(fixture: Fixture, runner: () => Promise<{ code: number; stdout: string }>, extra: Record<string, unknown> = {}) {
  return reg.ensureObsidianVault({
    configDir: fixture.configDir,
    vaultRoot: fixture.vaultRoot,
    hubPath: fixture.hubPath,
    appPresent: true,
    runLsappinfo: runner,
    now: () => 1_700_000_222_333,
    ...extra,
  })
}

/** A refusal leaves the list byte-identical, makes no backup and leaves no tmp file. */
async function refused(
  fixture: Fixture,
  runner: () => Promise<{ code: number; stdout: string }>,
  expected: object,
  extra: Record<string, unknown> = {},
) {
  const before = sha(fixture.registryPath)
  const step = await press(fixture, runner, extra)
  expect(step).toEqual(expected)
  expect(sha(fixture.registryPath)).toBe(before)
  expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
  expect(tmpFiles(fixture)).toEqual([])
  return step
}

const running = { result: "close-obsidian", reason: "obsidian-running" }
const unsure = { result: "close-obsidian", reason: "obsidian-unsure" }
const notRegistered = (reason: string) => ({ result: "not-registered", reason })

describe("AC-P1c: closed check and safe-write refusals (N10-162)", () => {
  test("the module exports ensureObsidianVault and makeLsappinfoRunner (N10-024, N10-027)", () => {
    expect(typeof reg.ensureObsidianVault).toBe("function")
    expect(typeof reg.makeLsappinfoRunner).toBe("function")
  })

  test("c1 registryUnregistered, runner closed, no lock -> proceeds to the write (closed check before the tmp and again before the rename)", async () => {
    const fixture = keep(registryUnregistered())
    const runner = switchable("closed")
    const step = await press(fixture, runner)
    expect(step).toEqual({ result: "registered" })
    expect(runner.calls).toBe(2)
    expect(existsSync(join(fixture.configDir, BACKUP))).toBe(true)
  })

  test("c2 runner running -> close-obsidian / obsidian-running (with or without a lock), one runner call, nothing written", async () => {
    const fixture = keep(registryUnregistered())
    const runner = switchable("running")
    await refused(fixture, runner, running)
    expect(runner.calls).toBe(1)
    singletonLockPresent("file", fixture)
    await refused(fixture, switchable("running"), running)
  })

  test("c3 runner twoInstances -> close-obsidian / obsidian-running", async () => {
    const fixture = keep(registryUnregistered())
    const runner = switchable("twoInstances")
    await refused(fixture, runner, running)
    expect(runner.calls).toBe(1)
  })

  test("c4 runner garbage (other non-empty text) -> close-obsidian / obsidian-unsure", async () => {
    const fixture = keep(registryUnregistered())
    await refused(fixture, switchable("garbage"), unsure)
  })

  // 1.3.1 row H1 (C127): the real lsappinfo prints one "\n" (exit 0) when Obsidian is not running. Whitespace-only
  // output is "no instance"; any other text without ASN stays unsure.
  for (const output of ["closedNewline", "closedTwoNewlines", "closedSpaceNewline"] as const) {
    test(`H1 runner ${output} (whitespace-only stdout, exit 0), no lock -> registered, both closed checks pass`, async () => {
      const fixture = keep(registryUnregistered())
      const runner = switchable(output)
      expect(await press(fixture, runner)).toEqual({ result: "registered" })
      expect(runner.calls).toBe(2)
    })
  }

  test("H1 runner garbageLine ('garbage\\n') -> close-obsidian / obsidian-unsure", async () => {
    await refused(keep(registryUnregistered()), switchable("garbageLine"), unsure)
  })

  test("H1 runner closedNewline + SingletonLock present -> close-obsidian / obsidian-unsure (the second signal still counts)", async () => {
    const fixture = keep(registryUnregistered())
    singletonLockPresent("dangling-link", fixture)
    await refused(fixture, switchable("closedNewline"), unsure)
  })

  test("H1 S9 repeat: closedNewline first, then running before the rename -> close-obsidian / obsidian-running", async () => {
    const fixture = keep(registryUnregistered())
    const runner = switchable("closedNewline")
    await refused(fixture, runner, running, {
      beforeRename: async () => {
        runner.output = "running"
      },
    })
    expect(runner.calls).toBe(2)
  })

  test("c5 runner nonZero, then runner rejects -> close-obsidian / obsidian-unsure (both)", async () => {
    const fixture = keep(registryUnregistered())
    await refused(fixture, switchable("nonZero"), unsure)
    await refused(fixture, switchable("rejects"), unsure)
    // The production runner's "unsure" answer (makeLsappinfoRunner, c8), on a missing list.
    await refused(keep(fakeObsidianHome()), () => Promise.resolve({ code: -1, stdout: "" }), unsure)
  })

  test(
    "c6 runner hangs -> close-obsidian / obsidian-unsure within 5,000 ms + 1,000 ms slack",
    async () => {
      const fixture = keep(registryUnregistered())
      const started = performance.now()
      await refused(fixture, switchable("hangs"), unsure)
      const elapsed = performance.now() - started
      expect(elapsed).toBeLessThan(6_000)
      expect(elapsed).toBeGreaterThanOrEqual(4_900)
    },
    10_000,
  )

  for (const kind of ["dangling-link", "file", "directory"] as const) {
    test(`c7 runner closed + SingletonLock present as ${kind} -> close-obsidian / obsidian-unsure, the lock untouched`, async () => {
      const fixture = keep(registryUnregistered())
      singletonLockPresent(kind, fixture)
      const lockBefore = lstatSync(fixture.lockPath)
      await refused(fixture, switchable("closed"), unsure)
      const lockAfter = lstatSync(fixture.lockPath)
      expect([lockAfter.ino, lockAfter.mode, lockAfter.isSymbolicLink()]).toEqual([lockBefore.ino, lockBefore.mode, lockBefore.isSymbolicLink()])
    })
  }

  test("c7 runner closed + lstat of the lock fails with EACCES (no search permission on the data folder) -> close-obsidian / obsidian-unsure", async () => {
    const fixture = keep(registryUnregistered())
    const before = sha(fixture.registryPath)
    // The data folder loses search permission between the runner answer and the lock lstat of closed check 1, so
    // the lstat fails with EACCES (mode 0300 would keep search permission and give ENOENT).
    const runner = () => {
      chmodSync(fixture.configDir, 0o600)
      return lsappinfoOutputs.closed()
    }
    const step = await press(fixture, runner)
    chmodSync(fixture.configDir, 0o700)
    expect(step).toEqual(unsure)
    expect(sha(fixture.registryPath)).toBe(before)
    expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
    expect(tmpFiles(fixture)).toEqual([])
  })

  describe("c8 makeLsappinfoRunner(fakeExecFile)", () => {
    function fakeExecFile(answer: [unknown, unknown, unknown]) {
      const calls: unknown[][] = []
      const impl = (...args: unknown[]) => {
        calls.push(args)
        const callback = args[3] as (error: unknown, stdout: unknown, stderr: unknown) => void
        callback(...answer)
      }
      return { impl, calls }
    }

    test("one call: exactly (/usr/bin/lsappinfo, [find, bundleid=md.obsidian], { timeout: 5000, maxBuffer: 4096 }) and a callback", async () => {
      const fake = fakeExecFile([null, "", ""])
      const run = reg.makeLsappinfoRunner(fake.impl)
      expect(fake.calls.length).toBe(0)
      expect(await run()).toEqual({ code: 0, stdout: "" })
      expect(fake.calls.length).toBe(1)
      expect(fake.calls[0].slice(0, 3)).toEqual(["/usr/bin/lsappinfo", ["find", "bundleid=md.obsidian"], { timeout: 5000, maxBuffer: 4096 }])
      expect(typeof fake.calls[0][3]).toBe("function")
      expect(fake.calls[0].length).toBe(4)
    })

    test("stdout is passed through as is when there is no error and no stderr", async () => {
      const out = 'ASN:0x0-0x1:"Obsidian":\n'
      expect(await reg.makeLsappinfoRunner(fakeExecFile([null, out, ""]).impl)()).toEqual({ code: 0, stdout: out })
    })

    const failures: [string, [unknown, unknown, unknown]][] = [
      ["an error callback (spawn error)", [Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "", ""]],
      ["a timeout error (killed by signal)", [Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null }), "", ""]],
      ["a maxBuffer error", [Object.assign(new Error("too much"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "x".repeat(10), ""]],
      ["a non-zero exit", [Object.assign(new Error("exit 1"), { code: 1 }), "", ""]],
      ["exit 0, empty stdout, stderr 'error' (S10-08)", [null, "", "error"]],
      ["exit 0, stdout with ASN, stderr text (S10-08)", [null, 'ASN:0x0-0x1:"Obsidian":\n', "warning"]],
    ]
    for (const [name, answer] of failures) {
      test(`${name} -> { code: -1, stdout: "" }`, async () => {
        expect(await reg.makeLsappinfoRunner(fakeExecFile(answer).impl)()).toEqual({ code: -1, stdout: "" })
      })
    }

    test("an execFile that throws synchronously -> { code: -1, stdout: \"\" }", async () => {
      const run = reg.makeLsappinfoRunner(() => {
        throw new Error("cannot start")
      })
      expect(await run()).toEqual({ code: -1, stdout: "" })
    })

    test("the runner output is read through the closed check: -1 from the runner is unsure", async () => {
      const fixture = keep(registryUnregistered())
      const run = reg.makeLsappinfoRunner(fakeExecFile([null, "", "error"]).impl)
      const before = sha(fixture.registryPath)
      expect(await press(fixture, run)).toEqual(unsure)
      expect(sha(fixture.registryPath)).toBe(before)
    })
  })

  test("c9 registryNestedChild (<root>/inbox listed) -> not-registered / nested-child, 0 runner calls", async () => {
    const fixture = keep(registryNestedChild())
    const runner = switchable()
    await refused(fixture, runner, notRegistered("nested-child"))
    expect(runner.calls).toBe(0)
  })

  test("c10 registryCaseAlias stale-child (root in other letter case + missing child; C39) -> not-registered / alias-case", async () => {
    const fixture = keep(registryCaseAlias("stale-child"))
    const runner = switchable()
    await refused(fixture, runner, notRegistered("alias-case"))
    expect(runner.calls).toBe(0)
  })

  test("c10 registryCaseAlias plain: in-vault when the disk resolves it to the root (C39: the same folder), else alias-case", async () => {
    const fixture = keep(registryCaseAlias("plain"))
    const runner = switchable()
    const before = sha(fixture.registryPath)
    const step = await press(fixture, runner)
    expect(step).toEqual(fixture.resolvesToRoot ? { result: "in-vault" } : notRegistered("alias-case"))
    expect(sha(fixture.registryPath)).toBe(before)
    expect(runner.calls).toBe(0)
  })

  test("c10 NFC (S10-14): an entry whose folder name is the NFD form of the root's NFC name (not resolvable) -> alias-case", async () => {
    const home = keep(fakeObsidianHome())
    const nfc = "vault-café"
    expect(nfc.normalize("NFD")).not.toBe(nfc)
    const vaultRoot = join(home.home, nfc)
    const hubFolder = join(vaultRoot, "swarm-memory", "default-project-0a1b2c")
    mkdirSync(hubFolder, { recursive: true })
    const hubPath = join(hubFolder, "index.md")
    writeFileSync(hubPath, "# Swarm memory (synthetic)\n")
    const alias = join(home.home, nfc.normalize("NFD"), "missing-child")
    writeFileSync(home.registryPath, JSON.stringify({ vaults: { "6d5c4b3a2918f7e6": { path: alias, ts: 1_700_000_000_000 } } }))
    const fixture = { ...home, vaultRoot, hubPath }
    const runner = switchable()
    await refused(fixture, runner, notRegistered("alias-case"))
    expect(runner.calls).toBe(0)
  })

  describe("c11 unsafe roots -> not-registered / unsafe-root, 0 runner calls", () => {
    const roots: [string, (fixture: Fixture) => Partial<Fixture>][] = [
      ["registryUnsafeRoot: the vault root is the fake home", (f) => registryUnsafeRoot(f)],
      ["the vault root is /", () => ({ vaultRoot: "/" })],
      ["the vault root is the fake home's parent", (f) => ({ vaultRoot: resolve(f.home, "..") })],
      [
        "the vault root is a folder inside the data folder",
        (f) => {
          const inner = join(f.configDir, "vault-inside")
          mkdirSync(inner)
          return { vaultRoot: inner }
        },
      ],
      ["the vault root is the data folder itself", (f) => ({ vaultRoot: f.configDir })],
      ["the vault root is the parent of the data folder (S10-06)", (f) => ({ vaultRoot: resolve(f.configDir, "..") })],
      [
        "the vault root is the home reached through a symlink (S10-06)",
        (f) => {
          const link = join(f.base, "home-link")
          symlinkSync(f.home, link)
          return { vaultRoot: link }
        },
      ],
      [
        "the data folder is given through a symlinked home and the vault root is the real home (S10-06)",
        (f) => {
          const link = join(f.base, "home-link")
          symlinkSync(f.home, link)
          return { vaultRoot: f.home, configDir: join(link, f.configDir.slice(f.home.length + 1)) }
        },
      ],
    ]
    for (const [name, change] of roots) {
      test(name, async () => {
        const home = keep(registryUnregistered())
        const fixture = { ...home, ...change(home) }
        const runner = switchable()
        await refused(fixture, runner, notRegistered("unsafe-root"))
        expect(runner.calls).toBe(0)
      })
    }

    test("the data folder does not exist yet: its parent's real path joined with its name is compared", async () => {
      const home = keep(fakeObsidianHome())
      rmSync(home.configDir, { recursive: true, force: true })
      const fixture = { ...home, vaultRoot: resolve(home.configDir, "..") }
      const runner = switchable()
      expect(await press(fixture, runner)).toEqual(notRegistered("unsafe-root"))
      expect(existsSync(home.configDir)).toBe(false)
      expect(runner.calls).toBe(0)
    })
  })

  test("c12 registrySymlinked (symlink, then a directory at the registry name) -> not-registered / registry-odd-file", async () => {
    const linked = keep(registrySymlinked("symlink"))
    const runner = switchable()
    expect(await press(linked, runner)).toEqual(notRegistered("registry-odd-file"))
    expect(lstatSync(linked.registryPath).isSymbolicLink()).toBe(true)
    const dir = keep(registrySymlinked("directory"))
    expect(await press(dir, runner)).toEqual(notRegistered("registry-odd-file"))
    expect(lstatSync(dir.registryPath).isDirectory()).toBe(true)
    expect(runner.calls).toBe(0)
    expect(existsSync(join(linked.configDir, BACKUP)) || existsSync(join(dir.configDir, BACKUP))).toBe(false)
  })

  test("c13 registryTooLarge (1,048,577 B) -> not-registered / registry-too-large", async () => {
    const fixture = keep(registryTooLarge())
    expect(readFileSync(fixture.registryPath).length).toBe(1_048_577)
    const runner = switchable()
    await refused(fixture, runner, notRegistered("registry-too-large"))
    expect(runner.calls).toBe(0)
  })

  describe("c14 beforeRename", () => {
    test("(a) obsidian.json rewritten with one more key -> registry-changed, the file keeps the edited bytes, no rename", async () => {
      const fixture = keep(registryUnregistered())
      let edited = Buffer.alloc(0)
      const step = await press(fixture, switchable(), {
        beforeRename: async () => {
          edited = Buffer.from(JSON.stringify({ ...JSON.parse(readFileSync(fixture.registryPath, "utf8")), extra: 1 }))
          writeFileSync(fixture.registryPath, edited)
        },
      })
      expect(step).toEqual(notRegistered("registry-changed"))
      expect(readFileSync(fixture.registryPath).equals(edited)).toBe(true)
      expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
      expect(tmpFiles(fixture)).toEqual([])
    })

    test("(b) the runner switches to running -> close-obsidian / obsidian-running, sha256 equal, no rename", async () => {
      const fixture = keep(registryUnregistered())
      const runner = switchable("closed")
      await refused(fixture, runner, running, {
        beforeRename: async () => {
          runner.output = "running"
        },
      })
      expect(runner.calls).toBe(2)
    })

    test("(b') a SingletonLock appears before the rename -> close-obsidian / obsidian-unsure", async () => {
      const fixture = keep(registryUnregistered())
      await refused(fixture, switchable("closed"), unsure, {
        beforeRename: async () => {
          singletonLockPresent("dangling-link", fixture)
        },
      })
    })

    test("(c) the tmp file overwritten with {} -> registry-verify, no rename, sha256 equal, no tmp, no backup (S10-04)", async () => {
      const fixture = keep(registryUnregistered())
      let tmpSeen = 0
      await refused(fixture, switchable(), notRegistered("registry-verify"), {
        beforeRename: async () => {
          const names = tmpFiles(fixture)
          tmpSeen = names.length
          for (const name of names) writeFileSync(join(fixture.configDir, name), "{}")
        },
      })
      expect(tmpSeen).toBe(1)
    })

    test("(c') the tmp file replaced by another file with the same bytes (other inode) -> registry-verify", async () => {
      const fixture = keep(registryUnregistered())
      await refused(fixture, switchable(), notRegistered("registry-verify"), {
        beforeRename: async () => {
          for (const name of tmpFiles(fixture)) {
            const file = join(fixture.configDir, name)
            copyFileSync(file, file + ".copy")
            unlinkSync(file)
            copyFileSync(file + ".copy", file)
            unlinkSync(file + ".copy")
          }
        },
      })
    })

    test("(d) the data folder made read-only (0500) -> registry-write, sha256 equal, no rename, no backup", async () => {
      const fixture = keep(registryUnregistered())
      const before = sha(fixture.registryPath)
      const step = await press(fixture, switchable(), {
        beforeRename: async () => {
          chmodSync(fixture.configDir, 0o500)
        },
      })
      chmodSync(fixture.configDir, 0o700)
      expect(step).toEqual(notRegistered("registry-write"))
      expect(sha(fixture.registryPath)).toBe(before)
      expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
      // A read-only folder also refuses the unlink of the tmp file, so the one tmp file the call made is still there
      // (row 44 finding F44-2); it is removed here, after the mode is restored.
      const left = tmpFiles(fixture)
      expect(left.length).toBe(1)
      for (const name of left) unlinkSync(join(fixture.configDir, name))
    })
  })

  test("c18 obsidian.json swapped for a symlink to a copy with the same bytes before the rename -> registry-changed, the link stays (S10-02)", async () => {
    const fixture = keep(registryUnregistered())
    const copy = join(fixture.base, "registry-copy.json")
    const step = await press(fixture, switchable(), {
      beforeRename: async () => {
        copyFileSync(fixture.registryPath, copy)
        unlinkSync(fixture.registryPath)
        symlinkSync(copy, fixture.registryPath)
      },
    })
    expect(step).toEqual(notRegistered("registry-changed"))
    expect(lstatSync(fixture.registryPath).isSymbolicLink()).toBe(true)
    expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
    expect(tmpFiles(fixture)).toEqual([])
  })

  test("c19 (a) an entry under /Volumes/ is compared without a realpath call (S10-03)", async () => {
    const fixture = keep(fakeObsidianHome())
    const volume = "/Volumes/syn-volume-0a1b2c/notes"
    writeFileSync(fixture.registryPath, JSON.stringify({ vaults: { "4c3b2a1908f7e6d5": { path: volume, ts: 1_700_000_000_000 } } }))
    const spy = spyOn(fsPromises, "realpath")
    try {
      const step = await press(fixture, switchable())
      expect(step).toEqual({ result: "registered" })
      const args = spy.mock.calls.map((call) => String(call[0]))
      expect(args.length).toBeGreaterThan(0)
      expect(args.filter((arg) => arg.startsWith("/Volumes")).length).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("c19 (b) a step that never settles: at 15,000 ms (not before) -> registry-write, tmp unlinked, no rename, sha256 equal; nothing written afterwards (S10-03, S10-15)", async () => {
    const fixture = keep(registryUnregistered())
    const before = sha(fixture.registryPath)
    const runner = switchable()
    let entered!: () => void
    const reached = new Promise<void>((done) => (entered = done))
    let release!: () => void
    const held = new Promise<void>((done) => (release = done))
    jest.useFakeTimers()
    let settled = false
    try {
      const pending = press(fixture, runner, {
        beforeRename: () => {
          entered()
          return held
        },
      })
      pending.then(() => (settled = true))
      await reached
      expect(tmpFiles(fixture).length).toBe(1)
      jest.advanceTimersByTime(14_999)
      // Real file-system round trips pass (the unlink of a fired deadline would finish meanwhile); the fake clock
      // stays at 14,999 ms. (A sleep would itself wait on the fake clock.)
      for (let i = 0; i < 20; i++) await fsPromises.stat(fixture.configDir)
      expect(settled).toBe(false)
      expect(tmpFiles(fixture).length).toBe(1)
      jest.advanceTimersByTime(1)
      const step = await pending
      expect(step).toEqual(notRegistered("registry-write"))
    } finally {
      jest.useRealTimers()
    }
    expect(tmpFiles(fixture)).toEqual([])
    expect(sha(fixture.registryPath)).toBe(before)
    // The late step is let go: it must still write nothing (no backup, no rename, no tmp left).
    release()
    for (let i = 0; i < 100 && runner.calls < 2; i++) await Bun.sleep(10)
    await Bun.sleep(100)
    expect(sha(fixture.registryPath)).toBe(before)
    expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
    expect(tmpFiles(fixture)).toEqual([])
    // The queue moved on: the next call runs normally.
    expect(await press(fixture, switchable())).toEqual({ result: "registered" })
  })

  test("every refusal carries no path: only result and reason keys, values without '/'", async () => {
    const steps = [
      await press(keep(registryUnregistered()), switchable("running")),
      await press(keep(registryNestedChild()), switchable()),
      await press(keep(registryTooLarge()), switchable()),
    ]
    for (const step of steps) {
      expect(Object.keys(step).every((k) => k === "result" || k === "reason")).toBe(true)
      expect(Object.values(step).some((v) => String(v).includes("/"))).toBe(false)
    }
  })
})

// c15-c17 grep pins. Every pattern is assembled from pieces so this file does not match itself.
const pin = (...parts: string[]) => new RegExp(parts.join(""), "g")
const here = import.meta.dir
const moduleFile = join(here, "obsidian-registry.ts")
const testFiles = readdirSync(here)
  .filter((name) => /^rel1210-p1.*\.test\.ts$/.test(name))
  .map((name) => join(here, name))
const fixtureFile = join(here, "rel1210-obsidian-registry.fixture.ts")
const text = (file: string) => readFileSync(file, "utf8")
const count = (file: string, pattern: RegExp) => (text(file).match(pattern) ?? []).length
const imported = (name: string) => pin("(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)[\"'](?:node:)?", name, "[\"']")

describe("AC-P1c grep pins c15-c17", () => {
  test("the pinned file set holds the module, the fixture and the P1 tests (this file included)", () => {
    const names = testFiles.map((file) => file.slice(here.length + 1))
    for (const name of ["rel1210-p1a-registry-check.test.ts", "rel1210-p1b-registry-write.test.ts", "rel1210-p1c-safe-write.test.ts", "rel1210-p1e-exact-keys.test.ts"]) {
      expect(names).toContain(name)
    }
    expect(existsSync(moduleFile) && existsSync(fixtureFile)).toBe(true)
  })

  const enumeration = [
    pin("lsappinfo", " li", "st"),
    pin("[\"']li", "st[\"']"),
    pin("\\bpg", "rep\\b"),
    pin("\\bls", "of\\b"),
    pin("[\"']p", "s[\"']"),
    pin("/bin/p", "s\\b"),
    pin("running", "Applications"),
    pin("process\\.ki", "ll"),
    pin("\\bki", "ll\\("),
    pin("launch", "ctl li", "st"),
    pin("System ", "Events"),
    pin("[\"']in", "fo[\"']"),
    pin("[\"']meta", "info[\"']"),
    pin("visible", "ProcessList"),
    pin("[\"']fr", "ont[\"']"),
    // the flag form only: a dash right after a word character (row 43's synthetic id text) is not a flag
    pin("(?<![\\w])-a", "ll\\b"),
    pin("NS", "Workspace"),
    pin("sys", "ctl"),
    pin("proc_", "listpids"),
    pin("p", "s-li", "st"),
    pin("find-", "process"),
  ]
  test("c15 enumeration: 0 matches in the module, the P1 tests and the fixture", () => {
    for (const file of [moduleFile, fixtureFile, ...testFiles]) {
      for (const pattern of enumeration) expect({ file: file.slice(here.length + 1), pattern: pattern.source, n: count(file, pattern) }).toEqual({ file: file.slice(here.length + 1), pattern: pattern.source, n: 0 })
    }
  })

  test("c15 the module: the bundle id find and the lsappinfo path occur once; the injected execFile is called at one site, with LSAPPINFO_PATH first", () => {
    expect(count(moduleFile, pin("bundleid=md", "\\.obsidian"))).toBe(1)
    expect(count(moduleFile, pin("/usr/bin/", "lsappinfo"))).toBe(1)
    expect(count(moduleFile, pin("execFile", "Impl\\("))).toBe(1)
    expect(count(moduleFile, pin("execFile", "Impl\\(\\s*LSAPPINFO_PATH\\s*,"))).toBe(1)
    expect(count(moduleFile, pin("\\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\\s*", "\\("))).toBe(0)
    expect(count(moduleFile, imported("chi" + "ld_process"))).toBe(0)
  })

  const realPaths = [pin("/Us", "ers/"), pin("Library/Application ", "Support/obsidian"), pin("home", "dir"), pin("get", "Path\\(")]
  test("c16 real paths: 0 matches in the module, the P1 tests and the fixture", () => {
    for (const file of [moduleFile, fixtureFile, ...testFiles]) {
      for (const pattern of realPaths) expect({ file: file.slice(here.length + 1), pattern: pattern.source, n: count(file, pattern) }).toEqual({ file: file.slice(here.length + 1), pattern: pattern.source, n: 0 })
    }
  })

  test("c16 the module: no Application Support text, no logger, no error text (S10-10)", () => {
    for (const pattern of [
      pin("Application ", "Support"),
      pin("console", "\\."),
      pin("\\.mes", "sage\\b"),
      pin("\\b(?:err|error|e|cause)\\.pa", "th\\b"),
      pin("String\\(e", "rr"),
    ]) {
      expect({ pattern: pattern.source, n: count(moduleFile, pattern) }).toEqual({ pattern: pattern.source, n: 0 })
    }
  })

  test("c17 no launch: the P1 tests and the fixture import neither electron nor child_process, and call no real openExternal", () => {
    for (const file of [fixtureFile, ...testFiles]) {
      for (const pattern of [imported("elec" + "tron"), imported("chi" + "ld_process"), pin("(?<![.\\w])openEx", "ternal\\("), pin("shell\\.openEx", "ternal")]) {
        expect({ file: file.slice(here.length + 1), pattern: pattern.source, n: count(file, pattern) }).toEqual({ file: file.slice(here.length + 1), pattern: pattern.source, n: 0 })
      }
    }
  })
})
