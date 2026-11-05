// 1.1.3 decision T9 (rows 10 and 11 follow-ups, G1-G6), on the consented path, at the table, for the root and for a
// subagent. Each case states its expected verdict literally (no oracle computed by the code under test). The path without
// consent is pinned too: every case keeps the 1.1.0 verdict row 11 recorded before these fixes (probe1.txt, probe2.txt).
// - G1: a shell's `-c` text and an `eval` are unwrapped and the inner command is judged; text that cannot be read but names
//   a deletion or an irreversible action gets ARCHIVE_FIRST.
// - G2: a project script run by name has its body expanded for deletions; a body that deletes gets ARCHIVE_FIRST.
// - G3: a cloud or remote resource deletion gets IRREVERSIBLE_ARCHIVE.
// - G4: git that discards uncommitted work gets ARCHIVE_FIRST when no Undo snapshot covers it or it acts outside.
// - G5: deleting the person's configuration outside the project gets ARCHIVE_FIRST.
// - G6: an append `>>` is never a replace; another `>` in the text (2>/dev/null, ->, awk) does not make it one.
// G7 (the gate) is in f113-gate-g7.test.ts; the report's Open issues listing is at the end of this file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassScreen } from "../../src/permission/bypass-screen"
import { ARCHIVE_FIRST_TEXT, IRREVERSIBLE_ARCHIVE_TEXT, consentedRefusalText } from "../../src/permission/autonomy-texts"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { AutonomyReport } from "../../src/session/autonomy-report"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let outside: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  await ScriptReader.prepare()
  fixture = await tmpdir({ git: true })
  outside = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor; git config --unset commit.gpgsign; true`.cwd(dir).quiet().nothrow()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "notes.txt"), "n\n")
  fs.writeFileSync(path.join(dir, "out.txt"), "o\n")
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        wipe: "rm -rf src",
        out: "rm -rf ../elsewhere",
        clean: "rimraf dist",
        prebuild: "rm -rf dist",
        build: "tsc -p .",
        inner: "bash -c 'rm -rf src'",
        hard: "git reset --hard",
        nuke: "kubectl delete ns prod",
        copy: "cp notes.txt copy.txt",
        lint: "eslint .",
        net: "curl https://x.example",
      },
    }),
  )
  await $`git add -A && git -c user.email=a@b -c user.name=a commit -qm i`.cwd(dir).quiet().nothrow()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
  await outside[Symbol.asyncDispose]()
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
const short = (verdict: Verdict) => ({
  class: verdict.class,
  category: verdict.category,
  ...(verdict.bypassed !== undefined && { bypassed: verdict.bypassed }),
})

const ARCHIVE = (bypassed: string) => ({ class: "X", category: "not_reversible", bypassed })
const IRREVERSIBLE = (bypassed?: string) => ({ class: "X", category: "irreversible", ...(bypassed && { bypassed }) })
const RUNS = (bypassed: string) => ({ class: "A", category: "by_main_agent", bypassed })
const HELD = (category: string) => ({ class: "D", category })

/** One case: the 1.1.0 verdict without consent, and the consented verdict for the root and for a subagent. */
async function expectCase(command: string, without: object, consented: object, extra: Partial<Input> = {}) {
  const input = await sh(command, extra)
  const got: Record<string, unknown> = { command, without: short(base(input)), root: short(root(input)), subagent: short(subagent(input)) }
  expect(got).toEqual({
    command,
    without,
    root: consented,
    subagent: consented,
  })
}

describe("T9 G1: a shell's -c text and eval are unwrapped and judged", () => {
  test("a deletion inside sh/bash/zsh -c or eval gets ARCHIVE_FIRST", async () => {
    for (const undo of [true, false]) {
      await expectCase(`bash -c "rm -rf src"`, HELD("not_routine"), ARCHIVE("unreadable_command"), { canUndo: undo })
      await expectCase(`bash -c "rm -rf ../elsewhere"`, HELD("not_routine"), ARCHIVE("unreadable_command"), { canUndo: undo })
      await expectCase(`zsh -c "rm notes.txt"`, HELD("not_routine"), ARCHIVE("unreadable_command"), { canUndo: undo })
      await expectCase(`sh -lc 'rm -rf src'`, HELD("not_routine"), ARCHIVE("unreadable_command"), { canUndo: undo })
      await expectCase(`eval "rm -rf src"`, HELD("not_routine"), ARCHIVE("unreadable_command"), { canUndo: undo })
      // nested: a shell text that runs a shell text
      await expectCase(`sh -c 'bash -c "rm -rf src"'`, HELD("not_routine"), ARCHIVE("unreadable_command"), { canUndo: undo })
    }
  })

  test("an irreversible git command inside -c text is refused with the archive or snapshot way", async () => {
    await expectCase(`sh -c "git reset --hard"`, HELD("not_routine"), IRREVERSIBLE())
    await expectCase(`bash -c "git clean -fdx"`, HELD("not_routine"), IRREVERSIBLE())
    await expectCase(`eval "git push --force origin main"`, HELD("not_routine"), IRREVERSIBLE())
  })

  test("a text that cannot be read but names a deletion gets ARCHIVE_FIRST; one that names none runs", async () => {
    await expectCase(`eval "$X rm -rf src"`, HELD("not_routine"), ARCHIVE("unreadable_command"))
    await expectCase(`bash -c "$(cat list) && rm -rf src"`, HELD("not_routine"), ARCHIVE("unreadable_command"))
    // negative: nothing destructive named
    await expectCase(`eval "$X"`, HELD("not_routine"), RUNS("unreadable_command"))
  })

  test("negative: a harmless -c text or eval still runs as the main agent's", async () => {
    await expectCase(`bash -c "echo hi"`, HELD("not_routine"), RUNS("unreadable_command"))
    await expectCase(`eval "echo hi"`, HELD("not_routine"), RUNS("unreadable_command"))
    await expectCase(`sh -c "ls -la src"`, HELD("not_routine"), RUNS("unreadable_command"))
  })

  test("the agent's answer is ARCHIVE_FIRST_TEXT / IRREVERSIBLE_ARCHIVE_TEXT", () => {
    expect(consentedRefusalText("not_reversible")).toBe(ARCHIVE_FIRST_TEXT)
    expect(consentedRefusalText("irreversible")).toBe(IRREVERSIBLE_ARCHIVE_TEXT)
  })
})

describe("T9 G2: a project script run by name is expanded for deletions", () => {
  test("a script body (or its pre hook) that deletes gets ARCHIVE_FIRST", async () => {
    for (const undo of [true, false]) {
      await expectCase("npm run wipe", HELD("not_routine"), ARCHIVE("not_routine"), { canUndo: undo })
      await expectCase("bun run wipe", HELD("not_routine"), ARCHIVE("not_routine"), { canUndo: undo })
      await expectCase("bun run out", HELD("not_routine"), ARCHIVE("not_routine"), { canUndo: undo })
      // 1.1.3 T10: `clean: rimraf dist` and `prebuild: rm -rf dist` delete only an output folder, so they run
      // (f113-output-folders.test.ts); without Undo, 1.1.0 holds a check as D `no_undo`.
      await expectCase("npm run clean", HELD("not_routine"), RUNS("not_routine"), { canUndo: undo })
      const check = undo ? "check" : "no_undo"
      await expectCase("npm run build", { class: undo ? "P" : "D", category: check }, RUNS(check), { canUndo: undo })
      await expectCase("npm run inner", HELD("not_routine"), ARCHIVE("not_routine"), { canUndo: undo })
    }
  })

  test("an irreversible step or a cloud deletion in a script is refused as irreversible", async () => {
    await expectCase("bun run hard", HELD("not_routine"), IRREVERSIBLE())
    await expectCase("npm run nuke", HELD("not_routine"), IRREVERSIBLE("not_routine"))
  })

  test("negative: a script that only copies, lints or sends runs", async () => {
    await expectCase("npm run copy", HELD("not_routine"), RUNS("not_routine"))
    await expectCase("npm run lint", { class: "P", category: "check" }, RUNS("check"))
    await expectCase("npm run net", HELD("not_routine"), RUNS("not_routine"))
  })
})

describe("T9 G3: deleting a cloud or remote resource gets IRREVERSIBLE_ARCHIVE", () => {
  const deletes = [
    "aws s3 rm s3://b --recursive",
    "aws s3 rb s3://b --force",
    "aws ec2 terminate-instances --instance-ids i-1",
    "aws rds delete-db-instance --db-instance-identifier d",
    "gcloud compute instances delete vm1",
    "gsutil rm -r gs://b",
    "az group delete -n rg --yes",
    "kubectl delete ns prod",
    "helm uninstall rel",
    "terraform destroy -auto-approve",
    "terraform apply -destroy",
    "tofu destroy",
    "pulumi destroy --yes",
    "doctl compute droplet delete d1",
    "fly apps destroy app",
    "flyctl volumes destroy vol_1",
    "vercel rm my-app --yes",
    "heroku apps:destroy app --confirm app",
    "gh repo delete o/r --yes",
    "npm unpublish pkg --force",
    "docker rm -f c1",
    "rclone purge remote:bucket",
  ]
  test("each common CLI's delete/destroy/rm form, root and subagent", async () => {
    for (const command of deletes) {
      const input = await sh(command)
      for (const verdict of [root(input), subagent(input)])
        expect({ command, class: verdict.class, category: verdict.category }).toEqual({ command, class: "X", category: "irreversible" })
      // without consent it waits as 1.1.0 holds it, whatever it was
      expect({ command, class: base(input).class }).toEqual({ command, class: "D" })
    }
  })

  test("the line keeps what it would have waited on", async () => {
    await expectCase("kubectl delete ns prod", HELD("not_routine"), IRREVERSIBLE("outward"))
    await expectCase("terraform destroy -auto-approve", HELD("not_routine"), IRREVERSIBLE("outward"))
  })

  test("negative: the same tools' reads, plans and deploys keep running", async () => {
    for (const command of [
      "kubectl get pods",
      "aws s3 ls",
      "gcloud compute instances list",
      "az group list",
      "terraform plan",
      "pulumi preview",
      "vercel deploy",
      "heroku logs",
      "docker ps",
      "docker rm c1",
    ]) {
      const input = await sh(command)
      for (const verdict of [root(input), subagent(input)])
        expect({ command, class: verdict.class, category: verdict.category }).toEqual({ command, class: "A", category: "by_main_agent" })
    }
  })

  test("the tools read are the ones the report names", () => {
    expect([...BypassScreen.CLOUD_DELETE_TOOLS].sort()).toEqual(
      [
        "aws", "az", "cdk", "docker", "doctl", "eksctl", "firebase", "fly", "flyctl", "gcloud", "gh", "glab", "gsutil", "helm",
        "heroku", "kubectl", "mc", "netlify", "npm", "oc", "pulumi", "railway", "rclone", "s3cmd", "serverless", "sls",
        "supabase", "terraform", "terragrunt", "tofu", "vercel", "wrangler",
      ].sort(),
    )
  })
})

describe("T9 G4: git that discards uncommitted work", () => {
  const discards = ["git checkout -- .", "git restore .", "git checkout -f", "git switch --discard-changes main", "git checkout src/a.ts"]
  test("without Undo it gets ARCHIVE_FIRST", async () => {
    for (const command of discards) await expectCase(command, HELD("not_routine"), ARCHIVE("not_routine"), { canUndo: false })
  })

  test("outside the project it gets ARCHIVE_FIRST even with Undo", async () => {
    await expectCase(`git -C ${outside.path} checkout -- .`, HELD("not_routine"), ARCHIVE("not_routine"))
    await expectCase("git worktree remove --force ../w", HELD("not_routine"), ARCHIVE("not_routine"))
  })

  test("negative: with Undo inside the project it runs (the snapshot covers it)", async () => {
    for (const command of discards) await expectCase(command, HELD("not_routine"), RUNS("not_routine"))
  })

  test("negative: git forms that keep the work run without Undo", async () => {
    for (const command of ["git checkout main", "git restore --staged notes.txt", "git worktree remove ../w", "git status"]) {
      const input = await sh(command, { canUndo: false })
      for (const verdict of [root(input), subagent(input)]) expect({ command, class: verdict.class }).toEqual({ command, class: "A" })
    }
  })
})

describe("T9 G5: deleting the person's configuration outside the project", () => {
  test("crontab -r, security delete-*, defaults delete, a settings file under the home folder: ARCHIVE_FIRST", async () => {
    await expectCase("crontab -r", HELD("not_routine"), ARCHIVE("system_service"))
    await expectCase("security delete-keychain login.keychain", HELD("not_routine"), ARCHIVE("not_routine"))
    await expectCase("security delete-generic-password -s svc", HELD("not_routine"), ARCHIVE("not_routine"))
    await expectCase("defaults delete com.apple.dock", HELD("not_routine"), ARCHIVE("outside_write_held"))
    await expectCase("/usr/libexec/PlistBuddy -c 'Delete :Key' x.plist", HELD("not_routine"), ARCHIVE("not_routine"))
    await expectCase(`osascript -e 'tell app "Finder" to empty trash'`, HELD("not_routine"), ARCHIVE("not_routine"))
    const prefs = path.join(os.homedir(), "Library/Preferences/com.example.app.plist")
    const input = await sh(`rm ${prefs}`)
    for (const verdict of [root(input), subagent(input)])
      expect({ class: verdict.class, category: verdict.category }).toEqual({ class: "X", category: "not_reversible" })
  })

  test("negative: reading the same configuration runs", async () => {
    for (const command of [
      "crontab -l",
      "defaults read com.apple.dock",
      "security find-generic-password -s svc",
      `osascript -e 'display notification "done"'`,
    ]) {
      const input = await sh(command)
      for (const verdict of [root(input), subagent(input)])
        expect({ command, class: verdict.class, category: verdict.category }).toEqual({ command, class: "A", category: "by_main_agent" })
    }
  })
})

describe("T9 G6: an append is never a replace", () => {
  test("replacingTargets reads each redirect's own operator, outside quotes", () => {
    const cases: [string, string[]][] = [
      ["echo a > f", ["f"]],
      ["echo a >| f", ["f"]],
      ["echo a &> f", ["f"]],
      ["echo a 1> f", ["f"]],
      ["echo a >> f", []],
      ["echo a &>> f", []],
      ["grep n notes.txt 2>/dev/null >> out.txt", ["/dev/null"]],
      [`echo "a -> b" >> out.txt`, []],
      ["awk '$1 > 5' notes.txt >> out.txt", []],
      ["echo 'a>b' >> out.txt", []],
      ["make 2>&1 >> log", []],
      ["exec 3<> f", []],
      ["echo x # > f", []],
    ]
    for (const [command, targets] of cases) expect({ command, targets: AutonomyTable.replacingTargets(command) }).toEqual({ command, targets })
  })

  test("without Undo an append to an existing file runs, whatever other > the text holds", async () => {
    for (const command of [
      "grep n notes.txt 2>/dev/null >> out.txt",
      `echo "a -> b" >> out.txt`,
      "awk '$1 > 5' notes.txt >> out.txt",
      "echo 'a>b' >> out.txt",
      "cat notes.txt >> out.txt",
    ]) {
      const input = await sh(command, { canUndo: false })
      for (const verdict of [root(input), subagent(input)]) expect({ command, class: verdict.class }).toEqual({ command, class: "A" })
    }
  })

  test("positive: a replace of an existing file without Undo is still ARCHIVE_FIRST", async () => {
    for (const command of ["cat notes.txt > out.txt", "grep n notes.txt 2>/dev/null > out.txt", "echo 'a>b' > out.txt"]) {
      const input = await sh(command, { canUndo: false })
      for (const verdict of [root(input), subagent(input)])
        expect({ command, ...short(verdict) }).toEqual({ command, class: "X", category: "not_reversible", bypassed: "no_undo" })
      expect({ command, class: base(input).class }).toEqual({ command, class: "A" })
    }
  })
})

describe("T9 row 11: the plain forms row 11 already saw redirected stay redirected", () => {
  test("direct deletions, inline code and compounds", async () => {
    await expectCase("rm -rf src", HELD("not_reversible"), ARCHIVE("not_reversible"))
    await expectCase("ls | xargs rm", { class: "X", category: "delete_compound" }, { class: "X", category: "delete_compound" })
    await expectCase(`find . -name "*.ts" -delete`, HELD("not_routine"), { class: "X", category: "delete_compound" })
  })

  test("inline code that deletes, which 1.1.0 holds unscreened without Undo, is refused as delete_compound", async () => {
    const DELETE = { class: "X", category: "delete_compound", bypassed: "no_undo" }
    await expectCase(`python3 -c "import shutil; shutil.rmtree('src')"`, HELD("no_undo"), DELETE, { canUndo: false })
    await expectCase(`node -e "require('fs').rmSync('src',{recursive:true})"`, HELD("no_undo"), DELETE, { canUndo: false })
    await expectCase(`perl -e "unlink 'notes.txt'"`, HELD("no_undo"), DELETE, { canUndo: false })
    await expectCase(`ruby -e "File.delete('notes.txt')"`, HELD("no_undo"), DELETE, { canUndo: false })
    // negative (matrix row 7): inline code that deletes nothing runs without Undo
    await expectCase(`python3 -c 'x = 1'`, HELD("no_undo"), RUNS("no_undo"), { canUndo: false })
  })
})

describe("T9: the end report lists git settings and hook writes under Open issues", () => {
  const line = (permission: string, patterns: string[], decision: "allow" | "reject" = "allow") =>
    ({ permission, patterns, decision }) as const
  test("writesGitSetup: positive", () => {
    for (const item of [
      line("bash", ["git config core.hooksPath /tmp/h"]),
      line("bash", ["git config --unset remote.origin.fetch"]),
      line("bash", ["git -C sub config user.name x"]),
      line("bash", ["echo x > .git/hooks/pre-commit"]),
      line("bash", ["chmod +x .git/hooks/pre-push"]),
      line("bash", ["cp hook.sh .git/hooks/post-checkout"]),
      line("bash", ["printf '[x]' >> .git/config"]),
      line("edit", [".git/config"]),
      line("write", [path.join("/p", ".git/hooks/pre-commit")]),
    ])
      expect({ item, listed: AutonomyReport.writesGitSetup(item) }).toEqual({ item, listed: true })
  })
  test("writesGitSetup: negative (a read, a refused call, another file)", () => {
    for (const item of [
      line("bash", ["git config user.name"]),
      line("bash", ["git config --get core.hooksPath"]),
      line("bash", ["git config --list"]),
      line("bash", ["cat .git/config"]),
      line("bash", ["echo x > .git/hooks/pre-commit"], "reject"),
      line("edit", ["src/config.ts"]),
      line("edit", [".github/config.yml"]),
      line("bash", ["git status"]),
    ])
      expect({ item, listed: AutonomyReport.writesGitSetup(item) }).toEqual({ item, listed: false })
  })
  test("render: each such write is listed under Open issues, in English and Indonesian", () => {
    const decision = (seq: number, patterns: string[], permission = "bash") =>
      ({
        v: 1,
        seq,
        prev: null,
        at: seq,
        type: "decision",
        rootID: "ses_root",
        sessionID: "ses_root",
        requestID: `per_${seq}`,
        agent: "build",
        directory: dir,
        permission,
        patterns,
        patternsTruncated: false,
        class: "A",
        risk: null,
        canUndo: true,
        decidedBy: "agent",
        decision: "allow",
        memo: false,
        follows: [],
        category: "by_main_agent",
        bypassed: "not_routine",
      }) as never
    const facts = (language: "en" | "id") => ({
      run: { root: "ses_root", directory: dir, since: 0, until: 10, language },
      lines: [decision(1, ["git config core.hooksPath /tmp/h"]), decision(2, [".git/hooks/pre-commit"], "edit"), decision(3, ["ls"])],
      open: [],
      goal: [],
      files: [],
      todos: [],
      attached: [],
      skipped: [],
      sends: new Map(),
    })
    const en = AutonomyReport.render(facts("en") as never)
    const issues = en.split("## Open issues\n\n")[1]!.split("\n\n## ")[0]!
    expect(issues).toBe(
      [
        "- Changed git settings or a git hook, which run later on your own git commands; please review: `bash git config core.hooksPath /tmp/h`",
        "- Changed git settings or a git hook, which run later on your own git commands; please review: `edit .git/hooks/pre-commit`",
      ].join("\n"),
    )
    const id = AutonomyReport.render(facts("id") as never)
    expect(id).toContain(
      "- Mengubah pengaturan git atau git hook, yang nanti berjalan pada perintah git Anda sendiri; mohon periksa: `bash git config core.hooksPath /tmp/h`",
    )
  })
})
