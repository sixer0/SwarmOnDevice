// Swarm 1.1.3 row 7 (masterplan/01_specs.md section 7, "Row 7 (property)"): under the person's consent to the bypass no
// permission call waits. Calls are generated over every matrix category, for the root and for a subagent, and sent through
// the real gate (`Permission.ask`, src/permission/index.ts) with the real table (`AutonomyTable.classify`), or with a base
// verdict of every category laid through the real `noWait`. For every call: it ends at once as a run or as an answer;
// no `DeferredError`, no `AwayError`, no `Deferred.await` (a timeout here); nothing is held (the pending list); the line's
// decision is "allow" or "reject"; the answer is a register text; one decision line per call when the writer works; the
// decider is never asked to settle a class P call, and never at all for the root. Control: the same calls without the
// consent are `classifyBase` to the byte, and some of them do wait, so the property is not vacuous.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import type { AutonomyDecider } from "../../src/permission/autonomy-decider"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import {
  MAIN_AGENT_UNAVAILABLE_TEXT,
  REFUSED_TEXT,
  SPEND_STOPPED_TEXT,
  SUBAGENT_STOPPED,
  UNJUDGED_TEXT,
  consentedRefusalText,
} from "../../src/permission/autonomy-texts"
import { ScriptReader } from "../../src/permission/script-reader"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { readSteps } from "../../src/tool/shell"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { expectNoManifestAbove } from "./install-fixture"

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: what a consented call may end as (spec section 7: "every message is a section 1 / autonomy-texts.ts text, a
// `mainAgentDeclined` text, or a stop text").
// ---------------------------------------------------------------------------------------------------------------------

const GENERAL_REFUSAL = Permission.refusedUnderConsent(undefined).message
const REGISTER_TEXTS: ReadonlySet<string> = new Set([
  ...Object.values(REFUSED_TEXT),
  ...Object.keys(REFUSED_TEXT).map((category) => consentedRefusalText(category)!),
  GENERAL_REFUSAL,
  MAIN_AGENT_UNAVAILABLE_TEXT,
  SPEND_STOPPED_TEXT,
])
const DECLINED = /^This call did not run\. The main agent declined it: .* Carry on without it, and list it in your final message\.$/s
const allowedText = (text: string) => REGISTER_TEXTS.has(text) || DECLINED.test(text) || text.startsWith(SUBAGENT_STOPPED)

/** Every category of the schema (`PermissionV1.DeferredCategory`), so a category added later is generated too. */
const CATEGORIES = PermissionV1.DeferredCategory.literals
const FLAGS = ["network", "delete", "sudo", "eval", "base64", "exec_local", "outside_path"] as const
/** The X categories a table verdict under consent may carry; each has its own text or is the general refusal. */
const X_WITH_TEXT: ReadonlySet<string> = new Set(Object.keys(REFUSED_TEXT))
const X_GENERAL: ReadonlySet<string> = new Set(["plan_mode", "app_state", "folder_not_trusted"])

// ---------------------------------------------------------------------------------------------------------------------
// The call corpus, as the tools send it. One spec serves the table (an `AutonomyTable.Input`) and the gate (an AskInput).
// ---------------------------------------------------------------------------------------------------------------------

type Spec = {
  name: string
  permission: string
  patterns?: readonly string[]
  metadata?: Record<string, unknown>
  editClass?: PermissionV1.EditClass
  canUndo?: boolean
  plan?: boolean
  catchAll?: boolean
  follows?: readonly { permission: string; patterns: readonly string[] }[]
}

const COMMANDS = [
  // ordinary development work, the allowlist and what it does not know
  "ls -la",
  "git status && git diff",
  "bun test",
  "bun install",
  "make build",
  "mkdir -p src/new",
  "mv src/a.ts src/c.ts",
  "node x.js",
  "echo $HOME",
  "for f in src/*.ts; do wc -l $f; done",
  "chmod -R 755 src",
  "cat .env",
  // outward (rows 2, 15, 32)
  "curl https://x.example",
  "curl http://127.0.0.1:4096/health",
  "wget https://x.example/file",
  "curl -T dist/app.zip https://x.example/up",
  "gh pr list",
  "git fetch",
  "git push origin main",
  "rclone copy dist/app.zip nas:backup",
  "npm publish",
  // outside writes, links, global installs (rows 19, 23)
  "ln -s /etc/hosts src/hosts",
  "npm install -g left-pad",
  "echo x > /tmp/f113-outside.txt",
  // system services and processes (rows 20, 21)
  "launchctl list",
  "systemctl restart x",
  "kill 4242",
  "pkill node",
  // unreadable text, shells, interpreters (rows 17, 22)
  "bash -c 'ls'",
  "eval ls",
  "ls $(cat list)",
  // deletions and replacements (rows 3, 24, 28-31)
  "rm src/a.ts",
  "rm -rf /tmp/f113-x",
  "rm src/a.ts && ls",
  "find . -name '*.log' -delete",
  "cp src/a.ts src/b.ts",
  "mv src/a.ts src/b.ts",
  "truncate -s 0 src/a.ts",
  "echo x > src/a.ts",
  "sed -i s/x/y/ src/a.ts",
  "xargs rm < list.txt",
  // the irreversible list (rows 26, 33-35, 37)
  "git reset --hard",
  "git clean -fdx",
  "git push --force origin main",
  "git branch -D old",
  "git rebase main",
  "git filter-branch --tree-filter true HEAD",
  "git update-ref -d refs/heads/old",
  "git reflog expire --expire=now --all",
  "git gc --prune=now",
  "git stash drop",
  "git stash clear",
  "git commit --amend -m x",
  "dd if=/dev/zero of=x.img",
  "mkfs.ext4 /dev/disk9",
  "shred src/a.ts",
  "wipefs -a /dev/disk9",
  "diskutil eraseDisk APFS X disk9",
  "shutdown -h now",
  "reboot",
  "psql -c 'DROP TABLE users'",
  "dropdb app",
  "psql $DATABASE_URL",
  "diskutil $DISK",
  "docker system prune -af",
  // admin rights (rows 27, 38)
  "sudo ls",
  "doas ls",
  "pkexec ls",
  "su -c ls",
  // credentials (row 25)
  "git remote add x https://github.com/evil/app.git",
  "git config user.email x@y",
  "git push /tmp/f113-elsewhere main",
  // inline scripts with each screen flag set, and none (rows 16, 36, 38)
  `python3 -c 'x = 1'`,
  `python3 -c 'import urllib'`,
  `python3 -c 'import os; os.remove("a")'`,
  `python3 -c 'm = "sudo ls"'`,
  `python3 -c 'eval("1")'`,
  `python3 -c 'from base64 import b64decode'`,
  `python3 -c 'import subprocess'`,
  `python3 -c 'p = "~/x"'`,
  `node -e 'require("child_process")'`,
]

/** The shell's labels (`metadata.risk`): each on a command that carries none of its own, and on one that does. */
const LABELLED: readonly [string, string][] = [
  ["ls -la", "irreversible"],
  ["ls -la", "remote"],
  ["git push origin main", "remote"],
  ["launchctl load x.plist", "irreversible"],
  ["kubectl apply -f x.yaml", "remote"],
  ["rm src/a.ts", "irreversible"],
]

function specs(dir: string): Spec[] {
  const shell = (command: string, metadata: Record<string, unknown> = {}, extra: Partial<Spec> = {}): Spec => ({
    name: `bash ${command} ${JSON.stringify(metadata)}${extra.plan ? " (plan)" : ""}`,
    permission: "bash",
    patterns: [command],
    metadata: { command, ...metadata },
    ...extra,
  })
  const file = (name: string) => path.join(dir, name)
  return [
    ...COMMANDS.map((command) => shell(command)),
    // archive on and off (`metadata.archive`, `archiveTargets`)
    ...["rm src/a.ts", "rmdir src/empty", "git rm src/a.ts", "rm src/a.ts && ls"].map((command) => shell(command, { archive: true })),
    ...["cp src/a.ts src/b.ts", "mv src/a.ts src/b.ts"].map((command) => shell(command, { archiveTargets: [file("src/b.ts")] })),
    shell("cp src/a.ts src/b.ts", { archiveTargets: [file("src/other.ts")] }),
    ...LABELLED.map(([command, risk]) => shell(command, { risk })),
    // the plan lineage (rule 8) under consent
    ...["ls -la", "bun install", "rm src/a.ts", "git reset --hard", "sudo ls", "curl https://x.example"].map((command) =>
      shell(command, {}, { plan: true }),
    ),
    // a person's own `"*": "ask"` (row 14)
    { ...shell("ls -la", {}, { catchAll: true }), name: "bash ls -la (person's catch-all)" },
    { ...shell("bun install", {}, { catchAll: true }), name: "bash bun install (person's catch-all)" },
    // nothing to undo with (row 7)
    { ...shell("touch src/new.ts", {}, { canUndo: false }), name: "bash touch, no Undo" },
    // edits and writes, each edit class, inside, outside, a sensitive and an app state file (rows 4, 5, 7, 12, 13, 23)
    ...(["ordinary", "not_ordinary", "no_undo", "sensitive", "secret"] as const).flatMap((editClass) => [
      { name: `edit src/a.ts ${editClass}`, permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: file("src/a.ts") }, editClass },
      { name: `edit src/a.ts ${editClass}, no Undo`, permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: file("src/a.ts") }, editClass, canUndo: false },
    ]),
    { name: "edit package.json", permission: "edit", patterns: ["package.json"], metadata: { filepath: file("package.json") }, editClass: "sensitive" },
    { name: "edit .env", permission: "edit", patterns: [".env"], metadata: { filepath: file(".env") }, editClass: "secret" },
    { name: "edit outside", permission: "edit", patterns: ["/tmp/f113-out.ts"], metadata: { filepath: "/tmp/f113-out.ts" }, editClass: "not_ordinary" },
    { name: "edit app state", permission: "edit", patterns: ["state"], metadata: { filepath: path.join(Global.Path.state, "autonomy", "x.json") } },
    { name: "edit (plan)", permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: file("src/a.ts") }, editClass: "ordinary", plan: true },
    { name: "write tool name", permission: "write", patterns: ["src/a.ts"], metadata: { filepath: file("src/a.ts") } },
    { name: "read .env", permission: "read", patterns: [".env"], metadata: { filepath: file(".env") } },
    // the web (rows 2, 15)
    { name: "webfetch remote", permission: "webfetch", patterns: ["https://evil.example.net/"], metadata: { url: "https://evil.example.net/" } },
    { name: "webfetch local", permission: "webfetch", patterns: ["http://127.0.0.1:4096/"], metadata: { url: "http://127.0.0.1:4096/" } },
    { name: "webfetch (plan)", permission: "webfetch", patterns: ["https://evil.example.net/"], metadata: { url: "https://evil.example.net/" }, plan: true },
    // MCP and tools that say nothing about themselves (row 6)
    { name: "mcp local", permission: "srv_tool", patterns: ["*"], metadata: { mcp: { server: "srv", tool: "tool", transport: "local" } } },
    { name: "mcp remote", permission: "srv_tool", patterns: ["x"], metadata: { mcp: { server: "srv", tool: "tool", transport: "remote" } } },
    { name: "mcp (plan)", permission: "srv_tool", patterns: ["y"], metadata: { mcp: { server: "srv", tool: "tool" } }, plan: true },
    { name: "opaque tool", permission: "graft_find_code", patterns: ["*"], metadata: {} },
    { name: "unknown tool with metadata", permission: "frobnicate", patterns: ["a"], metadata: { a: 1 } },
    // outside the folder (rows 1, 23)
    { name: "external_directory read", permission: "external_directory", patterns: ["/tmp/*"], metadata: { filepath: "/tmp/f113-a" } },
    {
      name: "external_directory with an edit following",
      permission: "external_directory",
      patterns: ["/tmp/*"],
      metadata: { filepath: "/tmp/f113-a.ts" },
      follows: [{ permission: "edit", patterns: ["/tmp/f113-a.ts"] }],
    },
    // what the mode never lets an agent answer
    { name: "consent prompt", permission: "autonomy_consent", patterns: ["*"], metadata: {} },
    { name: "project trust", permission: "project_trust", patterns: ["*"], metadata: {} },
  ]
}

