// Row 40: state folder, lock, journal and `status` (spec 5.3-5.6, 6.5; 9.5 V-23, V-24, V-25, V-28; 9.9 ST-01..03),
// RK-11 (symlinks at <state>, staging, previous, lock, lock/pid, state, state.new, with the P2 shape
// `previous -> ../victim` and `victim/` left intact) and RK-14 (injection payloads in the journal and lock/pid;
// the marker file must never appear). Lock cases follow C9. Review cases M-1, M-2 (C12) and F3 (C10, sandbox part)
// sit at the end. Ported from scratchpad/row17/t15a.zsh. Synthetic keys and fixture apps under $TMPDIR only.
// Only verify, status and the pre-lock/pre-process steps of the other subcommands run here, so nothing calls
// `pgrep`: the whole file runs inside the agent sandbox. Every case starts from an empty state folder.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  applier,
  buildApp,
  CODE,
  createEnv,
  type Env,
  type ErrorName,
  exists,
  expectReject,
  fileHash,
  hasError,
  installApp,
  invariants,
  must,
  type Package,
  pkg,
  REPO_APPLIER,
  run,
  snapshot,
  stateDirs,
  treeHash,
  writeJournal,
} from "./fixture"

setDefaultTimeout(180_000)

const V01_STDOUT = "result=verified\nrelease=1.2.0\nfrom_release=1.1.0\nmigration=none\nnew_key=no\n"
const ST01_STDOUT = "release=1.1.0\nbundle_version=1.19.3\nprevious_release=\ndata_min_release=\njournal_phase=none\n"
const RUN = "1762000000-123"

let env: Env
let installed: string
let good: Package
let dummy: string

const state = (...p: string[]) => path.join(env.state, ...p)
const support = () => path.dirname(env.state)
const marker = () => path.join(env.root, "x_injected")
const idle = () => ({ state_format: "1", phase: "idle", target_path: installed, to_release: "1.1.0" })
const lockPid = () => fs.readFile(state("lock", "pid"), "utf8").catch(() => null)
let slow: Package | undefined
/** A valid 1.2.0 package with a 64 MB incompressible resource, so a verify run holds the lock for a while. */
const slowPackage = async () =>
  (slow ??= await pkg(
    env,
    await buildApp(env, {
      release: "1.2.0",
      mutate: (app) => fs.writeFile(path.join(app, "Contents", "Resources", "pad.bin"), randomBytes(64 << 20)),
    }),
  ))

beforeAll(async () => {
  env = await createEnv()
  installed = await installApp(env)
  good = await pkg(env, await buildApp(env, { release: "1.2.0" }))
  dummy = path.join(env.root, "dummy.swarmpatch")
  await fs.writeFile(dummy, "notzip\n")
})
afterAll(async () => env?.cleanup())

beforeEach(async () => {
  await run(["/bin/chmod", "-R", "u+w", support()])
  for (const p of [env.state, path.join(support(), "victim"), marker()]) await fs.rm(p, { recursive: true, force: true })
})

/** `victim/` beside `<state>` with files, so a relative `../victim` link from inside `<state>` reaches it (P2). */
async function victim() {
  const dir = path.join(support(), "victim")
  await fs.mkdir(path.join(dir, "Swarm.app", "Contents"), { recursive: true })
  await fs.writeFile(path.join(dir, "Swarm.app", "Contents", "f"), "keep\n")
  await fs.writeFile(path.join(dir, "g"), "keep\n")
  await fs.chmod(dir, 0o700)
  return { dir, hash: await treeHash(dir) }
}

/** A PID that is not alive: a process that has already exited. */
async function deadPid() {
  const p = Bun.spawn(["/usr/bin/true"])
  await p.exited
  expect(() => process.kill(p.pid, 0)).toThrow()
  return p.pid
}

