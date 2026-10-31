import { describe, expect, test } from "bun:test"
import { Risk } from "../../src/tool/risk"
import { Secrets } from "../../src/tool/secrets"
import { FileSeen } from "../../src/tool/file-seen"
import { Permission } from "../../src/permission"
import { PERMISSION_BASELINE } from "@opencode-ai/core/swarm-permission-baseline"

const kind = (command: string): string => {
  const verdict = Risk.classify(command.split(" "))
  return verdict.kind === "risky" ? verdict.risk : verdict.kind
}

describe("Risk.classify", () => {
  test.each([
    ["git push --force origin main", "irreversible"],
    ["git push -f", "irreversible"],
    ["git push origin +main", "irreversible"],
    ["git push origin :main", "irreversible"],
    ["git push --force-with-lease", "irreversible"],
    ["git push --force origin $BRANCH", "irreversible"],
    ["git reset --hard HEAD~3", "irreversible"],
    ["git branch -D feature", "irreversible"],
    ["git stash drop", "irreversible"],
    ["git clean -fdx", "irreversible"],
    ["git filter-branch --all", "irreversible"],
    ["dd if=/dev/zero of=/dev/disk2", "irreversible"],
    ["chmod -R 777 .", "irreversible"],
    ["dropdb orders", "irreversible"],
    ["redis-cli FLUSHALL", "irreversible"],
    ["git push origin main", "remote"],
    ["npm publish", "remote"],
    ["terraform destroy", "remote"],
    ["kubectl delete pod x", "remote"],
  ])("%s is %s", (command, expected) => {
    expect(kind(command)).toBe(expected)
  })

  test("SQL that wipes data is caught inside its quoted argument", () => {
    expect(Risk.classify(["psql", "-c", "DROP TABLE orders"])).toEqual({ kind: "risky", risk: "irreversible" })
    expect(Risk.classify(["psql", "-c", "SELECT 1"])).toEqual({ kind: "unknown" })
  })

  test.each(["ls src", "cat README.md", "grep -rn total src", "find src -name x", "echo hi", "pwd", "git status", "constructor", "__proto__ x"])(
    "%s gets no label: it says nothing about being safe, and a prompt still asks",
    (command) => expect(kind(command)).toBe("unknown"),
  )

  test.each(["git add -A", "git commit -m x", "git reset --hard", "git reset --hard HEAD", "git checkout -- .", "git clean -fd", "git mv a b", "git restore --source=b a", "rm -rf dist", "mv a b", "cp a b", "mkdir -p src/lib", "touch x"])(
    "%s changes files",
    (command) => expect(kind(command)).toBe("undoable"),
  )

  // Nothing says these are safe: config, hooks, worktree config, HOME and the environment each make git run a program.
  test.each([
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff",
    "git show",
    "git blame a",
    "git rev-parse HEAD",
    "git ls-files",
    "git branch",
    "git tag",
    "git remote -v",
    "git config --get a.b",
    "git stash list",
    "git --version",
    "git",
  ])("%s keeps its prompt", (command) => expect(kind(command)).toBe("unknown"))

  // The allowlist is the safety property: everything below must keep its normal permission rule.
  test.each([
    "find . -delete",
    "find . -exec rm {} ;",
    "find -Ls .",
    "find . -follow",
    "sort -o out in",
    "sort -uo out in",
    "sort --out=out in",
    "sort --compress=sh in",
    "rg --pre evil x",
    "rg x",
    "printf hi",
    "printf -v HOME .",
    "printenv",
    "printenv X",
    "jq . a",
    "cut -c1 a",
    "diff a b",
    "stat a",
    "file a",
    "du .",
    "df",
    "which ls",
    "tree",
    "sleep 1",
    "basename a",
    "realpath a",
    "grep -o . a",
    "grep -ro . .",
    "grep -S x .",
    "grep -R x .",
    "grep -O x .",
    "grep -f list x",
    "grep --file=/etc/hosts x",
    "grep -f/etc/hosts x",
    "grep --include=a x .",
    "head -c 5 a",
    "tail -c5 a",
    "tail -f a",
    "cat -",
    "cat -- a",
    "ls -L",
    "ls -LR .",
    "ls --color",
    "uniq a b",
    "test -n x",
    "test -f",
    "test a = b",
    "true x",
    "pwd -x",
    "constructor",
    "toString",
    "hasOwnProperty",
    "__proto__",
    "git -c core.pager=evil log",
    "git fetch",
    "git rebase main",
    "git merge main",
    "git pull",
    "sed -i s/a/b/ file",
    "awk {system(x)} f",
    "xargs rm",
    "env FOO=1 rm -rf x",
    "bash -c rm",
    "sh deploy.sh",
    "python3 x.py",
    "curl https://example.com",
    "rm -rf $TARGET",
    "rm *.log",
    "cat $(which x)",
    "./ls",
    "/tmp/ls",
    "/bin/cat a",
    "g''it push",
  ])("%s is not recognised as safe", (command) => {
    expect(kind(command)).toBe("unknown")
  })

  test.each([
    ["git commit --am -m x", "irreversible"],
    ["git reset --har main", "irreversible"],
    ["git reset main", "irreversible"],
    ["git reset v1.0", "irreversible"],
    ["git reset feat/old", "irreversible"],
    ["git branch -qD x", "irreversible"],
    ["git branch -C a b", "irreversible"],
    ["git switch --force-c main HEAD~1", "irreversible"],
    ["git -C . push --force", "irreversible"],
    ["git -c a=b push -f", "irreversible"],
    ["git --no-pager reset --hard HEAD~1", "irreversible"],
    ["/usr/bin/git push -f", "irreversible"],
    ["/usr/bin/dropdb x", "irreversible"],
  ])("however %s is spelled it is %s", (command, expected) => expect(kind(command)).toBe(expected))

  test("a move or remove takes away what it names, a copy only what it lands on", () => {
    expect(Risk.classify(["rm", "-rf", "a", "b"])).toEqual({ kind: "undoable", paths: ["a", "b"], removes: true })
    expect(Risk.classify(["cp", ".env", "backup/.env"])).toEqual({ kind: "undoable", paths: ["backup/.env"], removes: false })
  })

  test("files that change what runs or what is allowed are not plain edits", () => {
    for (const file of [
      ".git/hooks/pre-commit",
      ".git",
      ".gitconfig",
      "sub/.gitconfig",
      ".git/config.worktree",
      ".husky/pre-push",
      "swarm.json",
      "packages/x/swarm.jsonc",
      ".swarm/agents/a.md",
      ".swarm/plugin/x.ts",
      ".github/workflows/ci.yml",
      "AGENTS.md",
      "packages/x/CLAUDE.md",
      ".claude/settings.json",
      ".bashrc",
      ".zshenv",
      ".profile",
      ".envrc",
      ".direnv/x",
      ".npmrc",
      ".curlrc",
      "bunfig.toml",
      ".tool-versions",
      "package.json",
      "packages/x/package.json",
      "Makefile",
      "sub/GNUmakefile",
      "rules.mk",
      "justfile",
      "Cargo.toml",
      "build.rs",
      "pyproject.toml",
      "setup.py",
      "conftest.py",
      "Dockerfile",
      "Dockerfile.dev",
      "docker-compose.yml",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      "Jenkinsfile",
      ".pre-commit-config.yaml",
      ".vscode/tasks.json",
      ".vscode/settings.json",
      ".idea/workspace.xml",
      "app.code-workspace",
      ".devcontainer/devcontainer.json",
      "vite.config.ts",
      "eslint.config.mjs",
      ".eslintrc.js",
      ".config/git/config",
      ".cargo/config.toml",
    ])
      expect([file, Risk.sensitive(file)]).toEqual([file, true])
    for (const file of ["src/orders.ts", "docs/.github.md", "README.md", "src/config.ts", "package.ts", "src/makefile.ts"])
      expect([file, Risk.sensitive(file)]).toEqual([file, false])
  })

  test("an edit with nobody asked is for what plainly is a project's own source and content", () => {
    for (const file of ["src/orders.ts", "src/config.ts", "src/hooks/useFoo.tsx", "lib/a.py", "main.go", "README.md", "docs/guide.md", "notes.txt", "src/i18n/en.json", "test/fixtures/a.yaml", "styles/app.css", "packages/x/src/index.ts"])
      expect([file, Risk.ordinaryEdit(file)]).toEqual([file, true])
    for (const file of [
      // What the gates found, one name at a time.
      "tui.json", "tui.jsonc", ".swarm/tui.json", "CONTEXT.md", ".agents/skills/x/SKILL.md", ".gitignore",
      "composer.json", "composer.lock", "mix.exs", ".formatter.exs", "Containerfile", "Earthfile", "Vagrantfile", "Tiltfile", "Procfile",
      "gradlew", "mvnw", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties", "Directory.Build.props", "x.csproj", "Package.swift",
      "Podfile", "build.sbt", "x.pth", ".rspec", ".rubocop.yml", "tsconfig.json", "packages/x/tsconfig.base.json", ".devcontainer.json", ".pdbrc",
      ".ipython/profile_default/startup/a.py", "jest.config.json", "vitest.workspace.ts", ".pnp.cjs", "rust-toolchain.toml", "WORKSPACE",
      "BUILD.bazel", ".bazelrc", "requirements.txt", "requirements-dev.txt", "uv.lock", "Gemfile.lock", "gems.rb", ".terraformrc",
      // Every place that loads something.
      ".swarm/plugin/x.ts", ".swarm/tool/x.ts", ".swarm/agent/x.md", ".swarm/command/x.md", ".swarm/skill/x/SKILL.md", ".opencode/plugin/x.ts", ".claude/skills/x/SKILL.md",
      // Source a tool runs by its name or its place.
      "vite.config.ts", "conftest.py", "setup.py", "build.rs", "node_modules/x/index.js", "vendor/x/a.php", "venv/lib/a.py",
      // Data formats anywhere else double as configuration.
      "config.json", "settings.yaml", "x.toml", "scripts/run.sh", "Makefile", "bin/tool",
    ])
      expect([file, Risk.ordinaryEdit(file)]).toEqual([file, false])
  })

  test("a disk that ignores case, or skips characters, opens the same file under another name", () => {
    for (const file of [
      ".GIT/config",
      ".Git/hooks/pre-commit",
      "SWARM.JSON",
      "packages/x/Swarm.JSONC",
      ".GitHub/workflows/y.yml",
      ".HUSKY/pre-commit",
      ".SWARM/command/y.md",
      ".OPENCODE/x",
      ".GITATTRIBUTES",
      ".GITCONFIG",
      "MAKEFILE",
      "PACKAGE.JSON",
      ".g\u200cit/config",
      ".git./config",
      ".git /config",
      "git~1/config",
      ".git::$INDEX_ALLOCATION/config",
      "\u017fwarm.json",
      ".hu\u017fky/pre-commit",
      ".\u017fwarm/command/y.md",
    ])
      expect([file, Risk.sensitive(file)]).toEqual([file, true])
  })
})

