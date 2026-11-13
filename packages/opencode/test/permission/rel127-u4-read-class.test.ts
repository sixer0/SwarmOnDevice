// 1.2.7 row 29b (U4, N7-115, N7-116, N7-130, N7-054; SR §3.2 "U4 read class" table, SR7-05, SR7-06, SR7-20, OP-6). The
// read and diagnostic shell class of the read roles (`planner`, `data-collector`): the 1.2.6 looks plus the SR additions,
// nothing else. `readRoleRefuses` is the role check the permission check runs ahead of every rule, grant and "always".
// Home is a fresh mkdtemp folder; every file is synthetic.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ROLE_SHELL_OUTSIDE_READ_TEXT } from "../../src/permission/autonomy-texts"
import type { InstanceContext } from "../../src/project/instance-context"
import { tmpdir } from "../fixture/fixture"

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  // The fixture sets keys `GitGuard` refuses (autonomy-table.test.ts does the same), so git looks are vetted here.
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  for (const name of ["a.md", "b.md", "x.zip", "a.pdf", "list.txt", "f.txt"]) writeFileSync(path.join(dir, name), "x\n")
  home = mkdtempSync(path.join(os.tmpdir(), "u4-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

const readOnly = (command: string) => AutonomyTable.isReadOnlyShell(command, dir, instance)

test("N7-130: READ_SHELL_ROLES is exactly planner and data-collector (equality pin)", () => {
  expect([...AutonomyTable.READ_SHELL_ROLES].sort()).toEqual(["data-collector", "planner"])
})

test("N7-115: the read class programs include the U4 additions and no writer", () => {
  for (const name of ["ls", "wc", "file", "du", "head", "tail", "cat", "stat", "tree", "find", "shasum", "sha256sum", "git", "mdls", "pdftotext", "unzip", "graft"])
    expect(AutonomyTable.READ_SHELL_COMMANDS.has(name)).toBe(true)
  for (const name of ["sh", "bash", "rm", "mv", "cp", "tee", "curl", "wget", "npm", "bun", "node", "python3", "sed", "awk", "env"])
    expect(AutonomyTable.READ_SHELL_COMMANDS.has(name)).toBe(false)
})

test("N7-054: the role refusal names the substitute", () => {
  expect(ROLE_SHELL_OUTSIDE_READ_TEXT).toBe(
    "This agent role only runs inspection commands (for example ls, head, git log). Hand this command to a coder subagent.",
  )
})

describe("SR §3.2 abuse checks: allowed", () => {
  for (const command of [
    "ls -la",
    "wc -l a.md",
    "file a.md",
    "du -sh .",
    "head -n 5 a.md",
    "tail -n 5 a.md",
    "cat a.md b.md",
    "stat a.md",
    "tree -L 2",
    "find . -name '*.md'",
    "shasum f.txt",
    "sha256sum f.txt",
    "pdftotext a.pdf -",
    "pdftotext -f 1 -l 2 -layout a.pdf -",
    "unzip -l x.zip",
    "mdls a.pdf",
    "mdls -name kMDItemContentType a.pdf",
    "git log --oneline -5",
    "git show HEAD --stat",
    "git diff",
    "git status",
    "git reflog",
    "git reflog show",
    "graft ask 'where is the gate' --no-refresh",
    "graft callers classify --no-refresh",
    "graft blast --no-refresh",
    "git --version",
    "cd . && ls -la && wc -l a.md",
    "ls -la 2>/dev/null",
    "ls -la 2>&1 | tail -20",
  ])
    test(command, () => expect(readOnly(command)).toBe(true))
})

describe("SR §3.2 abuse checks and N7-054 set: refused", () => {
  for (const command of [
    // writes, redirects
    "echo x > a.md",
    "cat a.md > b.md",
    "cat a.md >> b.md",
    "cat a.md | tee b.md",
    "sort -o b.md a.md",
    "tree -o out.txt",
    "find . -delete",
    "find . -exec rm {} ;",
    "find . -fprint out.txt",
    "touch a.md",
    "rm a.md",
    "sed -i s/x/y/ a.md",
    // installs, builds, tests
    "npm i",
    "bun install",
    "bun run build",
    "bun test",
    // network
    "curl https://example.com",
    "wget https://example.com",
    "nc example.com 80",
    // repo-changing git
    "git commit -m x",
    "git checkout .",
    "git reflog expire --all",
    "git reflog delete HEAD@{0}",
    "git log --output=f",
    "git diff --output f",
    // scripts
    "sh -c 'ls'",
    "sh ./probe.sh",
    "python3 -c 'print(1)'",
    "node -e 'fetch(1)'",
    // SR7-05 / SR7-06
    "pdftotext a.pdf",
    "pdftotext a.pdf out.txt",
    "pdftotext -cfg x a.pdf -",
    "unzip x.zip",
    "unzip -o x.zip",
    "unzip -lo x.zip",
    "unzip -l",
    "unzip -l x.zip -d out",
    "mdls -plist out.plist a.pdf",
    "mdls -p out.plist a.pdf",
    "graft build .",
    "graft init",
    "graft ask 'where'",
    "graft blast --export-viz out --no-refresh",
    "graft --dir /tmp ask x --no-refresh",
    "graft ask x --no-refresh --api-key k",
    "shasum -c list.txt",
    "sha256sum --check list.txt",
    "file -f list.txt",
    "file --files-from list.txt",
    "file -C",
    "tail -f a.md",
  ])
    test(command, () => expect(readOnly(command)).toBe(false))
})

// SR7-20: each must be not read-only; the shell runs the same text, so a parse difference would open a write or a run.
describe("SR7-20 parse-difference set: never read-only", () => {
  for (const command of [
    "cat $(echo a.md)",
    "cat `echo a.md`",
    "cat <(echo a.md)",
    "cat >(tee b.md)",
    "cat <<< a.md",
    "ls >| out.txt",
    "ls &> out.txt",
    "ls |& tee out.txt",
    "ls &",
    "ls; rm a.md",
    "ls || rm a.md",
    "! ls",
    "{ ls; }",
    "[[ -f a.md ]]",
    "ls\r",
    "ls\u0000",
    "X=1 ls",
    "exec ls",
    "command ls",
    "builtin ls",
    "ls \\\n> out.txt",
    "ls # > out.txt",
    "ls 2> out.txt",
    "ls\nrm a.md",
  ])
    test(JSON.stringify(command), () => expect(readOnly(command)).toBe(false))
})

describe("readRoleRefuses: the role check", () => {
  const call = (agent: string, command: string, permission = "bash") => ({ agent, permission, metadata: { command, workdir: dir } })
  test("a read role's look passes; anything else is refused", () => {
    for (const agent of ["planner", "data-collector"]) {
      expect(AutonomyTable.readRoleRefuses(call(agent, "ls -la"), instance)).toBe(false)
      expect(AutonomyTable.readRoleRefuses(call(agent, "git log --oneline -3"), instance)).toBe(false)
      expect(AutonomyTable.readRoleRefuses(call(agent, "bun test"), instance)).toBe(true)
      expect(AutonomyTable.readRoleRefuses(call(agent, "echo x > a.md"), instance)).toBe(true)
      expect(AutonomyTable.readRoleRefuses(call(agent, "sudo ls"), instance)).toBe(true)
      // The shell's folder prompt carries the command and is judged the same way.
      expect(AutonomyTable.readRoleRefuses(call(agent, "cat ../x > ../y", "external_directory"), instance)).toBe(true)
      expect(AutonomyTable.readRoleRefuses({ agent, permission: "bash", metadata: {} }, instance)).toBe(true)
    }
  })
  test("other agents and other tools are not judged here", () => {
    for (const agent of ["coder", "build", "verifier", "general"])
      expect(AutonomyTable.readRoleRefuses(call(agent, "bun test"), instance)).toBe(false)
    expect(AutonomyTable.readRoleRefuses({ agent: "planner", permission: "read", metadata: {} }, instance)).toBe(false)
    expect(AutonomyTable.readRoleRefuses({ agent: "planner", permission: "edit", metadata: { filepath: "a.md" } }, instance)).toBe(false)
  })
})
