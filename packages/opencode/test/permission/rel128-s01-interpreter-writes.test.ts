// Swarm 1.2.8 row 64a (S-01, C149; C11 S14-D2, C13 SR8-11). An interpreter's inline code that writes into a skill folder
// or into the vault mirror folder `<vault>/swarm-memory/**` is refused by the autonomy table like any other shell write
// there: X `skill_folder` / X `vault_mirror`, with autonomous mode on (no consent) and under a consent, as the main agent
// and as a subagent. Forms: `python3 -c`, `node -e`, `perl -e`, `ruby -e`, a stdin script (`| python3 -`), `sh -c` /
// `bash -c` around them, heredoc scripts (`python3 <<EOF`), with literal, `~`, `$HOME`, `os.path.expanduser`,
// `os.homedir()` / `path.join` / `Path.home() / …` spellings of the folder. A one-liner that only reads there keeps its
// verdict. Mode off (no autonomy table) shows a shell call to the person as a command: accepted residual (C124).
// HOME and the vault are mkdtemp folders with `os.homedir` stubbed; every file is synthetic. Namespace imports only, so
// the file loads at BASE (e1f9673772) and fails there by its assertions.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import * as TableModule from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

const { AutonomyTable } = TableModule

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let vault: string
let spies: { mockRestore(): void }[] = []
const saved = { vault: process.env.SWARM_VAULT_DIR }

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  mkdirSync(path.join(dir, ".swarm/skills/x"), { recursive: true })
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(path.join(dir, ".swarm/skills/x/SKILL.md"), "---\nname: x\ndescription: synthetic\n---\nbody\n")
  writeFileSync(path.join(dir, "a.md"), "synthetic\n")
  home = mkdtempSync(path.join(os.tmpdir(), "s01-"))
  mkdirSync(path.join(home, ".agents/skills/x"), { recursive: true })
  writeFileSync(path.join(home, ".agents/skills/x/SKILL.md"), "---\nname: x\ndescription: synthetic\n---\nbody\n")
  vault = path.join(home, ".swarm/vault")
  mkdirSync(path.join(vault, "swarm-memory/p/notes"), { recursive: true })
  mkdirSync(path.join(vault, "inbox"), { recursive: true })
  process.env.SWARM_VAULT_DIR = vault
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  if (saved.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = saved.vault
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

type Mode = "on" | "consent"
type Caller = "root" | "subagent"

async function verdict(command: string, mode: Mode, caller: Caller) {
  const input = {
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: dir, steps: await readSteps(command, dir) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...(caller === "subagent" && { agent: "coder" }),
    ...(mode === "consent" && {
      bypass: { caller },
      // A consent item even covering the file: it never opens a skill folder or the mirror.
      consent: {
        id: "c1",
        files: new Map(
          [path.join(dir, ".swarm/skills/x/SKILL.md"), path.join(home, ".agents/skills/x/notes.md")].map((f) => [f, "item-1"]),
        ),
      },
    }),
  } as unknown as TableModule.AutonomyTable.Input
  return mode === "consent" ? AutonomyTable.classify(input) : AutonomyTable.classifyBase(input)
}

/** Every inline-code form, around a path spelled as the code would spell it. */
const FORMS: ((target: string) => string)[] = [
  (t) => `python3 -c "open('${t}','w').write('x')"`,
  (t) => `python -c "import shutil; shutil.copy('a.md', '${t}')"`,
  (t) => `node -e "require('fs').writeFileSync('${t}','x')"`,
  (t) => `perl -e 'open F,">${t}"; print F "x"'`,
  (t) => `perl -e 'open(my $f, ">>", "${t}") or die'`,
  (t) => `ruby -e 'File.write("${t}", "x")'`,
  (t) => `printf %s "open('${t}','w').write('x')" | python3 -`,
  (t) => `sh -c "python3 -c \\"open('${t}','a').write('x')\\""`,
  (t) => `bash -c 'node -e "require(\\"fs\\").appendFileSync(\\"${t}\\", \\"x\\")"'`,
  (t) => `python3 <<'EOF'\nopen('${t}', 'w').write('x')\nEOF`,
  (t) => `node - <<EOF\nrequire('fs').renameSync('a.md', '${t}')\nEOF`,
]

const SKILL_TARGETS = () => [".swarm/skills/x/SKILL.md", ".swarm/skills/x/notes.md", path.join(home, ".agents/skills/x/notes.md")]
const VAULT_TARGETS = () => [path.join(vault, "swarm-memory/p/notes/a.md")]

/** Home-relative spellings inside the code (the shell does not expand these). */
const HOME_SKILL = [
  `python3 -c "import os; open(os.path.expanduser('~/.agents/skills/x/notes.md'),'w').write('x')"`,
  `python3 -c "import os; open(os.path.join(os.path.expanduser('~'), '.agents', 'skills', 'x', 'notes.md'), 'w')"`,
  `python3 -c "from pathlib import Path; (Path.home() / '.agents' / 'skills' / 'x' / 'notes.md').write_text('x')"`,
  `node -e "const p=require('path'),os=require('os'); require('fs').writeFileSync(p.join(os.homedir(), '.agents/skills/x/notes.md'), 'x')"`,
  `node -e "require('fs').writeFileSync(require('os').homedir() + '/.agents/skills/x/notes.md', 'x')"`,
  `python3 -c "open('$HOME/.agents/skills/x/notes.md','w')"`,
  `python3 -c "open('\${HOME}/.agents/skills/x/notes.md','w')"`,
  `ruby -e 'File.write(File.join(Dir.home, ".agents/skills/x/notes.md"), "x")'`,
]
const HOME_VAULT = [
  `python3 -c "import os; open(os.path.expanduser('~/.swarm/vault/swarm-memory/p/notes/a.md'),'w')"`,
  `node -e "require('fs').writeFileSync(require('path').join(require('os').homedir(), '.swarm/vault/swarm-memory/p/notes/b.md'), 'x')"`,
  `python3 -c "import os; os.remove(os.environ['HOME'] + '/.swarm/vault/swarm-memory/p/notes/a.md')"`,
]

const MODES: Mode[] = ["on", "consent"]
const CALLERS: Caller[] = ["root", "subagent"]

describe("S-01: interpreter inline code writing into a skill folder is X skill_folder", () => {
  for (const mode of MODES)
    for (const caller of CALLERS) {
      test(`mode ${mode}, ${caller}: every form x every skill target`, async () => {
        const wrong: string[] = []
        for (const target of SKILL_TARGETS())
          for (const form of FORMS) {
            const command = form(target)
            const got = await verdict(command, mode, caller)
            if (got.class !== "X" || got.category !== "skill_folder") wrong.push(`${got.class} ${got.category} | ${command}`)
          }
        expect(wrong).toEqual([])
      })
      test(`mode ${mode}, ${caller}: home-relative spellings in the code`, async () => {
        const wrong: string[] = []
        for (const command of HOME_SKILL) {
          const got = await verdict(command, mode, caller)
          if (got.class !== "X" || got.category !== "skill_folder") wrong.push(`${got.class} ${got.category} | ${command}`)
        }
        expect(wrong).toEqual([])
      })
    }
})

describe("S-01: interpreter inline code writing into <vault>/swarm-memory is X vault_mirror", () => {
  for (const mode of MODES)
    for (const caller of CALLERS) {
      test(`mode ${mode}, ${caller}: every form x the mirror`, async () => {
        const wrong: string[] = []
        for (const target of VAULT_TARGETS())
          for (const form of FORMS) {
            const command = form(target)
            const got = await verdict(command, mode, caller)
            if (got.class !== "X" || got.category !== "vault_mirror") wrong.push(`${got.class} ${got.category} | ${command}`)
          }
        expect(wrong).toEqual([])
      })
      test(`mode ${mode}, ${caller}: home-relative spellings of the mirror`, async () => {
        const wrong: string[] = []
        for (const command of HOME_VAULT) {
          const got = await verdict(command, mode, caller)
          if (got.class !== "X" || got.category !== "vault_mirror") wrong.push(`${got.class} ${got.category} | ${command}`)
        }
        expect(wrong).toEqual([])
      })
    }
})

describe("S-01: what stays as it was", () => {
  const UNCHANGED = [
    // Reads of the folders: no write-ish call in the code.
    `python3 -c "print(open('.swarm/skills/x/SKILL.md').read())"`,
    `node -e "process.stdout.write(require('fs').readFileSync('.swarm/skills/x/SKILL.md', 'utf8'))"`,
    `python3 -c "import os; print(os.listdir(os.path.expanduser('~/.agents/skills')))"`,
    `python3 -c "import os; print(os.path.exists(os.path.expanduser('~/.swarm/vault/swarm-memory/p')))"`,
    // A write elsewhere, the folders not named.
    `python3 -c "open('src/out.txt','w').write('x')"`,
    `node -e "require('fs').writeFileSync('src/out.txt','x')"`,
    // The vault inbox is not the mirror.
    `python3 -c "import os; open(os.path.expanduser('~/.swarm/vault/inbox/n.md'),'w')"`,
    // A mention outside any interpreter.
    `git commit -m "docs: write .swarm/skills notes with node"`,
  ]
  for (const mode of MODES)
    for (const caller of CALLERS)
      test(`mode ${mode}, ${caller}: no skill_folder / vault_mirror refusal`, async () => {
        const wrong: string[] = []
        for (const command of UNCHANGED) {
          const got = await verdict(command, mode, caller)
          if (got.category === "skill_folder" || got.category === "vault_mirror") wrong.push(`${got.category} | ${command}`)
        }
        expect(wrong).toEqual([])
      })

  test("heuristic (documented, stricter): a write elsewhere beside a read of a skill folder counts as a write there", async () => {
    const got = await verdict(`python3 -c "open('src/o.md','w').write(open('.swarm/skills/x/SKILL.md').read())"`, "consent", "root")
    expect([got.class, got.category]).toEqual(["X", "skill_folder"])
  })
})
