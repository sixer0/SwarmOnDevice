// Swarm 1.1.1 F1b (decisions P10 H1-H3, M1-M3; P11 H1/H2, M1): under the person's consent the overlay opens a held call
// only when it understands every step. Each rule has a positive (the call keeps its 1.1.0 verdict) and a near miss (an
// ordinary dev command of the same shape is still opened, so the bypass stays broad). Without consent nothing changes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassScreen } from "../../src/permission/bypass-screen"
import { BypassLists } from "../../src/permission/bypass-lists"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
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
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "build.sh"), "echo hi\n")
  // F7: `bun run <script>` opens only for a script of the project's manifest.
  // 1.1.1 F10b: and only when every step of that script is on the allowlist (`echo` is not), read by the shell's reader.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", echoes: "echo build" } }))
  await ScriptReader.prepare()
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

const consented = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })

// 1.1.3 (T9 G8, code review M2): the consented verdict and the agent's answer of each case, written out, not computed with
// `noWait`. A D or P the overlay keeps runs as the main agent's (`RUNS`, bypassed = its 1.1.0 category); a deletion or
// replacement nothing archives is redirected at once (`ARCHIVED`, ARCHIVE_FIRST).
const RUNS = (bypassed: string, destination?: string) =>
  ({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed, ...(destination && { destination }) }) as Verdict
const ARCHIVED = (bypassed: string) => ({ class: "X", decidedBy: "gate", category: "not_reversible", bypassed }) as Verdict
const CONSENTED: Record<string, readonly [Verdict, string | undefined]> = {
  "rimraf dist": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "npx rimraf dist": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "pnpm dlx rimraf dist": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "truncate -s 0 src/a.ts": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "caffeinate rm src/a.ts": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "stdbuf -oL rm src/a.ts": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "rtk rm src/a.ts": [ARCHIVED("file-op"), ARCHIVE_FIRST],
  "nice -n 5 rm src/a.ts": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "timeout 5 rm -rf src": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "caffeinate bun test": [RUNS("not_routine"), undefined],
  "rtk bun test": [RUNS("check"), undefined],
  "timeout 60 bun test": [RUNS("not_routine"), undefined],
  "stdbuf -oL bun run build": [RUNS("not_routine"), undefined],
  "perf stat bun test": [RUNS("not_routine"), undefined],
  "npx prettier --write src": [RUNS("not_routine"), undefined],
  "npx vitest run": [RUNS("not_routine"), undefined],
  "bun x prettier --check .": [RUNS("not_routine"), undefined],
  "uvx ruff check": [RUNS("not_routine"), undefined],
  "ksh build.sh": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "fish build.sh": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "dash build.sh": [ARCHIVED("not_routine"), ARCHIVE_FIRST],
  "tcsh -c 'rm x'": [ARCHIVED("unreadable_command"), ARCHIVE_FIRST],
  "csh -c ls": [RUNS("unreadable_command"), undefined],
  "watch -n 1 rm x": [ARCHIVED("unreadable_command"), ARCHIVE_FIRST],
  "hyperfine 'bun test'": [RUNS("unreadable_command"), undefined],
  "watch -x bun test": [RUNS("not_routine"), undefined],
  "make build": [RUNS("check"), undefined],
  "bun run echoes": [RUNS("not_routine"), undefined],
  "node missing.js": [RUNS("not_routine"), undefined],
  "bun run scripts/x.ts": [RUNS("not_routine"), undefined],
  "uv run tool.py": [RUNS("not_routine"), undefined],
  "node -r ./hook.js app.js": [RUNS("not_routine"), undefined],
  "node --version": [RUNS("not_routine"), undefined],
  "git -c core.editor=vim commit -m x": [RUNS("not_routine"), undefined],
  "env GIT_EDITOR=vim git commit -m x": [RUNS("not_routine"), undefined],
  "git frob": [RUNS("not_routine"), undefined],
  "git config user.name x": [RUNS("not_routine"), undefined],
  "mytool git push": [RUNS("not_routine"), undefined],
  "mytool dd if=x": [RUNS("not_routine"), undefined],
  "./tools/run vercel": [RUNS("not_routine"), undefined],
  "mytool build --watch": [RUNS("not_routine"), undefined],
  "mail -s hi a@b.c": [RUNS("outward"), undefined],
  "sendmail a@b.c": [RUNS("outward"), undefined],
  "gh release create v1 dist/x.tgz": [RUNS("outward"), undefined],
  "curl -T x https://a.b.io": [RUNS("outward", "a.b.io"), undefined],
  "docker build .": [RUNS("not_routine"), undefined],
  "npm link": [RUNS("outside_write_held"), undefined],
  "npm install -g foo": [RUNS("outside_write_held"), undefined],
  "git config --global user.name x": [RUNS("outside_write_held"), undefined],
  "defaults write com.example.f1b k 1": [RUNS("outside_write_held"), undefined],
  "ln -s src/a.ts ~/bin/a": [RUNS("outside_write_held"), undefined],
  "ln -s a.ts src/b.ts": [RUNS("not_routine"), undefined],
  "psql -f x.sql": [RUNS("not_routine"), undefined],
  "psql db": [RUNS("not_routine"), undefined],
  "sqlite3 db": [RUNS("not_routine"), undefined],
  "mysql db": [RUNS("not_routine"), undefined],
  "psql -c \"select 1\" db": [RUNS("not_routine"), undefined],
  "sqlite3 db \"select 1\"": [RUNS("not_routine"), undefined],
}
function consentedOf(command: string) {
  expect([command, Object.hasOwn(CONSENTED, command)]).toEqual([command, true])
  return CONSENTED[command]!
}