async function stepsOf(spec: Spec, cwd: string) {
  const command = spec.metadata?.command
  if (spec.permission !== "bash" || typeof command !== "string") return spec.metadata ?? {}
  const steps = await readSteps(command, cwd)
  return { ...spec.metadata, workdir: cwd, ...(steps ? { steps } : {}) }
}

/** The project every call runs in: a git repository with a manifest, sources, a secret and an empty folder. */
function populate(dir: string) {
  mkdirSync(path.join(dir, "src", "empty"), { recursive: true })
  mkdirSync(path.join(dir, "dist"), { recursive: true })
  writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  writeFileSync(path.join(dir, "src/b.ts"), "y\n")
  writeFileSync(path.join(dir, "dist/app.zip"), "z")
  writeFileSync(path.join(dir, ".env"), "TOKEN=1\n")
  writeFileSync(path.join(dir, "list.txt"), "src/a.ts\n")
  // 1.1.1 F17 (P30) and F19 (n41): an install opens only from the project's own manifest, with none above the top.
  expectNoManifestAbove(dir)
  writeFileSync(path.join(dir, "package.json"), "{}\n")
}

// ---------------------------------------------------------------------------------------------------------------------
// Part 1, the table: `classify` under consent never answers D or P, and every X it gives has its answer.
// ---------------------------------------------------------------------------------------------------------------------

