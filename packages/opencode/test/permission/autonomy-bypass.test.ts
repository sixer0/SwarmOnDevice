// Swarm 1.1.1 (spec S1.10-S1.19, decision P8): the consented bypass laid over the 1.1.0 table. Under consent the main agent
// decides what the table held or judged, except what a person keeps (outward, outside the folder, system services, other
// processes, unreadable text, flagged scripts, deletions the shell cannot archive); the irreversible list and admin rights
// are refused by code. P8: the overlay never answers stricter than 1.1.0 did, except those two refusals. Without consent the
// table is the 1.1.0 table.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { answerOf } from "./consented-literals"
import { expectNoManifestAbove } from "./install-fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  // 1.1.1 F12a (m33): the script reader is module-global; ready it here so no verdict depends on which file ran first.
  await ScriptReader.prepare()
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  // `GitGuard` refuses the fixture's quieting config; the rows here are about a plain repository.
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "src/b.ts"), "y\n")
  fs.writeFileSync(path.join(dir, "dist/app.zip"), "z")
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=1\n")
  // 1.1.1 F17 (P30): an install opens only from a manifest of the project's own; this one runs no hooks.
  // 1.1.1 F19 (n41): and only when nothing above the repository's top holds one, which this machine must give.
  expectNoManifestAbove(dir)
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n")
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

const ROOT = { caller: "root" } as const
const SUB = { caller: "subagent" } as const

