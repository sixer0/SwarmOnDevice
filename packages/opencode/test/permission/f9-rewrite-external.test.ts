// Swarm 1.1.1 F9 (decisions P15 G2-2 and G2-5, P16). Under the person's consent:
// - a git form that rewrites a commit or moves, deletes or force-moves a ref is refused as X `irreversible` (P8 lets the
//   irreversible list be stricter than 1.1.0, A1);
// - a plugin or MCP tool, or any tool that is not Swarm's own, keeps its 1.1.0 verdict: the overlay never opens it.
// Without consent nothing changes, to the byte.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassScreen } from "../../src/permission/bypass-screen"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { answerOf } from "./consented-literals"

type Input = AutonomyTable.Input

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }))
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

async function sh(command: string, metadata: Record<string, unknown> = {}): Promise<Input> {
  const steps = await readSteps(command, dir)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}), ...metadata },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
  }
}

const tool = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: ["*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})

const consented = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })

// 1.1.3 (T9 G8, code review M2): the consented verdicts are stated literally, with the agent's answer text; nothing here
// computes them with the code under test (`noWait`).
type Shape = { class: string; category?: string; bypassed?: string; answer?: string }
const RUNS = (bypassed: string): Shape => ({ class: "A", category: "by_main_agent", bypassed })
const shape = (verdict: AutonomyTable.Verdict): Shape => ({
  class: verdict.class,
  category: verdict.category,
  bypassed: verdict.bypassed,
  answer: answerOf(verdict),
})
const REFUSED: AutonomyTable.Verdict = { class: "X", decidedBy: "gate", category: "irreversible" }

/** Refused under consent, for the root and a subagent; without consent the 1.1.0 verdict, which was not this refusal. */
async function refused(commands: readonly string[]) {
  for (const command of commands) {
    const input = await sh(command)
    expect([command, consented(input)]).toEqual([command, REFUSED])
    expect([command, subagent(input)]).toEqual([command, REFUSED])
    const base = AutonomyTable.classify(input)
    expect([command, JSON.stringify(base)]).toEqual([command, JSON.stringify(AutonomyTable.classifyBase(input))])
    expect([command, base.category]).not.toEqual([command, "irreversible"])
  }
}

