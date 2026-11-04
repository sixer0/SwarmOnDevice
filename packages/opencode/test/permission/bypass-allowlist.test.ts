// Swarm 1.1.1 F7 (decision P15): under the person's consent the overlay opens a held shell call only when every step is a
// development command the allowlist recognises, in a form it recognises, and the shell's own reading carries no label.
// Everything else keeps its 1.1.0 verdict; the refusals and the kept-for-person categories still come first. Without
// consent nothing changes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassLists } from "../../src/permission/bypass-lists"
import { BypassScreen } from "../../src/permission/bypass-screen"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

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
  fs.writeFileSync(path.join(dir, "requirements.txt"), "requests\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest", lint: "eslint ." } }))
  // The project's own programs, as an install leaves them.
  fs.mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true })
  for (const bin of ["vitest", "tsc", "eslint", "prettier", "drizzle-kit"]) fs.writeFileSync(path.join(dir, "node_modules/.bin", bin), "")
  // The project's own Python environment.
  fs.mkdirSync(path.join(dir, ".venv"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".venv/pyvenv.cfg"), "home = /usr/bin\n")
  // 1.1.1 F10b: a manifest script is read by the shell's own reader, which starts asynchronously.
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
const allowlisted = (input: Input) => BypassScreen.allowlisted(input, AutonomyTable.classify(input))

/**
 * Each form the allowlist accepts. Where the 1.1.0 table held or judged it, it is now the main agent's; where it was A
 * already it runs as it did (P8).
 */
