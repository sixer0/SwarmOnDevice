import { SessionSearch } from "@/session/search"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Question } from "@/question"
import { SessionStatus } from "@/session/status"
import { InstanceDisposed } from "@/server/event"
import { laneRangeMap } from "@/server/shared/lanes-observation"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

// Home's agent board. One entry per instance that has ALREADY booted, because only a booted instance can hold a
// running session or a pending request. Reading per directory instead would boot every project and start its MCP
// children just to find out that nothing is happening there (components/home-status-card.tsx level 3 posture).
const GlobalAgentsInstance = Schema.Struct({
  directory: Schema.String,
  status: Schema.Record(Schema.String, SessionStatus.Info),
  permission: Schema.Array(PermissionV1.Request),
  question: Schema.Array(Question.Request),
}).annotate({ identifier: "GlobalAgentsInstance" })

const GlobalAgents = Schema.Struct({
  instances: Schema.Array(GlobalAgentsInstance),
}).annotate({ identifier: "GlobalAgents" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.String.check(
    Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

// Levels 1-2 of the Home status card (masterplan/04_s6_status_spec.md §4). The route publishes OBSERVATIONS
// only — the card computes level values from them — and the field set below is the whole contract on purpose.
// The setup record also carries absolute install paths, docker object ids, backup paths and digests
// (packages/setup/src/state.ts:28-37); those disclose the home directory and therefore the username to any
// process that can reach the port, so they are not representable in this API at all rather than merely
// omitted by a handler that could otherwise leak them (research/s6_04_route_impact.md §2).
const GlobalSetupStateFile = Schema.Struct({
  path: Schema.String,
  present: Schema.Boolean,
  updatedAtAbsent: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "GlobalSetupStateFile" })

const GlobalSetupComponent = Schema.Struct({
  state: Schema.optional(Schema.String),
  installedBySwarm: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "GlobalSetupComponent" })

const GlobalSetupConfigFile = Schema.Struct({
  path: Schema.String,
  present: Schema.Boolean,
  parseError: Schema.optional(Schema.String),
  entries: Schema.Struct({ graft: Schema.Boolean, swarmWeb: Schema.Boolean }),
}).annotate({ identifier: "GlobalSetupConfigFile" })

const GlobalSetupRegistration = Schema.Struct({
  reader: Schema.Literal("xdg-config"),
  configDirPath: Schema.String,
  configFile: GlobalSetupConfigFile,
  skills: Schema.Array(
    Schema.Struct({ relPath: Schema.String, present: Schema.Boolean }).annotate({ identifier: "GlobalSetupSkill" }),
  ),
}).annotate({ identifier: "GlobalSetupRegistration" })

const GlobalSetup = Schema.Struct({
  observedAt: Schema.String,
  stateFile: GlobalSetupStateFile,
  // Keys are the seven register component ids (PC-CMP-01..07). A string key set keeps the server free of the
  // @swarm/setup import; the handler always emits exactly those seven (server/shared/setup-observation.ts).
  components: Schema.Record(Schema.String, GlobalSetupComponent),
  registration: GlobalSetupRegistration,
}).annotate({ identifier: "GlobalSetup" })

// Row 247 — the lane-control surface (masterplan/06_s6b_lanes_spec.md §5.2). The stored tuple for
// PC-PATH-18 (~/.swarm/setup/lanes.json) plus the bounds it validates against, so the card never
// hard-codes a number, plus an observation half that says what the RUNNING carriers actually carry.
// Two payload rules distinguish this from its sibling /global/setup: only the TILDE form of the
// path is ever published (§526-532: expansion would disclose the home directory over the port),
// and an unreadable stored tuple OMITS `stored` rather than rendering `{}` — an empty map would
// dress a failure up as "legitimately unconfigured", which is the collapse this whole feature
// refuses (§4.3, §5 E5 lineage).
const GlobalLanesFile = Schema.Struct({
  tildePath: Schema.String,
  present: Schema.Boolean,
  error: Schema.optional(Schema.String),
  /** True when this request's write found ~/.swarm/setup at a mode other than 0700 and repaired
   *  it (06 §2.2 verify-not-assume). Reported, never silent. */
  dirModeRepaired: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "GlobalLanesFile" })

const GlobalLaneRange = Schema.Struct({
  min: Schema.Int,
  max: Schema.Int,
  setupValue: Schema.Int,
  stack: Schema.Literals(["firecrawl", "searxng"]),
  service: Schema.Literals(["api", "playwright-service", "searxng"]),
  basis: Schema.String,
}).annotate({ identifier: "GlobalLaneRange" })

// One entry per control, three honest states (the anti-collapse invariant the status card holds):
// a value seen inside the running container, an observed absence of the key there, or a named
// reason the probe could not look. Never a boolean, never null, never a default.
const GlobalLanesObservedValue = Schema.Struct({
  status: Schema.Literal("observed"),
  value: Schema.Int,
}).annotate({ identifier: "GlobalLanesObservedValue" })

const GlobalLanesObservedAbsent = Schema.Struct({
  status: Schema.Literal("absent"),
}).annotate({ identifier: "GlobalLanesObservedAbsent" })

const GlobalLanesObservedUnobserved = Schema.Struct({
  status: Schema.Literal("unobserved"),
  reason: Schema.String,
}).annotate({ identifier: "GlobalLanesObservedUnobserved" })

const GlobalLanesObservedEntry = Schema.Union([
  GlobalLanesObservedValue,
  GlobalLanesObservedAbsent,
  GlobalLanesObservedUnobserved,
]).annotate({ identifier: "GlobalLanesObservedEntry" })

const lanesStateFields = {
  observedAt: Schema.String,
  file: GlobalLanesFile,
  range: Schema.Record(Schema.String, GlobalLaneRange),
  // Sparse by design: an absent key means "unset" and renders as today (06 §5.1 rule 4); the WHOLE
  // key is omitted when the stored file failed validation, see the header above.
  stored: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
  updatedAt: Schema.optional(Schema.String),
  restartRequired: Schema.Literal("container-recreate"),
}

const GlobalLanesState = Schema.Struct(lanesStateFields).annotate({ identifier: "GlobalLanesState" })

const GlobalLanes = Schema.Struct({
  ...lanesStateFields,
  observed: Schema.Record(Schema.String, GlobalLanesObservedEntry),
}).annotate({ identifier: "GlobalLanes" })

/** DOCUMENTATION ONLY as a gate, DOCUMENTATION AS A CONTRACT as a description — `lanesUpdate` is
 *  handled raw (it must answer malformed JSON bodies with the spec's own token, which a framework
 *  decode rejection could not phrase), and the enforced closed set lives in the shared validator the
 *  handler imports. Nothing here decodes a request: an out-of-range submission still meets the
 *  handler's LANE_VALUE_OUT_OF_RANGE, not a schema error, and that ordering is deliberate.
 *
 *  The bounds ARE stated, though (finding F-251-4 / row 252 Q5.1): a published contract that calls
 *  `NUQ_WORKER_COUNT: 999` legal while the server refuses it is a weaker contract than the behaviour,
 *  and a client typed against the generated SDK could only discover the difference at runtime. They
 *  are read off the imported range table rather than restated, so [4,5]/[4,4]/[4,4] keep exactly one
 *  home (row 252 Q6.6 lists that single-home property as the drift class this session keeps closing). */
const lanePatchBounds = laneRangeMap()

function lanePatchField(key: string) {
  const bound = lanePatchBounds[key]
  return Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: bound.min, maximum: bound.max })))
}

