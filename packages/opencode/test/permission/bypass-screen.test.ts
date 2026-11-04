// Swarm 1.1.1 (spec S1.20-S1.27): the screen the consented bypass asks before it lets the main agent decide a call. Each
// trigger has one command that raises it and one that looks close and does not. No model, no network, no server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BypassScreen } from "../../src/permission/bypass-screen"
import type { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
})
afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

const instance = () => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext

/** The command as one program with literal words: no `metadata.steps`, so the screen reads it with `Risk.quotedWords`. */
const input = (command: string, fields: Partial<AutonomyTable.Input> = {}, metadata: Record<string, unknown> = {}) =>
  ({
    permission: "bash",
    patterns: [command],
    metadata: { command, ...metadata },
    instance: instance(),
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...fields,
  }) as AutonomyTable.Input

/** The command with the shell's own reading of it, as the shell tool sends it in autonomous mode. */
async function parsed(command: string, fields: Partial<AutonomyTable.Input> = {}) {
  const steps = await readSteps(command, dir)
  return input(command, fields, steps ? { steps } : {})
}

/** A reading written by hand, for words the shell's parser never hands over (a `$` it could not expand, a heredoc). */
const stepsOf = (command: string, steps: { argv: string[]; code?: string }[], fields: Partial<AutonomyTable.Input> = {}) =>
  input(command, fields, { steps: { v: 1, steps: steps.map((step) => ({ ...step, cwds: [dir] })), writes: [] } })

const screen = (command: string, fields: Partial<AutonomyTable.Input> = {}) => BypassScreen.screen(input(command, fields))

function expectEach(cases: [command: string, expected: BypassScreen.Screen][]) {
  for (const [command, expected] of cases) expect([command, screen(command)]).toEqual([command, expected])
}

const X = (x: BypassScreen.XTrigger): BypassScreen.Screen => ({ x })
const D = (d: BypassScreen.DTrigger): BypassScreen.Screen => ({ d })
const NONE: BypassScreen.Screen = {}