describe("1.1.3 row 7, table: under consent no verdict is D or P", () => {
  let fixture: Awaited<ReturnType<typeof tmpdir>>
  let dir: string
  let instance: InstanceContext
  let inputs: AutonomyTable.Input[]

  beforeAll(async () => {
    await ScriptReader.prepare()
    fixture = await tmpdir({ git: true })
    dir = fixture.path
    await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet().nothrow()
    instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
    populate(dir)
    inputs = await Promise.all(
      specs(dir).map(async (spec) => ({
        permission: spec.permission,
        patterns: spec.patterns ?? ["*"],
        metadata: await stepsOf(spec, dir),
        instance,
        cwd: dir,
        canUndo: spec.canUndo ?? true,
        folder: "clean" as const,
        editClass: spec.editClass,
        plan: spec.plan === true,
        rule: spec.catchAll ? ("user_catch_all" as const) : undefined,
        follows: spec.follows,
      })),
    )
  })
  afterAll(async () => {
    await fixture[Symbol.asyncDispose]()
  })

  test("every generated call, for the root and a subagent: A, B or X with its answer", () => {
    const violations: string[] = []
    for (const input of inputs)
      for (const caller of ["root", "subagent"] as const) {
        const verdict = AutonomyTable.classify({ ...input, bypass: { caller } })
        const where = `${caller} ${input.permission} ${input.patterns.join(" ")} ${JSON.stringify({ risk: input.metadata.risk, archive: input.metadata.archive, archiveTargets: input.metadata.archiveTargets, plan: input.plan, rule: input.rule, editClass: input.editClass, canUndo: input.canUndo })}`
        if (verdict.class === "D" || verdict.class === "P") violations.push(`${where} -> ${verdict.class} ${verdict.category}`)
        if (verdict.class === "X" && verdict.category !== undefined && !X_WITH_TEXT.has(verdict.category) && !X_GENERAL.has(verdict.category))
          violations.push(`${where} -> X ${verdict.category} has no answer`)
        if (verdict.class === "X" && verdict.category === "not_routine") violations.push(`${where} -> X not_routine is the gate's alone`)
      }
    expect(violations).toEqual([])
    // the corpus reaches every kind of answer: runs, archive redirects, refusals and the stop class
    const seen = new Set(inputs.map((input) => {
      const verdict = AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
      return verdict.class === "X" ? `X ${verdict.category}` : verdict.class
    }))
    for (const kind of ["A", "X not_reversible", "X delete_compound", "X irreversible", "X admin_rights", "X credential_change", "X plan_mode"])
      expect(seen).toContain(kind)
  })

  test("`noWait` over a base verdict of every category, class D and P, with every script flag: never D or P", () => {
    const violations: string[] = []
    const base = inputs.find((input) => input.permission === "graft_find_code")!
    const shell = inputs.find((input) => input.patterns[0] === "ls -la" && !input.metadata.risk && !input.plan)!
    for (const input of [base, shell])
      for (const category of CATEGORIES)
        for (const cls of ["D", "P"] as const)
          for (const flags of [[], ...FLAGS.map((flag) => [flag]), [...FLAGS]] as readonly (typeof FLAGS)[number][][]) {
            const verdict: AutonomyTable.Verdict = {
              class: cls,
              decidedBy: "gate",
              category,
              ...(flags.length > 0 && { screen: { bytes: 1, lines: 1, sha256: "0".repeat(64), flags } }),
            }
            for (const caller of ["root", "subagent"] as const) {
              const out = AutonomyTable.noWait({ ...input, bypass: { caller } }, verdict)
              if (out.class !== "A" && out.class !== "X") violations.push(`${caller} ${cls} ${category} [${flags}] -> ${out.class}`)
              if (out.class === "X" && !X_WITH_TEXT.has(out.category ?? "")) violations.push(`${caller} ${cls} ${category} -> X ${out.category}`)
            }
          }
    // and every X the table can give stays what it is, except a write outside, which runs (spec section 3 rule 2)
    for (const category of CATEGORIES) {
      const out = AutonomyTable.noWait({ ...base, bypass: { caller: "root" } }, { class: "X", decidedBy: "gate", category })
      if (out.class !== "X" && category !== "outside_write") violations.push(`X ${category} -> ${out.class}`)
    }
    expect(violations).toEqual([])
  })

  test("control: without consent `classify` is `classifyBase`, to the byte, and some calls are held", () => {
    let heldCount = 0
    for (const input of inputs) {
      const verdict = AutonomyTable.classify(input)
      expect(JSON.stringify(verdict)).toBe(JSON.stringify(AutonomyTable.classifyBase(input)))
      if (verdict.class === "D" || verdict.class === "P") heldCount++
    }
    expect(heldCount).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Part 2, the gate: the same calls through `Permission.ask`, with the session, the audit and the decider seam.
// ---------------------------------------------------------------------------------------------------------------------

const folder = path.join(Global.Path.state, "autonomy")

type DeciderCall = { sessionID: string; permission: string; category?: string; options?: AutonomyDecider.Options }
const stub = {
  calls: [] as DeciderCall[],
  answers: [] as (() => Effect.Effect<Permission.Decided>)[],
}
const allow = (): Effect.Effect<Permission.Decided> =>
  Effect.succeed({ decision: "allow", decidedBy: "agent:test/stub", reason: "fine" })
/** Rows 40-49: what the main agent may answer a subagent's call with, every hold reason and every failure included. */
const HOLD_REASONS = ["no_model", "model_error", "timeout", "invalid_output", "queue_full", "circuit_open", "limit", "spend_stopped"]
const DECIDER_OUTCOMES: (() => Effect.Effect<Permission.Decided>)[] = [
  allow,
  ...HOLD_REASONS.map(
    (reason) => () =>
      Effect.succeed({ decision: "reject", decidedBy: "system:main_agent_unavailable", reason } as Permission.Decided),
  ),
  // needs_person, as the decider gives it for a subagent (autonomy-decider.ts:302) and as it gives it for a root
  () => Effect.succeed({ decision: "reject", decidedBy: "agent:test/stub", reason: "a person should look." } as Permission.Decided),
  () => Effect.succeed({ decision: "defer", decidedBy: "agent:test/stub", reason: "cannot tell" } as Permission.Decided),
  () => Effect.succeed({ decision: "defer", decidedBy: "system:decider_unavailable", reason: "no_model" } as Permission.Decided),
  // an exception inside the decider (row 49)
  () => Effect.die(new Error("decider exploded")),
]
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input, _root, category, _script, options) =>
      Effect.suspend(() => {
        stub.calls.push({ sessionID: input.sessionID, permission: input.permission, category, options })
        const answer = stub.answers.length > 0 ? stub.answers[stub.calls.length % stub.answers.length]! : allow
        return answer()
      }),
  }),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Session.node,
      Autonomy.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
  stub.answers = []
})
afterEach(clean)