/** `lock/` (0700) with optional pid content, aged `age` seconds (both the folder and the pid file). */
async function seedLock(content: string | null, age = 0) {
  await stateDirs(env)
  await fs.mkdir(state("lock"), { mode: 0o700 })
  if (content !== null) await fs.writeFile(state("lock", "pid"), content)
  if (age === 0) return
  const t = Date.now() / 1000 - age
  if (content !== null) await fs.utimes(state("lock", "pid"), t, t)
  await fs.utimes(state("lock"), t, t)
}

/**
 * A rejection where the test seeded something under `<state>` that the applier must leave alone (a held lock, a
 * symlink): code, S11 line, empty stdout, INV-1, INV-2, INV-4, and INV-3 except the seeded lock.
 */
async function rejectKeeping(args: string[], name: ErrorName, seeded = ["INV-3: lock still present"]) {
  const app = installed
  const before = await snapshot(env, app)
  const r = await applier(env, args, app)
  expect({ code: r.code, error: hasError(r, name), stdout: r.stdout, stderr: r.stderr }).toMatchObject({
    code: CODE[name],
    error: true,
    stdout: "",
  })
  expect((await invariants(env, before, app)).filter((x) => !seeded.includes(x))).toEqual([])
  return r
}

async function expectVerified(args: string[]) {
  const before = await snapshot(env)
  const r = await applier(env, args)
  expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: V01_STDOUT, stderr: "" })
  expect(await invariants(env, before)).toEqual([])
}

const args = (sub: string) => (sub === "verify" || sub === "apply" ? [sub, good.path] : [sub])

