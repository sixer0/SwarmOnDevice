// Row 62: update handoff end to end (spec 04 section 10.3 HO-00..HO-16, register 14.4 HO-18..HO-21).
// The wrapper text HANDOFF_SCRIPT and its argv builder come from src/main/swarm-patch-handoff.ts (row 57) unchanged.
// Every case runs under its own folder from mktemp in $TMPDIR, with HOME=<T>/home, a stub relaunch tool
// <T>/bin/relaunch (never /usr/bin/open, HO-00) and a fake main PID created here. The applier is either a stub at
// <T>/apps/Swarm.app/Contents/Resources/swarm-patch/swarm-patch (W2 / D52-7 only accepts that path or a link to it)
// or, for HO-05 and HO-09, the repo applier inside a fixture app built by ./fixture.
// Needs the process list (W4 busy check and the applier's own check): run outside the agent sandbox (protocol SB).
// In the sandbox `pgrep` exits >= 2 and beforeAll fails every case with that reason; nothing is skipped.
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  HANDOFF_OUTPUT_MAX_BYTES,
  HANDOFF_RESULT_MAX_BYTES,
  HANDOFF_SCRIPT,
  type HandoffRequest,
  type HandoffSpawn,
  type HandoffTiming,
  handoffSpawnArgs,
} from "../../src/main/swarm-patch-handoff"
import { buildApp, exists, holder, installApp, must, pkg, requireProcessList, run, treeHash, withEnv } from "./fixture"

setDefaultTimeout(180_000)

// HO-00: the real home comes from the account database, not from $HOME (the run overrides HOME with a fixture).
// Bun's os.userInfo().homedir and os.homedir() both return $HOME, so ask zsh for ~<login name> (getpwnam).
function accountHome() {
  const user = Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString().trim()
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`HO-00: unexpected login name ${JSON.stringify(user)}`)
  const home = Bun.spawnSync(["/bin/zsh", "-fc", `print -r -- ~${user}`], { env: { PATH: "/usr/bin:/bin" } })
    .stdout.toString()
    .trim()
  if (!path.isAbsolute(home) || home === "/") throw new Error(`HO-00: cannot read the account home (${home})`)
  return home
}
const REAL_HOME = accountHome()
const MODULE = path.join(import.meta.dir, "..", "..", "src", "main", "swarm-patch-handoff.ts")
const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
const PREVIOUS = ["Library", "Application Support", "id.co.gsp.swarm.patch", "previous", "Swarm.app"]

type Box = {
  root: string
  home: string
  target: string
  res: string
  applier: string
  ud: string
  result: string
  relaunch: string
}

const forbidden = (p: string) => p.startsWith("/Applications/") || p === REAL_HOME || p.startsWith(REAL_HOME + "/")

// Applier stub (spec 10.3): records call number, $EPOCHREALTIME, `kill -0 <main>` and its ppid chain (HO-15), the
// argv bytes (HO-12), then exits with the code the case set in <T>/codes (line n, else the last line).
const stubApplier = (root: string) =>
  [
    "zmodload zsh/datetime",
    `T='${root}'`,
    "n=1",
    "[[ -f $T/applier.count ]] && n=$(( $(<$T/applier.count) + 1 ))",
    "print -r -- $n > $T/applier.count",
    "main=$(<$T/main.pid)",
    "if kill -0 $main 2>/dev/null; then st=alive; else st=dead; fi",
    "chain='' p=$$",
    "while (( p > 1 )); do p=$(/bin/ps -o ppid= -p $p 2>/dev/null); p=${p//[[:space:]]/}; [[ -n $p ]] || break; chain+=\" $p\"; done",
    'print -r -- "n=$n t=$EPOCHREALTIME main=$st pid=$$ chain=$chain" >> $T/applier.log',
    'print -rN -- "$@" > $T/argv.$n',
    'codes=( ${(f)"$(<$T/codes)"} )',
    "rc=${codes[$n]:-${codes[-1]}}",
    "if [[ -f $T/big ]]; then s=xxxxxxxxxx; s=$s$s$s$s$s$s$s$s$s$s; repeat 1000 print -rn -- $s; print; fi",
    "[[ -f $T/remove-target ]] && /bin/mv -- ${0:A:h:h:h:h} $T/gone",
    'print -r -- "stub call $n rc=$rc"',
    "exit $rc",
  ].join("\n") + "\n"

