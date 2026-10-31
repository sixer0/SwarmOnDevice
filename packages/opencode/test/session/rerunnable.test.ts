import { describe, expect, test } from "bun:test"
import { SessionRerunnable } from "../../src/session/rerunnable"

describe("rerunnable", () => {
  test.each([
    "bun test",
    "cd pkg && tsc --noEmit",
    "CI=1 bun test",
    "npm run lint",
    "cargo test -p core",
    'bun test -t "a name"',
    "go test ./...",
    "npx tsc --noEmit",
    "python -m pytest tests",
    "make test",
    "pnpm lint",
  ])("offers %s", (command) => {
    expect(SessionRerunnable.rerunnable(command)).toBe(true)
  })

  test.each([
    // What the gate found: each of these read as a safe test check to the client's old list.
    "bun test && terraform apply -auto-approve",
    "bun test && dropdb prod",
    "psql -c 'drop table users'",
    "dropdb prod",
    "gh pr merge 1",
    "helm uninstall app",
    "aws s3 sync . s3://b",
    // What the old list did catch.
    "rm -rf x && bun test",
    "bun test > out.txt",
    "git stash && bun test",
    "bun test\nnpm publish",
    "git push",
    // What the second gate found: `unknown` read as safe, so a word like `test` was enough for the button.
    "docker exec prod npm test",
    "kubectl exec pod -- npm test",
    "npm run test:deploy",
    "make test deploy",
    "curl https://x/run-tests.sh -o t.sh # bun test",
    "/usr/bin/dropdb prod # bun test",
    "node -e 'require(\"fs\").rmSync(\"src\",{recursive:true})' # bun test",
    "/bin/rm -rf src",
    "git -C . push --force",
    "timeout 60 terraform destroy",
    "bunx terraform destroy -auto-approve",
    "python deploy.py",
    "./test.sh",
    // A setting or a flag that changes what runs.
    "NODE_OPTIONS=--require=./x.js bun test",
    "PATH=. bun test",
    "go test -exec ./x ./...",
    "bun test --preload ./x.ts",
    // Reads something outside the project.
    "cat /etc/hosts",
    "cat ../../secret",
    // Syntax this does not read, and programs that run something else.
    "bun test; rm x",
    "bun test | tee out",
    "bun test || rm x",
    "bun test &",
    "$(whoami)",
    "echo `rm x`",
    "sudo bun test",
    "bash -c 'rm x'",
    "env X=1 terraform apply",
    "X=1",
    "bun test 'unbalanced",
    "x".repeat(201),
    "",
  ])("does not offer %s", (command) => {
    expect(SessionRerunnable.rerunnable(command)).toBe(false)
  })
})