describe("status (6.5, ST-01..03, C6)", () => {
  test("ST-01 no journal: exactly five lines, exit 0, and status creates nothing", async () => {
    const r = await applier(env, ["status"])
    expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: ST01_STDOUT, stderr: "" })
    expect(await exists(env.state)).toBe(false)
  })

  test("ST-02 idle journal with previous/Swarm.app: previous_release and journal_phase=idle, no sixth line", async () => {
    await writeJournal(env, { ...idle(), from_release: "1.1.0", to_release: "1.2.0", last_apply: "1.2.0", data_min_release: "1.0.0" })
    await must(["/usr/bin/ditto", installed, state("previous", "Swarm.app")])
    const r = await applier(env, ["status"])
    expect({ code: r.code, stdout: r.stdout }).toEqual({
      code: 0,
      stdout: "release=1.1.0\nbundle_version=1.19.3\nprevious_release=1.1.0\ndata_min_release=1.0.0\njournal_phase=idle\n",
    })
  })

  test("S10: idle journal without previous/Swarm.app gives an empty previous_release", async () => {
    await writeJournal(env, { ...idle(), from_release: "1.1.0", to_release: "1.2.0", data_min_release: "1.0.0" })
    expect((await applier(env, ["status"])).stdout).toContain("\nprevious_release=\n")
  })

  test("C5/C6: sixth line rollback_blocked=forward_migration only when data_min_release > previous_release", async () => {
    await writeJournal(env, { ...idle(), from_release: "1.1.0", to_release: "1.2.0", data_min_release: "1.2.0" })
    await must(["/usr/bin/ditto", installed, state("previous", "Swarm.app")])
    const lines = (await applier(env, ["status"])).stdout.trim().split("\n")
    expect({ count: lines.length, sixth: lines[5] }).toEqual({ count: 6, sixth: "rollback_blocked=forward_migration" })
  })

  test("ST valid staged journal gives journal_phase=staged", async () => {
    await writeJournal(env, { ...idle(), phase: "staged", run: RUN, started_at: "1762000000" })
    expect((await applier(env, ["status"])).stdout).toContain("journal_phase=staged\n")
  })

  // ST-03 and RK-14: each value is written verbatim; the parse must refuse it and never evaluate it.
  const m = marker
  const invalid: [string, () => Record<string, string>][] = [
    ["state_format=2", () => ({ ...idle(), state_format: "2" })],
    ["phase=bogus", () => ({ ...idle(), phase: "bogus" })],
    ["staged without run", () => ({ ...idle(), phase: "staged" })],
    ["idle with run", () => ({ ...idle(), run: RUN })],
    ["foreign target_path", () => ({ ...idle(), target_path: "/elsewhere/Swarm.app" })],
    ["previous_cdhash=ABC", () => ({ ...idle(), previous_cdhash: "ABC" })],
    ["RK-14 from_release=a[$(touch)1]", () => ({ ...idle(), from_release: `a[$(touch ${m()})1]` })],
    ["RK-14 phase=x[$(touch)]", () => ({ ...idle(), phase: `x[$(touch ${m()})]` })],
    ["RK-14 started_at=$(touch)", () => ({ ...idle(), started_at: `$(touch ${m()})` })],
    ["RK-14 data_min_release=`touch`", () => ({ ...idle(), data_min_release: `\`touch ${m()}\`` })],
    ["RK-14 run=1; touch", () => ({ ...idle(), phase: "staged", run: `1; touch ${m()}` })],
    ["RK-14 target_path with $(touch)", () => ({ ...idle(), target_path: `/x/$(touch ${m()})/Swarm.app` })],
  ]
  for (const [name, values] of invalid)
    test(`ST-03 invalid journal (${name}): exit 0, journal_phase=invalid, no marker`, async () => {
      await writeJournal(env, values())
      const sha = await fileHash(state("state"))
      const r = await applier(env, ["status"])
      expect({ code: r.code, last: r.stdout.trim().split("\n").at(-1), marker: await exists(marker()) }).toEqual({
        code: 0,
        last: "journal_phase=invalid",
        marker: false,
      })
      expect(await fileHash(state("state"))).toBe(sha)
    })

  const base = async () => {
    await writeJournal(env, idle())
    return fs.readFile(state("state"), "utf8")
  }
  const syntax: [string, (t: string) => string][] = [
    ["unknown key", (t) => t + "unknown_key=1\n"],
    ["duplicate key", (t) => t + "last_apply=\n"],
    ["missing key", (t) => t.replace(/^last_apply=\n/m, "")],
    ["CRLF", (t) => t.replaceAll("\n", "\r\n")],
    ["tab in a value", (t) => t.replace("to_release=1.1.0", "to_release=1.1.0\t")],
    ["NUL byte", (t) => t + "x\0y\n"],
    ["no final LF", (t) => t.slice(0, -1)],
    ["empty line", (t) => t + "\n"],
    ["uppercase key", (t) => t.replace("phase=", "Phase=")],
    ["over 16384 bytes", (t) => t.replace("to_release=1.1.0", `to_release=${"1".repeat(16400)}`)],
  ]
  for (const [name, edit] of syntax)
    test(`ST-03 journal syntax (${name}): journal_phase=invalid`, async () => {
      await fs.writeFile(state("state"), edit(await base()))
      expect((await applier(env, ["status"])).stdout.trim().split("\n").at(-1)).toBe("journal_phase=invalid")
    })

  test("status takes no lock: a held lock stays and status still exits 0", async () => {
    const holder = Bun.spawn(["/bin/sleep", "30"])
    try {
      await seedLock(`${holder.pid}\n`)
      const r = await applier(env, ["status"])
      expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 0, stdout: ST01_STDOUT })
      expect(await lockPid()).toBe(`${holder.pid}\n`)
    } finally {
      holder.kill()
      await holder.exited
    }
  })

  test("V-27 hostile environment (UNZIP, LC_ALL, TMPDIR, PATH): status output identical to ST-01", async () => {
    const r = await applier(env, ["status"], installed, {
      env: {
        HOME: env.home,
        UNZIP: "-x",
        UNZIPOPT: "-aa",
        ZIPOPT: "-q",
        LC_ALL: "tr_TR.UTF-8",
        TMPDIR: "/nonexistent",
        PATH: "/nonexistent",
      },
    })
    expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 0, stdout: ST01_STDOUT })
  })
})