const relaunchStub = (root: string) =>
  `#!/bin/zsh -f\nzmodload zsh/datetime\nprint -r -- "$EPOCHREALTIME $*" >> '${root}/relaunch.log'\n`

async function writeRelaunch(root: string) {
  if (!/^[A-Za-z0-9._/-]+$/.test(root)) throw new Error(`unexpected characters in T: ${root}`)
  if (forbidden(root)) throw new Error(`HO-00: T under /Applications or the real home: ${root}`)
  await fs.mkdir(path.join(root, "bin"), { recursive: true })
  await fs.writeFile(path.join(root, "bin", "relaunch"), relaunchStub(root), { mode: 0o755 })
}

function layout(root: string, home: string, target: string): Box {
  const res = path.join(target, "Contents", "Resources")
  const ud = path.join(root, "ud")
  return {
    root,
    home,
    target,
    res,
    applier: path.join(res, "swarm-patch", "swarm-patch"),
    ud,
    result: path.join(ud, "swarm-patch-result"),
    relaunch: path.join(root, "bin", "relaunch"),
  }
}

/** A fresh T with the stub applier at <target>/Contents/Resources/swarm-patch/swarm-patch. */
async function withBox(fn: (b: Box) => Promise<void>, targetRel = "Swarm.app") {
  const made = (await must(["/usr/bin/mktemp", "-d", path.join(process.env.TMPDIR!, "swarm_handoff_e2e.XXXXXX")])).stdout
  const root = await fs.realpath(made.trim())
  try {
    await writeRelaunch(root)
    const b = layout(root, path.join(root, "home"), path.join(root, "apps", ...targetRel.split("/")))
    await fs.mkdir(path.dirname(b.applier), { recursive: true })
    await fs.mkdir(b.home, { recursive: true })
    await fs.mkdir(b.ud, { recursive: true })
    await fs.writeFile(b.applier, stubApplier(root), { mode: 0o755 })
    await fs.writeFile(path.join(root, "codes"), "0\n")
    await fn(b)
  } finally {
    await run(["/bin/chmod", "-R", "u+w", root])
    await fs.rm(root, { recursive: true, force: true })
  }
}

const codes = (b: Box, ...c: number[]) => fs.writeFile(path.join(b.root, "codes"), c.join("\n") + "\n")

/** Fake main: a zsh that sleeps, then writes its own $EPOCHREALTIME as its last act (so that time <= its death). */
async function fakeMain(b: Box, seconds: number) {
  const proc = Bun.spawn(
    [
      "/bin/zsh",
      "-f",
      "-c",
      "zmodload zsh/datetime; /bin/sleep $1; print -r -- $EPOCHREALTIME > $2",
      "fake-main",
      String(seconds),
      path.join(b.root, "main.exit"),
    ],
    { stdout: "ignore", stderr: "ignore", env: { PATH: CHILD_PATH } },
  )
  await fs.writeFile(path.join(b.root, "main.pid"), String(proc.pid))
  return proc
}

const diedAt = async (b: Box) => Number((await fs.readFile(path.join(b.root, "main.exit"), "utf8")).trim())

const fast: HandoffTiming = { waitS: 20, maxAttempts: 3, retryDelayS: 0.1, pollS: 0.2 }

const viaModule = (b: Box, request: HandoffRequest, mainPid: number, timing: Partial<HandoffTiming> = {}) =>
  handoffSpawnArgs(
    request,
    { resourcesPath: b.res, userData: b.ud, home: b.home },
    { mainPid, relaunchTool: b.relaunch, timing: { ...fast, ...timing } },
  )

const raw = (b: Box, values: string[]): HandoffSpawn => ({
  command: "/bin/zsh",
  args: ["-f", "-c", HANDOFF_SCRIPT, "swarm-update-handoff", ...values],
  options: { env: { HOME: b.home, PATH: CHILD_PATH, LC_ALL: "C" } },
})