const request = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: ["*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})

/** A command as the shell tool sends it in autonomous mode: with its own reading of the text when it has one. */
async function sh(command: string, fields: Partial<Input> = {}, metadata: Record<string, unknown> = {}) {
  const steps = await readSteps(command, fields.cwd ?? dir)
  return request("bash", { patterns: [command], metadata: { command, ...(steps ? { steps } : {}), ...metadata }, ...fields })
}

const consented = (input: Input, bypass: Input["bypass"] = ROOT) => AutonomyTable.classify({ ...input, bypass })
const OPENED = (bypassed: AutonomyTable.Verdict["category"]): Verdict => ({
  class: "A",
  decidedBy: "agent",
  category: "by_main_agent",
  bypassed: bypassed as Verdict["bypassed"],
})
const HELD = (category: AutonomyTable.HeldCategory): Verdict => ({ class: "D", decidedBy: "gate", category })
const REFUSED = (category: AutonomyTable.HeldCategory): Verdict => ({ class: "X", decidedBy: "gate", category })
/** 1.1.3 (spec section 3 rule 4): the archive redirect keeps the category the call would have waited on. */
const REDIRECTED = (bypassed: AutonomyTable.HeldCategory): Verdict => ({ ...REFUSED("not_reversible"), bypassed })

const allowed = [
  { id: "dest-host", destination: { kind: "host", host: "docs.example.com" } },
  { id: "dest-nas", destination: { kind: "rclone", name: "nas" } },
] as AutonomyTable.Outward["allowed"]

describe("S1.11 the overlay runs only with consent, and never for a plan lineage", () => {
  test("no `bypass`: `classify` is `classifyBase`, to the byte, and says nothing of a bypass", async () => {
    for (const input of await corpus()) {
      const verdict = AutonomyTable.classify(input)
      expect(JSON.stringify(verdict)).toBe(JSON.stringify(AutonomyTable.classifyBase(input)))
      expect(JSON.stringify(AutonomyTable.classify({ ...input, bypass: undefined }))).toBe(JSON.stringify(verdict))
      expect("bypassed" in verdict).toBe(false)
      expect(verdict.category).not.toBe("by_main_agent")
    }
  })

  test("the plan agent keeps rule 8 under consent", async () => {
    for (const input of [await sh("bun install", { plan: true }), request("edit", { plan: true, patterns: ["src/a.ts"] })]) {
      expect(consented(input)).toEqual(AutonomyTable.classifyBase(input))
      expect(consented(input, SUB)).toEqual(AutonomyTable.classifyBase(input))
    }
  })
})

describe("S1.13 the overlay, rule by rule (P8)", () => {
  test("1. B stays B", () => {
    for (const permission of ["doom_loop", "spend_limit"])
      expect(consented(request(permission))).toEqual({ class: "B", decidedBy: "person" })
  })

  test("2. an irreversible action or admin rights is refused by code, whatever it was before", async () => {
    expect(consented(await sh("git reset --hard"))).toEqual(REFUSED("irreversible"))
    expect(consented(await sh("git push --force origin main", {}, { risk: "irreversible" }))).toEqual(REFUSED("irreversible"))
    expect(consented(await sh("git stash drop", {}, { risk: "irreversible" }))).toEqual(REFUSED("irreversible"))
    expect(consented(await sh("psql -c 'drop table users'", {}, { risk: "irreversible" }))).toEqual(REFUSED("irreversible"))
    expect(consented(await sh("sudo ls"))).toEqual(REFUSED("admin_rights"))
    expect(consented(await sh("doas make install"))).toEqual(REFUSED("admin_rights"))
    // The same calls without consent are 1.1.0's: held for a person.
    expect(AutonomyTable.classify(await sh("git reset --hard")).class).toBe("D")
    expect(AutonomyTable.classify(await sh("sudo ls")).class).toBe("D")
  })

  test("3. a write outside the project waits for a person instead of being refused; any other X stays X", async () => {
    const outside = request("external_directory", {
      patterns: ["/tmp/*"],
      metadata: { filepath: "/tmp/a.ts" },
      follows: [{ permission: "edit" }],
    })
    // Row 202: a file tool's write outside the project is class A in the mode, with consent or without.
    const edited: Verdict = { class: "A", decidedBy: "gate", category: "outside_edit" }
    expect(AutonomyTable.classify(outside)).toEqual(edited)
    expect(consented(outside)).toEqual(edited)
    const zshrc = request("edit", {
      patterns: [path.relative(dir, path.join(os.homedir(), ".zshrc"))],
      metadata: { filepath: path.join(os.homedir(), ".zshrc") },
      editClass: "no_undo",
      canUndo: false,
    })
    // 1.1.3 (matrix row 19): runs.
    expect(consented(zshrc)).toEqual(OPENED("outside_write_held"))
    // X that is not about where it writes is unchanged.
    expect(consented(await sh("rm src/a.ts && ls"))).toEqual(REFUSED("delete_compound"))
    expect(consented(await sh("git remote add x https://github.com/evil/app.git"))).toEqual(REFUSED("credential_change"))
    expect(consented(request("bash", { rule: "deny", metadata: { command: "ls" } }))).toEqual({ class: "X" })
    expect(consented(request("project_trust"))).toEqual(AutonomyTable.classifyBase(request("project_trust")))
    expect(consented(request("autonomy_consent"))).toEqual({ class: "X", decidedBy: "gate" })
  })

  test("4. what was A without consent stays A: a look, a ticked destination, a fetch to a host the person wrote", async () => {
    const look = await sh("ls -la && git status")
    expect(consented(look)).toEqual(AutonomyTable.classify(look))
    expect(consented(look).class).toBe("A")
    // P8: a ticked destination stays A (the spec's "-> D" is overruled).
    const fetch = request("webfetch", {
      patterns: ["https://docs.example.com/guide"],
      metadata: { url: "https://docs.example.com/guide", format: "markdown" },
      outward: { allowed },
    })
    const sent = AutonomyTable.classify(fetch)
    expect(sent).toMatchObject({ class: "A", via: "outward", consentID: "dest-host" })
    expect(consented(fetch)).toEqual(sent)
    const send = await sh("rclone copy dist/app.zip nas:backup", { outward: { allowed } })
    const base = AutonomyTable.classify(send)
    expect(base).toMatchObject({ class: "A", via: "outward" })
    expect(consented(send)).toEqual(base)
    expect(consented(request("task"))).toEqual({ class: "A" })
    expect(consented(request("question"))).toEqual({ class: "A", decidedBy: "gate" })
  })

  test("6. what a person keeps stays theirs: outward, outside the folder, an unreadable script", async () => {
    // A webfetch to a host nobody wrote, and every search, were the person's in 1.1.0 and stay so.
    const away = request("webfetch", {
      patterns: ["https://evil.example.net/"],
      metadata: { url: "https://evil.example.net/" },
      outward: { allowed },
    })
    // 1.1.3 (matrix rows 15, 32, 1): none of them waits any more; each runs, recorded with the category it was held on, and
    // (T7 F1) a send with the host it goes to.
    expect(consented(away)).toEqual({ ...OPENED("outward_not_in_mission"), destination: "evil.example.net" })
    expect(consented(request("websearch", { patterns: ["x"], metadata: { query: "x" } }))).toEqual(OPENED("outward_not_in_mission"))
    expect(consented(await sh("git push origin main", {}, { risk: "remote" }))).toMatchObject(OPENED("outward"))
    expect(consented(request("external_directory", { patterns: ["/tmp/*"], metadata: { filepath: "/tmp/a" } }))).toEqual(
      OPENED("outside_folder"),
    )
  })

  test("6. D triggers hold what the table held under the trigger's name", async () => {
    // 1.1.3 (matrix rows 2, 20, 21, 22): what a trigger held no longer waits; it runs, recorded under the trigger's name.
    // T7 F1: the host nobody named is on the line too.
    expect(consented(await sh("curl https://x.example"))).toEqual({ ...OPENED("outward"), destination: "x.example" })
    expect(consented(await sh("node x.js --url https://api.example.com"))).toEqual(OPENED("outward"))
    expect(consented(await sh("launchctl list", {}, { risk: "irreversible" }))).toEqual(OPENED("system_service"))
    expect(consented(await sh("crontab -l"))).toEqual(OPENED("system_service"))
    expect(consented(await sh("killall node", {}, { risk: "irreversible" }))).toEqual(OPENED("process_not_own"))
    expect(consented(await sh("kill 4242"))).toEqual(OPENED("process_not_own"))
    // 1.1.1 F10a (P5 A2d, P19): a kill of a process this session's own shell tool started is the main agent's again.
    const own = await sh("kill 4242", { ownProcesses: new Set([4242]) })
    expect(consented(own)).toEqual({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "not_routine" })
    expect(consented(await sh("kill 4242 4243", { ownProcesses: new Set([4242]) }))).toEqual(OPENED("process_not_own"))
    // 1.1.3 (matrix row 8): the kept not_routine verdict runs.
    expect(AutonomyTable.classify(await sh("kill -l"))).toEqual(HELD("not_routine"))
    expect(consented(await sh("kill -l"))).toEqual(OPENED("not_routine"))
    expect(consented(await sh("bash -c 'make'"))).toEqual(OPENED("unreadable_command"))
    expect(consented(await sh("source .venv/bin/activate"))).toEqual(OPENED("unreadable_command"))
    expect(consented(await sh("make", {}, { risk: "remote" }))).toMatchObject(OPENED("outward"))
  })

  test("5. a delete the shell cannot archive is not opened, and no stricter than in 1.1.0 (P8)", async () => {
    const find = await sh("find . -name '*.log' -delete")
    // 1.1.3 (matrix row 24, spec section 3 "underConsent rule 5"): refused at once as delete_compound (the archive method),
    // now also where the 1.1.0 verdict was a D.
    expect(AutonomyTable.classify(find).class).toBe("D")
    expect(consented(find)).toEqual(REFUSED("delete_compound"))
    expect(consented(find).class).not.toBe("A")
  })

  test("9. a flagged script keeps its 1.1.0 verdict, soft flags alone included (F7: no script is on the allowlist)", async () => {
    const hard = await sh(`python3 -c 'import socket; socket.create_connection(("x", 80))'`)
    expect(AutonomyTable.classify(hard)).toMatchObject({ class: "D", category: "script_flagged" })
    // 1.1.3 (matrix row 16): a script with no `sudo` or `delete` flag no longer waits; it runs as the main agent's.
    expect(consented(hard)).toEqual(OPENED("script_flagged"))
    // An address in the code is outward before it is a flag: held all the same, and 1.1.3 runs it (matrix row 2).
    expect(consented(await sh(`python3 -c 'import requests; requests.get("https://x.example")'`))).toEqual(OPENED("outward"))
    const soft = await sh(`python3 -c 'print(eval("1+1"))'`)
    expect(AutonomyTable.classify(soft)).toMatchObject({ class: "D", category: "script_flagged", screen: { flags: ["eval"] } })
    expect(consented(soft)).toEqual(OPENED("script_flagged"))
  })

  test("7. a deletion or an overwrite the shell could not archive stays for the person", async () => {
    // Without the shell's word that it moves the paths, a plain deletion would delete for good.
    const rm = await sh("rm src/a.ts")
    expect(AutonomyTable.classify(rm)).toEqual(HELD("not_reversible"))
    // 1.1.3 (matrix row 29): not a wait any more; the agent is redirected to the archive method at once.
    expect(consented(rm)).toEqual(REDIRECTED("not_reversible"))
    expect(consented(await sh("rm src/a.ts", {}, { archive: true }))).toEqual({ class: "A", decidedBy: "gate", category: "archived" })
    const cp = await sh("cp src/a.ts src/b.ts")
    expect(AutonomyTable.classify(cp)).toEqual(HELD("not_reversible"))
    // 1.1.3 (matrix row 30): redirected to the archive method.
    expect(consented(cp)).toEqual(REDIRECTED("not_reversible"))
    // 1.1.1 F7 (P15, G2-1): the shell's own `irreversible` label keeps 1.1.0 whatever the words, as for `chmod -R`.
    // 1.1.1 F9 (G2-2): `git commit --amend` rewrites a commit, so under consent it is refused instead.
    expect(consented(await sh("git commit --amend -m x", {}, { risk: "irreversible" }))).toEqual({
      class: "X",
      decidedBy: "gate",
      category: "irreversible",
    })
    // 1.1.3 (matrix row 3, a non-remote risk label): redirected to the archive method.
    expect(consented(await sh("chmod -R 755 src", {}, { risk: "irreversible" }))).toEqual(REDIRECTED("not_reversible"))
  })

  test("10. anything else held or judged is the main agent's: D and P categories, for the root and for a subagent", async () => {
    expect(consented(await sh("bun install"))).toEqual(OPENED("not_routine"))
    expect(consented(await sh("bun install"), SUB)).toEqual(OPENED("not_routine"))
    expect(consented(await sh("bun test"))).toEqual(OPENED("check"))
    expect(consented(await sh("bun install", { canUndo: false }))).toEqual(OPENED("not_routine"))
    expect(consented(await sh("bun test", { folder: "ask" }))).toEqual(OPENED("folder_not_trusted"))
    expect(consented(await sh("bun test", { canUndo: false }))).toEqual(OPENED("no_undo"))
    // S1.19: a secret is readable under consent; what would send it out is still held. 1.2.6 row 36 (U12, INTENT 01b 10.1
    // :261): the read is no longer opened by the overlay, it is gate A protected_read in both layers (was OPENED secret_file).
    expect(consented(request("read", { patterns: [".env"] }))).toEqual({ class: "A", decidedBy: "gate", category: "protected_read" })
    expect(consented(request("edit", { patterns: ["scripts/x.sh"], editClass: "not_ordinary" }))).toEqual(OPENED("edit-not-ordinary"))
    expect(consented(request("bash", { rule: "user_catch_all", metadata: { command: "tsc" } }))).toEqual(OPENED("asks_every_time"))
    // 1.1.1 F10b (P19): a make target keeps its 1.1.0 verdict; 1.1.3 (matrix row 14) runs that kept verdict.
    const make = request("bash", { rule: "user_catch_all", metadata: { command: "make" } })
    expect(AutonomyTable.classify(make)).toEqual(HELD("asks_every_time"))
    expect(consented(make)).toEqual(OPENED("asks_every_time"))
    // 1.1.1 F9 (G2-5): the `external_tool` path keeps its 1.1.0 verdict, whichever tool takes it; 1.1.3 (matrix row 6) runs it.
    const lsp = request("lsp", { patterns: ["*"] })
    // T9 G8: written out. 1.1.0 holds it as D `external_tool`; under consent it runs as the main agent's, no answer text.
    expect(AutonomyTable.classify(lsp)).toEqual({ class: "D", decidedBy: "gate", category: "external_tool" })
    expect(consented(lsp)).toEqual({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "external_tool" })
    expect(answerOf(consented(lsp))).toBeUndefined()
    expect(consented(lsp)).toMatchObject({ class: "A", category: "by_main_agent" })
  })
})

describe("S1.15 the step path inherits the overlay", () => {
  test("a compound of steps the overlay opens is A; one irreversible step makes it X; one curl step makes it D", async () => {
    // 1.1.1 F10b: `make` keeps 1.1.0, so the opened compound uses another recognised build step.
    const opened = await sh("bun install && cargo build")
    expect(AutonomyTable.classify(opened)).toEqual(HELD("not_routine"))
    expect(consented(opened)).toEqual(OPENED("not_routine"))
    expect(consented(await sh("bun install && git reset --hard"))).toEqual(REFUSED("irreversible"))
    expect(consented(await sh("cd src && bun install; sudo make install"))).toEqual(REFUSED("admin_rights"))
    // 1.1.3 (matrix rows 2, 20): the curl or launchctl step no longer holds the compound; each step runs as the main
    // agent's, so the compound does. Which step's category it records follows the tie rule of `classifySteps`.
    for (const command of ["bun install && curl https://x.example", "bun install && launchctl list"])
      expect([command, consented(await sh(command))]).toMatchObject([command, { class: "A", decidedBy: "agent", category: "by_main_agent" }])
    // A step whose program is a path is read word by word as well.
    expect(consented(await sh("bun install && /opt/homebrew/bin/cargo build"))).toEqual(OPENED("not_routine"))
  })

  test("overlaying twice changes nothing (idempotent)", async () => {
    for (const input of await corpus()) {
      const once = consented(input)
      expect([input.metadata.command ?? input.permission, AutonomyTable.underConsent({ ...input, bypass: ROOT }, once)]).toEqual([
        input.metadata.command ?? input.permission,
        once,
      ])
    }
  })
})

describe("P8: under consent nothing is stricter than without, except the irreversible list, admin rights and (1.1.3) the archive redirect", () => {
  const RANK: Record<AutonomyTable.Class, number> = { A: 0, P: 1, B: 2, D: 3, X: 4 }
  test("over every call of the corpus, for the root and for a subagent", async () => {
    let tightened = 0
    for (const input of await corpus()) {
      const base = AutonomyTable.classify(input)
      for (const bypass of [ROOT, SUB]) {
        const over = consented(input, bypass)
        const name = input.metadata.command ?? input.permission
        // 1.1.3 (matrix rows 3, 24, 29-31, 36): a deletion or replacement that waited is now redirected to the archive
        // method at once (X `not_reversible` or `delete_compound`), never a wait.
        const redirect = over.category === "not_reversible" || over.category === "delete_compound"
        if (over.class === "X" && (over.category === "irreversible" || over.category === "admin_rights" || redirect)) {
          tightened++
          continue
        }
        if (base.class === "A") expect([name, over]).toEqual([name, base])
        expect([name, RANK[over.class] <= RANK[base.class]]).toEqual([name, true])
        // Only a call the table held or judged can come out as the main agent's; 1.1.3 (matrix row 23) adds a write outside.
        if (over.category === "by_main_agent")
          expect([name, ["D", "P"].includes(base.class) || base.category === "outside_write"]).toEqual([name, true])
        // 1.1.3 (spec section 2): no consented call waits.
        expect([name, over.class === "D" || over.class === "P"]).toEqual([name, false])
      }
    }
    expect(tightened).toBeGreaterThan(0)
  })
})

/** Calls of every kind the table answers, A to X, shell and not. */
async function corpus(): Promise<Input[]> {
  const commands = [
    "ls -la",
    "cat src/a.ts | head -5",
    "git status && git diff",
    "git log --oneline -3",
    "bun test",
    "bun install",
    "make build",
    "mkdir -p src/new",
    "mv src/a.ts src/c.ts",
    "cp src/a.ts src/b.ts",
    "rm src/a.ts",
    "rm src/a.ts && ls",
    "find . -name '*.log' -delete",
    "curl https://x.example",
    "wget https://x.example/file",
    "gh pr list",
    "git fetch",
    "git push origin main",
    "git push --force origin main",
    "git reset --hard",
    "git rebase main",
    "git clean -fdx",
    "git stash drop",
    "sudo ls",
    "launchctl list",
    "kill 4242",
    "kill -l",
    "pkill node",
    "bash -c 'ls'",
    "eval ls",
    "python3 -c 'print(1)'",
    `python3 -c 'print(eval("1"))'`,
    "dd if=/dev/zero of=x.img",
    "docker system prune -af",
    "chmod -R 755 src",
    "cat .env",
    "git remote add x https://github.com/evil/app.git",
    "node x.js https://api.example.com",
    "rclone copy dist/app.zip nas:backup",
    "ls | head",
    "echo $HOME",
    "for f in src/*.ts; do wc -l $f; done",
  ]
  const shell = await Promise.all(commands.map((command) => sh(command, { outward: { allowed } })))
  const risky = await Promise.all([
    sh("git commit --amend -m x", {}, { risk: "irreversible" }),
    sh("git push origin main", {}, { risk: "remote" }),
    sh("launchctl load x.plist", {}, { risk: "irreversible" }),
  ])
  return [
    ...shell,
    ...risky,
    request("read", { patterns: ["src/a.ts"] }),
    request("read", { patterns: [".env"] }),
    request("edit", { patterns: ["src/a.ts"], metadata: { filepath: path.join(dir, "src/a.ts") }, editClass: "ordinary", harmless: true }),
    request("edit", { patterns: ["scripts/x.sh"], editClass: "not_ordinary" }),
    request("edit", { patterns: ["package.json"], editClass: "sensitive" }),
    request("external_directory", { patterns: ["/tmp/*"], metadata: { filepath: "/tmp/a" } }),
    request("external_directory", { patterns: ["/tmp/*"], metadata: { filepath: "/tmp/a.ts" }, follows: [{ permission: "edit" }] }),
    request("webfetch", { patterns: ["https://docs.example.com/x"], metadata: { url: "https://docs.example.com/x" }, outward: { allowed } }),
    request("webfetch", { patterns: ["https://evil.example.net/"], metadata: { url: "https://evil.example.net/" }, outward: { allowed } }),
    request("websearch", { patterns: ["x"], metadata: { query: "x" } }),
    request("task"),
    request("question"),
    request("doom_loop"),
    request("lsp"),
    request("bash", { rule: "deny", metadata: { command: "ls" } }),
    request("bash", { rule: "user_catch_all", metadata: { command: "ls" } }),
  ]
}