/** On the allowlist and held or judged in 1.1.0: the main agent's under consent, as F7 opens it. */
async function opened(commands: readonly string[]) {
  for (const command of commands) {
    const input = await sh(command)
    const base = AutonomyTable.classify(input)
    const expected: AutonomyTable.Verdict =
      base.class === "A" ? base : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: base.category }
    expect([command, consented(input)]).toEqual([command, expected])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

describe("F9 (G2-2): git forms that rewrite commits or refs are refused under consent", () => {
  test("amending a commit", async () => {
    await refused(["git commit --amend -m x", "git commit --am --no-edit", "git -C . commit --amend -m x"])
  })

  test("rebasing, also by a pull", async () => {
    await refused(["git rebase main", "git rebase -i HEAD~3", "git pull --rebase origin main", "git pull -r", "git pull --rebase=merges"])
  })

  test("history filtering tools", async () => {
    await refused([
      "git filter-branch --tree-filter true HEAD",
      "git filter-repo --path src",
      "git-filter-repo --path src",
      "bfg --delete-files x.bin",
      "git replace abc123 def456",
    ])
  })

  test("moving a branch or HEAD to another commit", async () => {
    await refused([
      "git reset --soft HEAD~1",
      "git reset HEAD~1",
      "git reset --mixed main",
      "git reset --keep abc123",
      "git update-ref refs/heads/main abc123",
      "git symbolic-ref HEAD refs/heads/other",
      "git checkout -B main abc123",
      "git switch -C main abc123",
      "git switch --force-create main",
    ])
  })

  test("expiring the reflog", async () => {
    await refused(["git reflog delete HEAD@{1}"])
    // 1.2.6 row 37c (C17), intended change: a reflog expiry cannot be checkpointed, so in a vetted repository it is still
    // refused in both layers, now as X `checkpoint_failed` with the git reason instead of X `irreversible`.
    const input = await sh("git reflog expire --expire=now --all")
    const notKept: AutonomyTable.Verdict = { class: "X", decidedBy: "gate", category: "checkpoint_failed", reason: "git" }
    expect(consented(input)).toEqual(notKept)
    expect(subagent(input)).toEqual(notKept)
    expect(AutonomyTable.classify(input)).toEqual(notKept)
  })

  test("deleting or force-moving refs, branch deletes and forced branch moves", async () => {
    await refused([
      "git update-ref -d refs/heads/x",
      "git symbolic-ref -d HEAD",
      "git branch -d feature",
      "git branch --delete feature",
      "git branch -D feature",
      "git branch -f main abc123",
      "git branch --force main abc123",
      "git branch -M old new",
      "git branch -C old new",
      "git push --force origin main",
    ])
  })

  test("tag delete and tag force", async () => {
    await refused(["git tag -d v1", "git tag --delete v1", "git tag -f v1", "git tag --force v1 abc123"])
  })

  test("one rewriting step in a compound refuses the whole call", async () => {
    await refused(["git add src/a.ts && git commit --amend --no-edit", "git status; git reset HEAD~1"])
  })

  test("near misses: a plain commit and a plain branch create stay opened", async () => {
    await opened(["git commit -m x", "git branch feature", "git branch -m old new", "git switch -c new", "git tag v2"])
  })

  test("near misses that are not on the allowlist keep their 1.1.0 verdict and are not refused", async () => {
    for (const command of [
      "git reset",
      "git reset HEAD",
      "git reset -- src/a.ts",
      "git reset HEAD -- src/a.ts",
      "git symbolic-ref HEAD",
      "git symbolic-ref --short HEAD",
      "git replace --list",
      "git pull --rebase=false origin main",
      "git pull --no-rebase origin main",
      "git commit --fixup=amend:HEAD",
    ]) {
      const input = await sh(command)
      expect([command, consented(input).category]).not.toEqual([command, "irreversible"])
      expect([command, BypassScreen.screen(input).x]).toEqual([command, undefined])
    }
  })

  test("without consent nothing changes: each form's verdict is classifyBase's, byte for byte", async () => {
    for (const command of ["git commit --amend -m x", "git reset HEAD~1", "git branch -d feature", "git tag -f v1", "git rebase main"]) {
      const input = await sh(command)
      expect(JSON.stringify(AutonomyTable.classify(input))).toBe(JSON.stringify(AutonomyTable.classifyBase(input)))
      expect(JSON.stringify(AutonomyTable.classify({ ...input, bypass: undefined }))).toBe(
        JSON.stringify(AutonomyTable.classifyBase(input)),
      )
    }
  })
})

describe("F9 (G2-5): plugin and MCP tools keep their 1.1.0 verdict under consent", () => {
  const local = { server: "notes", transport: "local", origin: "project" }
  const cases: [string, Input, Shape][] = [
    ["an MCP tool of an untrusted project", tool("notes_search", { folder: "ask", metadata: { mcp: local } }), RUNS("folder_not_trusted")],
    ["an MCP tool the gate opens in 1.1.0", tool("notes_search", { metadata: { mcp: { ...local, origin: "global" } } }), { class: "A", category: "mcp_tool" }],
    ["a remote MCP tool", tool("notes_search", { metadata: { mcp: { ...local, transport: "remote" } } }), RUNS("outward_not_in_mission")],
    ["an MCP tool borrowing another server's name", tool("other_search", { metadata: { mcp: local } }), RUNS("external_tool")],
    ["a plugin tool that says nothing about itself", tool("myplugin_run"), RUNS("external_tool")],
    ["a plugin tool with its own patterns and metadata", tool("myplugin_run", { patterns: ["build"], metadata: { target: "x" } }), RUNS("not_routine")],
    ["a tool asking with a name no Swarm tool uses", tool("list", { patterns: ["src"], metadata: { path: "src" } }), RUNS("not_routine")],
    ["the external_tool path of a built-in name", tool("lsp"), RUNS("external_tool")],
  ]

  for (const [name, input, expected] of cases)
    test(name, () => {
      const base = AutonomyTable.classify(input)
      // 1.1.3 (matrix rows 6, 11, 15, 8, spec section 3 rule 5; T9 G8: stated literally per case): the kept 1.1.0 verdict
      // no longer waits; a held one runs as the main agent's, recorded with its 1.1.0 category; an A stays A.
      expect(shape(consented(input))).toEqual(expected)
      expect(shape(subagent(input))).toEqual(expected)
      if (base.class !== "A") expect(consented(input)).toEqual({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: base.category })
    })

  test("an MCP source on a shell-named request is not opened either, though the same command would be", async () => {
    const plain = await sh("bun install")
    expect(consented(plain).category).toBe("by_main_agent")
    const borrowed = { ...plain, metadata: { ...plain.metadata, mcp: local } }
    // 1.1.3 (matrix rows 6, 8; T9 G8: stated literally): the kept 1.1.0 verdict no longer waits.
    expect(shape(consented(borrowed))).toEqual(RUNS("not_routine"))
  })

  test("near miss: Swarm's own tools are still opened", () => {
    const edit = tool("edit", { patterns: ["scripts/x.sh"], editClass: "not_ordinary" })
    expect(consented(edit)).toMatchObject({ class: "A", category: "by_main_agent" })
  })

  test("without consent nothing changes", () => {
    for (const [, input] of cases)
      expect(JSON.stringify(AutonomyTable.classify(input))).toBe(JSON.stringify(AutonomyTable.classifyBase(input)))
  })
})