/** HO-00 per spawn: every absolute value under T, none under /Applications or the real home, relaunch = the stub. */
function guard(b: Box, s: HandoffSpawn) {
  const env = s.options.env as Record<string, string>
  const values = [...s.args.slice(4), env.HOME!]
  if (s.command !== "/bin/zsh" || s.args[2] !== HANDOFF_SCRIPT) throw new Error("HO-00: not the handoff wrapper")
  if (values.includes("/usr/bin/open") || s.args[7] !== b.relaunch || !b.relaunch.startsWith(b.root + "/"))
    throw new Error(`HO-00: relaunch tool is not the stub in T: ${s.args[7]}`)
  if (env.HOME !== b.home) throw new Error(`HO-00: HOME is not <T>/home: ${env.HOME}`)
  for (const v of values) {
    if (forbidden(v)) throw new Error(`HO-00: ${v}`)
    if (v.startsWith("/") && v !== "/bin/zsh" && v !== "/bin/sh" && !v.startsWith(b.root + "/"))
      throw new Error(`HO-00: path outside T: ${v}`)
  }
}

function spawnWrapper(b: Box, s: HandoffSpawn) {
  guard(b, s)
  const proc = Bun.spawn([s.command, ...s.args], {
    env: s.options.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => ({ code, stdout, stderr, end: Date.now() / 1000 }),
  )
  return { proc, done }
}

const wrapper = (b: Box, s: HandoffSpawn) => spawnWrapper(b, s).done

type Call = { n: number; t: number; main: string; pid: number; chain: number[] }

async function calls(b: Box): Promise<Call[]> {
  const file = path.join(b.root, "applier.log")
  if (!(await exists(file))) return []
  return (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const m = line.match(/^n=(\d+) t=([0-9.]+) main=(alive|dead) pid=(\d+) chain=(.*)$/)
      if (!m) throw new Error(`bad applier.log line: ${line}`)
      return {
        n: Number(m[1]),
        t: Number(m[2]),
        main: m[3]!,
        pid: Number(m[4]),
        chain: m[5]!.trim().split(" ").filter(Boolean).map(Number),
      }
    })
}

async function relaunches(b: Box) {
  const file = path.join(b.root, "relaunch.log")
  if (!(await exists(file))) return []
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ t: Number(line.slice(0, line.indexOf(" "))), argv: line.slice(line.indexOf(" ") + 1) }))
}

async function resultHead(b: Box) {
  const text = await fs.readFile(b.result, "utf8")
  return { head: text.split("\n").slice(0, 5), text }
}

const head = (action: string, outcome: string, attempts: number, exit: string) => [
  "handoff_format=1",
  `handoff_action=${action}`,
  `handoff_outcome=${outcome}`,
  `handoff_attempts=${attempts}`,
  `handoff_exit=${exit}`,
]

/** B-F2: every applier call saw the main PID dead and started at or after the time main wrote just before dying. */
async function afterMain(b: Box, list: Call[]) {
  const died = await diedAt(b)
  expect(list.length).toBeGreaterThan(0)
  for (const c of list) expect({ n: c.n, main: c.main, afterDeath: c.t >= died }).toEqual({
    n: c.n,
    main: "dead",
    afterDeath: true,
  })
  return died
}

/** Exactly one relaunch, with the given argv, after the last applier call (when any ran). */
async function relaunchedOnce(b: Box, argv: string, list: Call[] = []) {
  const r = await relaunches(b)
  expect(r.map((x) => x.argv)).toEqual([argv])
  if (list.length) expect(r[0]!.t).toBeGreaterThan(list[list.length - 1]!.t)
  return r[0]!
}

/** Waits until `pgrep -lf` shows `pid` with `needle` in its argv (the wrapper sees processes the same way). */
async function visible(pid: number, needle: string) {
  for (let i = 0; i < 100; i++) {
    const r = await run(["/usr/bin/pgrep", "-lf", "."])
    if (r.stdout.split("\n").some((line) => line.startsWith(`${pid} `) && line.includes(needle))) return
    await Bun.sleep(50)
  }
  throw new Error(`process not visible in pgrep -lf: ${needle}`)
}

/** Pattern process (row 57 note): `/bin/sh -c 'sleep N; :' <path>` keeps the path in argv (no exec into sleep). */
async function patternProcess(argv: string[], needle: string) {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", env: { PATH: CHILD_PATH } })
  try {
    await visible(proc.pid, needle)
  } catch (error) {
    proc.kill()
    await proc.exited
    throw error
  }
  return proc
}

/**
 * Counts the wrapper's retry sleeps (`/bin/sleep <delay>`, a direct child of the wrapper between attempts) and returns
 * the time each new one was first seen, stopping at `count` or when the wrapper exits.
 */