describe("state folder (5.3, V-23)", () => {
  test("V-23 <state> mode 0755: E_BUSY for verify and status", async () => {
    await stateDirs(env)
    await fs.chmod(env.state, 0o755)
    await expectReject(env, ["verify", good.path], "E_BUSY")
    await expectReject(env, ["status"], "E_BUSY")
  })

  for (const sub of ["staging", "previous"])
    test(`5.3 ${sub} mode 0755: E_BUSY`, async () => {
      await stateDirs(env)
      await fs.chmod(state(sub), 0o755)
      await expectReject(env, ["verify", good.path], "E_BUSY")
    })

  const busy: [string, () => Record<string, string>][] = [
    ["unknown key", () => idle()],
    ["state_format=2", () => ({ ...idle(), state_format: "2" })],
    ["phase staged", () => ({ ...idle(), phase: "staged", run: RUN, started_at: "1762000000" })],
    ["foreign target_path", () => ({ ...idle(), target_path: "/elsewhere/Swarm.app" })],
  ]
  for (const [name, values] of busy)
    test(`V-23 journal ${name}: E_BUSY before any change; journal unchanged`, async () => {
      await writeJournal(env, values())
      if (name === "unknown key") await fs.appendFile(state("state"), "unknown_key=1\n")
      // A valid staged journal is what recover exists for (6.4), so only the invalid ones refuse recover.
      const subs = name === "phase staged" ? ["verify", "apply", "rollback"] : ["verify", "apply", "rollback", "recover"]
      for (const sub of subs) await expectReject(env, args(sub), "E_BUSY")
    })

  test("RK-14 journal injection: verify E_BUSY and the marker never appears", async () => {
    for (const values of [
      { ...idle(), from_release: `a[$(touch ${marker()})1]` },
      { ...idle(), phase: `idle]+$(touch ${marker()})` },
      { ...idle(), data_min_release: `$(touch ${marker()})` },
    ]) {
      await writeJournal(env, values)
      await expectReject(env, ["verify", good.path], "E_BUSY")
      expect(await exists(marker())).toBe(false)
    }
  })

  test("RB-06 (sandbox part) rollback without a journal: E_MIGRATION", async () => {
    await expectReject(env, ["rollback"], "E_MIGRATION")
  })

  test("5.6 leftovers in staging are removed when no operation is recorded", async () => {
    await stateDirs(env)
    await fs.mkdir(state("staging", "old", "x"), { recursive: true })
    await fs.writeFile(state("staging", ".hidden"), "z")
    await expectVerified(["verify", good.path])
  })

  test("5.6 staging is kept while an operation is recorded (phase new_placed)", async () => {
    await writeJournal(env, { ...idle(), phase: "new_placed", run: RUN, started_at: "1762000000" })
    await fs.mkdir(state("staging", RUN, "x"), { recursive: true })
    const r = await applier(env, ["verify", good.path])
    expect({ code: r.code, error: hasError(r, "E_BUSY") }).toEqual({ code: 23, error: true })
    expect(await exists(state("staging", RUN, "x"))).toBe(true)
    expect(await exists(state("lock"))).toBe(false)
  })

  test("5.3 HOME empty or relative: E_BUSY", async () => {
    for (const home of ["", "relative"]) {
      const r = await applier(env, ["status"], installed, { env: { HOME: home } })
      expect({ code: r.code, error: hasError(r, "E_BUSY") }).toEqual({ code: 23, error: true })
    }
  })
})