const say = (sessionID: SessionID, agent = "build") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent,
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
    } satisfies SessionV1.User)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "fix the build",
    } satisfies SessionV1.TextPart)
  })

/** A root in the mode with a person's last message, and a subagent below it. `consent` false is 1.1.0's mode on. */
const family = (consent = true) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* say(root.id)
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({
      scope: "session",
      root: root.id,
      on: true,
      ...(consent && { bypassConsent: "bypass-v1" as const, reportLanguage: "en" as const }),
    })
    return { root, child }
  })

const CATCH_ALL: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
const askOf = (spec: Spec, sessionID: SessionID, metadata: Record<string, unknown>, id: PermissionV1.ID): PermissionV1.AskInput => ({
  id,
  sessionID,
  permission: spec.permission,
  patterns: spec.patterns ?? ["*"],
  metadata,
  always: ["*"],
  ruleset: spec.catchAll ? CATCH_ALL : [],
  canUndo: spec.canUndo ?? true,
  agent: spec.plan ? "plan" : "general",
  ...(spec.editClass && { editClass: spec.editClass }),
  ...(spec.follows && { follows: spec.follows }),
})

type Wrap = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
/** "ran", the text the agent got, or "WAITED" when the call had not ended after three seconds (a `Deferred.await`). */
const settle = (input: PermissionV1.AskInput, wrap: Wrap = (self) => self) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* wrap(permission.ask(input)).pipe(Effect.as("ran" as const), Effect.timeoutOption("3 seconds"), Effect.exit)
    if (Exit.isSuccess(exit)) return Option.isSome(exit.value) ? RAN : { waited: "WAITED (no answer in 3 s)" }
    const failure = Cause.squash(exit.cause)
    if (failure instanceof PermissionV1.DeferredError) return { waited: `DeferredError ${failure.category}` }
    if (failure instanceof PermissionV1.AwayError) return { waited: "AwayError" }
    return { text: failure instanceof Error ? failure.message : String(failure) }
  }) as Effect.Effect<Outcome, never, Permission.Service>