async function retrySleeps(wrapperPid: number, delay: string, count: number, done: Promise<unknown>) {
  let finished = false
  void done.then(() => (finished = true))
  const seen = new Set<string>()
  const times: number[] = []
  const deadline = Date.now() + 60_000
  while (!finished && Date.now() < deadline) {
    const r = await run(["/usr/bin/pgrep", "-P", String(wrapperPid), "-f", `^/bin/sleep ${delay.replace(".", "\\.")}$`])
    for (const pid of r.stdout.split("\n").filter(Boolean))
      if (!seen.has(pid)) {
        seen.add(pid)
        times.push(Date.now() / 1000)
      }
    if (seen.size >= count) break
    await Bun.sleep(30)
  }
  return times
}

const swarmRelease = async (app: string) =>
  (await must(["/usr/bin/plutil", "-extract", "SwarmRelease", "raw", path.join(app, "Contents", "Info.plist")])).stdout.trim()

const pkgPath = (b: Box) => path.join(b.root, "in", "p.swarmpatch")
const apply = (b: Box): HandoffRequest => ({ action: "apply", packagePath: pkgPath(b), acceptForwardMigration: false })

beforeAll(() => requireProcessList("handoff-e2e.test.ts"))

test("HO-00 guard: fixture HOME and TMPDIR, no /Applications, no real home, no /usr/bin/open", () => {
  expect(path.isAbsolute(REAL_HOME)).toBe(true)
  expect(process.env.HOME === REAL_HOME).toBe(false)
  const tmp = process.env.TMPDIR ?? ""
  expect({ tmpAbsolute: path.isAbsolute(tmp), tmpForbidden: forbidden(tmp + "/") }).toEqual({
    tmpAbsolute: true,
    tmpForbidden: false,
  })
  // The wrapper runs only "$relaunch"; the literal default lives in the module's TS, never in the zsh text.
  expect(HANDOFF_SCRIPT.includes("/usr/bin/open")).toBe(false)
  expect(HANDOFF_SCRIPT.includes("/Applications")).toBe(false)
})

test("HO-01 zsh -n, HO-02 no dynamic execution, HO-20 no line reads as a pgrep PID line", () =>
  withBox(async (b) => {
    const file = path.join(b.root, "h.zsh")
    await fs.writeFile(file, HANDOFF_SCRIPT)
    expect((await run(["/bin/zsh", "-n", file])).code).toBe(0)
    const lines = HANDOFF_SCRIPT.split("\n")
    expect(lines.filter((l) => /(^|[;&| ])(eval|source|\.) /.test(l))).toEqual([])
    expect(HANDOFF_SCRIPT.includes("${~")).toBe(false)
    expect(lines.filter((l) => /^[1-9][0-9]{0,6}( |$)/.test(l))).toEqual([])
  }))

test("HO-03/HO-14/HO-15: startApplyHandoff from a main that quits; applier only after main died, never its child", () =>
  withBox(async (b) => {
    const main = path.join(b.root, "main.ts")
    const pkgFile = pkgPath(b)
    for (const v of [b.res, b.ud, b.home, b.relaunch, pkgFile]) expect(v.startsWith(b.root + "/") && !forbidden(v)).toBe(true)
    await fs.writeFile(
      main,
      [
        'import { appendFileSync, writeFileSync } from "node:fs"',
        `import { startApplyHandoff } from ${JSON.stringify(MODULE)}`,
        "const [root, res, ud, home, relaunch, pkg] = process.argv.slice(2) as [string, string, string, string, string, string]",
        'if (!relaunch.startsWith(root + "/")) process.exit(3)',
        "const log = (level: string) => (message: string, meta?: unknown) =>",
        '  appendFileSync(root + "/main.log", JSON.stringify({ level, message, meta }) + "\\n")',
        'writeFileSync(root + "/main.pid", String(process.pid))',
        "await startApplyHandoff({ packagePath: pkg, acceptForwardMigration: false }, { resourcesPath: res, userData: ud, home }, {",
        "  relaunchTool: relaunch,",
        "  timing: { waitS: 20, maxAttempts: 3, retryDelayS: 0.2, pollS: 0.2 },",
        '  logger: { log: log("info"), error: log("error") },',
        "})",
        "await Bun.sleep(1500)",
        'writeFileSync(root + "/main.exit", String(Date.now() / 1000))',
        "process.exit(0)",
      ].join("\n") + "\n",
    )
    const proc = Bun.spawn([process.execPath, main, b.root, b.res, b.ud, b.home, b.relaunch, pkgFile], {
      stdout: "ignore",
      stderr: "pipe",
      env: { HOME: b.home, PATH: CHILD_PATH, TMPDIR: process.env.TMPDIR! },
    })
    const mainPid = proc.pid
    expect({ code: await proc.exited, stderr: await new Response(proc.stderr).text() }).toEqual({ code: 0, stderr: "" })
    const log = (await fs.readFile(path.join(b.root, "main.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l))
    expect(log.map((l) => [l.level, l.message])).toEqual([["info", "swarm-patch handoff started"]])
    const wrapperPid = log[0].meta.pid as number
    // HO-14: the wrapper outlives its parent; wait for it to finish on its own.
    for (let i = 0; i < 300 && !(await exists(path.join(b.root, "relaunch.log"))); i++) await Bun.sleep(100)
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(wrapperPid, 0)
      } catch {
        break
      }
      await Bun.sleep(100)
    }
    const list = await calls(b)
    expect(list.length).toBe(1)
    const died = await afterMain(b, list)
    // HO-15: the main PID is not in the applier's ancestor chain.
    expect(list[0]!.chain.includes(mainPid)).toBe(false)
    expect(list[0]!.chain.includes(wrapperPid)).toBe(true)
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 1, "0"))
    const r = await relaunchedOnce(b, b.target, list)
    expect(r.t).toBeGreaterThan(died)
  }))