describe("RK-11 / T8b symlinks (V-25): E_BUSY and victim/ unchanged", () => {
  for (const sub of ["verify", "apply", "rollback", "recover", "status"])
    test(`P2 previous -> ../victim (${sub})`, async () => {
      await stateDirs(env)
      await fs.rm(state("previous"), { recursive: true })
      const v = await victim()
      await fs.symlink("../victim", state("previous"))
      expect(await fs.realpath(state("previous"))).toBe(await fs.realpath(v.dir))
      await expectReject(env, args(sub), "E_BUSY")
      expect(await treeHash(v.dir)).toBe(v.hash)
    })

  for (const sub of ["verify", "apply", "status"])
    test(`staging -> ../victim (${sub})`, async () => {
      await stateDirs(env)
      await fs.rm(state("staging"), { recursive: true })
      const v = await victim()
      // Stale content in victim/ would be "cleaned" through the link if the check were missing.
      await fs.symlink("../victim", state("staging"))
      // INV-3 reads staging through the seeded link, so it sees victim/; H(victim) is the real check.
      await rejectKeeping(args(sub), "E_BUSY", ["INV-3: staging not empty"])
      expect((await fs.lstat(state("staging"))).isSymbolicLink()).toBe(true)
      expect(await treeHash(v.dir)).toBe(v.hash)
    })

  for (const sub of ["verify", "status"])
    test(`<state> -> victim (${sub})`, async () => {
      const v = await victim()
      await fs.symlink(v.dir, env.state)
      const r = await applier(env, args(sub))
      expect({ code: r.code, error: hasError(r, "E_BUSY"), stdout: r.stdout }).toEqual({ code: 23, error: true, stdout: "" })
      expect(await treeHash(v.dir)).toBe(v.hash)
      expect((await fs.lstat(env.state)).isSymbolicLink()).toBe(true)
    })

  for (const name of ["lock", "lock.take", "state", "state.new", "lock/pid"])
    test(`${name} -> victim/g`, async () => {
      await stateDirs(env)
      if (name === "lock/pid") await fs.mkdir(state("lock"), { mode: 0o700 })
      const v = await victim()
      await fs.symlink(path.join(v.dir, "g"), state(name))
      await rejectKeeping(["verify", good.path], "E_BUSY")
      expect(await treeHash(v.dir)).toBe(v.hash)
      expect((await fs.lstat(state(name))).isSymbolicLink()).toBe(true)
    })
})

