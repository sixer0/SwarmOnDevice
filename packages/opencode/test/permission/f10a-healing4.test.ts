// Swarm 1.1.1 F10a (healing loop 4, decision P19): what the consent must not open, and the two corrections it restores.
// - B3 / M4.2: a redirect into the repository's own storage, a secret or a sensitive file keeps its 1.1.0 verdict.
// - G3-1: a shortened long option is the option it shortens, in the 1.1.0 table and in the allowlist.
// - G3-3: an output option that writes where Undo's snapshot does not reach keeps its 1.1.0 verdict.
// - G3-4: an edit nothing can undo of a file that is not ordinary keeps its 1.1.0 verdict (T8: the edit tools are not
//   redirected by T7 F3).
// - G3-5: showing or pruning a remote asks the remote, so it waits as outward.
// - m20: `-C` among git's own options is read wherever it stands.
// - P5 A2d: a kill of a process this session's own shell tool started is the main agent's again.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassLists } from "../../src/permission/bypass-lists"
import { BypassScreen } from "../../src/permission/bypass-screen"
import type { InstanceContext } from "../../src/project/instance-context"
import { Risk } from "../../src/tool/risk"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { ARCHIVE_FIRST, answerOf } from "./consented-literals"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src/sub"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "src/b.ts"), "y\n")
  fs.writeFileSync(path.join(dir, "src/sub/a.ts"), "z\n")
  fs.writeFileSync(path.join(dir, "payload.txt"), "p\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }))
  // Ignored and not rebuilt: the only copy, which Undo's snapshot leaves out. `dist` is ignored but rebuilt.
  fs.writeFileSync(path.join(dir, ".gitignore"), "data.db\nlocal/\ndist/\n.env\n")
  fs.writeFileSync(path.join(dir, "data.db"), "rows\n")
  fs.mkdirSync(path.join(dir, "local"), { recursive: true })
  fs.writeFileSync(path.join(dir, "local/keep.bin"), "k\n")
  fs.writeFileSync(path.join(dir, ".env"), "KEY=v\n")
  fs.mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true })
  for (const bin of ["jest", "vitest", "tsc"]) fs.writeFileSync(path.join(dir, "node_modules/.bin", bin), "")
  fs.mkdirSync(path.join(dir, ".venv"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".venv/pyvenv.cfg"), "home = /usr/bin\n")
  // An executable hook that already exists, as a project with hooks has.
  fs.writeFileSync(path.join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

async function sh(command: string, extra: Partial<Input> = {}): Promise<Input> {
  const steps = await readSteps(command, dir)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...extra,
  }
}

const base = (input: Input) => AutonomyTable.classify(input)
const root = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
const opened = (verdict: Verdict): Verdict =>
  verdict.class === "A" ? verdict : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: verdict.category }

/** T9 G8: the consented verdict a case expects, written out. */
type Expected = { class: string; category: string | undefined; bypassed?: string; destination?: string }
type Case = readonly [command: string, expected: Expected, answer?: string]
const OPENED = (bypassed: string): Expected => ({ class: "A", category: "by_main_agent", bypassed })
const REDIRECTED = (bypassed: string): Expected => ({ class: "X", category: "not_reversible", bypassed })
const shortG8 = (verdict: Verdict): Expected => ({
  class: verdict.class,
  category: verdict.category,
  ...(verdict.bypassed !== undefined && { bypassed: verdict.bypassed }),
  ...(verdict.destination !== undefined && { destination: verdict.destination }),
})