test("HO-04: main never exits within wait: main_alive, applier not run, relaunch once", () =>
  withBox(async (b) => {
    const main = await fakeMain(b, 30)
    try {
      const start = Date.now() / 1000
      const w = await wrapper(b, viaModule(b, apply(b), main.pid, { waitS: 2, pollS: 0.2 }))
      expect(w.code).toBe(0)
      expect(w.end - start).toBeGreaterThanOrEqual(2)
      expect((await resultHead(b)).head).toEqual(head("apply", "main_alive", 0, ""))
      expect(await calls(b)).toEqual([])
      await relaunchedOnce(b, b.target)
    } finally {
      main.kill()
      await main.exited
    }
  }))

test("HO-05 then HO-09 (real applier): E_RUNNING twice, applied on attempt 3; then rollback restores the old app", () =>
  withEnv(async (e) => {
    await writeRelaunch(e.root)
    const target = await installApp(e)
    const b = layout(e.root, e.home, target)
    await fs.mkdir(b.ud, { recursive: true })
    const p = await pkg(e, await buildApp(e, { release: "1.1.1" }))
    expect(await swarmRelease(target)).toBe("1.1.0")
    // A lingering helper under the target makes the applier's own check (5.7) return E_RUNNING (exit 20); the
    // wrapper's busy check does not cover Contents/Frameworks/, so it runs the applier and retries.
    const h = await holder(path.join(target, "Contents", "Frameworks", "Swarm Helper.app", "Contents", "MacOS", "Swarm Helper"))
    let killedAt = 0
    try {
      const main = await fakeMain(b, 0.5)
      const s = viaModule(b, { action: "apply", packagePath: p.path, acceptForwardMigration: false }, main.pid, {
        maxAttempts: 5,
        retryDelayS: 1.37,
      })
      const w = spawnWrapper(b, s)
      // Two retry sleeps = attempts 1 and 2 both exited 20. Stop the helper before attempt 3 starts.
      const sleeps = await retrySleeps(w.proc.pid, "1.37", 2, w.done)
      expect(sleeps.length).toBe(2)
      h.kill()
      await h.exited
      killedAt = Date.now() / 1000
      const done = await w.done
      expect(done.code).toBe(0)
      const died = await diedAt(b)
      expect(sleeps[0]!).toBeGreaterThan(died)
      const r = await resultHead(b)
      expect(r.head).toEqual(head("apply", "ran", 3, "0"))
      expect(r.text).toContain("result=applied")
      expect(await swarmRelease(target)).toBe("1.1.1")
      const relaunch = await relaunchedOnce(b, target)
      expect(relaunch.t).toBeGreaterThan(killedAt)
    } finally {
      if (!killedAt) {
        h.kill()
        await h.exited
      }
    }

    // HO-09: Undo through the handoff with the applier of the now-installed release.
    await fs.rename(path.join(e.root, "relaunch.log"), path.join(e.root, "relaunch.ho05.log"))
    await fs.rm(b.result)
    const main = await fakeMain(b, 0.5)
    const w = await wrapper(b, viaModule(b, { action: "rollback" }, main.pid))
    expect(w.code).toBe(0)
    const r = await resultHead(b)
    expect(r.head).toEqual(head("rollback", "ran", 1, "0"))
    expect(r.text).toContain("result=rolled_back")
    expect(await swarmRelease(target)).toBe("1.1.0")
    const relaunch = await relaunchedOnce(b, target)
    expect(relaunch.t).toBeGreaterThan(await diedAt(b))
  }))

