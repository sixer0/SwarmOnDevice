import { describe, expect, test } from "bun:test"
import type { GlobalSetup } from "@opencode-ai/sdk/v2/client"
import {
  SETUP_COMPONENT_IDS,
  classifySetupCall,
  classifySetupThrow,
  readSetupStatus,
  resolveInstalled,
  resolveRegistered,
  type SetupStatusClient,
} from "./setup-status"

// A complete, valid payload shaped exactly like row 201's published response (s6_r201_route.md §2). Used as
// the baseline every failure-mode test mutates, so a passing "ok" case proves the guard accepts the real shape.
function validPayload(overrides?: Partial<GlobalSetup>): GlobalSetup {
  return {
    observedAt: "2026-10-21T22:20:39.356Z",
    stateFile: { path: "~/.swarm/setup/state.json", present: true, updatedAtAbsent: false },
    components: {
      runtime: { state: "healthy", installedBySwarm: false },
      node: { state: "absent" },
      graft: {},
      rtk: { state: "absent" },
      obsidian: { state: "absent" },
      searxng: { state: "absent" },
      firecrawl: { state: "absent" },
    },
    registration: {
      reader: "xdg-config",
      configDirPath: "/tmp/xdg/swarm",
      configFile: {
        path: "/tmp/xdg/swarm/swarm.json",
        present: true,
        entries: { graft: true, swarmWeb: false },
      },
      skills: [
        { relPath: "agent/researcher.md", present: false },
        { relPath: "skills/swarm-research/SKILL.md", present: false },
        { relPath: "skills/graft/SKILL.md", present: true },
        { relPath: "skills/rtk/SKILL.md", present: false },
        { relPath: "skills/obsidian-inbox/SKILL.md", present: false },
      ],
    },
    ...overrides,
  }
}

function clientReturning(result: Awaited<ReturnType<SetupStatusClient["global"]["setup"]>>): SetupStatusClient {
  return { global: { setup: async () => result } }
}

function clientThrowing(error: unknown): SetupStatusClient {
  return {
    global: {
      setup: async () => {
        throw error
      },
    },
  }
}

describe("classifySetupCall", () => {
  test("a 200 with a schema-shaped body is an ok read", () => {
    const read = classifySetupCall({ data: validPayload(), response: { status: 200, ok: true } })
    expect(read.kind).toBe("ok")
    if (read.kind === "ok") expect(read.observed.observedAt).toBe("2026-10-21T22:20:39.356Z")
  })

  test("no response object is server_unreachable, never absent (E1)", () => {
    const read = classifySetupCall({ error: new Error("network"), response: undefined })
    expect(read).toMatchObject({ kind: "failed", cause: "server_unreachable" })
  })

  test("a 404 is not_provided_by_this_server, not http_error (E2)", () => {
    const read = classifySetupCall({ error: {}, response: { status: 404, ok: false } })
    expect(read).toMatchObject({ kind: "failed", cause: "not_provided_by_this_server", status: 404 })
  })

  test("a 401/500 is http_error with its status", () => {
    expect(classifySetupCall({ error: {}, response: { status: 401, ok: false } })).toMatchObject({
      kind: "failed",
      cause: "http_error",
      status: 401,
    })
    expect(classifySetupCall({ error: {}, response: { status: 500, ok: false } })).toMatchObject({
      kind: "failed",
      cause: "http_error",
      status: 500,
    })
  })

  test("a 200 whose body does not match the shape is unrecognized_response, not a half-trusted ok", () => {
    const missingRegistration = { observedAt: "x", stateFile: { path: "p", present: true }, components: {} }
    expect(classifySetupCall({ data: missingRegistration, response: { status: 200, ok: true } })).toMatchObject({
      kind: "failed",
      cause: "unrecognized_response",
    })
    expect(classifySetupCall({ data: "<html/>", response: { status: 200, ok: true } })).toMatchObject({
      kind: "failed",
      cause: "unrecognized_response",
    })
  })
})

