import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { BASELINE_CONFIG } from "@opencode-ai/core/swarm-defaults"
import {
  AGENT_BASELINE,
  PERMISSION_BASELINE,
  RESEARCHER_AGENT,
  SWARM_PERMISSION_BASELINE,
} from "@opencode-ai/core/swarm-permission-baseline"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { test, expect } from "bun:test"
import { mergeDeep } from "remeda"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

// Row 96 acceptance suite for the shipped permission baseline
// (masterplan/01f_tool_wiring_spec.md §4.2/§5.1). Every assertion drives the REAL
// matcher and merge code — Permission.fromConfig/evaluate/merge/disabled, the real
// Wildcard.match, and the same remeda mergeDeep that config.ts:41-44 uses for config
// merging — never a re-implementation of the rule engine. T-W7-7 assertions A-G are
// mirrored by name; T-W7-8 (ask-vs-hide asymmetry) is row 96's per §11. The CLI legs
// (T-W7-6, T-W7-7-D, r94 validator hookup) live in baseline.proofs.sh beside this file.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const rejectAll = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({ requestID: req.id, reply: "reject" })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

// Static projection of the built-in defaults at agent.ts:119-136. The dynamic
// whitelistedDirs allow entries under external_directory are machine-specific and do
// not participate in any case below; the real full construction is exercised
// end-to-end by baseline.proofs.sh through `swarm debug agent`.
const upstreamDefaults = Permission.fromConfig({
  "*": "allow",
  doom_loop: "ask",
  external_directory: { "*": "ask" },
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
})

const baselineRuleset = Permission.fromConfig(PERMISSION_BASELINE as unknown as ConfigPermissionV1.Info)

// The exact ruleset a native agent gets once the baseline ships: agent.ts:145-152
// merges Permission.merge(defaults, <agent-specific>, user) with `user` last, so
// appending the baseline ruleset after the defaults projection reproduces the
// precedence position the shipped code produces for the build agent.
const mergedNative = Permission.merge(upstreamDefaults, baselineRuleset)

// --- shipped shape --------------------------------------------------------------

test("baseline - composes into BASELINE_CONFIG (the FR-DEF-04 merge slot)", () => {
  // config.ts:336-340 seeds loadInstanceState with BASELINE_CONFIG; structural
  // equality here is the proof that row 96's entries ride that exact slot with zero
  // config.ts edits. The payload arrives through fresh-copy getters (measured remeda
  // assigns absent source keys by reference), so two reads are distinct objects.
  expect(BASELINE_CONFIG.permission).toEqual(PERMISSION_BASELINE)
  expect(BASELINE_CONFIG.agent).toEqual(AGENT_BASELINE)
  expect(BASELINE_CONFIG.experimental).toEqual(SWARM_PERMISSION_BASELINE.experimental)
  expect(BASELINE_CONFIG.experimental.mcp_timeout).toBe(600000)
  expect(BASELINE_CONFIG.permission).not.toBe(BASELINE_CONFIG.permission)
})

// CFG-02 / 01d T2d: every `config.ts:<n>` reference in the baseline comments names a
// key of CORE v1/config/config.ts; line n must contain it (the refs went stale once).
test("baseline - config.ts line references point at their keys", async () => {
  const baselineSrc = await Bun.file(
    new URL("../../../core/src/swarm-permission-baseline.ts", import.meta.url),
  ).text()
  const configLines = (
    await Bun.file(new URL("../../../core/src/v1/config/config.ts", import.meta.url)).text()
  ).split("\n")
  // References are written `config.ts:<n> <key>` so the key follows its line number.
  const refs = [...baselineSrc.matchAll(/config\.ts:(\d+) (mcp_timeout|experimental)\b/g)]
  expect(refs.map((m) => m[2]).sort()).toEqual(["experimental", "mcp_timeout"])
  for (const [, n, key] of refs) expect(configLines[Number(n) - 1]).toContain(key)
  // no reference without a named key
  expect(baselineSrc.match(/config\.ts:\d+/g)?.length).toBe(refs.length)
})