type Outcome = { readonly ran: true } | { readonly waited: string } | { readonly text: string }
const RAN: Outcome = { ran: true }

const decisionLines = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

const pending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list()
})

/** Lays the real `noWait` over a base verdict, in place of the table, so every category reaches the gate. */
const viaNoWait =
  (base: AutonomyTable.Verdict): Wrap =>
  (self) =>
    self.pipe(Effect.provideService(Permission.Classify, (input) => AutonomyTable.noWait(input, base)))
const throwing: Wrap = (self) =>
  self.pipe(
    Effect.provideService(Permission.Classify, () => {
      throw new Error("boom")
    }),
  )

type Sent = {
  name: string
  caller: "root" | "subagent"
  id: PermissionV1.ID
  outcome: Outcome
  writer: boolean
  /** A base verdict of X `not_routine` is answered with its own text, which is `UNJUDGED_TEXT`; not the belt. */
  unjudged?: boolean
}

/** Checks one family's calls against the oracle; returns the violations, each with the call it came from. */
const judgeFamily = (root: SessionID, sent: readonly Sent[], before: number) =>
  Effect.gen(function* () {
    const violations: string[] = []
    for (const call of sent) {
      const where = `${call.caller} ${call.name}`
      if ("waited" in call.outcome) violations.push(`${where}: ${call.outcome.waited}`)
      if ("text" in call.outcome && !allowedText(call.outcome.text)) violations.push(`${where}: not a register text: ${call.outcome.text}`)
      // The belt answers only what the table could not judge or the writer could not record; never a judged call.
      if ("text" in call.outcome && call.outcome.text === UNJUDGED_TEXT && call.writer && !call.unjudged)
        violations.push(`${where}: answered by the gate's belt (UNJUDGED_TEXT), so the table gave a waiting verdict`)
    }
    const lines = yield* decisionLines(root)
    // F113_SUMMARY=1 prints what the calls ended as, for the row 7 report.
    if (process.env.F113_SUMMARY) {
      const tally = new Map<string, number>()
      for (const call of sent) {
        const key = "ran" in call.outcome ? "ran" : "waited" in call.outcome ? `WAITED ${call.outcome.waited}` : call.outcome.text.slice(0, 90)
        tally.set(key, (tally.get(key) ?? 0) + 1)
      }
      const categories = new Map<string, number>()
      for (const line of lines.slice(before)) {
        const key = `${line.class} ${line.category ?? "-"} ${line.decision} bypassed=${line.bypassed ?? "-"}`
        categories.set(key, (categories.get(key) ?? 0) + 1)
      }
      console.log(JSON.stringify({ calls: sent.length, outcomes: Object.fromEntries(tally), lines: Object.fromEntries(categories), decider: stub.calls.length }, null, 1))
    }
    const written = sent.filter((call) => call.writer)
    const byID = new Map<string, number>()
    for (const line of lines) byID.set(line.requestID, (byID.get(line.requestID) ?? 0) + 1)
    for (const call of written)
      if ((byID.get(call.id) ?? 0) !== 1) violations.push(`${call.caller} ${call.name}: ${byID.get(call.id) ?? 0} decision lines`)
    if (lines.length !== before + written.length) violations.push(`${lines.length} decision lines for ${before + written.length} calls`)
    for (const line of lines.slice(before))
      if (line.decision !== "allow" && line.decision !== "reject") violations.push(`line ${line.permission} ${line.patterns.join(" ")}: decision ${line.decision}`)
    // `hold()` never ran: nothing is on the pending list (no entry, no prompt)
    const open = yield* pending
    if (open.length > 0) violations.push(`${open.length} pending: ${open.map((item) => `${item.permission} ${item.patterns.join(" ")}`).join("; ")}`)
    return violations
  })

