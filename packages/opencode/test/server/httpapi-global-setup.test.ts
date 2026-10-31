// Row 201 — `GET /global/setup`, the machine-global route behind the Home status card's levels 1-2.
//
// Two layers here, because the two things that need proving are different kinds of thing:
//  - the OBSERVATION rules (which file state produces which payload) are proven against throwaway
//    directories by calling the reader the handler itself calls, with paths passed explicitly;
//  - the SURFACE rules (auth posture, published key set, no directory binding) are proven over HTTP
//    against the real RootHttpApi tree, exactly as production assembles it (server.ts:140-144 provides
//    httpApiAuthLayer + schemaErrorLayer around rootApiRoutes).
//
// Run targeted: cd packages/opencode && bun test test/server/httpapi-global-setup.test.ts

import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Permission } from "../../src/permission"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { SessionStatus } from "../../src/session/status"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  SETUP_COMPONENT_IDS,
  SETUP_SKILL_PATHS,
  observeRegistration,
  observeStateFile,
  setupObservation,
} from "../../src/server/shared/setup-observation"
import { testEffect } from "../lib/effect"

// The four keys row 194 §2 names as never-publishable, plus the two supply-chain fields its §2
// recommendation leaves off by default. A single stray `paths[]` is a username disclosure.
const FORBIDDEN_KEYS = ["paths", "dockerObjects", "backups", "lockVersion", "version", "integrity"]

function keyTrail(value: unknown, trail = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyTrail(item, trail))
  if (!value || typeof value !== "object") return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    `${trail}.${key}`,
    ...keyTrail(child, `${trail}.${key}`),
  ])
}

function forbiddenKeys(value: unknown) {
  return keyTrail(value).filter((trail) => FORBIDDEN_KEYS.includes(trail.slice(trail.lastIndexOf(".") + 1)))
}

function tempRoot(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `r201-${tag}-`))
  // 0700 so the fixtures below, which name absolute paths, are not readable by other local users either.
  chmodSync(dir, 0o700)
  return dir
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8")
}