describe("lock (5.4, S8, V-24, V-28, C9)", () => {
  test("V-24 lock/pid of a live process: E_BUSY, lock and pid untouched", async () => {
    const holder = Bun.spawn(["/bin/sleep", "30"])
    try {
      await seedLock(`${holder.pid}\n`)
      const r = await rejectKeeping(["verify", good.path], "E_BUSY")
      expect(r.stderr).toContain(`pid ${holder.pid}`)
      expect(await lockPid()).toBe(`${holder.pid}\n`)
    } finally {
      holder.kill()
      await holder.exited
    }
  })

  test("V-24 lock/pid of a dead process: the stale lock is taken over, verify passes, lock released", async () => {
    await seedLock(`${await deadPid()}\n`)
    await expectVerified(["verify", good.path])
  })

  const payloads = () => [
    `1; touch ${marker()}`,
    `$(touch ${marker()})`,
    `a[$(touch ${marker()})1]`,
    `\`touch ${marker()}\``,
    "0",
    "-1",
    "12345678",
  ]
  test("V-28/RK-14 lock/pid that is not a PID: E_BUSY, no command runs, lock/ not removed", async () => {
    for (const content of payloads()) {
      await fs.rm(env.state, { recursive: true, force: true })
      await seedLock(`${content}\n`)
      await rejectKeeping(["verify", good.path], "E_BUSY")
      expect({ content, marker: await exists(marker()), pid: await lockPid() }).toEqual({
        content,
        marker: false,
        pid: `${content}\n`,
      })
    }
  })

  test("5.4 lock/pid that is a directory or a lock with mode 0755: E_BUSY", async () => {
    await seedLock(null)
    await fs.mkdir(state("lock", "pid"))
    await fs.utimes(state("lock"), Date.now() / 1000 - 60, Date.now() / 1000 - 60)
    await rejectKeeping(["verify", good.path], "E_BUSY")
    await fs.rm(env.state, { recursive: true })
    await seedLock(`${await deadPid()}\n`)
    await fs.chmod(state("lock"), 0o755)
    await rejectKeeping(["verify", good.path], "E_BUSY")
  })

  // C9: a holder sits between `mkdir lock` and writing lock/pid; a run that sees a fresh pid-less lock must wait.
  for (const [name, content] of [
    ["missing", null],
    ["empty", ""],
  ] as const) {
    test(`C9 lock/pid ${name}, lock younger than 10 s: E_BUSY and lock/ kept [waits on C9 fix]`, async () => {
      await seedLock(content, 2)
      await rejectKeeping(["verify", good.path], "E_BUSY")
      expect({ lock: await exists(state("lock")), pid: await lockPid() }).toEqual({ lock: true, pid: content })
    })

    test(`C9 lock/pid ${name}, lock older than 10 s: stale, taken over, verify passes`, async () => {
      await seedLock(content, 60)
      await expectVerified(["verify", good.path])
    })
  }

  // C9: the exit trap removes lock/ only when lock/pid is its own PID. A run that lost the lock to another holder
  // (here: lock/pid rewritten to a live process while the run is extracting) must leave that holder's lock alone.
  test("C9 exit trap keeps a lock whose pid is another holder's [waits on C9 fix]", async () => {
    const slow = await slowPackage()
    const other = Bun.spawn(["/bin/sleep", "60"])
    try {
      const call = applier(env, ["verify", slow.path])
      const seen = await (async () => {
        for (let i = 0; i < 6000; i++) {
          const runs = await fs.readdir(state("staging")).catch(() => [] as string[])
          if (runs.length === 1 && (await exists(state("staging", runs[0], "x")))) return lockPid()
          await Bun.sleep(5)
        }
        throw new Error("x/ never appeared")
      })()
      expect(seen ?? "").toMatch(/^[1-9][0-9]*\n$/)
      await fs.writeFile(state("lock", "pid.tmp"), `${other.pid}\n`)
      await fs.rename(state("lock", "pid.tmp"), state("lock", "pid"))
      await call
      expect({ lock: await exists(state("lock")), pid: await lockPid() }).toEqual({ lock: true, pid: `${other.pid}\n` })
    } finally {
      other.kill()
      await other.exited
    }
  })

  // C9, C14: two holders never at once, 20 rounds in a row per starting state. Six verify runs of a slow package
  // (64 MB, so each hold lasts long enough to be seen) start together while lock/pid is sampled every 1 ms. A round
  // fails when a run is seen holding the lock and, later but before that run exits, another run is seen holding
  // it (two holders), when a verified run was never seen holding it, or when a run ends with anything other than
  // verified or E_BUSY (a second holder removing the first one's staging folder). EXIT_MARGIN covers the moment
  // between the exit trap removing lock/ and the process ending.
  const ROUNDS = 20
  const EXIT_MARGIN = 300
  for (const [name, seed] of [
    // State folders exist, so the runs contend for lock/ only, not for creating <state>.
    ["free lock", async () => stateDirs(env)],
    ["stale lock (dead pid)", async () => seedLock(`${await deadPid()}\n`)],
    ["stale pid-less lock (60 s)", async () => seedLock(null, 60)],
  ] as const)
    test(`C9/C14 race, ${ROUNDS} rounds of 6 parallel verify runs from a ${name}: never two holders`, async () => {
      const slow = await slowPackage()
      const script = path.join(installed, "Contents", "Resources", "swarm-patch", "swarm-patch")
      for (let round = 1; round <= ROUNDS; round++) {
        await fs.rm(env.state, { recursive: true, force: true })
        await seed()
        const t0 = performance.now()
        const runs = Array.from({ length: 6 }, () => {
          const proc = Bun.spawn(["/bin/zsh", "-f", script, "verify", slow.path], {
            env: { ...(process.env as Record<string, string>), HOME: env.home },
            stdout: "pipe",
            stderr: "pipe",
          })
          const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
            ([stdout, stderr, code]) => ({ pid: proc.pid, stdout, stderr, code, end: performance.now() - t0 }),
          )
          return { pid: proc.pid, done }
        })
        const samples: { t: number; pid: number }[] = []
        const all = Promise.all(runs.map((r) => r.done))
        for (let finished = false; !finished; ) {
          const text = await lockPid()
          if (text && /^[1-9][0-9]*\n$/.test(text)) samples.push({ t: performance.now() - t0, pid: Number(text) })
          finished = await Promise.race([all.then(() => true), Bun.sleep(1).then(() => false)])
        }
        const results = await all
        const firstSeen = (pid: number) => samples.find((x) => x.pid === pid)?.t
        const overlaps = results.flatMap((r) => {
          const start = firstSeen(r.pid)
          if (start === undefined) return []
          return samples
            .filter((x) => x.pid !== r.pid && runs.some((o) => o.pid === x.pid) && x.t > start && x.t < r.end - EXIT_MARGIN)
            .slice(0, 1)
            .map((x) => `pid ${x.pid} held the lock at ${x.t.toFixed(0)} ms while pid ${r.pid} (seen at ${start.toFixed(0)} ms) ran until ${r.end.toFixed(0)} ms`)
        })
        const odd = results
          .filter((r) => !(r.code === 0 && r.stdout === V01_STDOUT) && !(r.code === 23 && hasError(r, "E_BUSY") && r.stdout === ""))
          .map((r) => `${r.code} ${r.stderr.trim()}`)
        const unseen = results.filter((r) => r.code === 0 && firstSeen(r.pid) === undefined).map((r) => r.pid)
        expect({ round, overlaps, odd, unseen }).toEqual({ round, overlaps: [], odd: [], unseen: [] })
        expect(results.some((r) => r.code === 0)).toBe(true)
        expect({
          lock: await exists(state("lock")),
          take: await exists(state("lock.take")),
          staging: await fs.readdir(state("staging")),
        }).toEqual({ lock: false, take: false, staging: [] })
      }
    })
})