describe("S1.21 irreversible: refused by code", () => {
  test("git: reset --hard, clean -f, force pushes, branch force deletes, history rewrites", () => {
    expectEach([
      ["git reset --hard", X("irreversible")],
      ["git reset --har HEAD~1", X("irreversible")],
      // 1.1.1 F9 (G2-2): a reset that moves the branch to another commit is refused too.
      ["git reset --soft main", X("irreversible")],
      ["git reset --soft HEAD", NONE],
      ["git clean -fd", X("irreversible")],
      ["git clean --force", X("irreversible")],
      ["git clean -n", NONE],
      ["git push --force origin main", X("irreversible")],
      ["git push --force-with-lease", X("irreversible")],
      ["git push --force-if-includes", X("irreversible")],
      ["git push --mirror", X("irreversible")],
      ["git push --delete origin x", X("irreversible")],
      ["git push --prune origin", X("irreversible")],
      ["git push -f", X("irreversible")],
      ["git push -d origin x", X("irreversible")],
      ["git push origin +main", X("irreversible")],
      ["git push origin :old", X("irreversible")],
      ["git push origin main", D("outward")],
      ["git branch -D topic", X("irreversible")],
      ["git branch -d -f topic", X("irreversible")],
      ["git branch --delete --force topic", X("irreversible")],
      // 1.1.1 F9 (G2-2): any branch delete drops the ref and its reflog, so it is refused too.
      ["git branch -d topic", X("irreversible")],
      ["git rebase main", X("irreversible")],
      ["git log --grep rebase", NONE],
      ["git filter-branch --tree-filter x", X("irreversible")],
      ["git filter-repo --path x", X("irreversible")],
      ["git reflog expire --all", X("irreversible")],
      // `{` is no literal word without the shell's reading; the rough split still finds what nothing can undo.
      ["git reflog delete HEAD@{1}", X("irreversible")],
      ["git reflog show", NONE],
      ["git gc --prune=now", X("irreversible")],
      ["git gc", NONE],
      ["git stash drop", X("irreversible")],
      ["git stash clear", X("irreversible")],
      ["git stash list", NONE],
      ["git update-ref -d refs/heads/x", X("irreversible")],
      // 1.1.1 F9 (G2-2): moving a ref to another commit is refused too.
      ["git update-ref refs/heads/x HEAD", X("irreversible")],
    ])
  })

  test("git global options are skipped as `Risk.gitCommand` skips them", () => {
    expectEach([
      ["git -C . push -f", X("irreversible")],
      ["git -c core.pager=cat reset --hard", X("irreversible")],
      ["git --no-pager stash drop", X("irreversible")],
      ["git -C . status", NONE],
    ])
  })

  test("SQL wipes, database drops, redis flushes and migration resets", () => {
    expectEach([
      ["psql -c 'DROP TABLE users'", X("irreversible")],
      ["mysql -e 'drop database app'", X("irreversible")],
      ["sqlite3 app.db 'TRUNCATE t'", X("irreversible")],
      ["sqlite3 app.db 'delete from t'", X("irreversible")],
      ["mongosh --eval 'db.dropDatabase()'", X("irreversible")],
      ["psql -c 'select 1'", NONE],
      ["dropdb app", X("irreversible")],
      ["dropuser bob", X("irreversible")],
      ["redis-cli FLUSHALL", X("irreversible")],
      ["redis-cli flushdb", X("irreversible")],
      ["redis-cli get x", NONE],
      ["npx prisma migrate reset", X("irreversible")],
      ["bun run db:drop", X("irreversible")],
      ["npx prisma db push --force-reset", X("irreversible")],
      ["npx prisma migrate dev", NONE],
    ])
  })

  test("disks, the host and docker volumes", () => {
    expectEach([
      ["dd if=/dev/zero of=disk.img", X("irreversible")],
      ["mkfs -t ext4 /dev/sdb1", X("irreversible")],
      ["mkfs.ext4 /dev/sdb1", X("irreversible")],
      ["shred -u secret.txt", X("irreversible")],
      ["wipefs -a /dev/sdb", X("irreversible")],
      ["diskutil eraseDisk APFS x disk4", X("irreversible")],
      ["diskutil apfs deleteContainer disk4", X("irreversible")],
      ["diskutil list", NONE],
      ["shutdown -h now", X("irreversible")],
      ["reboot", X("irreversible")],
      ["halt", X("irreversible")],
      ["docker volume rm data", X("irreversible")],
      ["docker volume prune", X("irreversible")],
      ["docker system prune -af", X("irreversible")],
      ["docker compose down -v", X("irreversible")],
      ["docker compose down", NONE],
      ["docker volume ls", NONE],
      ["docker ps", NONE],
    ])
  })
})

describe("S1.22 delete_compound: deletions the shell cannot archive", () => {
  test("find -delete, find -exec rm, xargs rm, rsync --delete to a local target", () => {
    expectEach([
      ["find . -name '*.log' -delete", X("delete_compound")],
      ["find . -exec rm '{}' ';'", X("delete_compound")],
      ["find . -execdir shred '{}' +", X("delete_compound")],
      ["find . -ok rm -f '{}' ';'", X("delete_compound")],
      ["find . -exec cat '{}' ';'", NONE],
      ["find . -name '*.log'", NONE],
      ["xargs rm -f", X("delete_compound")],
      ["xargs -n 1 rm", X("delete_compound")],
      ["xargs echo", NONE],
      ["rsync -a --delete src/ backup/", X("delete_compound")],
      ["rsync -a --delete-after src/ /Volumes/x/backup/", X("delete_compound")],
      ["rsync -a --delete src/ host:backup/", D("outward")],
      ["rsync -a src/ backup/", D("outward")],
    ])
  })

  test("in the shell's own reading, a `find -delete` step anywhere in a list", async () => {
    expect(BypassScreen.screen(await parsed("ls && find . -name x -delete"))).toEqual(X("delete_compound"))
  })
})