describe("harmless calls under the shipped baseline", () => {
  const rules = Permission.fromConfig(PERMISSION_BASELINE as never)
  test("a person's own catch-all is not the baseline's", () => {
    const { USER_CATCH_ALL } = Permission
    expect(Permission.isShippedCatchAll(Permission.evaluate("edit", "src/a.ts", rules))).toBe(true)
    const own = Permission.fromConfig({ "*": "ask", [USER_CATCH_ALL]: true } as never)
    expect(Permission.isShippedCatchAll(Permission.evaluate("edit", "src/a.ts", own))).toBe(false)
    expect(Permission.isShippedCatchAll({ permission: "*", pattern: "*", action: "ask" })).toBe(false)
  })

  test("every native agent, subagents included, sees the git tool and reads with it unprompted", () => {
    const explore = Permission.merge(Permission.fromConfig({ "*": "deny", grep: "allow", read: "allow" }), rules)
    expect(Permission.disabled(["git"], explore).size).toBe(0)
    expect(Permission.isShippedCatchAll(Permission.evaluate("git", "status", explore))).toBe(true)
    // A person who wants it off can have that.
    expect(Permission.disabled(["git"], Permission.merge(rules, Permission.fromConfig({ git: "deny" }))).has("git")).toBe(true)
  })

  test("the baseline's catch-all is what a harmless call skips, and a named rule is not", () => {
    expect(Permission.evaluate("edit", "src/a.ts", rules).permission).toBe("*")
    expect(Permission.evaluate("bash", "curl x", rules).permission).toBe("bash")
    expect(Permission.evaluate("bash", "sudo rm", rules).action).toBe("deny")
  })
})