describe("bootstrap (B2, B3, B4)", () => {
  test("B3 backup copy: status and verify give E_USAGE", async () => {
    await stateDirs(env)
    const backup = state("previous", "Swarm.app")
    await must(["/usr/bin/ditto", installed, backup])
    for (const a of [["status"], ["verify", good.path]]) {
      const r = await applier(env, a, backup)
      expect({ code: r.code, error: hasError(r, "E_USAGE") }).toEqual({ code: 2, error: true })
    }
  })

  test("B3 applier inside staging: E_USAGE", async () => {
    await stateDirs(env)
    const copy = state("staging", "r", "x", "Swarm.app")
    await must(["/usr/bin/ditto", installed, copy])
    const r = await applier(env, ["status"], copy)
    expect({ code: r.code, error: hasError(r, "E_USAGE") }).toEqual({ code: 2, error: true })
  })

  test("B2 applier not inside an .app bundle: E_USAGE", async () => {
    const dir = path.join(env.root, "notapp", "Contents", "Resources", "swarm-patch")
    await fs.mkdir(dir, { recursive: true })
    await fs.copyFile(REPO_APPLIER, path.join(dir, "swarm-patch"))
    const r = await run(["/bin/zsh", "-f", path.join(dir, "swarm-patch"), "status"], { env: { HOME: env.home } })
    expect({ code: r.code, error: hasError(r, "E_USAGE") }).toEqual({ code: 2, error: true })
  })

  test("B2 a symlinked caller path resolves to the real target", async () => {
    const link = path.join(env.root, "applink")
    await fs.rm(link, { force: true })
    await fs.symlink(env.apps, link)
    const r = await run(["/bin/zsh", "-f", path.join(link, "Swarm.app", "Contents", "Resources", "swarm-patch", "swarm-patch"), "status"], {
      env: { HOME: env.home },
    })
    expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 0, stdout: ST01_STDOUT })
  })

  test("B4 SwarmRelease that is not semver: status E_SEAL", async () => {
    const app = await buildApp(env, { release: "1.1.0-rc1", into: path.join(env.root, "inst", "rc") })
    const r = await applier(env, ["status"], app)
    expect({ code: r.code, error: hasError(r, "E_SEAL") }).toEqual({ code: 15, error: true })
  })

  test("usage: no subcommand, unknown subcommand, status with an argument", async () => {
    for (const a of [[], ["bogus"], ["status", "extra"]]) await expectReject(env, a, "E_USAGE")
  })
})