describe("1.1.3 row 7, gate: under consent no call waits, for the root and for a subagent", () => {
  it.instance(
    "the real table, every generated call: runs or is answered at once, one line each, the decider never settles P",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        populate(test.directory)
        yield* Effect.promise(() => ScriptReader.prepare())
        const { root, child } = yield* family()
        // every subagent call the bypass opened goes to the main agent: cycle its answers through rows 40-49
        stub.answers = DECIDER_OUTCOMES
        const sent: Sent[] = []
        for (const spec of specs(test.directory)) {
          const metadata = yield* Effect.promise(() => stepsOf(spec, test.directory))
          for (const [caller, session] of [["root", root.id], ["subagent", child.id]] as const) {
            const id = PermissionV1.ID.ascending()
            sent.push({ name: spec.name, caller, id, outcome: yield* settle(askOf(spec, session, metadata, id)), writer: true })
          }
        }
        const violations = yield* judgeFamily(root.id, sent, 0)
        // the decider is never asked to settle a class P call, and never for the root
        for (const call of stub.calls) {
          if (call.options?.forSubagent === undefined) violations.push(`decider asked to settle ${call.permission} ${call.category} (class P)`)
          if (call.sessionID === root.id) violations.push(`decider asked for the root: ${call.permission} ${call.category}`)
        }
        expect(violations).toEqual([])
        // non-vacuous: calls ran, archive redirects and refusals were given, and the main agent was asked for subagents
        expect(sent.filter((call) => "ran" in call.outcome).length).toBeGreaterThan(20)
        expect(sent.some((call) => "text" in call.outcome && call.outcome.text === REFUSED_TEXT.not_reversible)).toBe(true)
        expect(sent.some((call) => "text" in call.outcome && call.outcome.text === REFUSED_TEXT.irreversible)).toBe(true)
        expect(sent.some((call) => "text" in call.outcome && call.outcome.text === REFUSED_TEXT.delete_compound)).toBe(true)
        expect(sent.some((call) => "text" in call.outcome && call.outcome.text === consentedRefusalText("admin_rights"))).toBe(true)
        expect(sent.some((call) => "text" in call.outcome && call.outcome.text === consentedRefusalText("credential_change"))).toBe(true)
        expect(stub.calls.length).toBeGreaterThan(DECIDER_OUTCOMES.length)
      }),
    120_000,
  )

  it.instance(
    "a base verdict of every category, D and P, every script flag, through the real `noWait` and the real gate",
    () =>
      Effect.gen(function* () {
        const { root, child } = yield* family()
        stub.answers = DECIDER_OUTCOMES
        const sent: Sent[] = []
        let n = 0
        for (const category of CATEGORIES)
          for (const cls of ["D", "P", "X"] as const)
            for (const flags of [[], ["sudo"], ["delete"], ["network", "eval", "base64", "exec_local", "outside_path"]] as ScriptFormFlags[]) {
              if (flags.length > 0 && (cls === "X" || category !== "script_flagged")) continue
              const base: AutonomyTable.Verdict = {
                class: cls,
                decidedBy: "gate",
                category,
                ...(flags.length > 0 && { screen: { bytes: 1, lines: 1, sha256: "0".repeat(64), flags } }),
              }
              for (const [caller, session] of [["root", root.id], ["subagent", child.id]] as const) {
                const id = PermissionV1.ID.ascending()
                const spec: Spec = { name: `${cls} ${category} [${flags}]`, permission: "graft_find_code", patterns: [`f${n++}`], metadata: {} }
                const unjudged = cls === "X" && category === "not_routine"
                sent.push({ name: spec.name, caller, id, outcome: yield* settle(askOf(spec, session, {}, id), viaNoWait(base)), writer: true, unjudged })
              }
            }
        const violations = yield* judgeFamily(root.id, sent, 0)
        for (const call of stub.calls) {
          if (call.options?.forSubagent === undefined) violations.push(`decider asked to settle ${call.permission} ${call.category} (class P)`)
          if (call.sessionID === root.id) violations.push(`decider asked for the root: ${call.permission} ${call.category}`)
        }
        expect(violations).toEqual([])
        expect(sent.length).toBe(CATEGORIES.length * 3 * 2 + 3 * 2 * 2)
      }),
    120_000,
  )

  it.instance("the record writer failing, and the table throwing: refused at once with UNJUDGED_TEXT, nothing held", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const { root, child } = yield* family()
      stub.answers = DECIDER_OUTCOMES
      const sent: Sent[] = []
      const chosen = specs(test.directory).filter((spec) =>
        ["bash bun install {}", "bash curl https://x.example {}", "bash launchctl list {}", "opaque tool", "mcp local"].includes(spec.name),
      )
      expect(chosen.length).toBe(5)
      chmodSync(folder, 0o500)
      for (const spec of chosen) {
        const metadata = yield* Effect.promise(() => stepsOf(spec, test.directory))
        for (const [caller, session] of [["root", root.id], ["subagent", child.id]] as const) {
          const id = PermissionV1.ID.ascending()
          sent.push({ name: `${spec.name} (writer failing)`, caller, id, outcome: yield* settle(askOf(spec, session, metadata, id)), writer: false })
        }
      }
      chmodSync(folder, 0o755)
      for (const spec of chosen)
        for (const [caller, session] of [["root", root.id], ["subagent", child.id]] as const) {
          const id = PermissionV1.ID.ascending()
          const outcome = yield* settle(askOf({ ...spec, patterns: [`t-${spec.name}`] }, session, {}, id), throwing)
          sent.push({ name: `${spec.name} (table throws)`, caller, id, outcome, writer: false })
          if (!("text" in outcome) || outcome.text !== UNJUDGED_TEXT) throw new Error(`table throws: ${JSON.stringify(outcome)}`)
        }
      const violations = (yield* judgeFamily(root.id, [], 0)).filter((violation) => !violation.includes("decision lines for"))
      for (const call of sent) if ("waited" in call.outcome) violations.push(`${call.caller} ${call.name}: ${call.outcome.waited}`)
      for (const call of sent) if ("text" in call.outcome && !allowedText(call.outcome.text)) violations.push(`${call.caller} ${call.name}: ${call.outcome.text}`)
      for (const call of stub.calls) if (call.options?.forSubagent === undefined) violations.push(`decider settled P: ${call.permission}`)
      expect(violations).toEqual([])
      // the failing writer bit: an opened call it could not record did not run
      expect(sent.some((call) => call.name.endsWith("(writer failing)") && "text" in call.outcome && call.outcome.text === UNJUDGED_TEXT)).toBe(true)
    }),
  )

  it.instance("a full queue (QUEUE_LIMIT held before the consent) and a call held before it: nothing waits, no queue_full", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const { root, child } = yield* family(false)
      const permission = yield* Permission.Service
      // 1.1.0 mode on: fill the root's queue with held calls
      const heldSpecs = Array.from({ length: Permission.QUEUE_LIMIT }, (_, index): Spec => ({
        name: `held ${index}`,
        permission: "graft_find_code",
        patterns: [`q${index}`],
        metadata: {},
      }))
      for (const spec of heldSpecs) {
        const outcome = yield* settle(askOf(spec, root.id, {}, PermissionV1.ID.ascending()))
        expect("waited" in outcome ? outcome.waited : "").toStartWith("DeferredError")
      }
      const full = yield* settle(askOf({ name: "one more", permission: "graft_find_code", patterns: ["q-extra"] }, root.id, {}, PermissionV1.ID.ascending()))
      expect(full).toEqual({ waited: "DeferredError queue_full" })
      const queued = (yield* permission.list()).length
      expect(queued).toBe(Permission.QUEUE_LIMIT)
      const before = (yield* decisionLines(root.id)).length
      // now the person consents
      const autonomy = yield* Autonomy.Service
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
      stub.answers = DECIDER_OUTCOMES
      const sent: Sent[] = []
      const chosen = [
        ...specs(test.directory).filter((spec) => spec.permission === "bash").slice(0, 40),
        ...heldSpecs.slice(0, 3).map((spec) => ({ ...spec, name: `${spec.name} again (held before the consent)` })),
      ]
      for (const spec of chosen) {
        const metadata = yield* Effect.promise(() => stepsOf(spec, test.directory))
        for (const [caller, session] of [["root", root.id], ["subagent", child.id]] as const) {
          const id = PermissionV1.ID.ascending()
          sent.push({ name: spec.name, caller, id, outcome: yield* settle(askOf(spec, session, metadata, id)), writer: true })
        }
      }
      const violations = (yield* judgeFamily(root.id, sent, before)).filter((violation) => !violation.includes(" pending: "))
      expect(violations).toEqual([])
      // the queue did not grow, and no line of the consented calls says queue_full
      expect((yield* permission.list()).length).toBe(queued)
      const lines = (yield* decisionLines(root.id)).slice(before)
      expect(lines.filter((line) => line.category === "queue_full")).toEqual([])
      for (const call of stub.calls) expect(call.options?.forSubagent).toBeDefined()
    }),
    120_000,
  )

  it.instance("the stop class (row 55): a spend limit and a repeating call stop with their text, for the root and a subagent", () =>
    Effect.gen(function* () {
      for (const [caller, permission] of [["subagent", "doom_loop"], ["subagent", "spend_limit"], ["root", "doom_loop"], ["root", "spend_limit"]] as const) {
        const { root, child } = yield* family()
        const id = PermissionV1.ID.ascending()
        const spec: Spec = { name: permission, permission, patterns: ["bash"], metadata: {} }
        const outcome = yield* settle(askOf(spec, caller === "root" ? root.id : child.id, {}, id))
        const violations = yield* judgeFamily(root.id, [{ name: permission, caller, id, outcome, writer: true }], 0)
        expect(violations).toEqual([])
        expect("text" in outcome ? outcome.text : "").toStartWith(SUBAGENT_STOPPED)
      }
      expect(stub.calls).toEqual([])
    }),
  )

  it.instance("control: the same calls without the consent are the 1.1.0 path, and some of them wait", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const { root } = yield* family(false)
      let waited = 0
      for (const spec of specs(test.directory).slice(0, 30)) {
        const metadata = yield* Effect.promise(() => stepsOf(spec, test.directory))
        const outcome = yield* settle(askOf(spec, root.id, metadata, PermissionV1.ID.ascending()))
        if ("waited" in outcome) waited++
      }
      expect(waited).toBeGreaterThan(5)
    }),
    120_000,
  )
})

type ScriptFormFlags = (typeof FLAGS)[number][]
