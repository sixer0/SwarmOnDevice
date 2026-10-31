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

  test.each(["ls src", "cat README.md", "git status --short", "git log --oneline -5", "git diff", "grep -r total src", "git fetch"])(
    "%s only reads",
    (command) => expect(kind(command)).toBe("harmless"),
  )

  test.each(["git add -A", "git commit -m x", "git reset --hard", "git reset --hard HEAD", "git checkout -- .", "git clean -fd", "rm -rf dist", "mv a b", "cp a b", "mkdir -p src/lib", "touch x"])(
    "%s changes only what a snapshot restores",
    (command) => expect(kind(command)).toBe("undoable"),
  )

  // The allowlist is the safety property: everything below must keep its normal permission rule.
  test.each([
    "find . -delete",
    "find . -exec rm {} ;",
    "sort -o out in",
    "rg --pre evil x",
    "git diff --output=/tmp/x",
    "git -c core.pager=evil log",
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
    "g''it push",
  ])("%s is not recognised as safe", (command) => {
    expect(kind(command)).toBe("unknown")
  })

  test("a move or remove takes away what it names, a copy only what it lands on", () => {
    expect(Risk.classify(["rm", "-rf", "a", "b"])).toEqual({ kind: "undoable", paths: ["a", "b"], removes: true })
    expect(Risk.classify(["cp", ".env", "backup/.env"])).toEqual({ kind: "undoable", paths: ["backup/.env"], removes: false })
  })

  test("files that change what runs or what is allowed are not plain edits", () => {
    for (const file of [".git/hooks/pre-commit", ".git", ".husky/pre-push", "swarm.json", "packages/x/swarm.jsonc", ".swarm/agents/a.md", ".github/workflows/ci.yml"])
      expect(Risk.sensitive(file)).toBe(true)
    for (const file of ["src/orders.ts", "package.json", "docs/.github.md"]) expect(Risk.sensitive(file)).toBe(false)
  })
})

describe("harmless calls under the shipped baseline", () => {
  const rules = Permission.fromConfig(PERMISSION_BASELINE as never)
  test("the baseline's catch-all is what a harmless call skips, and a named rule is not", () => {
    expect(Permission.evaluate("edit", "src/a.ts", rules).permission).toBe("*")
    expect(Permission.evaluate("bash", "curl x", rules).permission).toBe("bash")
    expect(Permission.evaluate("bash", "sudo rm", rules).action).toBe("deny")
  })
})

describe("Secrets", () => {
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
    for (const file of [".env", ".env.local", "a/.env.production", "prod.env", ".npmrc", "id_rsa", "cert.pem", "x.key", "credentials.json"])
      expect(Secrets.secretFile(file)).toBe(true)
    for (const file of [".env.example", ".env.sample", "env.ts", "environment.ts", "README.md"]) expect(Secrets.secretFile(file)).toBe(false)
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