test("HO-06: applier exits 20 on every attempt: limit reached, target unchanged, the old app is relaunched once", () =>
  withBox(async (b) => {
    await codes(b, 20)
    const before = await treeHash(b.target)
    const main = await fakeMain(b, 0.5)
    const w = await wrapper(b, viaModule(b, apply(b), main.pid, { maxAttempts: 3, retryDelayS: 0.1 }))
    expect(w.code).toBe(0)
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 3, "20"))
    const list = await calls(b)
    expect(list.map((c) => c.n)).toEqual([1, 2, 3])
    await afterMain(b, list)
    expect(await treeHash(b.target)).toBe(before)
    await relaunchedOnce(b, b.target, list)
  }))

// BN-70..BN-73 under both roots (spec 5.4, HO-07).
const patterns: { id: string; make: (r: string) => Promise<{ argv: string[]; needle: string }> }[] = [
  {
    id: "BN-70 swarm-cli/",
    make: async (r) => {
      const p = path.join(r, "Contents", "Resources", "swarm-cli", "swarm")
      return { argv: ["/bin/sh", "-c", "sleep 60; :", p], needle: p }
    },
  },
  {
    id: "BN-71 /bin/sh swarm-launcher",
    make: async (r) => {
      const p = path.join(r, "Contents", "Resources", "swarm-cli", "swarm-launcher")
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, "sleep 60; :\n")
      return { argv: ["/bin/sh", p], needle: `/bin/sh ${p}` }
    },
  },
  {
    id: "BN-72 swarm-setup/",
    make: async (r) => {
      const p = path.join(r, "Contents", "Resources", "swarm-setup", "install")
      return { argv: ["/bin/sh", "-c", "sleep 60; :", p], needle: p }
    },
  },
  {
    id: "BN-73 rg",
    make: async (r) => {
      const p = path.join(r, "Contents", "Resources", "rg")
      return { argv: ["/bin/sh", "-c", "sleep 60; :", p], needle: p }
    },
  },
]

for (const root of ["target", "previous"] as const)
  for (const pattern of patterns)
    test(`HO-07 ${pattern.id} under ${root}: still_running on every attempt, applier not run, relaunch once`, () =>
      withBox(async (b) => {
        const r = root === "target" ? b.target : path.join(b.home, ...PREVIOUS)
        const { argv, needle } = await pattern.make(r)
        const proc = await patternProcess(argv, needle)
        try {
          const main = await fakeMain(b, 0.3)
          const w = await wrapper(b, viaModule(b, apply(b), main.pid, { maxAttempts: 2, retryDelayS: 0.1 }))
          expect(w.code).toBe(0)
          expect((await resultHead(b)).head).toEqual(head("apply", "still_running", 2, ""))
          expect(await calls(b)).toEqual([])
          await relaunchedOnce(b, b.target)
        } finally {
          proc.kill()
          await proc.exited
        }
      }))

test("HO-07 variant: the matching process ends after attempt 1, attempt 2 runs the applier", () =>
  withBox(async (b) => {
    const p = path.join(b.target, "Contents", "Resources", "rg")
    const proc = await patternProcess(["/bin/sh", "-c", "sleep 60; :", p], p)
    let killed = false
    try {
      const main = await fakeMain(b, 0.3)
      const w = spawnWrapper(b, viaModule(b, apply(b), main.pid, { maxAttempts: 2, retryDelayS: 1.37 }))
      const sleeps = await retrySleeps(w.proc.pid, "1.37", 1, w.done)
      expect(sleeps.length).toBe(1)
      proc.kill()
      await proc.exited
      killed = true
      expect((await w.done).code).toBe(0)
      expect((await resultHead(b)).head).toEqual(head("apply", "ran", 2, "0"))
      const list = await calls(b)
      expect(list.length).toBe(1)
      await afterMain(b, list)
      await relaunchedOnce(b, b.target, list)
    } finally {
      if (!killed) {
        proc.kill()
        await proc.exited
      }
    }
  }))

