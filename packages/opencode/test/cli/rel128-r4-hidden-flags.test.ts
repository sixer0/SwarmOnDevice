// 1.2.8 row 36c, AC-R4 (R-4, PROBE, green expected; N8-319). The hidden `swarm run` flags `--yolo` and
// `--dangerously-skip-permissions` (and their twins on the TUI command) are probed for three things:
//   1. they resolve to the same run options as `--auto`, differing only in the flag's own name;
//   2. under the person's consent (the autonomy "bypass" layer, root and subagent) `sudo ls`, `git reset --hard`,
//      `git push --force`, a write into Swarm's app state and a person-only own-server route stay class X, and the
//      flags have no path into that verdict: `auto` only answers a published ask with "once", and an X call is
//      refused before any ask is published (permission/index.ts `refusedBy`);
//   3. from an agent: the CLI cannot switch the autonomy mode (`swarm autonomy …` is X), a `swarm run --attach` to the
//      running server is X own_api, and (sub-case R4-AGENT) a nested `swarm run` carrying an auto-answer flag is not
//      run without a person under the consent. R4-AGENT is RED at BASE and HEAD and is kept as `test.todo` with its
//      body for the permission-lane coder row the controller opens (driver rules, plan §2 rule 3).
// Synthetic values only: no server is contacted, no session runs, home is a fresh mkdtemp folder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import yargs from "yargs"
import { Global } from "@opencode-ai/core/global"
import { PERMISSION_BASELINE } from "@opencode-ai/core/swarm-permission-baseline"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { RunCommand } from "../../src/cli/cmd/run"
import { Permission } from "../../src/permission"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const HIDDEN = ["--yolo", "--dangerously-skip-permissions"] as const
const FLAG_KEYS = new Set(["auto", "yolo", "dangerously-skip-permissions", "dangerouslySkipPermissions"])
const PORT = 47319
const SELF = { hostname: "127.0.0.1", port: PORT }
const OWN = `http://127.0.0.1:${PORT}`
const SRC = path.join(import.meta.dir, "..", "..", "src")
const TUI_SRC = path.join(import.meta.dir, "..", "..", "..", "tui", "src")

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
})
afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "r4h-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  SelfAddress.add(SELF)
})
afterEach(() => {
  SelfAddress.remove(SELF)
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
})

// --- 1. the resolved options ------------------------------------------------------------------------------------

/** What yargs hands the `run` handler for these words, with the flag's own keys and yargs' bookkeeping removed. */
const resolved = (argv: string[]) => {
  let seen: Record<string, unknown> | undefined
  yargs(argv)
    .command({
      command: RunCommand.command as string,
      builder: RunCommand.builder as never,
      handler: (args) => {
        seen = args as Record<string, unknown>
      },
    })
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message)
    })
    .parseSync()
  if (!seen) throw new Error(`run did not resolve for ${argv.join(" ")}`)
  return seen
}
const withoutFlag = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).filter(([key]) => !FLAG_KEYS.has(key) && key !== "$0"))
/** The `auto` value run.ts:281 and tui.ts:349 compute from the parsed flags (the expression is pinned in section 2). */
const autoOf = (args: Record<string, unknown>) =>
  Boolean(args.auto || args.yolo || args["dangerously-skip-permissions"])

describe("R4-OPTIONS: the hidden flags resolve to the options of --auto", () => {
  test("same options as --auto apart from the flag's own name, for a plain run, --format json and --attach", () => {
    for (const rest of [["run", "hello"], ["run", "--format", "json", "hello"], ["run", "--attach", "http://127.0.0.1:1", "hi"]]) {
      const auto = resolved([...rest, "--auto"])
      expect(autoOf(auto)).toBe(true)
      for (const flag of HIDDEN) {
        const hidden = resolved([...rest, flag])
        expect({ flag, rest, auto: autoOf(hidden), options: withoutFlag(hidden) }).toEqual({
          flag,
          rest,
          auto: true,
          options: withoutFlag(auto),
        })
      }
    }
  })
  test("no flag, and the hidden flags set to false, resolve to auto off", () => {
    expect(autoOf(resolved(["run", "hello"]))).toBe(false)
    for (const flag of HIDDEN) expect(autoOf(resolved(["run", "hello", `${flag}=false`]))).toBe(false)
  })
  test("the hidden flags are declared hidden, boolean, default false, on run and on the TUI command", () => {
    for (const file of ["cli/cmd/run.ts", "cli/cmd/tui.ts"]) {
      const text = readFileSync(path.join(SRC, file), "utf8")
      for (const name of ["yolo", "dangerously-skip-permissions"]) {
        const block = text.match(new RegExp(`\\.option\\("${name}", \\{([^}]*)\\}\\)`))?.[1] ?? ""
        expect({ file, name, hidden: /hidden: true/.test(block), boolean: /type: "boolean"/.test(block), off: /default: false/.test(block) }).toEqual({
          file,
          name,
          hidden: true,
          boolean: true,
          off: true,
        })
      }
    }
  })
})