describe("Secrets", () => {
  test("well-known credential files are secret by name", () => {
    for (const file of [".pypirc", ".dockercfg", ".docker/config.json", ".kube/config", "kubeconfig", "terraform.tfvars", "x.tfstate", ".htpasswd", "token.txt", "wp-config.php", "application.properties", "application-prod.properties", "appsettings.json", "appsettings.Production.json", "secrets/prod.txt", ".secrets", "config/prod.env.bak"])
      expect([file, Secrets.secretFile(file)]).toEqual([file, true])
    for (const file of ["src/secrets/manager.ts", "src/token.ts", "appsettings.ts", "docs/application.md", ".env.example", "src/vite.env.d.ts", "src/app.env.ts"])
      expect([file, Secrets.secretFile(file)]).toEqual([file, false])
  })

  test("a password written out is hidden in any file, and code that handles one is left alone", () => {
    expect(Secrets.scrub("password=hunter2hunter2xy\n", "/nonexistent")).toBe("password=[hidden:password]\n")
    expect(Secrets.scrub('db_password: "Tr0ub4dor3x"', "/nonexistent")).toContain("[hidden:password]")
    for (const code of ["password = req.body.password", "password: string", "const password = await ask()", "pwd=$(pwd)"])
      expect(Secrets.scrub(code, "/nonexistent")).toBe(code)
  })

  test("masks secret values by name and by shape, and leaves plain settings readable", () => {
    expect(Secrets.maskLine("API_KEY=abc")).toBe("API_KEY=[hidden:API_KEY]")
    expect(Secrets.maskLine('export DB_PASSWORD="hunter2"')).toBe("export DB_PASSWORD=[hidden:DB_PASSWORD]")
    expect(Secrets.maskLine("DATABASE_URL=postgres://u:pw@db/x")).toBe("DATABASE_URL=postgres://u:[hidden:password]@db/x")
    expect(Secrets.maskLine("SESSION_TTL=3600")).toBe("SESSION_TTL=3600")
    expect(Secrets.maskLine("AUTH_URL=https://auth.example.com/login")).toBe("AUTH_URL=https://auth.example.com/login")
    expect(Secrets.maskLine("PORT=3000")).toBe("PORT=3000")
    expect(Secrets.maskLine("NODE_ENV=production")).toBe("NODE_ENV=production")
    expect(Secrets.maskLine("API_URL=https://api.example.com")).toBe("API_URL=https://api.example.com")
    expect(Secrets.maskLine("NEXT_PUBLIC_KEY=pk_abc")).toBe("NEXT_PUBLIC_KEY=pk_abc")
    expect(Secrets.maskLine("# API_KEY=old")).toBe("# API_KEY=old")
  })

  test("knows which files hold secrets", () => {
    for (const file of [".env", ".env.local", "a/.env.production", "prod.env", ".npmrc", "id_rsa", "cert.pem", "x.key", "credentials.json", ".env-prod", ".env_prod", ".envs/prod", ".ENV", ".NPMRC", ".ENVRC", "A/.Env.Local", ".NETRC", "CREDENTIALS", "config/secrets.yaml", "config/credentials.yml"])
      expect(Secrets.secretFile(file)).toBe(true)
    for (const file of [".env.example", ".env-prod.example", ".environment", "env.ts", ".env.sample", "environment.ts", "README.md"]) expect(Secrets.secretFile(file)).toBe(false)
  })

  test("recognises credentials wherever they turn up in output", () => {
    const root = "/nonexistent-trust-test"
    const out = Secrets.scrub(
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 key sk-ant-abcdefghijklmnopqrstuv aws AKIAIOSFODNN7EXAMPLE conn postgres://orders:s3cret@db/x done",
      root,
    )
    for (const leak of ["ghp_abc", "sk-ant", "AKIAIOSF", "s3cret"]) expect(out).not.toContain(leak)
    expect(out).toContain("postgres://orders:[hidden:password]@db/x")
    expect(Secrets.scrub("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", root)).toBe("[hidden:private-key]")
    expect(Secrets.scrub("nothing to see, port 3000", root)).toBe("nothing to see, port 3000")
  })

  test("hides secret values held in the environment, not paths", () => {
    process.env.TRUST_TEST_TOKEN = "tok_abc123def456"
    process.env.TRUST_TEST_AUTH_SOCK = "/tmp/agent.sock"
    try {
      const root = "/nonexistent-trust-env-" + Math.random()
      expect(Secrets.scrub("value tok_abc123def456 at /tmp/agent.sock", root)).toBe("value [hidden:TRUST_TEST_TOKEN] at /tmp/agent.sock")
    } finally {
      delete process.env.TRUST_TEST_TOKEN
      delete process.env.TRUST_TEST_AUTH_SOCK
    }
  })

  test("text with no project to look in still loses what is plainly a secret", () => {
    for (const [text, leak] of [
      ["API_KEY=INPUTsecretVALUEddd444 echo hi", "INPUTsecretVALUEddd444"],
      ["use the token TYPEDsecretVALUEeee555 please", "TYPEDsecretVALUEeee555"],
      ["db pass is hunter2hunter2 on db.internal", "hunter2hunter2"],
      ["password=abc", "abc"],
      ["sk_live_a1b2c3d4e5f6g7h8", "sk_live"],
    ] as const)
      expect(Secrets.scrubText(text)).not.toContain(leak)
    for (const text of ["the token parser lives in src/lexer.ts", "password reset emails go out", "key = item.id", "commit 9240f3eb7e5d1a2b3c4d5e6f7a8b9c0d1e2f3a4b"])
      expect(Secrets.scrubText(text)).toBe(text)
  })

  test("refuses to write a placeholder over a real value", () => {
    expect(() => Secrets.assertNoPlaceholder("KEY=[hidden:KEY]\n", "KEY=real\n", ".env")).toThrow("Not written")
    expect(() => Secrets.assertNoPlaceholder("note [hidden:KEY]\nb", "note [hidden:KEY]\n", "a.md")).not.toThrow()
    expect(() => Secrets.assertNoPlaceholder("plain\n", "", "a.md")).not.toThrow()
  })
})