test("HO-08: exit 14 is not retried; rollback action (stub) gets argv [rollback]", () =>
  withBox(async (b) => {
    await codes(b, 14)
    let main = await fakeMain(b, 0.3)
    expect((await wrapper(b, viaModule(b, apply(b), main.pid))).code).toBe(0)
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 1, "14"))
    let list = await calls(b)
    expect(list.length).toBe(1)
    await afterMain(b, list)
    await relaunchedOnce(b, b.target, list)

    // The rollback path with the stub: same wrapper, action rollback, one call, relaunch once.
    for (const f of ["relaunch.log", "applier.log", "applier.count"]) await fs.rm(path.join(b.root, f))
    await codes(b, 0)
    main = await fakeMain(b, 0.3)
    expect((await wrapper(b, viaModule(b, { action: "rollback" }, main.pid))).code).toBe(0)
    expect((await resultHead(b)).head).toEqual(head("rollback", "ran", 1, "0"))
    list = await calls(b)
    expect(list.length).toBe(1)
    await afterMain(b, list)
    expect((await fs.readFile(path.join(b.root, "argv.1"), "utf8")).split("\0").filter(Boolean)).toEqual(["rollback"])
    await relaunchedOnce(b, b.target, list)
  }))

test("HO-10: result file mode 600, no .new left, size capped although the applier prints 100000 bytes", () =>
  withBox(async (b) => {
    await fs.writeFile(path.join(b.root, "big"), "")
    const main = await fakeMain(b, 0.3)
    expect((await wrapper(b, viaModule(b, apply(b), main.pid))).code).toBe(0)
    const st = await fs.lstat(b.result)
    expect({ file: st.isFile(), mode: (st.mode & 0o777).toString(8) }).toEqual({ file: true, mode: "600" })
    expect(st.size).toBeLessThanOrEqual(HANDOFF_RESULT_MAX_BYTES)
    expect(st.size).toBeGreaterThanOrEqual(HANDOFF_OUTPUT_MAX_BYTES)
    expect(await exists(b.result + ".new")).toBe(false)
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 1, "0"))
    const list = await calls(b)
    await afterMain(b, list)
    await relaunchedOnce(b, b.target, list)
  }))

test("HO-11: result folder not writable: no result file, relaunch still exactly once", () =>
  withBox(async (b) => {
    await fs.chmod(b.ud, 0o500)
    const main = await fakeMain(b, 0.3)
    expect((await wrapper(b, viaModule(b, apply(b), main.pid))).code).toBe(0)
    await fs.chmod(b.ud, 0o700)
    expect(await fs.readdir(b.ud)).toEqual([])
    const list = await calls(b)
    await afterMain(b, list)
    await relaunchedOnce(b, b.target, list)
  }))

test("HO-12: hostile package path and a target with a space reach the applier byte for byte", () =>
  withBox(async (b) => {
    const hostile = path.join(b.root, "in", `a b '$(touch ${b.root}/pwned)'.swarmpatch`)
    const main = await fakeMain(b, 0.3)
    const request: HandoffRequest = { action: "apply", packagePath: hostile, acceptForwardMigration: false }
    expect((await wrapper(b, viaModule(b, request, main.pid))).code).toBe(0)
    expect(b.target).toBe(path.join(b.root, "apps", "x y", "Swarm.app"))
    const argv = (await fs.readFile(path.join(b.root, "argv.1"), "utf8")).split("\0")
    expect(argv).toEqual(["apply", hostile, ""])
    expect(await exists(path.join(b.root, "pwned"))).toBe(false)
    const list = await calls(b)
    await afterMain(b, list)
    await relaunchedOnce(b, b.target, list)
  }, "x y/Swarm.app"))