describe("GET /global/setup observations", () => {
  describe("state file degradation (spec §5 E3-E5c)", () => {
    test("a missing record is present:false with no error and no invented component states", () => {
      const dir = tempRoot("missing")
      try {
        const path = join(dir, "state.json")
        const read = observeStateFile(path)
        expect(read.stateFile).toEqual({ path, present: false })
        // E3/E4: "never set up" and "removed itself" are indistinguishable, and every component stays
        // unobserved rather than being defaulted to `absent` (§4 rule 2).
        expect(SETUP_COMPONENT_IDS.map((id) => read.components[id])).toEqual(SETUP_COMPONENT_IDS.map(() => ({})))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("an unreadable record keeps its verbatim cause instead of an all-absent default", () => {
      const dir = tempRoot("unreadable")
      const path = join(dir, "state.json")
      try {
        writeJson(path, { components: { graft: { state: "healthy" } } })
        chmodSync(path, 0o000)
        const read = observeStateFile(path)
        expect(read.stateFile.present).toBe(true)
        expect(read.stateFile.error).toBeDefined()
        expect(read.stateFile.error?.startsWith("cannot read state file:")).toBe(true)
        // E5a: this is the loudest trap in the matrix — a permission problem must never read as
        // "nothing installed". No component may carry a state here.
        expect(read.components.graft).toEqual({})
        expect(forbiddenKeys(read)).toEqual([])
      } finally {
        chmodSync(path, 0o600)
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("invalid JSON and a non-object top level each name their own cause", () => {
      const dir = tempRoot("unparseable")
      try {
        const broken = join(dir, "broken.json")
        writeFileSync(broken, "{not json", "utf8")
        const invalid = observeStateFile(broken)
        expect(invalid.stateFile.present).toBe(true)
        expect(invalid.stateFile.error?.startsWith("state file is not valid JSON:")).toBe(true)
        expect(invalid.components.graft).toEqual({})

        const arrayTop = join(dir, "array.json")
        writeFileSync(arrayTop, "[1,2]", "utf8")
        expect(observeStateFile(arrayTop).stateFile.error).toBe("state file top level is not an object")

        const scalar = join(dir, "scalar.json")
        writeFileSync(scalar, "7", "utf8")
        expect(observeStateFile(scalar).stateFile.error).toBe("state file top level is not an object")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("a wrong-but-readable mode is not a read precondition (E5c)", () => {
      const dir = tempRoot("mode")
      const path = join(dir, "state.json")
      try {
        writeJson(path, { updatedAt: "2026-10-20T00:00:00.000Z", components: { graft: { state: "healthy" } } })
        chmodSync(path, 0o644)
        const read = observeStateFile(path)
        // PC-PATH-02 expects 0600, but readState never checks mode (packages/setup/src/state.ts:105-126),
        // so level 1 must stay unchanged rather than be downgraded because of permissions.
        expect(read.stateFile.error).toBeUndefined()
        expect(read.stateFile.present).toBe(true)
        expect(read.components.graft).toEqual({ state: "healthy" })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("record passthrough and leak surface (spec §4 rules 1-2)", () => {
    const dir = tempRoot("record")
    const path = join(dir, "state.json")

    beforeAll(() => {
      writeJson(path, {
        version: 1,
        lockVersion: "9.9.9",
        updatedAt: "2026-10-20T22:59:12.000Z",
        components: {
          runtime: {
            state: "healthy",
            installedBySwarm: false,
            version: "22.0.0",
            integrity: "sha256:aaa",
            paths: ["/Users/someuser/.swarm/tools/runtime/bin/node"],
            dockerObjects: [{ kind: "volume", id: "fc-data", createdBySwarm: true, hasData: true }],
            backups: ["/Users/someuser/.swarm/setup/backups/swarm.json.deadbeef.bak"],
          },
          graft: { state: "absent" },
          // An unrecognised value must survive verbatim; normalise() would not have produced it and the
          // route may not turn it into a known word (§4 rule 2).
          rtk: { state: "downloaded-but-strange" },
          // No state field at all: normalise() coerces this to `absent` (state.ts:76); publishing that
          // would be a positive claim of absence, so the observation stays empty instead.
          node: { installedBySwarm: true },
          // Not an object: no observation.
          obsidian: "broken",
          searxng: { state: "failed", paths: ["/Users/someuser/.swarm/tools/searxng"] },
        },
      })
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    test("publishes only state and installedBySwarm, verbatim", () => {
      const read = observeStateFile(path)
      expect(read.stateFile).toEqual({ path, present: true, updatedAtAbsent: false })
      expect(read.components).toEqual({
        runtime: { state: "healthy", installedBySwarm: false },
        node: { installedBySwarm: true },
        graft: { state: "absent" },
        rtk: { state: "downloaded-but-strange" },
        obsidian: {},
        searxng: { state: "failed" },
        firecrawl: {},
      })
    })

    test("never copies paths, dockerObjects, backups, lockVersion, version or integrity out of the record", () => {
      const read = observeStateFile(path)
      expect(forbiddenKeys(read)).toEqual([])
      // The record under test is deliberately full of them, so an empty result above is a real filter and
      // not an empty input.
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
      expect(forbiddenKeys(raw).length).toBeGreaterThan(0)
    })

    test("updatedAtAbsent flags a record whose age would otherwise be fabricated", () => {
      const noStamp = join(dir, "no-stamp.json")
      writeJson(noStamp, { components: { graft: { state: "healthy" } } })
      expect(observeStateFile(noStamp).stateFile.updatedAtAbsent).toBe(true)

      const nullStamp = join(dir, "null-stamp.json")
      writeFileSync(nullStamp, JSON.stringify({ updatedAt: null, components: {} }), "utf8")
      expect(observeStateFile(nullStamp).stateFile.updatedAtAbsent).toBe(true)
    })
  })

  describe("registration (spec §4 registration, §5 E16/E17)", () => {
    test("an absent swarm.json is present:false with both entries false and no parse error", () => {
      const dir = tempRoot("reg-absent")
      try {
        const reg = observeRegistration(dir)
        expect(reg.reader).toBe("xdg-config")
        expect(reg.configDirPath).toBe(dir)
        expect(reg.configFile).toEqual({ path: join(dir, "swarm.json"), present: false, entries: { graft: false, swarmWeb: false } })
        expect(reg.skills).toEqual(SETUP_SKILL_PATHS.map((relPath) => ({ relPath, present: false })))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("entry presence is read off the mcp map, including the swarm-web literal", () => {
      const dir = tempRoot("reg-entries")
      try {
        writeJson(join(dir, "swarm.json"), { mcp: { graft: { type: "local", command: ["graft"] }, "swarm-web": { type: "local" } } })
        mkdirSync(join(dir, "skills", "graft"), { recursive: true })
        writeFileSync(join(dir, "skills", "graft", "SKILL.md"), "# graft\n", "utf8")
        const reg = observeRegistration(dir)
        expect(reg.configFile.present).toBe(true)
        expect(reg.configFile.entries).toEqual({ graft: true, swarmWeb: true })
        // E17: config-file presence and skill presence are separate cells and may legitimately disagree.
        expect(reg.skills).toEqual([
          { relPath: "agent/researcher.md", present: false },
          { relPath: "skills/swarm-research/SKILL.md", present: false },
          { relPath: "skills/graft/SKILL.md", present: true },
          { relPath: "skills/rtk/SKILL.md", present: false },
          { relPath: "skills/obsidian-inbox/SKILL.md", present: false },
        ])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("a corrupt swarm.json reports present plus the parse cause, never silence (E16)", () => {
      const dir = tempRoot("reg-corrupt")
      try {
        const file = join(dir, "swarm.json")
        writeFileSync(file, '{"mcp": ', "utf8")
        const reg = observeRegistration(dir)
        expect(reg.configFile.present).toBe(true)
        expect(reg.configFile.parseError?.startsWith("swarm.json is not valid JSON:")).toBe(true)
        expect(reg.configFile.entries).toEqual({ graft: false, swarmWeb: false })

        writeFileSync(file, '["mcp"]', "utf8")
        expect(observeRegistration(dir).configFile.parseError).toBe("swarm.json top level is not an object")

        // A non-object mcp block is not a crash and not an entry either.
        writeJson(file, { mcp: "nope" })
        expect(observeRegistration(dir).configFile.entries).toEqual({ graft: false, swarmWeb: false })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("observation freshness", () => {
    test("observedAt is stamped per call and the payload reflects the files as they are now", async () => {
      const dir = tempRoot("fresh")
      const statePath = join(dir, "state.json")
      try {
        const first = setupObservation(dir, statePath)
        expect(first.stateFile.present).toBe(false)
        await Effect.runPromise(Effect.sleep("15 millis"))
        const second = setupObservation(dir, statePath)
        expect(Date.parse(second.observedAt)).toBeGreaterThanOrEqual(Date.parse(first.observedAt))
        expect(second.observedAt).not.toBe(first.observedAt)

        // No caching across requests: writing the record between two calls changes the next answer.
        writeJson(statePath, { updatedAt: "2026-10-21T00:00:00.000Z", components: { graft: { state: "healthy" } } })
        expect(setupObservation(dir, statePath).components.graft).toEqual({ state: "healthy" })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Surface: auth posture and published key set over the real route tree.
// ---------------------------------------------------------------------------

const PASSWORD = "r201-probe-password"

function apiLayer(password: Option.Option<string>) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // Raw HttpApi routes expose an opaque handler context at the request boundary
      // (same workaround httpapi-global.test.ts uses).
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(InstanceStore.Service)({})),
    Layer.provide(Layer.mock(Permission.Service)({})),
    Layer.provide(Layer.mock(Question.Service)({})),
    Layer.provide(Layer.mock(SessionStatus.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
  )
}

function basic(password: string) {
  // Built by the product's own helper so the credential shape cannot drift from what the auth layer
  // decodes (packages/opencode/src/server/auth.ts:40-45; username default literal "opencode" at :19).
  return ServerAuth.header({ username: "opencode", password }) ?? ""
}

const guardedIt = testEffect(apiLayer(Option.some(PASSWORD)))
const openIt = testEffect(apiLayer(Option.none()))

describe("GET /global/setup surface", () => {
  guardedIt.live("rejects an anonymous request with 401", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.setup).pipe(HttpClient.execute)
      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  guardedIt.live("rejects a wrong password with 401", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.setup)
        .pipe(HttpClientRequest.setHeader("Authorization", basic("not-the-password")), HttpClient.execute)
      expect(response.status).toBe(401)
    }),
  )

  guardedIt.live("answers a credentialed request with the minimum observation set", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.setup)
        .pipe(HttpClientRequest.setHeader("Authorization", basic(PASSWORD)), HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["components", "observedAt", "registration", "stateFile"])
      expect(forbiddenKeys(body)).toEqual([])
      expect(Object.keys(body.components as Record<string, unknown>).sort()).toEqual([...SETUP_COMPONENT_IDS].sort())
      const registration = body.registration as { reader: string; configDirPath: string; configFile: Record<string, unknown> }
      expect(registration.reader).toBe("xdg-config")
      expect(registration.configDirPath.startsWith("/")).toBe(true)
      expect(typeof registration.configFile.present).toBe("boolean")
    }),
  )

  guardedIt.live("ignores directory and workspace selectors — it is machine-global, not instance-scoped", () =>
    Effect.gen(function* () {
      const get = (path: string) =>
        HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("Authorization", basic(PASSWORD)), HttpClient.execute)
      const plain = yield* get(GlobalPaths.setup)
      const scoped = yield* get(`${GlobalPaths.setup}?directory=/etc&workspace=whatever`)
      expect(plain.status).toBe(200)
      // A route wired to WorkspaceRoutingMiddleware would either reject the selector or answer for it.
      // This one declares no query at all, so the selector changes nothing it publishes (row 194 §3).
      expect(scoped.status).toBe(200)
      const plainBody = (yield* plain.json) as Record<string, unknown>
      const scopedBody = (yield* scoped.json) as Record<string, unknown>
      expect(scopedBody.registration).toEqual(plainBody.registration)
      expect(scopedBody.components).toEqual(plainBody.components)
    }),
  )

  // Middleware inheritance, asserted rather than assumed: with no password configured the same middleware
  // passes anonymous traffic through (httpapi-authorization.test.ts:79-86 measures this too). The serve
  // guard makes that state unreachable through `swarm serve`; it is NOT unreachable on every listener,
  // which is why row 207 owns acp.ts:25 and cli/tui/worker.ts:56.
  openIt.live("answers anonymously when no password is configured (the c4 class, reachable only off the serve path)", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.setup).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
    }),
  )
})
