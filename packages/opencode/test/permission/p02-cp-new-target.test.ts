// Swarm 1.2.6 row 35 (P-02, 01b section 3.2 and 9.2): under consent a `cp`/`mv` to a path that does not exist is not a
// replacement. `destroys()` and `consentRedirect` look at the targets (`Risk.copyTargets`, `Risk.replacing`); the copy/move
// flags that do not move the target are widened (N-150). A real replacement keeps its 1.2.5 answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { Risk } from "../../src/tool/risk"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input

let fixture: Awaited<ReturnType<typeof tmpdir>>
let away: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  away = await tmpdir()
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  for (const file of ["assets/P1.png", "a.png", "a.md", "src/a.ts", "src/b.ts"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), "x\n")
  }
  fs.writeFileSync(path.join(dir, "package.json"), "{}")
  fs.writeFileSync(path.join(dir, ".env"), "A=1\n")
  // The handoff form: `mkdir -p ab2` ran first.
  fs.mkdirSync(path.join(dir, "ab2"))
  fs.writeFileSync(path.join(away.path, "x.png"), "x")
  fs.writeFileSync(path.join(away.path, "n.md"), "x")
  await ScriptReader.prepare()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
  await away[Symbol.asyncDispose]()
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

const consented = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const short = (verdict: AutonomyTable.Verdict): { class: string; category?: string } => ({ class: verdict.class, category: verdict.category })
const FILE_OP = { class: "A", category: "file-op" }
const REFUSED = { class: "X", category: "not_reversible" }
// A form the 1.1.0 table leaves to the decider (P, or a D it held) goes to the main agent under consent (`noWait` rule 5).
const AGENT = { class: "A", category: "by_main_agent" }

describe("P-02: a consented cp/mv to a missing target runs", () => {
  test("P2-1: the handoff form `cp -a assets/P1.png ab2/P1-X.png` after `mkdir -p ab2`", async () => {
    const command = "cp -a assets/P1.png ab2/P1-X.png"
    const verdict = consented(await sh(command))
    expect([command, short(verdict)]).toEqual([command, AGENT])
    // The plain form needs no decider word either way: what kept it from A is its name (`.png` is no ordinary edit).
    expect(short(consented(await sh("cp assets/P1.png ab2/P1-X.png")))).toEqual(AGENT)
  })

  test("P2-2: -n, -c (clone) and a quoted name with a space", async () => {
    for (const command of ["cp -n a.png ab2/new.png", "cp -c a.png ab2/new.png", 'cp a.png "ab2/P1 X.png"', "cp -aX a.png ab2/n2.png", "mkdir -p ab3 && cp -a assets/P1.png ab3/P1-X.png"])
      expect([command, short(consented(await sh(command)))]).toEqual([command, AGENT])
    // An ordinary name with a widened flag is the gate's own A `file-op`.
    for (const command of ["cp -a src/a.ts src/c.ts", "cp -n src/a.ts src/b.ts", "cp -L src/a.ts docs/x.md"])
      expect([command, short(consented(await sh(command)))]).toEqual([command, FILE_OP])
  })

  test("P2-3: a source outside the project, plain or with a flag", async () => {
    // Guard: an ordinary name is the 1.2.5 `outside_copy`.
    const md = `cp ${path.join(away.path, "n.md")} src/n.md`
    expect(short(consented(await sh(md)))).toEqual({ class: "A", category: "outside_copy" })
    for (const flag of ["", "-p ", "-a "]) {
      const command = `cp ${flag}${path.join(away.path, "x.png")} ab2/x.png`
      expect([command, short(consented(await sh(command)))]).toEqual([command, AGENT])
    }
  })

  test("P2-4: `mv -n a.md b.md` with b missing", async () => {
    expect(short(consented(await sh("mv -n a.md b.md")))).toEqual(FILE_OP)
  })

  test("P2-5 (guard): a plain copy or move to a new name stays A `file-op`", async () => {
    for (const command of ["cp src/a.ts src/c.ts", "mv src/a.ts src/d.ts", "mv -v src/a.ts src/e.ts"])
      expect([command, consented(await sh(command))]).toEqual([command, { class: "A", decidedBy: "gate", category: "file-op" }])
  })
})

describe("P-02: a real replacement keeps its 1.2.5 answer (CHAR-P02-replace)", () => {
  test("P2-6: onto an existing file: archived with the shell's word, refused without it", async () => {
    const target = path.join(dir, "src/b.ts")
    expect(consented(await sh("cp src/a.ts src/b.ts", { archiveTargets: [target] }))).toEqual({ class: "A", decidedBy: "gate", category: "archived" })
    expect(short(consented(await sh("cp src/a.ts src/b.ts")))).toEqual(REFUSED)
    // `-f` beside `-n` may replace, whichever program runs it.
    expect(short(consented(await sh("cp -fn a.png src/b.ts")))).toEqual(REFUSED)
    // `cd` moves the folder the target is read from.
    expect(short(consented(await sh("cd src && cp a.ts b.ts")))).toEqual(REFUSED)
    expect(short(consented(await sh("cp a.png ab2/n1.png && cp a.md src/b.ts")))).toEqual(REFUSED)
  })

  test("P2-7: a sensitive, secret, outside or unreadable form is still not run", async () => {
    for (const command of [
      "cp src/a.ts package.json",
      "cp .env ab2/x.txt",
      "cp ~/.ssh/id_rsa ./k",
      "mv .env ab2/e",
      `mv ${path.join(away.path, "x.png")} ab2/m.png`,
      "cp a.png ~/out.png",
      "cp a.png .git/hooks/pre-commit",
      "cp a.png .swarm/x.png",
      "mv a.png /dev/null",
      "cp -i a.png ab2/i.png",
      "cp -t ab2 a.png",
      "sh -c 'cp a.png ab2/q.png'",
      // Something beside the copy could put a file where the gate saw none.
      "git checkout main && cp src/a.ts src/c.ts",
      "npm install && cp a.png ab2/n4.png",
      "cp a.png ab2/n3.png && cp a.md ab2/n3.png",
      "touch ab2/n5.png && cp a.png ab2/n5.png",
    ])
      expect([command, consented(await sh(command)).class]).toEqual([command, "X"])
  })
})

describe("P-02: the shared reader (N-150, E-45)", () => {
  test("widened flags, -n and the targets", () => {
    expect(Risk.copyMove(["cp", "-aprRfvnXcLPH", "a", "b"])).toEqual({ name: "cp", sources: ["a"], dest: "b", noClobber: false })
    expect(Risk.copyMove(["cp", "-n", "a", "b"])?.noClobber).toBe(true)
    expect(Risk.copyMove(["mv", "-fvn", "a", "b"])?.noClobber).toBe(false)
    for (const words of [["cp", "-i", "a", "b"], ["cp", "-t", "d", "a"], ["cp", "--", "a", "b"], ["cp", "--reflink", "a", "b"], ["mv", "-a", "a", "b"]])
      expect([words.join(" "), Risk.copyMove(words)]).toEqual([words.join(" "), undefined])
    const existing = Risk.copyMove(["cp", "-n", "a.md", "src/b.ts"])!
    expect(Risk.replacing(existing, dir)).toEqual([])
    expect(Risk.replacing({ ...existing, noClobber: false }, dir)).toEqual([path.join(dir, "src/b.ts")])
    expect(Risk.replacing(Risk.copyMove(["cp", "a.md", "x.md", "missing-dir"])!, dir)).toBeUndefined()
  })
})