test("HO-13: W2 refusals exit 2 with no applier call, no result file and no relaunch", () =>
  withBox(async (b) => {
    const dead = Bun.spawn(["/usr/bin/true"])
    await dead.exited
    await fs.writeFile(path.join(b.root, "main.pid"), String(dead.pid))
    const pid = String(dead.pid)
    const t = ["20", "3", "0.1", "0.2"]
    const ok = ["/bin/zsh", "-f", b.applier, "apply", pkgPath(b)]
    const cases: Record<string, string[]> = {
      "pid abc": ["abc", b.target, b.result, b.relaunch, ...t, ...ok],
      "relative target": [pid, "apps/Swarm.app", b.result, b.relaunch, ...t, ...ok],
      "max 0": [pid, b.target, b.result, b.relaunch, "20", "0", "0.1", "0.2", ...ok],
      "applier argv without /bin/zsh": [pid, b.target, b.result, b.relaunch, ...t, "/bin/sh", ...ok.slice(1)],
      "action recover": [pid, b.target, b.result, b.relaunch, ...t, "/bin/zsh", "-f", b.applier, "recover"],
    }
    for (const [name, values] of Object.entries(cases)) {
      const w = await wrapper(b, raw(b, values))
      expect({
        name,
        code: w.code,
        calls: await calls(b),
        result: await exists(b.result),
        relaunch: await relaunches(b),
      }).toEqual({ name, code: 2, calls: [], result: false, relaunch: [] })
    }
  }))

test("HO-18 (D52-1): target gone after the applier: relaunch gets -e <result file>, never the backup", () =>
  withBox(async (b) => {
    await fs.writeFile(path.join(b.root, "remove-target"), "")
    const main = await fakeMain(b, 0.3)
    expect((await wrapper(b, viaModule(b, apply(b), main.pid))).code).toBe(0)
    expect(await exists(b.target)).toBe(false)
    expect(await exists(path.join(b.root, "gone", "Contents", "Resources", "swarm-patch", "swarm-patch"))).toBe(true)
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 1, "0"))
    const list = await calls(b)
    await afterMain(b, list)
    const r = await relaunchedOnce(b, `-e ${b.result}`, list)
    expect(r.argv.includes("previous")).toBe(false)
  }))

test("HO-19 (D52-6): links planted at <result>.new and at <result> are removed, never written through", () =>
  withBox(async (b) => {
    const victims = [path.join(b.root, "victim-new"), path.join(b.root, "victim-result")]
    for (const v of victims) await fs.writeFile(v, "KEEP\n", { mode: 0o644 })
    await fs.symlink(victims[0]!, b.result + ".new")
    await fs.symlink(victims[1]!, b.result)
    const main = await fakeMain(b, 0.3)
    expect((await wrapper(b, viaModule(b, apply(b), main.pid))).code).toBe(0)
    for (const v of victims) expect(await fs.readFile(v, "utf8")).toBe("KEEP\n")
    expect(await exists(b.result + ".new")).toBe(false)
    const st = await fs.lstat(b.result)
    expect({ file: st.isFile(), link: st.isSymbolicLink(), mode: (st.mode & 0o777).toString(8) }).toEqual({
      file: true,
      link: false,
      mode: "600",
    })
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 1, "0"))
    const list = await calls(b)
    await afterMain(b, list)
    await relaunchedOnce(b, b.target, list)
  }))

test("HO-21 (D52-7): applier outside the target is refused; a symlink resolving to the target's applier runs", () =>
  withBox(async (b) => {
    const outside = path.join(b.root, "bin", "applier-stub.zsh")
    await fs.copyFile(b.applier, outside)
    const link = path.join(b.root, "link", "swarm-patch")
    await fs.mkdir(path.dirname(link))
    await fs.symlink(b.applier, link)
    const t = ["20", "3", "0.1", "0.2"]

    let main = await fakeMain(b, 0.3)
    const refused = await wrapper(b, raw(b, [String(main.pid), b.target, b.result, b.relaunch, ...t, "/bin/zsh", "-f", outside, "apply", pkgPath(b)]))
    main.kill()
    await main.exited
    expect({ code: refused.code, calls: await calls(b), result: await exists(b.result), relaunch: await relaunches(b) }).toEqual({
      code: 2,
      calls: [],
      result: false,
      relaunch: [],
    })

    main = await fakeMain(b, 0.3)
    const accepted = await wrapper(b, raw(b, [String(main.pid), b.target, b.result, b.relaunch, ...t, "/bin/zsh", "-f", link, "apply", pkgPath(b)]))
    expect(accepted.code).toBe(0)
    expect((await resultHead(b)).head).toEqual(head("apply", "ran", 1, "0"))
    const list = await calls(b)
    expect(list.length).toBe(1)
    await afterMain(b, list)
    await relaunchedOnce(b, b.target, list)
  }))