test("baseline - key order is normative (catch-all first, per-server gates last)", () => {
  const keys = Object.keys(PERMISSION_BASELINE)
  expect(keys[0]).toBe("*")
  expect(keys.slice(-2)).toEqual(["graft_*", "swarm-web_*"])
  // web denies sit before bash; grants sit between the catch-all and the denies.
  expect(keys.indexOf("webfetch")).toBeLessThan(keys.indexOf("bash"))
  expect(keys.indexOf("glob")).toBeLessThan(keys.indexOf("webfetch"))
  // fromConfig emits rules in that order, so findLast sees grants/denies/gates after "*".
  const firstRule = Permission.fromConfig(PERMISSION_BASELINE as unknown as ConfigPermissionV1.Info)[0]
  expect(firstRule).toEqual({ permission: "*", pattern: "*", action: "ask" })
})

test("baseline - researcher block matches 01f §5.1 shape (deny-all first, three grants)", () => {
  const permKeys = Object.keys(RESEARCHER_AGENT.permission)
  expect(permKeys[0]).toBe("*")
  expect(RESEARCHER_AGENT.permission["*"]).toBe("deny")
  expect(RESEARCHER_AGENT.mode).toBe("subagent")
  expect(RESEARCHER_AGENT.permission.task).toBe("deny")
  expect(RESEARCHER_AGENT.permission.todowrite).toBe("deny")
  for (const grant of ["swarm-web_search", "swarm-web_fetch", "swarm-web_vault_inbox"]) {
    expect(RESEARCHER_AGENT.permission[grant as keyof typeof RESEARCHER_AGENT.permission]).toBe("allow")
  }
})

// --- T-W7-7 assertions A and B ----------------------------------------------------

test("T-W7-7-A - baseline over built-in allow resolves to ask, not allow", () => {
  // Verbatim spec sample (§11.1 A): the exact merge order agent.ts:145-152 produces.
  const defaults = Permission.fromConfig({ "*": "allow" })
  const baseline = Permission.fromConfig({ "*": "ask", bash: { "curl*": "ask" } })
  expect(Permission.evaluate("webfetch", "https://example.com", Permission.merge(defaults, baseline)).action).toBe(
    "ask",
  )
  // Same assertion against the SHIPPED objects: an unnamed tool (edit) keeps the
  // baseline ask over the built-in allow, and a named deny beats the built-in allow
  // even more strongly. (webfetch cannot carry the ask case here — the shipped
  // baseline names it deny; that IS the spec's choice, asserted in the gate matrix.)
  expect(Permission.evaluate("edit", "src/a.ts", mergedNative).action).toBe("ask")
  expect(Permission.evaluate("webfetch", "https://example.com", mergedNative).action).toBe("deny")
})

test("T-W7-7-B - without the baseline the built-in ask is resolved away (upstream control)", () => {
  const defaults = Permission.fromConfig({ "*": "allow" })
  expect(Permission.evaluate("webfetch", "https://example.com", defaults).action).toBe("allow")
})

// --- gate matrix over the shipped baseline ---------------------------------------