describe("FileSeen", () => {
  const file = (name: string) => `/virtual/${name}-${Math.random()}`
  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n"

  test("keeps both agents' changes when they touch different lines", () => {
    const path = file("merge")
    FileSeen.record("a", path, base)
    const theirs = base.replace("one", "ONE")
    const ours = base.replace("eight", "EIGHT")
    const decision = FileSeen.decide({ session: "a", file: path, label: "x", current: theirs, next: ours })
    expect(decision).toEqual({ text: "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n", merged: true })
  })

  test("refuses when both changed the same lines, and shows what changed", () => {
    const path = file("conflict")
    FileSeen.record("a", path, base)
    const decision = FileSeen.decide({ session: "a", file: path, label: "x.ts", current: base.replace("two", "2"), next: base.replace("two", "II") })
    if (!("refused" in decision)) throw new Error("expected a refusal")
    expect(decision.refused).toContain("Not written: x.ts changed")
    expect(decision.refused).toContain("+2")
  })

  test("refuses a blind overwrite of what another agent wrote, but not of an untouched file", () => {
    const path = file("blind")
    FileSeen.wrote("a", path, "from a\n")
    const other = FileSeen.decide({ session: "b", file: path, label: "x", current: "from a\n", next: "from b\n" })
    expect("refused" in other).toBe(true)
    expect(FileSeen.decide({ session: "a", file: path, label: "x", current: "from a\n", next: "again\n" })).toEqual({ text: "again\n", merged: false })
    expect(FileSeen.decide({ session: "b", file: file("untouched"), label: "x", current: "old\n", next: "new\n" })).toEqual({ text: "new\n", merged: false })
  })

  test("writes straight through when nothing moved, or the file is gone", () => {
    const path = file("same")
    FileSeen.record("a", path, base)
    expect(FileSeen.decide({ session: "a", file: path, label: "x", current: base, next: "new" })).toEqual({ text: "new", merged: false })
    expect(FileSeen.decide({ session: "a", file: path, label: "x", current: undefined, next: "new" })).toEqual({ text: "new", merged: false })
  })

  test("explains a missing edit target when the file moved on", () => {
    const path = file("note")
    FileSeen.record("a", path, base)
    expect(FileSeen.changedNote("a", path, base)).toBe("")
    expect(FileSeen.changedNote("a", path, "other")).toContain("changed after you last read it")
  })
})
