import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
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

export const GlobalPaths = {
  health: "/global/health",
  setup: "/global/setup",
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