describe("S1.24 admin_rights and S1.23 wrappers", () => {
  test("sudo, doas, su, pkexec, osascript with administrator privileges", () => {
    expectEach([
      ["sudo ls", X("admin_rights")],
      ["doas ls", X("admin_rights")],
      ["su -", X("admin_rights")],
      ["pkexec ls", X("admin_rights")],
      ["/usr/bin/sudo ls", X("admin_rights")],
      ["osascript -e 'do shell script \"x\" with administrator privileges'", X("admin_rights")],
      ["osascript -e 'display dialog \"hi\"'", NONE],
      ["echo sudo", NONE],
    ])
  })

  test("sudo or doas anywhere in the wrapper chain; wrappers and assignments skipped to find the program", () => {
    expectEach([
      ["env sudo ls", X("admin_rights")],
      ["nohup sudo ls", X("admin_rights")],
      ["timeout 5 doas ls", X("admin_rights")],
      ["env FOO=1 git reset --hard", X("irreversible")],
      ["FOO=1 git clean -f", X("irreversible")],
      ["nice -n 5 git clean -f", X("irreversible")],
      ["timeout -s KILL 5 git push -f", X("irreversible")],
      ["command git stash drop", X("irreversible")],
      ["exec dd if=a of=b", X("irreversible")],
      ["time git rebase main", X("irreversible")],
      ["builtin kill -l", NONE],
      ["env -u HOME curl https://x.example", D("outward")],
      ["env -S 'git push -f'", D("unreadable_command")],
      ["nice -n 5 ls", NONE],
    ])
  })
})

describe("S1.25 D triggers: kept for a person", () => {
  test("outward programs, git network subcommands, addresses, and the shell's remote label", () => {
    expectEach([
      ["curl https://x.example", D("outward")],
      ["wget x.example", D("outward")],
      ["nc host 80", D("outward")],
      ["ssh host", D("outward")],
      ["scp a host:b", D("outward")],
      ["rclone copy a nas:b", D("outward")],
      ["gh pr list", D("outward")],
      ["aria2c x", D("outward")],
      ["git fetch", D("outward")],
      ["git pull", D("outward")],
      ["git clone x", D("outward")],
      ["git ls-remote origin", D("outward")],
      ["git submodule update", D("outward")],
      ["git remote update", D("outward")],
      ["git remote -v", NONE],
      ["node x.js --url https://api.example.com", D("outward")],
      ["node x.js s3://bucket/key", D("outward")],
      ["node x.js file:///tmp/a", NONE],
      ["npm install left-pad", NONE],
      ["bun add zod", NONE],
    ])
    expect(BypassScreen.screen(input("make deploy", {}, { risk: "remote" }))).toEqual(D("outward"))
    expect(BypassScreen.screen(input("make deploy", {}, { risk: "irreversible" }))).toEqual(NONE)
  })

  test("system services", () => {
    expectEach([
      ["launchctl list", D("system_service")],
      ["systemctl restart x", D("system_service")],
      ["crontab -l", D("system_service")],
      ["brew list", NONE],
    ])
  })

  test("S1.27 kill: own children run, anything else waits, `kill -l` is harmless", () => {
    const own = new Set([4242, 4343])
    const kill = (command: string) => screen(command, { ownProcesses: own })
    expect(kill("kill 4242")).toEqual(NONE)
    expect(kill("kill -9 4242 4343")).toEqual(NONE)
    expect(kill("kill -s TERM 4242")).toEqual(NONE)
    expect(kill("kill -TERM -- 4242")).toEqual(NONE)
    expect(kill("kill -l")).toEqual(NONE)
    expect(screen("kill -l")).toEqual(NONE)
    expect(kill("kill 4242 5555")).toEqual(D("process_not_own"))
    expect(kill("kill 5555")).toEqual(D("process_not_own"))
    expect(kill("kill %1")).toEqual(D("process_not_own"))
    expect(kill("kill 0")).toEqual(D("process_not_own"))
    expect(kill("kill -9 -1")).toEqual(D("process_not_own"))
    expect(kill("kill -- -4242")).toEqual(D("process_not_own"))
    expect(kill("kill node")).toEqual(D("process_not_own"))
    expect(kill("kill -9")).toEqual(D("process_not_own"))
    expect(screen("kill 4242")).toEqual(D("process_not_own"))
    // The server's own pid is never Swarm's child, whatever the set says.
    expect(screen(`kill ${process.pid}`, { ownProcesses: new Set([process.pid]) })).toEqual(D("process_not_own"))
    expect(kill("pkill node")).toEqual(D("process_not_own"))
    expect(kill("killall node")).toEqual(D("process_not_own"))
    expect(BypassScreen.screen(stepsOf("kill $PID", [{ argv: ["kill", "$PID"] }], { ownProcesses: own }))).toEqual(
      D("unreadable_command"),
    )
  })

  test("unreadable: no words, a dynamic program, `sh -c`, eval, source", () => {
    expectEach([
      ["ls | head", D("unreadable_command")],
      ["$CMD x", D("unreadable_command")],
      ["`which git` status", D("unreadable_command")],
      ["sh -c 'ls'", D("unreadable_command")],
      ["bash -lc 'ls'", D("unreadable_command")],
      ["zsh -c ls", D("unreadable_command")],
      ["bash scripts/run.sh", NONE],
      ["eval ls", D("unreadable_command")],
      ["source .venv/bin/activate", D("unreadable_command")],
      [". ./env.sh", D("unreadable_command")],
    ])
  })

  test("unreadable: a `$` or backquote in the words of git, kill, SQL or diskutil steps", () => {
    const one = (argv: string[]) => BypassScreen.screen(stepsOf(argv.join(" "), [{ argv }]))
    expect(one(["git", "push", "$REMOTE"])).toEqual(D("unreadable_command"))
    expect(one(["git", "$SUB"])).toEqual(D("unreadable_command"))
    expect(one(["psql", "-c", "$Q"])).toEqual(D("unreadable_command"))
    expect(one(["diskutil", "`x`"])).toEqual(D("unreadable_command"))
    expect(one(["$TOOL", "x"])).toEqual(D("unreadable_command"))
    // An X found among the literal words still refuses, whatever else is dynamic.
    expect(one(["git", "reset", "--hard", "$REF"])).toEqual(X("irreversible"))
    expect(one(["cat", "$FILE"])).toEqual(NONE)
  })

  test("script_flagged: a heredoc whose screen finds the network, deleting, sudo or a path outside; soft flags are not", () => {
    const heredoc = (code: string) => BypassScreen.screen(stepsOf("python3 - <<'EOF'", [{ argv: ["python3", "-"], code }]))
    expect(heredoc("import requests\nrequests.get('https://x.example')\n")).toEqual(D("script_flagged"))
    expect(heredoc("import shutil\nshutil.rmtree('build')\n")).toEqual(D("script_flagged"))
    expect(heredoc("open('/etc/passwd').read()\n")).toEqual(D("script_flagged"))
    expect(heredoc("import base64\nbase64.b64decode('eA==')\n")).toEqual(NONE)
    expect(heredoc("print(eval('1+1'))\n")).toEqual(NONE)
    expect(heredoc("print(1)\n")).toEqual(NONE)
  })
})