describe("review fixes M-1, M-2 (C12) and F3 (C10)", () => {
  test("M-1 backup copy, no journal: recover --target gives E_USAGE with the S11 line, nothing changed [waits on M-1 fix]", async () => {
    await stateDirs(env)
    const backup = state("previous", "Swarm.app")
    await must(["/usr/bin/ditto", installed, backup])
    const hb = await treeHash(backup)
    const r = await applier(env, ["recover", "--target", installed], backup)
    expect({ code: r.code, error: hasError(r, "E_USAGE"), stderr: r.stderr }).toMatchObject({ code: 2, error: true })
    expect({ backup: await treeHash(backup), journal: await exists(state("state")), lock: await exists(state("lock")) }).toEqual({
      backup: hb,
      journal: false,
      lock: false,
    })
  })

  // M-2: what the applier accepts as a target must read back from the journal by the same rule. Either the
  // non-ASCII target is refused up front (E_USAGE, nothing changed), or a journal naming it is valid.
  test("M-2 target folder with a non-ASCII name: refused up front, or its journal reads back valid [waits on M-2 fix]", async () => {
    const t = path.join(env.root, "Aplikasi é", "Swarm.app")
    await must(["/usr/bin/ditto", installed, t])
    const before = await snapshot(env, t)
    const v = await applier(env, ["verify", good.path], t)
    if (v.code === CODE.E_USAGE) {
      expect(hasError(v, "E_USAGE")).toBe(true)
      expect(await invariants(env, before, t)).toEqual([])
      for (const a of [["apply", good.path], ["status"], ["rollback"], ["recover"]]) await expectReject(env, a, "E_USAGE", { app: t })
      return
    }
    expect({ code: v.code, stdout: v.stdout }).toEqual({ code: 0, stdout: V01_STDOUT })
    await writeJournal(env, { ...idle(), target_path: t })
    expect((await applier(env, ["status"], t)).stdout).toContain("journal_phase=idle\n")
  })

  // F3 sandbox part: C10 checks that the parent of --target is writable by the user. A parent owned by the user
  // but read-only must be refused before anything else, even with an idle journal.
  test("F3/C10 --target whose parent is the user's but not writable: E_USAGE [waits on C10 fix]", async () => {
    const parent = path.join(env.root, "ro")
    await fs.mkdir(parent)
    const t = path.join(parent, "Swarm.app")
    await writeJournal(env, { ...idle(), target_path: t })
    const backup = state("previous", "Swarm.app")
    await must(["/usr/bin/ditto", installed, backup])
    const sha = await fileHash(state("state"))
    const hb = await treeHash(backup)
    await fs.chmod(parent, 0o555)
    const r = await applier(env, ["recover", "--target", t], backup)
    await fs.chmod(parent, 0o755)
    expect({ code: r.code, error: hasError(r, "E_USAGE"), stdout: r.stdout }).toEqual({ code: 2, error: true, stdout: "" })
    expect({ journal: await fileHash(state("state")), backup: await treeHash(backup), target: await exists(t) }).toEqual({
      journal: sha,
      backup: hb,
      target: false,
    })
  })
})