async function opens(commands: readonly string[]) {
  for (const command of commands) {
    const input = await sh(command)
    const base = AutonomyTable.classify(input)
    expect([command, allowlisted(input)]).toEqual([command, true])
    const expected: AutonomyTable.Verdict =
      base.class === "A" ? base : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: base.category }
    expect([command, consented(input)]).toEqual([command, expected])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

/** A form the allowlist does not accept: the call keeps its 1.1.0 verdict exactly, for the root and a subagent. */
async function keeps(commands: readonly string[], metadata: Record<string, unknown> = {}) {
  for (const command of commands) {
    const input = await sh(command, metadata)
    const base = AutonomyTable.classify(input)
    expect([command, allowlisted(input)]).toEqual([command, false])
    expect([command, base.class === "A"]).toEqual([command, false])
    expect([command, consented(input)]).toEqual([command, base])
    expect([command, subagent(input)]).toEqual([command, base])
  }
}

/** Not on the allowlist; whatever the earlier rules make of it, it is never the main agent's. */
async function notOpened(commands: readonly string[]) {
  for (const command of commands) {
    const input = await sh(command)
    expect([command, allowlisted(input)]).toEqual([command, false])
    expect([command, consented(input).category]).not.toEqual([command, "by_main_agent"])
  }
}

describe("F7: each allowlist entry opens in a plain form", () => {
  test("git: read, branch, switch/checkout of a branch, add, commit, stash, merge, tag, remote, plumbing reads", async () => {
    await opens([
      "git status", "git diff", "git log --oneline -3", "git show HEAD", "git blame src/a.ts", "git branch", "git branch feature",
      "git branch -m old new", "git switch main", "git switch -c feature", "git checkout feature", "git checkout -b feature",
      "git add src/a.ts", "git add -A", `git commit -m "fix"`, "git commit -am fix", "git stash", "git stash push -m wip",
      "git stash list", "git stash show", "git stash apply", "git stash pop", "git merge feature", "git tag v1",
      "git tag -a v1 -m release", "git tag -l", "git remote -v", "git remote show -n origin", "git rev-parse HEAD", "git ls-files",
      "git grep foo", "git describe", "git worktree list", "git -C src status", "git --no-pager log",
    ])
  })

  test("git fetch and pull without rebase or force are on the list, and still wait as `outward` (kept categories first)", async () => {
    for (const command of ["git fetch origin", "git pull origin main"]) {
      const input = await sh(command)
      expect([command, allowlisted(input)]).toEqual([command, true])
      expect([command, consented(input).category]).not.toEqual([command, "by_main_agent"])
    }
  })

  test("package managers: install, test, run of a manifest script, build, exec of the project's own listed program", async () => {
    await opens([
      "bun install", "bun add zod", "bun test", "bun run build", "bun build ./src/a.ts --outdir dist", "bun x vitest run",
      "bunx tsc --noEmit", "npm install", "npm ci", "npm test", "npm run lint", "npm exec vitest run", "npx vitest run",
      "pnpm install", "pnpm add zod", "pnpm test", "pnpm run build", "pnpm build", "pnpm exec tsc", "yarn", "yarn install",
      "yarn add zod", "yarn test", "yarn run build", "yarn build",
    ])
    await opens([
      "pip install -r requirements.txt", "pip3 install requests", "python3 -m pip install requests", "uv sync", "uv add requests",
      "uv pip install requests", "uv run pytest", "poetry install", "poetry add requests", "poetry run pytest",
    ])
    await opens([
      "cargo build", "cargo test", "cargo check", "cargo fmt", "cargo clippy", "go build ./...", "go test ./...", "go vet ./...",
      "go fmt ./...",
    ])
    // 1.1.1 F10b (P19): a make target runs what the makefile says, which nothing reads; it keeps 1.1.0.
    await keeps(["make", "make build", "make -j4 test", "gmake build"])
  })

  test("compilers, type checkers, linters, formatters and test runners invoked directly", async () => {
    await opens([
      "tsc --noEmit", "tsgo --noEmit", "eslint src", "eslint --fix src", "prettier --check .", "biome check src", "ruff check .",
      "black .", "mypy src", "pytest -q", "python -m pytest", "vitest run", "jest", "swift build", "swift test",
      "xcodebuild -scheme App build", "xcodebuild test", "gradle build", "gradle test", "mvn test", "mvn package",
    ])
  })

  test("in-folder file utilities", async () => {
    await opens([
      "mkdir -p src/new", "touch src/e.ts", "ls -la", "cat src/a.ts", "head -5 src/a.ts", "tail -5 src/a.ts", "wc -l src/a.ts",
      "sort src/a.ts", "find . -name '*.ts'", "grep -r foo src", "rg foo src", "sed -n 1,5p src/a.ts", "jq . package.json",
    ])
  })

  test("F10a (m21): `cp` and `mv` are not on the list; each keeps its 1.1.0 verdict exactly, for the root and a subagent", async () => {
    // A copy or move to a new name is A in 1.1.0 already (the shell archives what it would replace); every other form is
    // held as it was.
    for (const command of ["cp src/a.ts src/c.ts", "mv src/a.ts src/d.ts", "cp src/a.ts package.json", "mv -v src/a.ts src/b.ts"]) {
      const input = await sh(command)
      expect([command, allowlisted(input)]).toEqual([command, false])
      expect([command, consented(input)]).toEqual([command, AutonomyTable.classify(input)])
      expect([command, subagent(input)]).toEqual([command, AutonomyTable.classify(input)])
    }
  })
})

describe("F7: the same program with an excluded subcommand or option keeps its 1.1.0 verdict", () => {
  test("git", async () => {
    await keeps([
      // `branch -d`, `branch -f`, `switch -C` and `tag -f` rewrite refs and are refused since F9 (f9-rewrite-external.test.ts).
      "git branch --edit-description", "git checkout src/a.ts", "git checkout src",
      "git checkout -- src/a.ts", "git checkout -f main", "git switch -f main", "git switch --discard-changes main",
      "git commit -e -m x", "git commit --template x.txt", "git stash branch x",
      "git merge -s ours feature", "git tag -e v1", "git remote rename a b", "git worktree add x",
      "git diff --ext-diff", "git log --output=out.txt", "git grep -O foo", "git -c core.pager=less status",
      "git config user.name x", "git cherry-pick abc", "git revert abc", "git restore src/a.ts",
    ])
    await notOpened(["git pull --rebase origin main", "git pull --force", "git fetch --upload-pack=x origin", "git tag -d v1"])
  })

  test("git commit --amend is refused as irreversible since F9; a fixup commit only adds one and keeps its 1.1.0 verdict", async () => {
    expect(consented(await sh("git commit --amend -m x"))).toEqual({ class: "X", decidedBy: "gate", category: "irreversible" })
    await keeps(["git commit --fixup=amend:HEAD"])
  })

  test("package managers", async () => {
    await keeps([
      "bun test --preload ./x.ts", "bun run scripts/x.ts", "bun run deploy", "bun x drizzle-kit push", "bun x missing",
      "bun pm cache rm", "npm run deploy", "npx -p x y", "npx drizzle-kit push", "pnpm dlx x", "yarn dlx x", "bun add file:../x",
      "pip uninstall x", "uv run python x.py",
      "poetry run python x.py", "cargo run", "cargo build --config x", "go run .", "go test -exec x ./...",
      "go build -toolexec x", "go generate", "make -f other.mk", "make CC=gcc", "make --eval=x", "make -E x",
    ])
    // A global or user install is outside_write_held before the allowlist is read.
    await notOpened(["uv tool install x", "pip install --user x", "pip install --target vendor x", "bun install -g x", "npm install -g x", "npm exec --package=x y", "yarn global add x", "cargo install x"])
    // 1.1.1 F26 (P42): `poetry publish` is a publish the consent lets out (f26-outward.test.ts).
  })

  test("compilers, linters, formatters and test runners", async () => {
    await keeps([
      "eslint --rulesdir x src", "eslint -c x.js src", "prettier --plugin x .", "pytest -p x", "pytest -o addopts=x", "vitest --config x",
      "jest --setupFiles x", "mypy --python-executable x src", "xcodebuild clean build", "xcodebuild archive", "gradle -I x.gradle build",
      "mvn -Dexec.executable=x test", "swift run",
    ])
    // A publish or deploy is `outward` before the allowlist is read.
    await notOpened(["mvn install", "mvn deploy", "gradle publish", "gradle assembleRelease publish"])
  })

  test("file utilities", async () => {
    await keeps(["sort -o out.txt src/a.ts", "rg --pre x foo", "sed -n 'w out' src/a.ts", "sed -n '1e ls' src/a.ts"])
    await notOpened([
      "cp -f src/a.ts src/b.ts", "mv -f src/a.ts src/b.ts", "find . -exec ls {} ;", "find . -delete", "mkdir /tmp/f7-outside",
      "cat ~/.ssh/config", "ls ../..", "sed -i s/a/b/ src/a.ts",
    ])
  })
})

describe("F7: a program that is not on the list keeps its 1.1.0 verdict", () => {
  test("unknown programs, launchers, a program by a path outside the system folders", async () => {
    await keeps([
      "docker build .", "mytool build", "deno test", "rake test", "env CI=1 bun test", "timeout 5 bun test", "./node_modules/.bin/vitest run",
      "node app.js", "python3 tool.py", "java -jar x.jar",
    ])
    expect(Object.hasOwn(BypassLists.ALLOWLIST, "constructor")).toBe(false)
    expect(Object.hasOwn(BypassLists.ALLOWLIST, "__proto__")).toBe(false)
    await keeps(["constructor x", "__proto__ x"])
  })

  test("a listed program by a system path opens", async () => {
    await opens(["/opt/homebrew/bin/cargo build", "/usr/bin/git status"])
    await keeps(["/tmp/bin/cargo build"])
  })

  test("an assignment before the program: the shell gives no reading for one; only a safe one is read through", async () => {
    // With no reading the screen holds the text as unreadable (rule 6), before the allowlist is read. 1.1.1 F40 (P56
    // item 7): a one-program text whose leading assignments are all safe, with plain values, is read word by word.
    await notOpened(["NODE_OPTIONS=--require=./x.js bun test"])
    expect(allowlisted(await sh("CI=1 bun test"))).toBe(true)
    const reading = (argv: string[]) =>
      sh(argv.join(" "), { steps: { v: 1, steps: [{ argv, cwds: [dir] }], writes: [] } })
    expect(allowlisted(await reading(["CI=1", "NODE_ENV=test", "bun", "test"]))).toBe(true)
    expect(allowlisted(await reading(["NODE_OPTIONS=--require=./x.js", "bun", "test"]))).toBe(false)
    expect(allowlisted(await reading(["PATH=./bin:/usr/bin", "make"]))).toBe(false)
    expect(allowlisted(await reading(["GIT_SSH_COMMAND=x", "git", "status"]))).toBe(false)
  })
})

describe("F7: the shell's own labels keep 1.1.0 whatever the words", () => {
  test("`irreversible` and `remote` labels", async () => {
    await keeps(["bun test", "make build", "git status --short"], { risk: "irreversible" })
    for (const command of ["bun test", "make build"]) {
      const input = await sh(command, { risk: "remote" })
      expect([command, allowlisted(input)]).toEqual([command, false])
      expect([command, consented(input).category]).not.toEqual([command, "by_main_agent"])
    }
  })

  test("a redirect writing outside the folder, a folder outside, a step running outside, an archive offer", async () => {
    const outside = await sh("bun test", { steps: { v: 1, steps: [{ argv: ["bun", "test"], cwds: [dir] }], writes: ["/tmp/f7-out.txt"] } })
    expect(allowlisted(outside)).toBe(false)
    const away = await sh("bun test", { steps: { v: 1, steps: [{ argv: ["bun", "test"], cwds: ["/tmp"] }], writes: [] } })
    expect(allowlisted(away)).toBe(false)
    expect(allowlisted({ ...(await sh("bun test")), permission: "external_directory" })).toBe(false)
    expect(allowlisted(await sh("bun test", { archive: true }))).toBe(false)
    // A redirect inside the folder is the shell's own write rule's (1.1.0); the step itself is listed.
    const inside = await sh("bun test", { steps: { v: 1, steps: [{ argv: ["bun", "test"], cwds: [dir] }], writes: [path.join(dir, "out.txt")] } })
    expect(allowlisted(inside)).toBe(true)
  })

  test("a program the shell would find inside the project is not the recognised one", () => {
    const input: Input = {
      permission: "bash",
      patterns: ["make"],
      metadata: { command: "make" },
      instance,
      cwd: dir,
      canUndo: true,
      folder: "clean",
    }
    expect(BypassScreen.allowlisted(input, { class: "D", decidedBy: "gate", category: "program_not_trusted" })).toBe(false)
  })
})

describe("F7: compounds", () => {
  test("a compound of allowed steps opens", async () => {
    for (const command of ["bun install && bun run build", "git add src/a.ts && git commit -m x", "bun test; cargo build", "cd src && bun test"]) {
      const verdict = consented(await sh(command))
      expect([command, verdict.class, verdict.category]).toEqual([command, "A", "by_main_agent"])
      expect([command, subagent(await sh(command)).category]).toEqual([command, "by_main_agent"])
    }
  })

  test("a compound with one unlisted step keeps its 1.1.0 verdict", async () => {
    await keeps(["bun install && docker build .", "bun test; mytool x", "git add -A && git config user.name x", "make && node app.js"])
  })
})

describe("F7: nothing changes without consent", () => {
  test("every fixture here is byte-equal to `classifyBase` without consent", async () => {
    const commands = [
      "git status", "git checkout feature", "git checkout src/a.ts", "bun install", "bun run build", "bun run deploy", "npx vitest run",
      "pip install requests", "uv run pytest", "make build", "make CC=gcc", "docker build .", "bun install && bun run build",
      "bun install && docker build .", "sed -n 1,5p src/a.ts",
    ]
    for (const command of commands) {
      const input = await sh(command)
      expect([command, JSON.stringify(AutonomyTable.classify(input))]).toEqual([command, JSON.stringify(AutonomyTable.classifyBase(input))])
    }
  })
})
