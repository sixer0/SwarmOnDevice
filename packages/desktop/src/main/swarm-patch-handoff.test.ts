import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  HANDOFF_OUTPUT_MAX_BYTES,
  HANDOFF_SCRIPT,
  createHandoffLauncher,
  handoffRequestFromArgv,
  handoffSpawnArgs,
  startHandoff,
} from "./swarm-patch-handoff"

// Row 57 unit checks. Runs in the agent sandbox: no pgrep-dependent case here (those are row 62, outside the sandbox).
// HO-00 / C25 (review row 31 L7): the real home comes from the account database, never from $HOME or $USER. Bun's
// os.homedir() returns $HOME and os.userInfo().username returns $USER, so the login name comes from `id -un` (the
// effective uid) and zsh `~<name>` (getpwnam) gives its home. The name is checked before it reaches the zsh text,
// so there is no eval and no other expansion.
function accountHome(env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }) {
  const user = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8", env }).stdout.trim()
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(user)) throw new Error(`HO-00: unexpected login name ${JSON.stringify(user)}`)
  const home = spawnSync("/bin/zsh", ["-f", "-c", `print -r -- ~${user}`], { encoding: "utf8", env })
    .stdout.trim()
  if (!isAbsolute(home) || home === "/" || home === "/var/empty") throw new Error(`HO-00: cannot read the account home (${home})`)
  return home
}
const realHome = accountHome()
const T = realpathSync(mkdtempSync(join(tmpdir(), "swarm-handoff-test-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const app = join(T, "apps", "Swarm.app")
const res = join(app, "Contents", "Resources")
const applier = join(res, "swarm-patch", "swarm-patch")
const ud = join(T, "ud")
const home = join(T, "home")
const relaunch = join(T, "bin", "relaunch")
for (const dir of [join(res, "swarm-patch"), ud, home, join(T, "bin")]) mkdirSync(dir, { recursive: true })
writeFileSync(applier, `print -r -- called >> ${JSON.stringify(join(T, "applier.log"))}\nexit 0\n`)
writeFileSync(relaunch, `#!/bin/zsh -f\nprint -r -- "$*" >> ${JSON.stringify(join(T, "relaunch.log"))}\n`)
chmodSync(relaunch, 0o755)
const paths = { resourcesPath: res, userData: ud, home }

// HO-00 guard: nothing here may point at /Applications or the real home, and relaunch must be the stub in T.
test("HO-00 guard", () => {
  for (const p of [app, ud, home, relaunch]) {
    expect(p.startsWith("/Applications/")).toBe(false)
    expect(p === realHome || p.startsWith(realHome + "/")).toBe(false)
  }
  expect(relaunch.startsWith(T)).toBe(true)
})

test("HO-00 guard does not follow $USER or $HOME (L7)", () => {
  // The lookup run with USER=nobody and HOME=/ must still give the account home of the effective uid.
  expect(accountHome({ PATH: "/usr/bin:/bin", USER: "nobody", HOME: "/" })).toBe(realHome)
  expect(realHome).not.toBe("/var/empty")
})

describe("HANDOFF_SCRIPT text", () => {
  test("HO-01 zsh -n exits 0", () => {
    const file = join(T, "h.zsh")
    writeFileSync(file, HANDOFF_SCRIPT)
    expect(spawnSync("/bin/zsh", ["-n", file]).status).toBe(0)
  })
  test("HO-02 no dynamic execution", () => {
    expect(HANDOFF_SCRIPT.split("\n").filter((l) => /(^|[;&| ])(eval|source|\.) /.test(l))).toEqual([])
    expect(HANDOFF_SCRIPT.includes("${~")).toBe(false)
  })
  test("HO-20 no line reads as a pgrep PID line", () => {
    expect(HANDOFF_SCRIPT.split("\n").filter((l) => /^[1-9][0-9]{0,6}( |$)/.test(l))).toEqual([])
  })
  // F-CP (C34, C35): Swarm's own crash handler is matched by two exact literals and stopped before every attempt.
  test("F-CP prefix and database literals, both roots, quoted comparison only", () => {
    const lines = HANDOFF_SCRIPT.split("\n")
    const body = lines.slice(lines.indexOf("stopcp() {"), lines.indexOf("}", lines.indexOf("stopcp() {")) + 1).join("\n")
    expect(body).toContain(
      '  local list r p line cpid cmd i=0 db=" --database=$HOME/Library/Application Support/id.co.gsp.swarm.desktop/Crashpad "; local -a exe pids left ok',
    )
    expect(body).toContain('for r in "$target" "$HOME/Library/Application Support/id.co.gsp.swarm.patch/previous/Swarm.app"; do')
    expect(body).toContain('exe+=( "$r/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler" )')
    // Begins with the prefix (quoted literal + *), holds the database argument (quoted literal between *).
    expect(body).toContain('[[ $cmd == "$p "* && " $cmd " == *"$db"* ]]; then cpok $cpid && pids+=( $cpid ); break; fi')
    expect(body).toContain("list=$(/usr/bin/pgrep -lf '.' 2>/dev/null); (( $? < 2 )) || return 0")
    expect(body).toContain("[[ $cpid != $$ ]] || continue")
    expect(body).toContain("kill -TERM $pids 2>/dev/null")
    expect(body).toContain("(( ${#left} && i < 10 )) || break")
    expect(body).toContain("/bin/sleep 0.5; (( i++ ))")
    expect(body).toContain("for p in $left; do cpok $p && ok+=( $p ); done")
    expect(body).toContain("(( ${#ok} )) && kill -KILL $ok 2>/dev/null")
    // No pattern flags or regex on the paths; the only regex is the pgrep line split.
    expect(body.includes("${~")).toBe(false)
    expect(body.match(/=~/g)?.length).toBe(1)
    expect(body.includes("(#")).toBe(false)
    // Only the collected pids are signalled.
    expect(body.split("\n").filter((l) => /\bkill\b/.test(l)).map((l) => l.trim())).toEqual([
      "kill -TERM $pids 2>/dev/null",
      "left=(); for p in $pids; do kill -0 $p 2>/dev/null && left+=( $p ); done",
      "(( ${#ok} )) && kill -KILL $ok 2>/dev/null",
    ])
  })
  // CP-1: a pgrep line is only a candidate (a same-user argv can forge one with a newline); each pid is re-read alone.
  test("CP-1 cpok re-reads each pid on its own: uid, exact comm, command prefix, whole database argument", () => {
    const lines = HANDOFF_SCRIPT.split("\n")
    const start = lines.indexOf("cpok() {")
    const body = lines.slice(start, lines.indexOf("}", start) + 1).map((l) => l.trim())
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(lines.indexOf("stopcp() {"))
    expect(body).toEqual([
      "cpok() {",
      "local r u x c",
      "[[ $1 =~ '^[1-9][0-9]{0,6}$' && $1 != $$ ]] || return 1",
      "u=$(/bin/ps -p $1 -o uid= 2>/dev/null) || return 1",
      "[[ $u =~ '^ *([0-9]+)$' && $match[1] == $UID ]] || return 1",
      "x=$(/bin/ps -ww -p $1 -o comm= 2>/dev/null) || return 1",
      "c=$(/bin/ps -ww -p $1 -o command= 2>/dev/null) || return 1",
      'for r in $exe; do [[ $x == "$r" && $c == "$r "* && " $c " == *"$db"* ]] && return 0; done',
      "return 1",
      "}",
    ])
    // Exactly the two call sites: every candidate before SIGTERM, every survivor before SIGKILL.
    const calls = lines.filter((l) => /\bcpok \$/.test(l)).map((l) => l.trim())
    expect(calls).toEqual([
      'for p in $exe; do if [[ $cmd == "$p "* && " $cmd " == *"$db"* ]]; then cpok $cpid && pids+=( $cpid ); break; fi; done',
      "for p in $left; do cpok $p && ok+=( $p ); done",
    ])
    // Single-pid queries only, no listing-wide ps, no glob or pattern flags on the paths.
    expect(body.filter((l) => l.includes("/bin/ps")).every((l) => l.includes("/bin/ps") && / -p \$1 -o /.test(l))).toBe(true)
    expect(body.join("\n").includes("${~")).toBe(false)
    expect(body.join("\n").includes("(#")).toBe(false)
  })
  test("F-CP runs after the main-dead wait and before every attempt, ahead of busy and the applier", () => {
    const lines = HANDOFF_SCRIPT.split("\n")
    const wait = lines.indexOf("while kill -0 $pid 2>/dev/null; do")
    const waitEnd = lines.indexOf("done", wait)
    const loop = lines.indexOf("  while (( attempts < max )); do")
    const inc = lines.indexOf("    (( attempts++ ))")
    const call = lines.indexOf("    stopcp")
    const busy = lines.findIndex((l) => l.startsWith("    if busy; then"))
    const applier = lines.findIndex((l) => l.includes('out=$("$@" 2>&1)'))
    expect(lines.filter((l) => l.trim() === "stopcp")).toHaveLength(1)
    expect(wait).toBeGreaterThan(lines.indexOf("stopcp() {"))
    expect([wait < waitEnd, waitEnd < loop, loop < inc, inc + 1 === call, call + 1 === busy, busy <= applier]).toEqual([
      true, true, true, true, true, true,
    ])
  })
  test("F-CP result line follows the five handoff_* lines", () => {
    expect(HANDOFF_SCRIPT).toContain(
      "print -r -- handoff_attempts=$attempts; print -r -- handoff_exit=$rc; print -r -- handoff_crashpad_stopped=$cpn",
    )
    expect(HANDOFF_SCRIPT).toContain("action=$4 outcome='' attempts=0 rc='' out='' n=0 cpn=0")
  })
  test("output cap literal equals HANDOFF_OUTPUT_MAX_BYTES", () => {
    expect(HANDOFF_SCRIPT.includes(`\${out[1,${HANDOFF_OUTPUT_MAX_BYTES}]}`)).toBe(true)
  })
})

function fakeChild(event: "spawn" | "error") {
  const child = new EventEmitter() as EventEmitter & { unref: () => void; pid: number; unrefs: number }
  child.unrefs = 0
  child.pid = 4242
  child.unref = () => void child.unrefs++
  queueMicrotask(() =>
    event === "spawn" ? child.emit("spawn") : child.emit("error", Object.assign(new Error("x"), { code: "EACCES" })),
  )
  return child
}

describe("launcher", () => {
  test("UM-11 shape: argv, options, env, unref after spawn, quit once", async () => {
    const calls: { command: string; args: readonly string[]; options: unknown }[] = []
    let child: ReturnType<typeof fakeChild> | undefined
    let quits = 0
    const launch = createHandoffLauncher(paths, {
      mainPid: 123,
      relaunchTool: relaunch,
      quit: () => void quits++,
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        child = fakeChild("spawn")
        return child as unknown as ChildProcess
      },
    })
    const pkg = join(T, "in", "a b.swarmpatch")
    expect(await launch(["/bin/zsh", "-f", applier, "apply", "--accept-forward-migration", pkg])).toEqual({ ok: true })
    expect(calls[0]!.command).toBe("/bin/zsh")
    expect(calls[0]!.args).toEqual([
      "-f", "-c", HANDOFF_SCRIPT, "swarm-update-handoff", "123", app, join(ud, "swarm-patch-result"), relaunch,
      "60", "10", "2", "0.5", "/bin/zsh", "-f", applier, "apply", "--accept-forward-migration", pkg,
    ])
    expect(calls[0]!.options).toEqual({ detached: true, stdio: "ignore", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } })
    expect(child!.unrefs).toBe(1)
    expect(quits).toBe(1)
  })

  test("spawn error: ok false with code, no unref, no quit, logged", async () => {
    let child: ReturnType<typeof fakeChild> | undefined
    let quits = 0
    const errors: unknown[] = []
    const launch = createHandoffLauncher(paths, {
      relaunchTool: relaunch,
      quit: () => void quits++,
      logger: { log: () => {}, error: (_m, meta) => void errors.push(meta) },
      spawn: () => (child = fakeChild("error")) as unknown as ChildProcess,
    })
    expect(await launch(["/bin/zsh", "-f", applier, "rollback"])).toEqual({ ok: false, code: "EACCES" })
    expect(child!.unrefs).toBe(0)
    expect(quits).toBe(0)
    expect(errors.length).toBe(1)
  })

  test("bad applier argv is refused before spawn", async () => {
    let spawned = 0
    const launch = createHandoffLauncher(paths, { quit: () => {}, spawn: () => (spawned++, fakeChild("spawn")) as unknown as ChildProcess })
    for (const argv of [
      ["/bin/zsh", "-f", applier, "recover"],
      ["/bin/zsh", "-f", "/tmp/other/swarm-patch", "rollback"],
      ["/bin/zsh", "-f", applier, "apply", "--accept-new-key", "/x.swarmpatch"],
      ["/bin/zsh", "-f", applier, "apply", "relative.swarmpatch"],
    ])
      expect(await launch(argv)).toEqual({ ok: false, code: "EINVAL" })
    expect(spawned).toBe(0)
    expect(handoffRequestFromArgv(["/bin/zsh", "-f", applier, "rollback"], applier)).toEqual({ action: "rollback" })
  })
})

function runWrapper(mainPid: string, extra: { applierPath?: string; action?: string } = {}) {
  rmSync(join(T, "relaunch.log"), { force: true })
  rmSync(join(T, "applier.log"), { force: true })
  const { args, options } = handoffSpawnArgs({ action: "rollback" }, paths, {
    relaunchTool: relaunch,
    mainPid: 1,
    timing: { waitS: 0.4, pollS: 0.1, retryDelayS: 0.1, maxAttempts: 2 },
  })
  args[4] = mainPid
  if (extra.applierPath) args[14] = extra.applierPath
  if (extra.action) args[15] = extra.action
  return spawnSync("/bin/zsh", args, { env: options.env as NodeJS.ProcessEnv })
}

describe("wrapper in the sandbox", () => {
  test("HO-04 main alive: main_alive, attempts 0, applier not run, relaunch once, mode 600", () => {
    const main = Bun.spawn(["/bin/sleep", "30"])
    const run = runWrapper(String(main.pid))
    main.kill()
    expect(run.status).toBe(0)
    const result = readFileSync(join(ud, "swarm-patch-result"), "utf8")
    expect(result).toBe("handoff_format=1\nhandoff_action=rollback\nhandoff_outcome=main_alive\nhandoff_attempts=0\nhandoff_exit=\nhandoff_crashpad_stopped=0\n")
    expect(statSync(join(ud, "swarm-patch-result")).mode & 0o777).toBe(0o600)
    expect(existsSync(join(T, "applier.log"))).toBe(false)
    expect(readFileSync(join(T, "relaunch.log"), "utf8")).toBe(`${app}\n`)
  })

  test("HO-21 / D52-7: applier outside the target is refused with exit 2, no result, no relaunch", () => {
    rmSync(join(ud, "swarm-patch-result"), { force: true })
    const other = join(T, "other", "swarm-patch")
    mkdirSync(join(T, "other"), { recursive: true })
    writeFileSync(other, "exit 0\n")
    const run = runWrapper("9999999", { applierPath: other })
    expect(run.status).toBe(2)
    expect(existsSync(join(ud, "swarm-patch-result"))).toBe(false)
    expect(existsSync(join(T, "relaunch.log"))).toBe(false)
  })

  test("HO-13 subset: bad PID and bad action exit 2", () => {
    expect(runWrapper("abc").status).toBe(2)
    expect(runWrapper("9999999", { action: "recover" }).status).toBe(2)
    expect(existsSync(join(T, "relaunch.log"))).toBe(false)
  })

  // Row 32 N-3: only the exact BN-61 shapes pass W2. Every other applier argv exits 2 before the applier, the result
  // file or the relaunch. PID 9999999 does not exist, so an accepted argv goes on to W4 (and pgrep, which the sandbox
  // refuses, makes it still_running); a refused one stops at W2.
  test("N-3: W2 accepts exactly the BN-61 applier argv shapes", () => {
    const pkg = join(T, "in", "p.swarmpatch")
    const base = (applierArgv: string[]) => {
      const { args } = handoffSpawnArgs({ action: "rollback" }, paths, {
        relaunchTool: relaunch,
        mainPid: 9999999,
        timing: { waitS: 0.4, pollS: 0.1, retryDelayS: 0.1, maxAttempts: 1 },
      })
      return [...args.slice(0, 12), ...applierArgv]
    }
    const run = (applierArgv: string[]) => {
      rmSync(join(T, "relaunch.log"), { force: true })
      rmSync(join(ud, "swarm-patch-result"), { force: true })
      const r = spawnSync("/bin/zsh", base(applierArgv), { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } })
      return { status: r.status, result: existsSync(join(ud, "swarm-patch-result")), relaunch: existsSync(join(T, "relaunch.log")) }
    }
    const z = ["/bin/zsh", "-f", applier]
    const refused = {
      "rollback + extra": [...z, "rollback", "--accept-new-key"],
      "rollback + package": [...z, "rollback", pkg],
      "apply without package": [...z, "apply"],
      "apply + new-key option": [...z, "apply", "--accept-new-key", pkg],
      "apply + two options": [...z, "apply", "--accept-forward-migration", "--accept-new-key", pkg],
      "apply + trailing option": [...z, "apply", pkg, "--accept-new-key"],
      "apply relative package": [...z, "apply", "p.swarmpatch"],
      "apply wrong suffix": [...z, "apply", join(T, "in", "p.zip")],
      "apply package with LF": [...z, "apply", join(T, "in", "a\nb.swarmpatch")],
      "forward option as package": [...z, "apply", "--accept-forward-migration"],
    }
    for (const [name, argv] of Object.entries(refused))
      expect({ name, ...run(argv) }).toEqual({ name, status: 2, result: false, relaunch: false })
    for (const argv of [[...z, "rollback"], [...z, "apply", pkg], [...z, "apply", "--accept-forward-migration", pkg]])
      expect(run(argv)).toEqual({ status: 0, result: true, relaunch: true })
  })

  test("D-2: a non-ASCII target and home pass W2; the relaunch gets the target byte for byte", () => {
    const app2 = join(T, "Aplikasi \u00dcnduhan", "Swarm.app")
    const res2 = join(app2, "Contents", "Resources")
    const home2 = join(T, "h\u00f6me")
    mkdirSync(join(res2, "swarm-patch"), { recursive: true })
    mkdirSync(home2, { recursive: true })
    writeFileSync(join(res2, "swarm-patch", "swarm-patch"), "exit 0\n")
    rmSync(join(T, "relaunch.log"), { force: true })
    rmSync(join(ud, "swarm-patch-result"), { force: true })
    const { args, options } = handoffSpawnArgs({ action: "rollback" }, { resourcesPath: res2, userData: ud, home: home2 }, {
      relaunchTool: relaunch,
      mainPid: 9999999,
      timing: { waitS: 0.4, pollS: 0.1, retryDelayS: 0.1, maxAttempts: 1 },
    })
    const run = spawnSync("/bin/zsh", args, { env: options.env as NodeJS.ProcessEnv })
    expect(run.status).toBe(0)
    expect(existsSync(join(ud, "swarm-patch-result"))).toBe(true)
    expect(readFileSync(join(T, "relaunch.log"))).toEqual(Buffer.from(`${app2}\n`))
  })

  test("N-1: the result move replaces a link planted at the result path, never writes into its directory", () => {
    expect(HANDOFF_SCRIPT).toContain('/bin/mv -f -h -- "$new" "$result"')
    // The same mv form on a link to a directory (the race the absence check cannot close).
    const dir = join(T, "n1")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, "elsewhere"), { recursive: true })
    writeFileSync(join(dir, "new"), "x\n")
    symlinkSync(join(dir, "elsewhere"), join(dir, "result"))
    expect(spawnSync("/bin/mv", ["-f", "-h", "--", join(dir, "new"), join(dir, "result")]).status).toBe(0)
    expect(lstatSync(join(dir, "result")).isFile()).toBe(true)
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([])
  })
})