export const GlobalLanesPatchInput = Schema.Struct({
  NUQ_WORKER_COUNT: lanePatchField("NUQ_WORKER_COUNT"),
  MAX_CONCURRENT_PAGES: lanePatchField("MAX_CONCURRENT_PAGES"),
  GRANIAN_BLOCKING_THREADS: lanePatchField("GRANIAN_BLOCKING_THREADS"),
}).annotate({ identifier: "GlobalLanesPatchInput" })

export const GlobalPaths = {
  health: "/global/health",
  setup: "/global/setup",
  agents: "/global/agents",
  search: "/global/search",
  lanes: "/global/lanes",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the Swarm server.",
        }),
      ),
      // Machine-global by construction: no query, no payload, and this group carries no instance or
      // workspace middleware (auth arrives from RootHttpApi at api.ts:57-59). Copying the three-middleware
      // shape of groups/mcp.ts:146-148 would make it directory-scoped and stop being a machine fact
      // (research/s6_04_route_impact.md §3).
      HttpApiEndpoint.get("setup", GlobalPaths.setup, {
        success: described(GlobalSetup, "Machine-global setup observations"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.setup",
          summary: "Get setup observations",
          description:
            "Read-only observations behind the Home status card's installed and registered levels: the setup component record, and the presence of the config entry and skill texts the setup writes into the server's own global config directory. Values are observations read during this request; nothing here starts or connects anything.",
        }),
      ),
      HttpApiEndpoint.get("agents", GlobalPaths.agents, {
        success: described(GlobalAgents, "What every booted instance's agents are doing right now"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.agents",
          summary: "Get agent activity",
          description:
            "Session statuses, pending permission requests and pending questions from every instance that has already booted. It never boots an instance, so a project with nothing running stays cold and starts nothing.",
        }),
      ),
      HttpApiEndpoint.get("search", GlobalPaths.search, {
        query: {
          q: Schema.String,
          directory: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.NumberFromString),
        },
        success: described(SessionSearch.Response, "Sessions that answer the question, best first"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.search",
          summary: "Search everything sessions said and did",
          description:
            "Searches prompts, answers, reasoning, edits and commands across every project on this machine, with no model involved. Understands plain questions, dates such as `last month`, and a file with an optional line (`src/auth.ts:42`), which answers which session wrote that line. A running agent is not affected: the index lives in its own file.",
        }),
      ),
      // Row 247 — lane controls. Same machine-global posture as `setup` above (no query, no group
      // middleware; auth arrives from RootHttpApi), because a lane setting is a per-estate fact, not
      // a per-directory one (06 §5.2). The GET answers stored-plus-observed and starts nothing: the
      // observation leg reads /proc/1/environ INSIDE already-running, label-scoped carriers via
      // `docker exec` (rule E17) and degrades to named reasons when it cannot — it never spawns.
      HttpApiEndpoint.get("lanesGet", GlobalPaths.lanes, {
        success: described(GlobalLanes, "Lane-control state: stored tuple, published bounds, and in-container observations"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.lanes.get",
          summary: "Get lane controls",
          description:
            "The stored lane tuple (~/.swarm/setup/lanes.json, tilde form only), each control's validation bounds straight off the shipped range table, and what the running carrier containers actually carry in their PID 1 environment. Every control is recreate-class: applying a stored change needs the stack's apply command, so restartRequired says so rather than implying live effect. An unreadable stored file yields file.error with `stored` omitted — never an empty map dressed up as unconfigured.",
        }),
      ),
      // PATCH is merge-then-validate-whole (§5.2): the submitted fields over the stored map, the
      // candidate checked by the shared validator BEFORE any filesystem call exists, then one atomic
      // commit. Refusals are 400s carrying the spec's LANE_VALUE_* tokens — input defects, not policy
      // (the sibling upgrade's 403 remains the policy shape).
      HttpApiEndpoint.patch("lanesUpdate", GlobalPaths.lanes, {
        payload: GlobalLanesPatchInput,
        success: described(GlobalLanesState, "The full stored state after commit"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.lanes.update",
          summary: "Update lane controls",
          description:
            "Merge the submitted subset of the three lane controls over the stored tuple, validate the whole candidate through the shipped validator, and commit atomically at mode 0600. Any defect — out-of-range (both sides of the bounds), a key outside the closed three-name set, a non-integer value, or a body that is not the closed struct — refuses with its LANE_VALUE_* token and writes nothing, including the well-formed siblings of the same payload. The response is the full stored state read back after commit.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the Swarm system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global Swarm configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global Swarm configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all Swarm instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade swarm",
          description: "Upgrade swarm to the specified version.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