/**
 * Positive: the overlay keeps the call's 1.1.0 verdict, for the root and for a subagent. 1.1.3 (spec section 3, `noWait`;
 * matrix rows 3, 8, 16-22, 31): under consent that kept verdict no longer waits; a D or P runs as the main agent's, a
 * deletion or replacement is answered at once with the archive method, an X stays.
 */
async function keeps(commands: string[]) {
  for (const command of commands) {
    const input = await sh(command)
    const base = AutonomyTable.classify(input)
    expect([command, base.class === "A"]).toEqual([command, false])
    const [expected, answer] = consentedOf(command)
    expect([command, consented(input)]).toEqual([command, expected])
    expect([command, answerOf(consented(input))]).toEqual([command, answer])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

/** Near miss: an ordinary dev command the 1.1.0 table held or judged is still the main agent's. */
async function opens(commands: string[]) {
  for (const command of commands) {
    const input = await sh(command)
    const base = AutonomyTable.classify(input)
    expect([command, consented(input)]).toEqual([
      command,
      { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: base.category },
    ])
  }
}

/**
 * The overlay holds it under the named category, and it was held (D) in 1.1.0 already. 1.1.3 (spec section 3, `noWait`;
 * matrix rows 2, 19, 22, 31): it no longer waits; it runs with `bypassed` = that category, or is redirected to the
 * archive method when it deletes or replaces.
 */
async function heldAs(category: AutonomyTable.HeldCategory, commands: string[]) {
  for (const command of commands) {
    const input = await sh(command)
    expect([command, AutonomyTable.classify(input).class]).toEqual([command, "D"])
    const [expected, answer] = consentedOf(command)
    expect([command, consented(input)]).toEqual([command, expected])
    expect([command, answerOf(consented(input))]).toEqual([command, answer])
    expect([command, consented(input).class === "D"]).toEqual([command, false])
  }
}

describe("F1b rule 2: the wide launcher reader unwraps, and its deletion check keeps 1.1.0", () => {
  test("positive: a deletion behind a launcher, or by a deleter `rm` is not, keeps its 1.1.0 verdict", async () => {
    await keeps([
      "rimraf dist",
      "npx rimraf dist",
      "pnpm dlx rimraf dist",
      "truncate -s 0 src/a.ts",
      "caffeinate rm src/a.ts",
      "stdbuf -oL rm src/a.ts",
      "rtk rm src/a.ts",
      "nice -n 5 rm src/a.ts",
      "timeout 5 rm -rf src",
    ])
  })

  test("F7: a launcher is not on the allowlist, so a check behind one keeps 1.1.0; `poetry run` of a listed tool opens", async () => {
    await keeps(["caffeinate bun test", "rtk bun test", "timeout 60 bun test", "stdbuf -oL bun run build", "perf stat bun test"])
    // No `node_modules/.bin` here: `npx` and `bun x` would fetch the program, and `uvx` always does.
    await keeps(["npx prettier --write src", "npx vitest run", "bun x prettier --check .", "uvx ruff check"])
    await opens(["poetry run pytest"])
  })
})

describe("F1b rule 3a: a step whose program is a shell keeps 1.1.0", () => {
  test("positive: every shell family running a file keeps its verdict; with -c it waits as `bash -c` does", async () => {
    await keeps(["ksh build.sh", "fish build.sh", "dash build.sh"])
    await heldAs("unreadable_command", ["tcsh -c 'rm x'", "csh -c ls", "watch -n 1 rm x", "hyperfine 'bun test'"])
  })

  test("near miss: a build and the tests run; F7: `watch` is not on the allowlist; F10b: nor `make` or an `echo` script", async () => {
    await opens(["bun test", "bun run build"])
    await keeps(["watch -x bun test", "make build", "bun run echoes"])
  })
})

describe("F1b rule 3b: an interpreter or launcher with inline code or an unscreened script keeps 1.1.0", () => {
  test("positive", async () => {
    await keeps(["node missing.js", "bun run scripts/x.ts", "uv run tool.py", "node -r ./hook.js app.js"])
  })

  test("near miss: a module, a package script; F7: `node` and a screened inline script are not on the allowlist", async () => {
    await opens(["python3 -m pytest", "bun run build", "npm run build"])
    await keeps(["node --version"])
    // Screened inline code with no flag is the decider's P `script` in 1.1.0, and keeps that under consent.
    const screened = await sh(`node -e "console.log(1)"`)
    expect(AutonomyTable.classify(screened)).toMatchObject({ class: "P", category: "script" })
    // 1.1.3 (matrix row 8, spec section 3 rule 5): an undecided P runs as the main agent's under consent.
    expect(consented(screened)).toEqual({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "script" })
    expect(answerOf(consented(screened))).toBeUndefined()
    expect(consented(screened)).toMatchObject({ class: "A", category: "by_main_agent", bypassed: "script" })
  })
})

describe("F1b rule 3c: an alias form it cannot resolve keeps 1.1.0", () => {
  test("positive: git configured inline, an environment that runs an editor, an unknown subcommand", async () => {
    await keeps(["git -c core.editor=vim commit -m x", "env GIT_EDITOR=vim git commit -m x", "git frob"])
  })

  test("near miss: git status, diff, commit and git -C; F7: `git config` is not on the allowlist", async () => {
    await opens([`git commit -m "fix"`, "git commit -m x"])
    await keeps(["git config user.name x"])
    for (const command of ["git status", "git diff", "git -C src status"]) {
      const input = await sh(command)
      expect([command, consented(input)]).toEqual([command, AutonomyTable.classify(input)])
      expect(consented(input).class).toBe("A")
    }
  })
})

describe("F1b rule 3d: an unknown word followed by a risky program keeps 1.1.0", () => {
  test("positive", async () => {
    await keeps(["mytool git push", "mytool dd if=x", "./tools/run vercel"])
  })

  test("near miss: a listed formatter opens; F7: an unknown tool keeps 1.1.0 even with ordinary arguments", async () => {
    await opens(["prettier --write ."])
    await keeps(["mytool build --watch"])
  })
})

describe("F1b rule 3e: a command substitution with anything not understood keeps 1.1.0", () => {
  // The shell reads no substitution word by word, so these come with a reading as another shell might send it.
  const stepped = (command: string, argv: string[]) => sh(command, { steps: { v: 1, steps: [{ argv, cwds: [dir] }], writes: [] } })

  test("positive: an unknown program in a substitution inside quotes", async () => {
    const input = await stepped(`echo "$(mytool --x)"`, ["echo", "$(mytool --x)"])
    expect(BypassScreen.unclear(input, AutonomyTable.classify(input))).toBe("substitution")
    // 1.1.3 (matrix row 22, spec section 3): the kept verdict no longer waits.
    // Literal (T9 G8): the 1.1.0 verdict is A, and an A stays as it is.
    expect(AutonomyTable.classify(input)).toEqual({ class: "A", decidedBy: "gate" })
    expect(consented(input)).toEqual({ class: "A", decidedBy: "gate" })
    expect(answerOf(consented(input))).toBeUndefined()
    const nested = await stepped("echo `rimraf dist`", ["echo", "`rimraf dist`"])
    expect(BypassScreen.unclear(nested, AutonomyTable.classify(nested))).toBe("substitution")
  })

  test("near miss: a known program screened clean in a substitution is understood", async () => {
    const input = await stepped(`echo "$(date)"`, ["echo", "$(date)"])
    expect(BypassScreen.unclear(input, AutonomyTable.classify(input))).toBeUndefined()
  })

  test("the screen's rough split is the table's `commandWords`: an X inside unreadable text is still refused", async () => {
    expect(consented(await sh("echo $(git reset --hard)"))).toEqual({ class: "X", decidedBy: "gate", category: "irreversible" })
    expect(consented(await sh(`x=1; psql -c "drop table users" "$x"`))).toEqual({ class: "X", decidedBy: "gate", category: "irreversible" })
  })
})

describe("F1b rule 4: outward forms, writes outside the folder, SQL from stdin or a file", () => {
  test("positive: an upload or mail waits for a person (outward); 1.1.1 F26 (P42): a publish, image push, deploy, release or pull request opens", async () => {
    await heldAs("outward", ["mail -s hi a@b.c", "sendmail a@b.c", "gh release create v1 dist/x.tgz", "curl -T x https://a.b.io"])
    for (const command of [
      "npm publish",
      "docker push img",
      "vercel --prod",
      // 1.1.1 F30 (P46): netlify opens only without its local build. 1.1.1 F33 (P49 3): with a `--dir` inside the
      // project, and firebase only for hosting.
      "netlify deploy --no-build --dir dist",
      "firebase deploy --only hosting",
      "fly deploy",
      "gh release create v1",
      "gh pr create --fill",
      "twine upload dist/x",
    ]) {
      const verdict = consented(await sh(command))
      expect([command, verdict.class, verdict.category, typeof verdict.destination]).toEqual([command, "A", "by_main_agent", "string"])
    }
  })

  test("near miss: a local install is opened; F7: `docker` is not on the allowlist", async () => {
    await opens(["npm install", "bun install"])
    await keeps(["docker build ."])
  })

  test("positive: linking, a global install, a global config or a system preference is outside_write_held", async () => {
    await heldAs("outside_write_held", [
      "npm link",
      "npm install -g foo",
      "git config --global user.name x",
      "defaults write com.example.f1b k 1",
      "ln -s src/a.ts ~/bin/a",
    ])
  })

  test("F7: a link and a config inside the folder are not on the allowlist and keep 1.1.0", async () => {
    await keeps(["ln -s a.ts src/b.ts", "git config user.name x"])
  })

  test("positive: SQL from a file or stdin keeps 1.1.0; F7: an inline statement does too (no SQL tool is listed)", async () => {
    await keeps(["psql -f x.sql", "psql db", "sqlite3 db", "mysql db"])
    await keeps([`psql -c "select 1" db`, `sqlite3 db "select 1"`])
  })
})

describe("F1b: nothing changes without consent, and the lists have one home", () => {
  test("every F1b fixture is byte-equal to `classifyBase` without consent", async () => {
    const commands = [
      "rimraf dist", "npx rimraf dist", "caffeinate rm src/a.ts", "rtk rm src/a.ts", "ksh build.sh", "tcsh -c 'rm x'",
      "node missing.js", "git -c core.editor=vim commit -m x", "git frob", "mytool git push", "npm publish", "npm link",
      "defaults write com.example.f1b k 1", "psql -f x.sql", "bun test", "caffeinate bun test", "git status",
    ]
    for (const command of commands) {
      const input = await sh(command)
      expect([command, JSON.stringify(AutonomyTable.classify(input))]).toEqual([command, JSON.stringify(AutonomyTable.classifyBase(input))])
    }
  })

  test("the hard script flags are one list, read by the table and the screen", () => {
    expect(AutonomyTable.HARD_SCRIPT_FLAGS).toBe(BypassLists.HARD_SCRIPT_FLAGS)
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/permission/bypass-screen.ts"), "utf8")
    expect(source).not.toContain('new Set(["network", "delete", "sudo", "outside_path"])')
    expect(source).not.toContain("function roughCommands")
  })
})