describe("S1.20 what is screened", () => {
  test("only bash and external_directory with a command", () => {
    expect(BypassScreen.screen(input("sudo ls", { permission: "external_directory" }))).toEqual(X("admin_rights"))
    for (const permission of ["read", "edit", "webfetch", "websearch", "task", "glob"])
      expect([permission, BypassScreen.screen(input("sudo ls", { permission }))]).toEqual([permission, NONE])
    expect(BypassScreen.screen({ ...input("x"), metadata: {} })).toEqual(NONE)
  })

  test("the shell's reading is used when its shape is valid; every step is read, X outranks D", async () => {
    expect(BypassScreen.screen(await parsed("curl https://x.example && git reset --hard"))).toEqual(X("irreversible"))
    expect(BypassScreen.screen(await parsed("cd src && ls && launchctl list"))).toEqual(D("system_service"))
    expect(BypassScreen.screen(await parsed("ls && curl https://x.example; launchctl list"))).toEqual(D("outward"))
    expect(BypassScreen.screen(await parsed("ls -la && git status"))).toEqual(NONE)
    // A reading of a bad shape is not believed: the text is read as one program, which a list is not.
    expect(BypassScreen.screen(input("ls && git status", {}, { steps: { v: 2, steps: [], writes: [] } }))).toEqual(
      D("unreadable_command"),
    )
  })

  test("text nobody can read is held, and an irreversible command found in it on a rough split is refused", () => {
    expectEach([
      ["ls | git reset --hard", X("irreversible")],
      ["echo x | sudo tee /etc/hosts", X("admin_rights")],
      ["(cd x; git push -f)", X("irreversible")],
      ["ls | find . -delete", D("unreadable_command")],
      ["echo 'git reset --hard' | cat", D("unreadable_command")],
    ])
  })
})