/** The call keeps its 1.1.0 verdict exactly, for the root and for a subagent; it was not A without consent. */
async function keeps(cases: readonly Case[], extra: Partial<Input> = {}) {
  for (const [command, expected, answer] of cases) {
    const input = await sh(command, extra)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    // 1.1.3 (spec section 3, `noWait`; matrix rows 3, 8, 16-23, 31): the overlay keeps the 1.1.0 verdict, and under consent
    // that kept verdict no longer waits: a D or P runs as the main agent's, a deletion or replacement is redirected to the
    // archive method at once, an X stays.
    // T9 G8: the expected verdict and the agent's answer are written per case, not computed by the code under test.
    for (const verdict of [root(input), subagent(input)]) {
      expect([command, shortG8(verdict), answerOf(verdict)]).toEqual([command, expected, answer])
    }
  }
}

/** The call is opened: A as it was, or the main agent's, for the root and a subagent alike. */
async function opens(commands: readonly string[], extra: Partial<Input> = {}) {
  for (const command of commands) {
    const input = await sh(command, extra)
    const expected = opened(base(input))
    expect([command, root(input)]).toEqual([command, expected])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

describe("B3 / M4.2: a redirect into the repository's storage, a secret or a sensitive file keeps 1.1.0", () => {
  test("an allowlisted reader redirected over the repository's refs, index, HEAD, config or exclude list", async () => {
    await keeps([
      ["cat /dev/null > .git/packed-refs", OPENED("secret_file")],
      ["cat /dev/null > .git/HEAD", OPENED("secret_file")],
      ["head -c 0 src/a.ts > .git/index", OPENED("secret_file")],
      ["cat /dev/null > .git/refs/heads/main", OPENED("secret_file")],
      ["ls > .git/config", OPENED("secret_file")],
      ["git log --oneline > .git/info/exclude", OPENED("secret_file")],
    ])
  })

  test("planting: appending to the repository's config, overwriting an existing hook, writing a new one", async () => {
    await keeps([["cat payload.txt >> .git/config", OPENED("secret_file")], ["cat payload.txt > .git/hooks/pre-commit", OPENED("secret_file")], ["sed -n 1p payload.txt > .git/hooks/post-checkout", OPENED("secret_file")]])
  })

  test("plant, then run: neither the planting step nor the compound is opened; the later git command is as in 1.1.0", async () => {
    // A compound is held as its strongest step: in 1.1.0 as not routine, under consent under the planting step's own name.
    for (const command of ["cat payload.txt >> .git/config && git status", "cat payload.txt > .git/hooks/pre-commit && git commit -m x"]) {
      const input = await sh(command)
      expect([command, base(input).class]).toEqual([command, "D"])
      // 1.1.3 (matrix rows 4, 22, spec section 3 rule 5): the held compound no longer waits; it runs as the main agent's.
      for (const verdict of [root(input), subagent(input)])
        expect([command, verdict.class, verdict.decidedBy, verdict.category]).toEqual([command, "A", "agent", "by_main_agent"])
    }
    // The run step alone is what it was: `git status` is A without consent and stays A (P8); a commit is the agent's.
    const status = await sh("git status")
    expect(base(status).class).toBe("A")
    expect(root(status)).toEqual(base(status))
    await opens(["git commit -m x"])
  })

  test("a redirect over a secret or a sensitive file, and over any non-ordinary file where nothing can undo it", async () => {
    await keeps([["cat src/a.ts > .env", OPENED("secret_file")], ["cat src/a.ts > package.json", OPENED("sensitive_file")], ["cat src/a.ts > .gitignore", OPENED("sensitive_file")]])
    await keeps([["cat src/a.ts > .env", REDIRECTED("secret_file"), ARCHIVE_FIRST], ["cat src/a.ts > data.db", REDIRECTED("not_routine"), ARCHIVE_FIRST]], { canUndo: false })
  })

  test("near miss: a redirect into an ordinary file in the folder is opened as before, with or without Undo", async () => {
    await opens(["cat src/a.ts > src/c.ts", "git log --oneline > src/log.md"])
    await opens(["cat src/a.ts > src/c.ts"], { canUndo: false })
  })
})

describe("G3-1: a shortened long option is the option it shortens", () => {
  // Each pair: the shortened word, and the full one the 1.1.0 table already refused to call a look.
  const pairs: readonly (readonly [string, string])[] = [
    ["sort --out=src/c.ts src/a.ts", "sort --output=src/c.ts src/a.ts"],
    ["sort --compress-prog=x -S 1k src/a.ts", "sort --compress-program=x -S 1k src/a.ts"],
    ["tail --fol src/a.ts", "tail --follow src/a.ts"],
    ["grep --rec foo src", "grep --recursive foo src"],
    ["git grep --open-files-in=less foo", "git grep --open-files-in-pager=less foo"],
    ["git log --outp=src/c.ts", "git log --output=src/c.ts"],
    ["git diff --ext", "git diff --ext-diff"],
    ["git diff --textc", "git diff --textconv"],
    ["git diff --no-ind src/a.ts src/b.ts", "git diff --no-index src/a.ts src/b.ts"],
    ["diff --to=src/a.ts src/b.ts", "diff --to-file=src/a.ts src/b.ts"],
    ["wc --files0=src/a.ts", "wc --files0-from=src/a.ts"],
  ]

  test("without consent: the shortened word is no look, and never looser than the full word (a 1.1.0 fix, stricter only)", async () => {
    const RANK: Record<string, number> = { A: 0, P: 1, B: 2, D: 3, X: 4 }
    for (const [short, full] of pairs) {
      const shortened = AutonomyTable.classifyBase(await sh(short))
      const named = AutonomyTable.classifyBase(await sh(full))
      expect([short, shortened.class === "A"]).toEqual([short, false])
      expect([short, RANK[shortened.class]! >= RANK[named.class]!]).toEqual([short, true])
    }
    // The full recursive search is a look only after a bounded walk finds no secret; the shortened one gets no walk at all.
    expect(AutonomyTable.classifyBase(await sh("grep --rec foo src"))).toEqual({ class: "D", decidedBy: "gate", category: "not_routine" })
  })

  test("near miss: an option of the program's own that only starts like a refused one is still a look", async () => {
    for (const command of ["git diff --text", "git log --oneline -3", "sort -n src/a.ts", "tail -n 3 src/a.ts", "git diff --stat"])
      expect([command, AutonomyTable.classifyBase(await sh(command)).class]).toEqual([command, "A"])
  })

  test("under consent: the allowlist reads the shortened word as the excluded option", async () => {
    await keeps([
      ["git log --outp=src/c.ts", OPENED("not_routine")], ["git grep --open-files-in=less foo", OPENED("not_routine")], ["sort --out=src/c.ts src/a.ts", OPENED("not_routine")], ["git commit --temp=x.txt", OPENED("not_routine")],
      ["git commit --ree=HEAD", OPENED("not_routine")], ["git stash push --pat", OPENED("not_routine")], ["npm install --glob zod", OPENED("not_routine")], ["bun test --prel=./x.ts", OPENED("not_routine")], ["pip install --us requests", OPENED("not_routine")],
      ["pytest --conf=x", OPENED("not_routine")], ["pytest --overr=x=y", OPENED("not_routine")], ["eslint --conf x.js src", OPENED("not_routine")], ["prettier --plug=x --check .", OPENED("not_routine")], ["jest --conf=x.js", OPENED("not_routine")],
      ["vitest run --setupF=x.ts", OPENED("not_routine")], ["cargo build --conf x", OPENED("not_routine")], ["git merge --strat=ours feature", OPENED("not_routine")],
    ])
  })

  test("near miss under consent: an exact option that a refused one starts with is that option, and opens", async () => {
    // 1.1.1 F14 (G4-2 variant): `eslint --rule` gives config inline and now keeps 1.1.0 (f14-healing6.test.ts).
    await opens(["git diff --text", "pip install --pre requests", "pytest --pdb", "pytest --co", "jest --watch"])
    // `--prune` is fetch's own option; a fetch still waits as outward, but the list accepts it.
    expect(BypassScreen.allowlisted(await sh("git fetch --prune origin"), base(await sh("git fetch --prune origin")))).toBe(true)
  })

  test("the shared reader: exact, shortened, ambiguous, and exact options of their own", () => {
    expect(Risk.abbreviates("--output", ["--output"])).toBe(true)
    expect(Risk.abbreviates("--out=x", ["--output"])).toBe(true)
    expect(Risk.abbreviates("--o", ["--output", "--other"])).toBe(true)
    expect(Risk.abbreviates("--outputs", ["--output"])).toBe(false)
    expect(Risk.abbreviates("--text", ["--textconv"], ["text"])).toBe(false)
    expect(Risk.abbreviates("--textc", ["--textconv"], ["text"])).toBe(true)
    expect(Risk.abbreviates("--OUTDIR=x", ["--outDir"], [], true)).toBe(true)
    expect(Risk.abbreviates("-o", ["--output"])).toBe(false)
    expect(Risk.abbreviates("--", ["--output"])).toBe(false)
  })
})

describe("G3-3: an output option writing where Undo's snapshot does not reach keeps 1.1.0", () => {
  test("an ignored file or folder that is not rebuilt, named by a build, test, lint or type-check tool's output option", async () => {
    await keeps([
      ["go build -o data.db .", OPENED("not_routine")], ["go test -coverprofile=data.db ./...", OPENED("not_routine")], ["bun build src/a.ts --outfile data.db", OPENED("not_routine")], ["tsc --outFile data.db", OPENED("not_routine")],
      ["tsc --outfile=data.db", OPENED("not_routine")], ["pytest --junitxml=data.db", OPENED("not_routine")], ["pytest --junit-x data.db", OPENED("not_routine")], ["ruff check --output-file=data.db", OPENED("not_routine")],
      ["ruff check -o data.db", OPENED("not_routine")], ["eslint -o data.db .", OPENED("not_routine")], ["eslint --output-file data.db .", OPENED("not_routine")], ["cargo build --target-dir=local", OPENED("not_routine")],
      ["jest --outputFile=data.db", OPENED("not_routine")], ["vitest run --coverage.reportsDirectory=local", OPENED("not_routine")], ["mypy --html-report local src", OPENED("not_routine")],
    ])
  })

  test("a secret, a sensitive file or the repository's storage named by an output option", async () => {
    await keeps([["go build -o .env .", OPENED("secret_file")], ["eslint -o package.json .", OPENED("not_routine")], ["tsc --outDir .git/x", OPENED("not_routine")]])
  })

  test("an output option with no value to read keeps 1.1.0", async () => {
    await keeps([["eslint . -o", OPENED("not_routine")]])
  })

  test("without Undo, an output option onto a file that is not ordinary keeps 1.1.0", async () => {
    await keeps([["go build -o bin.db .", OPENED("not_routine")]], { canUndo: false })
  })

  test("near miss: an output into a new place, or into a rebuilt folder, opens; an option that writes nothing opens", async () => {
    await opens([
      "go build -o bin/app .", "tsc --outDir dist", "bun build src/a.ts --outdir dist", "tsc --declaration", "vitest run --coverage",
      "pytest -q", "eslint src", "pytest --debug=src/debug.log",
    ])
  })

  test("the reader of output options", () => {
    expect(BypassLists.outputTargets("go", ["build", "-o", "x", "."])).toEqual(["x"])
    expect(BypassLists.outputTargets("go", ["build", "--o=x"])).toEqual(["x"])
    expect(BypassLists.outputTargets("eslint", ["-ox", "."])).toEqual(["x"])
    expect(BypassLists.outputTargets("tsc", ["--OUTDIR", "d"])).toEqual(["d"])
    expect(BypassLists.outputTargets("tsc", ["--declaration"])).toEqual([])
    expect(BypassLists.outputTargets("pytest", ["--debug"])).toEqual(["pytestdebug.log"])
    expect(BypassLists.outputTargets("pytest", ["--junit-x=r.xml"])).toEqual(["r.xml"])
    expect(BypassLists.outputTargets("vitest", ["--coverage.reportsDirectory=c"])).toEqual(["c"])
    expect(BypassLists.outputTargets("vitest", ["--coverage"])).toEqual([])
    expect(BypassLists.outputTargets("eslint", ["-o"])).toBeUndefined()
    expect(BypassLists.outputTargets("cat", ["-o", "x"])).toEqual([])
  })
})

describe("G3-4: an edit nothing can undo of a file that is not ordinary keeps 1.1.0", () => {
  const edit = (file: string, extra: Partial<Input> = {}): Input => ({
    permission: "edit",
    patterns: [file],
    metadata: { filepath: path.join(dir, file) },
    instance,
    cwd: dir,
    canUndo: false,
    folder: "clean",
    editClass: "no_undo",
    ...extra,
  })

  test("not ordinary, with no Undo: the 1.1.0 verdict, for the root and a subagent", () => {
    for (const input of [edit("scripts/x.sh"), edit("data.db"), edit("scripts/x.sh", { canUndo: true })]) {
      const before = base(input)
      expect(before.class).not.toBe("A")
      // 1.1.3 (matrix rows 7, 8, spec section 3 rule 5): the kept verdict runs as the main agent's. T8: the edit tools
      // are not redirected by T7 F3, even when the file exists and has no Undo.
      // T9 G8: written out. 1.1.0 P `edit-not-ordinary` (pinned above as not A); under consent the main agent's, no answer text.
      expect(before).toEqual({ class: "P", decidedBy: "agent", category: "edit-not-ordinary" })
      for (const verdict of [root(input), subagent(input)])
        expect([shortG8(verdict), answerOf(verdict)]).toEqual([OPENED("edit-not-ordinary"), undefined])
    }
    // data.db exists in the fixture: an existing file with no Undo still runs (T8)
    expect(fs.existsSync(path.join(dir, "data.db"))).toBe(true)
  })

  test("near miss: an ordinary file with no Undo is A in 1.1.0 and stays A (T8); one with Undo that is not ordinary opens", () => {
    const ordinary = edit("src/a.ts")
    expect(base(ordinary).class).toBe("A")
    expect(root(ordinary)).toEqual(base(ordinary))
    expect(subagent(ordinary)).toEqual(base(ordinary))
    const undoable = edit("scripts/x.sh", { canUndo: true, editClass: "not_ordinary" })
    expect(root(undoable)).toEqual(opened(base(undoable)))
  })
})

describe("G3-5: inspecting a remote that asks the remote waits as outward", () => {
  test("show and prune ask the remote; set-head --auto too", async () => {
    for (const command of ["git remote show origin", "git remote -v show origin", "git remote prune origin"]) {
      const input = await sh(command)
      expect([command, BypassScreen.screen(input).d]).toEqual([command, "outward"])
      // 1.1.3 (matrix row 2): it no longer waits as outward; it runs, recorded as outward.
      expect([command, root(input)]).toEqual([command, opened({ class: "D", decidedBy: "gate", category: "outward" })])
      expect([command, subagent(input)]).toEqual([command, opened({ class: "D", decidedBy: "gate", category: "outward" })])
    }
  })

  test("setting a remote's HEAD is a remote change, refused in 1.1.0 already, and the screen also calls it outward", async () => {
    const input = await sh("git remote set-head origin -a")
    expect(BypassScreen.screen(input).d).toBe("outward")
    expect(root(input)).toEqual(base(input))
    expect(base(input).class).toBe("X")
  })

  test("near miss: the offline forms ask nothing", async () => {
    await opens(["git remote show -n origin", "git remote -v"])
    for (const command of ["git remote prune -n origin", "git remote prune --dry-run origin"])
      expect([command, BypassScreen.screen(await sh(command)).d]).toEqual([command, undefined])
  })
})

describe("m20: `-C` among git's own options is read wherever it stands, one after the other", () => {
  test("a path checkout under `-C` after another global option keeps 1.1.0", async () => {
    await keeps([["git --no-pager -C src checkout a.ts", OPENED("not_routine")], ["git -P -C src checkout a.ts", OPENED("not_routine")], ["git -C src --no-pager checkout a.ts", OPENED("not_routine")], ["git -C src -C sub checkout a.ts", OPENED("not_routine")]])
  })

  test("a `-C` that names no folder inside the project, or no folder at all, is not on the list", async () => {
    for (const command of ["git -C missing status", "git -C src -C missing status"])
      expect([command, BypassScreen.allowlisted(await sh(command), base(await sh(command)))]).toEqual([command, false])
  })

  test("near miss: a branch switch or a look under `-C` anywhere among them opens", async () => {
    await opens(["git --no-pager -C src status", "git -C src -C sub log --oneline", "git -P -C src checkout -b topic"])
  })
})

describe("P5 A2d: a kill of a process this session's own shell tool started is the main agent's again", () => {
  const own = { ownProcesses: new Set([4242, 4343]) }

  test("own processes, with or without a signal, for the root and a subagent", async () => {
    await opens(["kill 4242", "kill -9 4242", "kill -s TERM 4242 4343", "kill -- 4343"], own)
    for (const command of ["kill 4242", "kill -9 4242 4343"]) expect([command, root(await sh(command, own)).category]).toEqual([command, "by_main_agent"])
  })

  test("any process that is not one of them, a group, this server, a list of signals or a word nobody can read stays held", async () => {
    // 1.1.3 (matrix rows 21, 22): held as before, and that hold no longer waits; it runs as the main agent's.
    const notOwn = opened({ class: "D", decidedBy: "gate", category: "process_not_own" })
    expect(root(await sh("kill 4242 9999", own))).toEqual(notOwn)
    expect(root(await sh("kill 4242"))).toEqual(notOwn)
    expect(root(await sh("kill -- -4242", own))).toEqual(notOwn)
    // 1.1.3 (T7 F4): this server is Swarm's own; stopping it would stop the run, so it is refused at once (its text ends
    // with CONSENT_CONTINUE_SUFFIX at the gate), never run and never held.
    expect(root(await sh(`kill ${process.pid}`, { ownProcesses: new Set([process.pid]) }))).toEqual({
      class: "X",
      decidedBy: "gate",
      category: "process_not_own",
      bypassed: "process_not_own",
    })
    await keeps([["kill -l", OPENED("not_routine")]], own)
    expect(root(await sh("kill $PID", own))).toMatchObject({ class: "A", category: "by_main_agent", bypassed: "unreadable_command" })
  })
})

describe("F10a: without consent nothing else moves, and the consent never tightens beyond P8", () => {
  test("every consented verdict here is no stricter than the 1.1.0 one, except the irreversible list and admin rights", async () => {
    const RANK: Record<string, number> = { A: 0, P: 1, B: 2, D: 3, X: 4 }
    const commands = [
      "cat /dev/null > .git/HEAD", "cat payload.txt >> .git/config && git status", "go build -o data.db .", "tsc --outDir dist",
      "git remote show origin", "git --no-pager -C src checkout a.ts", "kill 4242", "sort --out=src/c.ts src/a.ts", "git commit -m x",
    ]
    for (const command of commands) {
      const input = await sh(command, { ownProcesses: new Set([4242]) })
      for (const verdict of [root(input), subagent(input)]) {
        const before = base(input)
        const tighter = RANK[verdict.class]! > RANK[before.class]!
        expect([command, tighter && !(verdict.class === "X" && ["irreversible", "admin_rights"].includes(verdict.category ?? ""))]).toEqual([command, false])
        // A class may also stay D while its category names why: that is not stricter.
      }
    }
  })
})