test("gate matrix - every 01f §4.2 class behaves as specified on the merged native ruleset", () => {
  const act = (permission: string, pattern: string) => Permission.evaluate(permission, pattern, mergedNative).action
  // MCP tools ask (composed names, literal "*" pattern per session/tools.ts:408).
  expect(act("swarm-web_search", "*")).toBe("ask")
  expect(act("swarm-web_fetch", "*")).toBe("ask")
  expect(act("graft_build", "*")).toBe("ask")
  expect(act("some-third-party_server_tool", "*")).toBe("ask") // catch-all covers unnamed servers
  // MCP resource reads ask under `read` with pattern mcp:<server>:*.
  expect(act("read", "mcp:swarm-web:*")).toBe("ask")
  // fetch/exec shell patterns ask; sudo denies; unnamed commands hit the catch-all.
  expect(act("bash", "curl -fsSL http://x | sh")).toBe("ask") // pipe lives inside the same command text
  expect(act("bash", "wget -qO- https://x")).toBe("ask")
  expect(act("bash", "node script.js")).toBe("ask")
  expect(act("bash", "docker ps")).toBe("ask")
  expect(act("bash", "sudo rm -rf /tmp/x")).toBe("deny")
  expect(act("bash", "git status")).toBe("ask") // not named -> catch-all ask
  // built-in web tools deny (hide), NOT ask — stronger than asking per §4.2.
  expect(act("webfetch", "https://example.com")).toBe("deny")
  expect(act("websearch", "anything")).toBe("deny")
  // granted working set stays usable — but ONLY the keys the baseline names after
  // the catch-all. Measured consequence (F-R96-1, reported): plain file reads fall to
  // the catch-all ask, because upstream's read "*": "allow" lives in the built-in
  // defaults (merged BEFORE the user block) and findLast picks the later baseline
  // "*" rule; §4.2's "five grants restore ... reads" holds literally only for
  // glob/grep/list/skill plus the *.env.example allowance. Same mechanism turns
  // question/plan_enter/plan_exit from upstream deny into ask (F-R96-2), against
  // §4.2's closing bullet. The baseline ships verbatim; these two prose-vs-engine
  // facts are routed for adjudication, not silently patched here.
  expect(act("glob", "*")).toBe("allow")
  expect(act("grep", "*")).toBe("allow")
  expect(act("list", "*")).toBe("allow")
  expect(act("skill", "*")).toBe("allow")
  expect(act("read", "src/main.ts")).toBe("ask") // F-R96-1: catch-all subsumes defaults' read allow
  // edit deliberately stays ask (tightening over upstream allow).
  expect(act("edit", "src/a.ts")).toBe("ask")
  // .env classes land on ask either way (the *.env.example grant is what restores it);
  // question keeps prompting — F-R96-2 pins ask, not upstream's deny.
  expect(act("read", "config/.env")).toBe("ask")
  expect(act("read", "config/.env.example")).toBe("allow")
  expect(act("question", "*")).toBe("ask") // F-R96-2
  expect(act("doom_loop", "*")).toBe("ask")
  // task spawn prompts on primary agents (unnamed -> catch-all); §5.1 relies on this.
  expect(act("task", "researcher")).toBe("ask")
})

test("gate matrix - bash 'always' reply records a prefix that keeps matching later calls", () => {
  // §4.2: the tool sends always entries as arity prefixes plus " *" (shell.ts:409 +
  // permission/arity.ts), and an "always" reply appends {permission,pattern,allow} to
  // the in-memory approved list which evaluate() consults after the ruleset
  // (index.ts:73,145-151). So approving `curl -fsSL …` once records "curl *" — which
  // still wins over the baseline ask on the next curl command.
  const approved = [{ permission: "bash", pattern: "curl *", action: "allow" as const }]
  expect(Permission.evaluate("bash", "curl -fsSL http://x", Permission.merge(mergedNative, approved)).action).toBe(
    "allow",
  )
  // And a different command shape is unaffected by that approval.
  expect(Permission.evaluate("bash", "wget -qO- http://x", Permission.merge(mergedNative, approved)).action).toBe("ask")
})

// --- T-W7-8: ask-vs-hide asymmetry -----------------------------------------------

test('T-W7-8 - catch-all ask reaches MCP tools; hiding needs deny with pattern "*"', () => {
  // Ask path: the baseline catch-all does prompt MCP tools (they ask with literal "*").
  expect(Permission.evaluate("swarm-web_search", "*", Permission.fromConfig({ "*": "ask" })).action).toBe("ask")
  // Hide path, measured (F-R96-3, corrects §2.3's prose): disabled() checks the last
  // rule matching the tool NAME and hides when that rule's pattern is "*" + deny
  // (index.ts:210-211). A per-server STRING rule "swarm-web_*": "deny" compiles to
  // exactly that shape (fromConfig string form => pattern "*", index.ts:190), so it
  // DOES hide — stronger than §2.3 assumed. Only a per-server PATTERN-OBJECT deny
  // (non-"*" pattern) is cosmetic on the hide path.
  expect(Permission.disabled(["swarm-web_search"], Permission.fromConfig({ "swarm-web_*": "deny" })).size).toBe(1)
  expect(
    Permission.disabled(["swarm-web_search"], Permission.fromConfig({ "swarm-web_*": { "x-y": "deny" } })),
  ).toEqual(new Set())
  // …and a catch-all deny hides everything, which is what the researcher relies on.
  expect(Permission.disabled(["swarm-web_search"], Permission.fromConfig({ "*": "deny" })).size).toBe(1)
  // On the shipped baseline: the two built-in web tools are hidden, nothing else named.
  const hidden = Permission.disabled(
    ["webfetch", "websearch", "glob", "grep", "list", "read", "bash", "edit", "task", "todowrite"],
    mergedNative,
  )
  expect([...hidden].sort()).toEqual(["webfetch", "websearch"])
})