// --- 2. where the flags go ----------------------------------------------------------------------------------------

/** Code lines only: line comments dropped, so a comment that names a flag is not read as a use. */
const codeLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line, index) => ({ line: line.replace(/\/\/.*$/, "").trim(), at: `${path.basename(file)}:${index + 1}` }))
    .filter((entry) => entry.line.length > 0)

const sourceFiles = (root: string) =>
  [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root, absolute: true })].filter((file) => !file.includes("node_modules"))

describe("R4-WIRING: a hidden flag only feeds `auto`, and `auto` only answers a published ask with once", () => {
  test("run.ts and tui.ts read the hidden flags in one expression each, `args.auto || args.yolo || …`", () => {
    for (const file of ["cli/cmd/run.ts", "cli/cmd/tui.ts"]) {
      const reads = codeLines(path.join(SRC, file)).filter(({ line }) => /args\.yolo|args\[["']dangerously-skip-permissions["']\]|args\.dangerouslySkipPermissions/.test(line))
      expect({ file, reads: reads.length }).toEqual({ file, reads: 1 })
      expect(reads[0]!.line).toMatch(/auto\s*[:=]\s*args\.auto \|\| args\.yolo \|\| args\["dangerously-skip-permissions"\],?$/)
    }
  })
  test("no other file of opencode or the TUI reads the hidden flags (by any spelling)", () => {
    const readers: string[] = []
    for (const root of [SRC, TUI_SRC])
      for (const file of sourceFiles(root)) {
        const rel = path.relative(SRC, file)
        if (rel === path.join("cli", "cmd", "run.ts") || rel === path.join("cli", "cmd", "tui.ts")) continue
        for (const { line, at } of codeLines(file))
          if (/\byolo\b|dangerously-skip-permissions|dangerouslySkipPermissions/i.test(line)) readers.push(`${at}: ${line}`)
      }
    expect(readers).toEqual([])
  })
  test("run.ts uses `auto` once: answering a published ask with once, never for spend_limit/doom_loop, never always", () => {
    const lines = codeLines(path.join(SRC, "cli/cmd/run.ts"))
    const uses = lines.filter(({ line }) => /(?<![\w."'-])auto(?![\w"'-])/.test(line) && !/^auto:/.test(line))
    expect(uses.map(({ line }) => line)).toEqual([
      'const auto = args.auto || args.yolo || args["dangerously-skip-permissions"]',
      "if (auto && !needsPerson(permission.permission)) {",
    ])
    const text = readFileSync(path.join(SRC, "cli/cmd/run.ts"), "utf8")
    const branch = text.slice(text.indexOf("if (auto && !needsPerson(permission.permission)) {"))
    expect(branch.slice(0, branch.indexOf("} else {"))).toMatch(/reply: "once"/)
    expect(text).not.toMatch(/reply:\s*"always"/)
    // Nothing in run.ts changes the autonomy mode or the consent.
    expect(codeLines(path.join(SRC, "cli/cmd/run.ts")).filter(({ line }) => /autonomy|consent|bypass/i.test(line))).toEqual([])
  })
  test("the TUI's auto mode answers asks with once and leaves spend_limit/doom_loop to a person; it sets no server mode", () => {
    const sync = readFileSync(path.join(TUI_SRC, "context/sync.tsx"), "utf8")
    const branch = sync.slice(sync.indexOf('if (permission.mode === "auto" && !needsPerson(request.permission)) {'))
    expect(branch.length).toBeLessThan(sync.length)
    expect(branch.slice(0, branch.indexOf("break"))).toMatch(/reply: "once"/)
    const mode = readFileSync(path.join(TUI_SRC, "context/permission.tsx"), "utf8")
    expect(mode).not.toMatch(/sdk|autonomy|consent|fetch\(/)
  })
  test("needsPerson keeps spend_limit and doom_loop for a person", async () => {
    const { needsPerson } = await import("@opencode-ai/core/permission/needs-person")
    expect([needsPerson("spend_limit"), needsPerson("doom_loop"), needsPerson("bash")]).toEqual([true, true, false])
  })
})

// --- 3. the listed calls stay X ------------------------------------------------------------------------------------

const request = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: ["*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})
const bash = (command: string) => request("bash", { patterns: [command], metadata: { command } })
const consented = (input: Input): [string, Verdict][] => [
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
  ["consent-subagent", AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })],
]
const every = (input: Input): [string, Verdict][] => [["base", AutonomyTable.classify(input)], ...consented(input)]
const expectX = (layers: [string, Verdict][], call: string, category: string) => {
  for (const [layer, verdict] of layers)
    expect({ call, layer, class: verdict.class as string, category: verdict.category as string | undefined }).toEqual({ call, layer, class: "X", category })
}
const appStateWrite = () => `echo x > ${path.join(Global.Path.config, "tool-health.json")}`

describe("R4-X: under the bypass every listed call is X, and no input of the verdict comes from the CLI flags", () => {
  test("sudo ls, git reset --hard, git push --force: X under the consent, root and subagent (CHAR-07, CHAR-08)", () => {
    expectX(consented(bash("sudo ls")), "sudo ls", "admin_rights")
    expectX(consented(bash("git reset --hard")), "git reset --hard", "irreversible")
    expectX(consented(bash("git push --force")), "git push --force", "irreversible")
  })
  test("a write into app state: X app_state in every layer (CHAR-06)", () => {
    expectX(every(bash(appStateWrite())), "app-state write", "app_state")
  })
  test("person-only own-server routes: X own_api in every layer (CHAR-U10b)", () => {
    for (const command of [
      `curl -s -X PUT ${OWN}/autonomy/mode -d '{"on":true}'`,
      `curl -s -X POST ${OWN}/permission/per_1/reply -d '{"reply":"always"}'`,
      `curl -s -X POST ${OWN}/session/ses_1/shell -d '{"command":"ls"}'`,
      `curl -s -X POST ${OWN}/tui/submit-prompt`,
    ])
      expectX(every(bash(command)), command, "own_api")
  })
  test("with the mode off, sudo is denied by the shipped baseline, so no ask exists for --auto/--yolo to answer", () => {
    const ruleset = Permission.fromConfig(PERMISSION_BASELINE as unknown as ConfigPermissionV1.Info)
    expect(Permission.evaluate("bash", "sudo ls", ruleset).action).toBe("deny")
  })
  test("the classifier's input has no field a CLI flag sets (the verdict cannot depend on --yolo)", () => {
    // After the R-1 split (row 26) the type lives in autonomy-parts/types.ts; at BASE it is in autonomy-table.ts.
    const split = path.join(SRC, "permission/autonomy-parts/types.ts")
    const table = readFileSync(existsSync(split) ? split : path.join(SRC, "permission/autonomy-table.ts"), "utf8")
    expect(table).toContain("export type Input = {")
    const input = table.slice(table.indexOf("export type Input = {"))
    const body = input.slice(0, input.indexOf("\n}\n"))
    expect(body).not.toMatch(/\bauto\b|yolo|skip/i)
  })
})

// --- 4. from an agent ----------------------------------------------------------------------------------------------

describe("R4-AGENT: an agent cannot reach the person's controls through the Swarm CLI", () => {
  test("`swarm autonomy …` (switching the mode) is X own_api person_only in every layer", () => {
    for (const command of ["swarm autonomy on", "opencode autonomy off", "sh -c 'swarm autonomy on'"])
      for (const [layer, verdict] of every(bash(command)))
        expect({ command, layer, class: verdict.class, category: verdict.category }).toEqual({ command, layer, class: "X", category: "own_api" })
  })
  test("`swarm run --attach <own server> --yolo …` is X own_api in every layer", () => {
    for (const flag of ["--auto", ...HIDDEN])
      expectX(every(bash(`swarm run --attach ${OWN} ${flag} "hello"`)), `run --attach ${flag}`, "own_api")
  })
  // RED at BASE and HEAD (row 36c): under the consent a nested `swarm run` with an auto-answer flag is class A
  // by_main_agent (bypassed not_routine), so the main agent runs it on the consent and nobody is asked. The nested run
  // starts its own in-process server and a new root session; with a session-scoped consent that root's mode is off, so
  // its D asks (`git push --force` is X in the outer session) are answered "once" by the nested CLI (run.ts:808-812).
  // Kept as todo with its body for the permission-lane coder row; `bun test --todo` runs it.
  test.todo("a nested `swarm run`/TUI with --auto, --yolo or --dangerously-skip-permissions is not run without a person under the consent", () => {
    for (const command of [
      `swarm run --yolo "git push --force"`,
      `swarm run --dangerously-skip-permissions "git push --force"`,
      `swarm run --auto "git push --force"`,
      `opencode run --yolo hello`,
      `swarm-launcher.sh run --dangerously-skip-permissions hello`,
      `sh -c 'swarm run --yolo hello'`,
      `swarm --yolo --prompt hello`,
    ])
      for (const [layer, verdict] of consented(bash(command)))
        expect({ command, layer, refused: verdict.class === "X" }).toEqual({ command, layer, refused: true })
  })
})