describe("classifySetupThrow", () => {
  test("a bare network throw is server_unreachable", () => {
    expect(classifySetupThrow(new TypeError("fetch failed"))).toMatchObject({
      kind: "failed",
      cause: "server_unreachable",
    })
  })

  test("a throw carrying a 404 response is not_provided_by_this_server", () => {
    const thrown = Object.assign(new Error("not found"), { response: { status: 404 } })
    expect(classifySetupThrow(thrown)).toMatchObject({ kind: "failed", cause: "not_provided_by_this_server" })
  })

  test("a throw carrying a non-ok status is http_error", () => {
    const thrown = Object.assign(new Error("boom"), { cause: { status: 503 } })
    expect(classifySetupThrow(thrown)).toMatchObject({ kind: "failed", cause: "http_error", status: 503 })
  })
})

describe("readSetupStatus", () => {
  test("resolves an ok read through the client seam", async () => {
    const read = await readSetupStatus(clientReturning({ data: validPayload(), response: { status: 200, ok: true } }))
    expect(read.kind).toBe("ok")
  })

  test("catches a throwing client and classifies it", async () => {
    const read = await readSetupStatus(clientThrowing(new TypeError("Failed to fetch")))
    expect(read).toMatchObject({ kind: "failed", cause: "server_unreachable" })
  })
})

// Item 3 of the dispatch: prove version skew degrades to unknown-with-cause, NEVER to "nothing installed".
describe("version skew (client newer than server)", () => {
  test("404 from an older server yields unknown, never false, for every component", () => {
    const read = classifySetupCall({ error: {}, response: { status: 404, ok: false } })
    for (const id of SETUP_COMPONENT_IDS) {
      const level = resolveInstalled(read, id)
      expect(level.value).toBe("unknown")
      expect(level).toMatchObject({ cause: "not_provided_by_this_server" })
    }
  })

  test("404 also yields unknown for every registered surface, never false", () => {
    const read = classifySetupCall({ error: {}, response: { status: 404, ok: false } })
    for (const surface of ["graft", "swarm-web", "rtk", "obsidian"] as const) {
      expect(resolveRegistered(read, surface).value).toBe("unknown")
    }
  })

  test("an older server answering text/html (interceptor throw) still degrades to unknown, not absent", () => {
    // The generated client throws when a response is text/html before any status is visible to us; this is the
    // realistic skew path on a desktop app pointed at an older sidecar that serves its SPA shell for /global/setup.
    const read = classifySetupThrow(new Error("Request is not supported by this version of Swarm Server"))
    expect(resolveInstalled(read, "graft").value).toBe("unknown")
    expect(resolveRegistered(read, "graft").value).toBe("unknown")
  })

  test("the anti-collapse invariant: no transport failure ever produces value:false", () => {
    const failures = [
      classifySetupCall({ error: new Error("net"), response: undefined }),
      classifySetupCall({ error: {}, response: { status: 404, ok: false } }),
      classifySetupCall({ error: {}, response: { status: 500, ok: false } }),
      classifySetupCall({ data: { junk: true }, response: { status: 200, ok: true } }),
      classifySetupThrow(new TypeError("fetch failed")),
    ]
    for (const read of failures) {
      expect(read.kind).toBe("failed")
      for (const id of SETUP_COMPONENT_IDS) expect(resolveInstalled(read, id).value).toBe("unknown")
    }
  })
})

