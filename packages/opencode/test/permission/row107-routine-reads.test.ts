// 1.3.3 row 107 (MC-7): pure reads inside the project are routine (`routine()` answers "read", class A at the gate).
// `wc`, `grep -c` and plain `grep`, `ls`, `cat`, `head`, `tail` with only read flags, on paths that land inside the
// session's folder once links are followed. Everything else in the second table is not routine: a redirection, a pipe into
// a program that is not a look, a substitution, `;`, `&&` with a non-look, `||`, `&`, a glob, a path outside (absolute,
// `~`, `..`, a link), a write flag (`sed -i`) and `tail -f`, which waits for good and so is no look either.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { tmpdir } from "../fixture/fixture"

let project: Awaited<ReturnType<typeof tmpdir>>
let away: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  project = await tmpdir({ git: true })
  away = await tmpdir()
  dir = project.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "a.md"), "foo\nbar\n")
  fs.writeFileSync(path.join(dir, "src/b.ts"), "export const foo = 1\n")
  fs.writeFileSync(path.join(dir, ".env"), "KEY=1\n")
  fs.writeFileSync(path.join(dir, "pats.txt"), "foo\n")
  fs.writeFileSync(path.join(away.path, "secret.txt"), "outside\n")
  // A file and a folder in the project that are links to a place beyond it.
  fs.symlinkSync(path.join(away.path, "secret.txt"), path.join(dir, "link-out"))
  fs.symlinkSync(away.path, path.join(dir, "dir-out"))
})

afterAll(async () => {
  await project[Symbol.asyncDispose]()
  await away[Symbol.asyncDispose]()
})

const judge = (command: string, cwd = dir) => AutonomyTable.routine(command, cwd, instance)

const ROUTINE: readonly string[] = [
  "wc -l a.md",
  "wc a.md src/b.ts",
  "wc -c src/b.ts",
  "grep -c foo a.md",
  "grep foo a.md",
  "grep -n foo src/b.ts",
  "grep -in foo a.md src/b.ts",
  "ls",
  "ls -la src",
  "ls ./src",
  "cat a.md",
  "cat src/b.ts a.md",
  'cat "a.md"',
  "head -n 5 a.md",
  "head -20 a.md",
  "tail -n 5 a.md",
  "tail -5 src/b.ts",
  "cat a.md 2>/dev/null",
  "cat a.md | head -n 3",
  "wc -l a.md && grep -c foo a.md",
  "cd src && cat b.ts",
  "grep -f pats.txt a.md",
  "grep -if pats.txt a.md",
  "grep --file=pats.txt a.md",
  "grep --color=never foo a.md",
  "head --lines=5 a.md",
]

const HELD: readonly (readonly [string, string])[] = [
  ["`..` escape", "cat ../secret.txt"],
  ["`..` escape inside a longer path", "cat src/../../secret.txt"],
  ["absolute path outside", "cat /etc/hosts"],
  ["home folder", "cat ~/.zshrc"],
  ["$HOME", "ls $HOME"],
  ["link to a file outside", "cat link-out"],
  ["link to a folder outside", "cat dir-out/secret.txt"],
  ["glob escaping the project", "ls ../*"],
  ["glob inside the project is not a plain word either", "wc -l src/*.ts"],
  ["redirection to a file", "cat a.md > copy.md"],
  ["append redirection", "cat a.md >> copy.md"],
  ["stderr redirection outside /dev/null", "cat a.md 2>/tmp/err"],
  ["input redirection", "cat < a.md"],
  ["pipe into a shell", "cat a.md | sh"],
  ["pipe into a non-read program", "cat a.md | xargs rm"],
  ["pipe into tee", "cat a.md | tee b.md"],
  ["command substitution", "cat $(echo a.md)"],
  ["backquote substitution", "cat `echo a.md`"],
  ["process substitution", "cat <(cat /etc/hosts)"],
  ["semicolon", "cat a.md; rm a.md"],
  ["&& into a non-read", "cat a.md && rm a.md"],
  ["||", "cat a.md || rm a.md"],
  ["background &", "cat a.md &"],
  ["second line", "cat a.md\nrm a.md"],
  ["tail -f waits for good", "tail -f a.md"],
  ["tail --follow", "tail --follow a.md"],
  ["sed -i writes", "sed -i s/foo/bar/ a.md"],
  ["wc reads names from a file", "wc --files0-from=a.md"],
  ["grep -r on the parent", "grep -r foo .."],
  ["secret file", "cat .env"],
  ["cwd outside the project", "cat secret.txt"],
  // Flag values that name a file are paths too (row 107 hardening).
  ["grep pattern file outside, long form", "grep --file=../secret.txt foo a.md"],
  ["grep pattern file through a link out, long form", "grep --file=link-out foo a.md"],
  ["grep pattern file that is a secret, long form", "grep --file=.env foo a.md"],
  ["grep pattern file that is a secret, attached short form", "grep -f.env foo a.md"],
  ["grep pattern file outside, attached in a cluster", "grep -if/etc/hosts foo a.md"],
  ["grep exclude list read from outside", "grep --exclude-from=/etc/hosts foo a.md"],
  ["head with an absolute value outside", "head --lines=5 --x=/etc/hosts a.md"],
]

describe("row 107: pure reads inside the project are routine", () => {
  test(`${ROUTINE.length} read commands inside the project are "read"`, () => {
    expect(ROUTINE.length).toBeGreaterThanOrEqual(15)
    expect(ROUTINE.map((command) => [command, judge(command)])).toEqual(ROUTINE.map((command) => [command, "read"]))
  })

  test(`${HELD.length} commands that are not pure reads inside the project are not routine`, () => {
    expect(HELD.length).toBeGreaterThanOrEqual(15)
    const cwdOf = (command: string) => (command === "cat secret.txt" ? away.path : dir)
    expect(HELD.map(([why, command]) => [why, judge(command, cwdOf(command))])).toEqual(HELD.map(([why]) => [why, undefined]))
  })

  test("an absolute path that lands inside the project is a read; the same file through a link out is not", () => {
    expect(judge(`cat ${path.join(dir, "a.md")}`)).toBe("read")
    expect(judge(`cat ${path.join(dir, "link-out")}`)).toBeUndefined()
  })

  test("the gate answers a routine read with class A and nobody asked", () => {
    const verdict = AutonomyTable.classify({
      permission: "bash",
      patterns: ["wc -l a.md"],
      metadata: { command: "wc -l a.md" },
      instance,
      cwd: dir,
      canUndo: true,
      folder: "clean",
    })
    expect(verdict).toEqual({ class: "A", decidedBy: "gate" })
  })
})