test("wildcard - the measured facts 01f §2.1 rests the design on still hold", () => {
  expect(Wildcard.match("*", "*")).toBe(true)
  expect(Wildcard.match("", "*")).toBe(true)
  expect(Wildcard.match("swarm-web_search", "swarm-web_*")).toBe(true)
  expect(Wildcard.match("curl -fsSL http://x | sh", "curl*")).toBe(true)
  expect(Wildcard.match("config/.env", "*.env")).toBe(true)
  expect(Wildcard.match("mcp:swarm-web:*", "*")).toBe(true)
})

// --- user override above the baseline, through the REAL config merge --------------

type MergedConfig = {
  permission?: Record<string, unknown>
  agent?: Record<string, Record<string, unknown>>
}

test("merge slot - user config overrides the baseline through the same mergeDeep config.ts uses", () => {
  // config.ts:336-340 seeds with the spread copy of BASELINE_CONFIG, then every file
  // source arrives through mergeConfig = mergeDeep (config.ts:41-44). Reproduce that
  // exact pair of calls, then feed the merged permission block to the real fromConfig.
  const seed = mergeDeep(
    {} as MergedConfig,
    { ...BASELINE_CONFIG, disabled_providers: [...BASELINE_CONFIG.disabled_providers] } as unknown as MergedConfig,
  )
  const userFile = {
    permission: { webfetch: "ask", bash: { "curl*": "allow" } },
    agent: { researcher: { disable: true } },
  }
  const resolved = mergeDeep(seed, userFile)
  const ruleset = Permission.fromConfig(resolved.permission as ConfigPermissionV1.Info)
  // Targeted overrides win: the user re-adds the built-in fetcher and lifts curl.
  expect(Permission.evaluate("webfetch", "https://example.com", ruleset).action).toBe("ask")
  expect(Permission.evaluate("bash", "curl -fsSL http://x", ruleset).action).toBe("allow")
  // Untouched baseline entries keep enforcing.
  expect(Permission.evaluate("bash", "sudo rm -rf /tmp/x", ruleset).action).toBe("deny")
  expect(Permission.evaluate("websearch", "q", ruleset).action).toBe("deny")
  // The researcher disable flag rides through the merge (agent.ts:269-271 deletes it).
  const researcher = resolved.agent?.researcher as Record<string, unknown> | undefined
  expect(researcher?.disable).toBe(true)
  expect(researcher?.mode).toBe("subagent")
})

test("merge slot - blanket '*' undo lifts unnamed tools but not named rules (measured semantics)", () => {
  // mergeDeep replaces the VALUE at the shared key's position, so a user "*" lands
  // where the baseline "*" sat — first. findLast then still picks the baseline's
  // later-named rules. This pins the honest consequence: users undo specific rules by
  // naming them; a blanket allow only frees tools the baseline never named.
  const seed = mergeDeep({} as MergedConfig, BASELINE_CONFIG as unknown as MergedConfig)
  const resolved = mergeDeep(seed, { permission: { "*": "allow" } })
  const ruleset = Permission.fromConfig(resolved.permission as ConfigPermissionV1.Info)
  expect(Permission.evaluate("edit", "src/a.ts", ruleset).action).toBe("allow") // unnamed -> lifted
  expect(Permission.evaluate("bash", "curl -fsSL http://x", ruleset).action).toBe("ask") // named -> survives
  expect(Permission.evaluate("webfetch", "https://example.com", ruleset).action).toBe("deny") // named -> survives
})

