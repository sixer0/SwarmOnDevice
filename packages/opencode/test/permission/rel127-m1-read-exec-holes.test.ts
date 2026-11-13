// 1.2.7 row 47a (decision C61; M1 review findings M1-01, M1-04, M1-11, M1-12, M1-14). The probe forms of the M1 review as
// red tests:
// - M1-01: an option of a read-class program that runs a program (`rg --hostname-bin`, `rg --pre`, `diff -l`, `file -z`)
//   is not a read: not in the U4 read class (`isReadOnlyShell`), not A without consent, not the root's U12 look under it.
//   A marker script proves `rg --hostname-bin` no longer runs a program through the read class.
// - M1-04: zsh `emulate [-LR] <mode> -c '<text>'` (and the `noglob`/`nocorrect`/`-` prefixes, `trap '<text>'`) is shell
//   text: judged as `sh -c '<text>'` is, so a deletion in it gets the archive-first X `not_reversible`, root and subagent.
// - M1-11: the graft read rule is an allowlist of query sub-commands and their listed options (no `--name`, `--pr-author`).
// - M1-12: git's `cat-file --filters`, `--show-signature` and signature format placeholders are not reads.
// Home is a fresh mkdtemp folder (os.homedir stubbed); every file is synthetic.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFileSync, execSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  for (const name of ["a.md", "b.md", "f", "notes.txt"]) writeFileSync(path.join(dir, name), "foo\n")
  execFileSync("git", ["add", "a.md"], { cwd: dir })
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "a"], { cwd: dir })
  home = mkdtempSync(path.join(os.tmpdir(), "m1-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  await ScriptReader.prepare()
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

const readOnly = (command: string) => AutonomyTable.isReadOnlyShell(command, dir, instance)

async function sh(command: string): Promise<Input> {
  const steps = await readSteps(command, dir)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
  }
}
const base = (input: Input) => AutonomyTable.classify(input)
const root = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
const short = (verdict: Verdict) => ({ class: verdict.class, category: verdict.category, bypassed: verdict.bypassed })

// M1-01: every read-class program option checked for running a program (see 47a_read_class_exec_holes.md for the audit).
const RUNS_A_PROGRAM = [
  "rg --hostname-bin=./marker.sh foo f",
  "rg --hostname-bin ./marker.sh foo f",
  "rg --pre ./marker.sh foo f",
  "rg --pre=./marker.sh foo f",
  "rg --pre-glob '*' --pre ./marker.sh foo f",
  "rg -z foo f",
  "rg --search-zip foo f",
  "diff -l a.md b.md",
  "diff --paginate a.md b.md",
  "file -z f",
  "file --uncompress f",
  "file -Z f",
  "sort --compress-program=./marker.sh f",
  "find . -exec ./marker.sh ;",
  "git cat-file --filters HEAD:a.md",
  "git cat-file --filt HEAD:a.md",
  "git cat-file --textconv HEAD:a.md",
  "git show --textconv HEAD",
  "git log --textconv -p",
  "git diff --ext-diff",
  "git log --show-signature -1",
  "git show --show-signature HEAD",
  "git log --format=%G? -1",
  "git log --pretty=format:%GS -1",
  "git for-each-ref --format=%(signature)",
  "git -c core.pager=./marker.sh log",
  "git --exec-path=. log",
  "git -p log",
  "git grep -O foo",
]

describe("M1-01 / M1-12: a read-class option that runs a program is not in the U4 read class", () => {
  for (const command of RUNS_A_PROGRAM) test(command, () => expect(readOnly(command)).toBe(false))
})

describe("M1-01 / M1-12: nor A without consent, nor the root's U12 look under consent", () => {
  for (const command of RUNS_A_PROGRAM)
    test(command, async () => {
      const input = await sh(command)
      expect([command, base(input).class]).not.toEqual([command, "A"])
      // Under consent a program the table cannot vouch for is opened as `not_routine` like any other; it is never a read
      // (category undefined) nor a `protected_read`.
      const consented = root(input)
      expect([command, consented.class === "A" && consented.bypassed === undefined]).toEqual([command, false])
      expect([command, consented.category === "protected_read"]).toEqual([command, false])
    })
  // The root's U12 "all reads allowed" path (`protectedLook`): a look outside the folder.
  test("rg --hostname-bin on a place outside the folder is no protected_read", async () => {
    const outside = path.join(home, "outside.txt")
    writeFileSync(outside, "foo\n")
    const verdict = root(await sh(`rg --hostname-bin=./marker.sh foo ${outside}`))
    expect(verdict.category).not.toBe("protected_read")
    expect(root(await sh(`rg foo ${outside}`)).category).toBe("protected_read")
  })
})

// INTENT row 47j (U9-2, C76; supersedes C61/C70's refusal of these for the consented callers): the options the person's
// ruling names leave the read class (above) and run as running a program under the consent, root and subagent alike:
// A with `bypassed` set (opened by the consent, on record), never a read. The read roles keep them out (U4).
describe("U9-2: under the consent a program-running read option runs as a program, root and subagent", () => {
  for (const command of [
    "rg --hostname-bin=./marker.sh foo f",
    "rg --pre ./marker.sh foo f",
    "diff -l a.md b.md",
    "file -z f",
    "git cat-file --filters HEAD:a.md",
    "git log --show-signature -1",
    "git log --pretty=format:%GS -1",
  ])
    test(command, async () => {
      const input = await sh(command)
      for (const verdict of [root(input), subagent(input)]) {
        expect([command, verdict.class, verdict.bypassed !== undefined]).toEqual([command, "A", true])
        expect(verdict.category === "protected_read" || verdict.bypassed === "protected_read").toBe(false)
      }
      expect(AutonomyTable.SUBAGENT_RUNS_LIKE_ROOT.has(subagent(input).bypassed!)).toBe(true)
      expect(base(input).class).not.toBe("A")
    })
})

describe("M1-01: the looks themselves stay reads", () => {
  for (const command of [
    "rg foo f",
    "rg -n foo f",
    "rg --no-config -n foo f",
    "diff a.md b.md",
    "diff -u a.md b.md",
    "file f",
    "git log --oneline -3",
    "git log --format=%h%x20%s -3",
    "git cat-file -p HEAD:a.md",
    "git show HEAD --stat",
  ])
    test(command, () => expect(readOnly(command)).toBe(true))
})

test("M1-01 marker: rg --hostname-bin runs the program, and the read class no longer lets it run", () => {
  let rg: string | undefined
  try {
    rg = execFileSync("sh", ["-c", "command -v rg"], { encoding: "utf8" }).trim() || undefined
  } catch {
    rg = undefined
  }
  if (!rg) return console.warn("rg not installed: marker test skipped")
  const marker = path.join(dir, "ran.marker")
  const script = path.join(dir, "marker.sh")
  writeFileSync(script, `#!/bin/sh\necho ran > "${marker}"\necho host\n`)
  chmodSync(script, 0o755)
  const command = "rg --hostname-bin=./marker.sh foo f"
  // The flag runs the program (ripgrep 15 on this Mac): proven directly, then cleaned up.
  execSync(command, { cwd: dir, stdio: "ignore" })
  expect(existsSync(marker)).toBe(true)
  rmSync(marker)
  // What a read role's shell does: run the call only when it is in the read class.
  if (readOnly(command)) execSync(command, { cwd: dir, stdio: "ignore" })
  expect(existsSync(marker)).toBe(false)
  rmSync(script)
})

// M1-04: zsh `emulate … -c` is shell text, judged as `sh -c` is.
const ARCHIVE_FIRST = { class: "X", category: "not_reversible" } as const
describe("M1-04: a deletion through a zsh string form is X not_reversible (archive first), root and subagent", () => {
  for (const command of [
    `emulate sh -c "rm notes.txt"`,
    `emulate -L sh -c "rm notes.txt"`,
    `emulate -LR zsh -c "rm notes.txt"`,
    `zsh -c 'emulate sh -c "rm notes.txt"'`,
    `nohup emulate sh -c "rm notes.txt"`,
    `time emulate sh -c "rm notes.txt"`,
    "noglob rm notes.txt",
    "nocorrect rm notes.txt",
    "nohup noglob rm notes.txt",
    `trap 'rm notes.txt' EXIT`,
  ])
    test(command, async () => {
      const input = await sh(command)
      for (const verdict of [root(input), subagent(input)])
        expect([command, { class: verdict.class, category: verdict.category }]).toEqual([command, ARCHIVE_FIRST])
    })
})

describe("M1-04: `emulate <mode> -c '<text>'` gets the verdict of `sh -c '<text>'` (C21 shell-text path)", () => {
  for (const text of ["ls", "rm notes.txt", "cat $(echo a.md)", "curl https://example.invalid", "echo x > b.md"])
    test(text, async () => {
      const quoted = `'${text}'`
      const plain = await sh(`sh -c ${quoted}`)
      for (const form of [`emulate sh -c ${quoted}`, `emulate -L zsh -c ${quoted}`]) {
        const input = await sh(form)
        expect([form, short(root(input))]).toEqual([form, short(root(plain))])
        expect([form, short(subagent(input))]).toEqual([form, short(subagent(plain))])
      }
    })
  test("an unreadable inner text is unreadable_command, which a subagent does not run like the root", async () => {
    const verdict = subagent(await sh(`emulate sh -c "$X"`))
    expect(verdict.bypassed ?? verdict.category).toBe("unreadable_command")
    expect(AutonomyTable.SUBAGENT_RUNS_LIKE_ROOT.has("unreadable_command")).toBe(false)
  })
  test("`emulate sh` alone runs no text and deletes nothing", async () => {
    const verdict = root(await sh("emulate sh"))
    expect(verdict.category === "not_reversible").toBe(false)
  })
})

// M1-11: the graft rule is an allowlist.
describe("M1-11: graft read rule allowlist", () => {
  for (const command of [
    "graft ask 'where is the gate' --no-refresh",
    "graft ask x --source --full -n 5 --in src --json --no-refresh",
    "graft map --max-dirs 10 --no-refresh",
    "graft skeleton src/a.ts --no-refresh",
    "graft callers classify --direction out -d all --no-refresh",
    "graft grep -i foo --fixed --no-refresh",
    "graft blast --no-refresh",
    "graft blast --base main -d 2 --format json --no-owners --no-refresh",
    // INTENT row 47j (U9-3, C76): with or without --no-refresh (a refresh only rebuilds graft's own cache).
    "graft ask 'where is the gate'",
    "graft blast --base main --no-owners",
  ])
    test(`allowed: ${command}`, () => expect(readOnly(command)).toBe(true))
  for (const command of [
    "graft blast --no-refresh --name",
    "graft blast --no-refresh --pr-author someone",
    "graft blast --no-refresh --title x",
    "graft blast --no-refresh --export-viz out",
    "graft ask x --no-refresh -o out",
    "graft ask x --no-refresh --unknown",
    "graft map --no-refresh --format json",
    "graft ask x --no-refresh -n",
    "graft blast --no-refresh --format html",
    "graft callers x --direction sideways --no-refresh",
    "graft --no-refresh ask x",
    "graft build . --no-refresh",
    "graft ask a b c --no-refresh",
  ])
    test(`refused: ${command}`, () => expect(readOnly(command)).toBe(false))
})