describe("resolveInstalled (level 1)", () => {
  const ok = (payload: GlobalSetup) => ({ kind: "ok", observed: payload, receivedAt: 1 } as const)

  test("healthy is true", () => {
    expect(resolveInstalled(ok(validPayload()), "runtime")).toEqual({ value: true })
  })

  test("a known non-healthy state is false carrying that state (E6/E7/E8 stay distinct)", () => {
    expect(resolveInstalled(ok(validPayload()), "node")).toEqual({ value: false, detail: "absent" })
    const failed = validPayload()
    failed.components.firecrawl = { state: "failed" }
    expect(resolveInstalled(ok(failed), "firecrawl")).toEqual({ value: false, detail: "failed" })
    const skipped = validPayload()
    skipped.components.obsidian = { state: "skipped" }
    expect(resolveInstalled(ok(skipped), "obsidian")).toEqual({ value: false, detail: "skipped" })
  })

  test("a component entry with no state key is unknown/state_absent, not coerced to absent (§2.1 item 1)", () => {
    expect(resolveInstalled(ok(validPayload()), "graft")).toEqual({ value: "unknown", cause: "state_absent" })
  })

  test("an unrecognised state string is passed through as unknown, never defaulted (spec §4 rule 2)", () => {
    const weird = validPayload()
    weird.components.node = { state: "quantum" }
    expect(resolveInstalled(ok(weird), "node")).toEqual({ value: "unknown", cause: "unrecognized_state", detail: "quantum" })
  })

  test("missing state file is a known negative no_state_record, NOT unknown (E3/E4)", () => {
    const missing = validPayload()
    missing.stateFile = { path: "~/.swarm/setup/state.json", present: false }
    delete (missing.stateFile as { updatedAtAbsent?: boolean }).updatedAtAbsent
    missing.components = {}
    expect(resolveInstalled(ok(missing), "graft")).toEqual({ value: false, detail: "no_state_record" })
  })

  test("unreadable record is unknown/unreadable quoting the error, never all-absent (E5a)", () => {
    const unreadable = validPayload()
    unreadable.stateFile = {
      path: "~/.swarm/setup/state.json",
      present: true,
      error: "cannot read state file: EACCES: permission denied",
    }
    unreadable.components = {}
    const level = resolveInstalled(ok(unreadable), "graft")
    expect(level).toMatchObject({ value: "unknown", cause: "unreadable" })
    expect((level as { detail?: string }).detail).toContain("EACCES")
  })

  test("invalid JSON record is unknown/unparseable (E5b)", () => {
    const bad = validPayload()
    bad.stateFile = { path: "p", present: true, error: "state file is not valid JSON: Expected '}'" }
    expect(resolveInstalled(ok(bad), "graft")).toMatchObject({ value: "unknown", cause: "unparseable" })
  })
})

describe("resolveRegistered (level 2)", () => {
  const ok = (payload: GlobalSetup) => ({ kind: "ok", observed: payload, receivedAt: 1 } as const)

  test("MCP entry presence drives graft and swarm-web independently", () => {
    expect(resolveRegistered(ok(validPayload()), "graft")).toEqual({ value: true })
    expect(resolveRegistered(ok(validPayload()), "swarm-web")).toEqual({ value: false })
  })

  test("skill-text presence drives rtk and obsidian", () => {
    const withRtk = validPayload()
    withRtk.registration.skills = withRtk.registration.skills.map((entry) =>
      entry.relPath === "skills/rtk/SKILL.md" ? { ...entry, present: true } : entry,
    )
    expect(resolveRegistered(ok(withRtk), "rtk")).toEqual({ value: true })
    expect(resolveRegistered(ok(validPayload()), "obsidian")).toEqual({ value: false })
  })

  test("a corrupt config is false WITH the parse error verbatim, never silence (E16)", () => {
    const corrupt = validPayload()
    corrupt.registration.configFile = {
      path: "p",
      present: true,
      parseError: "state file top level is not an object",
      entries: { graft: false, swarmWeb: false },
    }
    expect(resolveRegistered(ok(corrupt), "graft")).toEqual({ value: false, detail: "state file top level is not an object" })
  })

  test("a surface missing from the skills array is unknown/not_observed, not false", () => {
    const partial = validPayload()
    partial.registration.skills = partial.registration.skills.filter((entry) => entry.relPath !== "skills/rtk/SKILL.md")
    expect(resolveRegistered(ok(partial), "rtk")).toMatchObject({ value: "unknown", cause: "not_observed" })
  })

  test("level 2 renders independently of the state file (E3: hand-written config on a never-set-up machine)", () => {
    const noState = validPayload()
    noState.stateFile = { path: "p", present: false }
    expect(resolveRegistered(ok(noState), "graft")).toEqual({ value: true })
  })
})

describe("tripwire against register drift", () => {
  test("the seam's component ids match the keys the route publishes", () => {
    // If the register gains an eighth component and the route starts publishing it, this assertion is the
    // first thing to fail, mirroring the F-4 mitigation row 201 named (s6_r201_route.md §9 F-4).
    const seamIds: string[] = [...SETUP_COMPONENT_IDS].sort()
    const payloadKeys = Object.keys(validPayload().components ?? {}).sort()
    expect(seamIds).toEqual(payloadKeys)
    expect(SETUP_COMPONENT_IDS.length).toBe(7)
  })
})