test("merge slot - shipped baseline objects survive real merges unmutated (no shared-reference bleed)", () => {
  const before = JSON.stringify(SWARM_PERMISSION_BASELINE)
  const a = mergeDeep({} as MergedConfig, { ...BASELINE_CONFIG } as unknown as MergedConfig)
  const b = mergeDeep({} as MergedConfig, { ...BASELINE_CONFIG } as unknown as MergedConfig)
  // The getter composition means the seed already owns fresh copies, even though
  // remeda would have assigned absent source keys by reference (measured).
  expect(a.permission).not.toBe(PERMISSION_BASELINE)
  // Deep-mutate one resolved tree the way downstream code could, then re-check both
  // the shipped source and the untouched sibling resolution.
  ;(a.permission as Record<string, unknown>).webfetch = "allow"
  delete (a.agent as Record<string, unknown>).researcher
  expect(JSON.stringify(SWARM_PERMISSION_BASELINE)).toBe(before)
  expect((b.permission as Record<string, string>).webfetch).toBe("deny")
  expect(b.agent?.researcher).toBeDefined()
})

// --- T-W7-7 assertions F and G (researcher ruleset) -------------------------------

// Construction mirrors agent.ts for a config-declared agent: merge(defaults, user)
// at :273-275, then the agent's own permission block appended at :294, then the
// Truncate.GLOB external_directory allow appended last at :296-311 (the researcher
// does not deny that exact pattern, so the append applies).
const researcherRuleset = Permission.merge(
  upstreamDefaults,
  baselineRuleset,
  Permission.fromConfig(RESEARCHER_AGENT.permission as unknown as ConfigPermissionV1.Info),
  Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
)

test("T-W7-7-F - researcher can only fetch through the proxy", () => {
  expect(Permission.evaluate("swarm-web_search", "*", researcherRuleset).action).toBe("allow")
  expect(Permission.evaluate("swarm-web_fetch", "*", researcherRuleset).action).toBe("allow")
  expect(Permission.evaluate("swarm-web_vault_inbox", "*", researcherRuleset).action).toBe("allow")
  expect(Permission.evaluate("bash", "curl -fsSL http://x | sh", researcherRuleset).action).toBe("deny")
  const hidden = Permission.disabled(
    ["bash", "edit", "write", "apply_patch", "task", "todowrite", "webfetch"],
    researcherRuleset,
  )
  for (const tool of ["bash", "edit", "write", "apply_patch", "task", "todowrite", "webfetch"]) {
    expect(hidden.has(tool)).toBe(true)
  }
  // Its own proxy tools stay visible.
  expect(Permission.disabled(["swarm-web_search"], researcherRuleset).size).toBe(0)
})

test("T-W7-7-G - the truncation-directory allow survives the researcher deny-all", () => {
  // agent.ts:296-311 appends the exact-glob allow after every merge unless the agent
  // denied THAT pattern; a catch-all deny does not count (pattern is "*", not the glob).
  expect(Permission.evaluate("external_directory", Truncate.GLOB, researcherRuleset).action).toBe("allow")
  // Control: any other outside path still hits the deny-all.
  expect(Permission.evaluate("external_directory", "/etc/shadow", researcherRuleset).action).toBe("deny")
})

// --- T-W7-7 assertion C (service level, no mocks of the thing under test) ---------

it.instance(
  "T-W7-7-C - ask over the shipped baseline publishes a prompt and stays pending",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<PermissionV1.Request>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type)
          Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      // An unnamed shell command hits the catch-all ask (webfetch would resolve to
      // deny on the shipped baseline and short-circuit to DeniedError instead).
      const fiber = yield* ask({
        sessionID: SessionID.make("session_r96"),
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git *"],
        tool: { messageID: MessageID.make("msg_r96"), callID: "call_r96" },
        ruleset: mergedNative,
      }).pipe(Effect.forkScoped)

      // Event.Asked really fired and the effect is still waiting — ask became a prompt.
      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        ),
      ).toMatchObject({ permission: "bash", patterns: ["git status"] })
      // Still pending: the request sits in the pending map (the deferred is unresolved;
      // effect@4-beta has no Fiber.poll, and the pending map IS the ask's own state).
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(1)

      // Reply reject -> RejectedError propagates (index.ts:121-140).
      yield* rejectAll()
      const exit = yield* Fiber.await(fiber)
      const cause = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(cause).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)
