import { describe, expect, test } from "bun:test"
import type { GlobalSetup } from "@opencode-ai/sdk/v2/client"
import { buildStatusCardModel, collectLiteralTokens, type Level3Input, type LadderRow } from "./home-status-card.model"
import type { SetupRead } from "../context/setup-status"

// Mechanical proof for row 203. These run in the plain `src` unit lane (`bun test --conditions=solid`) because
// they exercise home-status-card.model.ts — the pure code that decides every string the card paints. Solid JSX
// cannot render here (packages/app/tsconfig.json:14 `"jsx": "preserve"`; the compiler transform is Vite-only), the
// same constraint recorded at pages/new-session/new-session-view-mark.test.ts:19-23, so the proof binds the content
// decision rather than a DOM tree. The `.tsx` component maps these exact fields onto elements one-to-one.

function okRead(payload: GlobalSetup): SetupRead {
  return { kind: "ok", observed: payload, receivedAt: 1_700_000_000_000 }
}
function failedRead(cause: "server_unreachable" | "not_provided_by_this_server" | "http_error"): SetupRead {
  return { kind: "failed", cause }
}

// A complete payload matching row 201's published shape (s6_r201_route.md §2), mutated per case below.
function payload(overrides?: Partial<GlobalSetup>): GlobalSetup {
  return {
    observedAt: "2026-10-21T22:20:39.356Z",
    stateFile: { path: "/home/u/.swarm/setup/state.json", present: true, updatedAtAbsent: false },
    components: {
      runtime: { state: "healthy", installedBySwarm: false },
      node: { state: "healthy" },
      graft: { state: "healthy" },
      rtk: { state: "healthy" },
      obsidian: { state: "absent" },
      searxng: { state: "absent" },
      firecrawl: { state: "absent" },
    },
    registration: {
      reader: "xdg-config",
      configDirPath: "/home/u/.config/swarm",
      configFile: { path: "/home/u/.config/swarm/swarm.json", present: true, entries: { graft: true, swarmWeb: false } },
      skills: [
        { relPath: "agent/researcher.md", present: false },
        { relPath: "skills/swarm-research/SKILL.md", present: false },
        { relPath: "skills/graft/SKILL.md", present: true },
        { relPath: "skills/rtk/SKILL.md", present: true },
        { relPath: "skills/obsidian-inbox/SKILL.md", present: false },
      ],
    },
    ...overrides,
  }
}

function surface(model: ReturnType<typeof buildStatusCardModel>, id: LadderRow["surface"]): LadderRow {
  const row = model.ladder.find((r) => r.surface === id)
  if (!row) throw new Error(`no ladder row for ${id}`)
  return row
}

describe("AC-192-1 — the negative case (mandatory)", () => {
  // Delete ONLY ~/.config/swarm/swarm.json on a machine where level 1 is true: the state record still says graft
  // is healthy, but the config entry is gone. The card must show level 1 TRUE beside level 2 FALSE for graft in a
  // single capture. A card that cannot show this disagreement has failed (spec §10 AC-192-1).
  test("level 1 true renders beside level 2 false for the same surface in one model build", () => {
    const noSwarmJson = payload()
    noSwarmJson.registration.configFile = {
      path: "/home/u/.config/swarm/swarm.json",
      present: false,
      entries: { graft: false, swarmWeb: false },
    }
    const model = buildStatusCardModel({ read: okRead(noSwarmJson), loading: false })
    const graft = surface(model, "graft")
    expect(graft.installed.kind).toBe("yes") // level 1: state record says healthy
    expect(graft.registered.kind).toBe("no") // level 2: the file the setup writes is gone
    // They disagree, and each names its OWN source — neither is derived from the other (R2).
    expect(graft.installed.sourceToken).toContain(".swarm/setup/state.json")
    // F-04: level 2 names the directory the payload REPORTED, not a hardcoded literal.
    expect(graft.registered.sourceToken).toBe(noSwarmJson.registration.configDirPath)
    expect(graft.installed.sourceToken).not.toBe(graft.registered.sourceToken)
  })
})

describe("F-04 — the level-2 source names the directory the server reported, never a hardcoded literal", () => {
  test("an ok read paints the payload's configDirPath verbatim, even when relocated away from ~/.config", () => {
    const relocated = payload()
    relocated.registration.configDirPath = "/tmp/r206b-xdg/swarm"
    const model = buildStatusCardModel({ read: okRead(relocated), loading: false })
    for (const row of model.ladder) expect(row.registered.sourceToken).toBe("/tmp/r206b-xdg/swarm")
  })

  test("a failed read yields source `unknown`, never the old literal and never any path (anti-collapse)", () => {
    // The failed arm of SetupRead carries no component data (context/setup-status.ts:48-51), so there is no
    // path for it to display; the card must say unknown rather than fall back to a hardcoded location.
    for (const cause of ["server_unreachable", "not_provided_by_this_server", "http_error"] as const) {
      const model = buildStatusCardModel({ read: failedRead(cause), loading: false })
      for (const row of model.ladder) {
        expect(row.registered.kind).toBe("unknown")
        expect(row.registered.causeToken).toBe(cause)
        expect(row.registered.sourceToken).toBe("unknown")
        expect(row.registered.sourceToken).not.toContain("/")
      }
    }
  })

  test("an empty published path degrades to `unknown`, not to a blank source", () => {
    const blank = payload()
    blank.registration.configDirPath = ""
    const model = buildStatusCardModel({ read: okRead(blank), loading: false })
    for (const row of model.ladder) expect(row.registered.sourceToken).toBe("unknown")
  })
})

describe("unknown is first-class and names its cause (R4)", () => {
  test("server unreachable yields unknown with cause server_unreachable, never false (E1)", () => {
    const model = buildStatusCardModel({ read: failedRead("server_unreachable"), loading: false })
    for (const row of model.ladder) {
      expect(row.installed.kind).toBe("unknown")
      expect(row.installed.causeToken).toBe("server_unreachable")
      expect(row.registered.kind).toBe("unknown")
      expect(row.registered.causeToken).toBe("server_unreachable")
    }
  })

  test("the 404 version-skew path yields unknown with cause not_provided_by_this_server (E2)", () => {
    // Level 3 renders independently from /mcp even when the setup route is absent (E2), so pass an observation.
    const model = buildStatusCardModel({
      read: failedRead("not_provided_by_this_server"),
      loading: false,
      mcp: { scopeLabel: "/repo", receivedAt: 1, servers: { graft: { status: "connected" } } },
    })
    const graft = surface(model, "graft")
    expect(graft.installed.kind).toBe("unknown")
    expect(graft.installed.causeToken).toBe("not_provided_by_this_server")
    expect(graft.registered.causeToken).toBe("not_provided_by_this_server")
    // Level 3 came from a different source and is NOT dragged into the setup read's failure (R2).
    expect(graft.visible.kind).toBe("yes")
    expect(graft.visible.labelKey).toBe("mcp.status.connected")
  })
})

describe("R1 — no aggregate exists anywhere", () => {
  const model = buildStatusCardModel({ read: okRead(payload()), loading: false })

  test("the model exposes no combined-verdict field", () => {
    // The whole point of the card is that it cannot say "ready". The model's shape proves it: there is no field
    // that spans levels, no percentage, no score. A reviewer can grep this list and find no such pixel.
    expect(Object.keys(model).sort()).toEqual(["configDirPath", "freshness", "ladder", "level3Scope", "records", "stateFilePath"])
    for (const key of Object.keys(model)) {
      expect(/ready|aggregate|percent|score|verdict/i.test(key)).toBe(false)
    }
  })

  test("no painted literal token is a ready/not-ready verdict word", () => {
    const tokens = collectLiteralTokens(model)
    for (const banned of ["ready", "not ready", "all good", "ok", "complete"]) {
      expect(tokens.some((t) => t.toLowerCase() === banned)).toBe(false)
    }
  })

  test("counts never mix sources: the model prints no merged numerator at all (R3)", () => {
    // There is deliberately no "N of M" string produced; numbers would require mixing file states with server states.
    const tokens = collectLiteralTokens(model)
    expect(tokens.some((t) => /\d+\s+of\s+\d+/.test(t))).toBe(false)
  })
})

describe("per-surface honesty (spec §7)", () => {
  test("rtk: visible and used DIFFER, and visible is a category non-value, never 'not visible' (E19, AC-192-6)", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    const rtk = surface(model, "rtk")
    expect(rtk.visible.kind).toBe("not_applicable")
    expect(rtk.visible.causeToken).toBe("not_an_mcp_server")
    expect(rtk.visible.token).toBe("not_applicable")
    expect(rtk.used.kind).toBe("not_claimed")
    // The structural difference the spec demands: visible != used for rtk.
    expect(rtk.visible.kind).not.toBe(rtk.used.kind)
    // Never rendered as a negative status or blank.
    expect(rtk.visible.token).not.toBe("not visible")
    expect(rtk.visible.token).not.toBe("")
  })

  test("obsidian (skill text) is also not_applicable at level 3, not a blank cell", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    expect(surface(model, "obsidian").visible.kind).toBe("not_applicable")
  })

  test("level 4 is an explicit non-claim on every surface, never a grey tick or unknown (E21)", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    for (const row of model.ladder) {
      expect(row.used.kind).toBe("not_claimed")
      expect(row.used.labelKey).toBe("setup.status.notClaimed")
      expect(row.used.kind).not.toBe("unknown")
    }
  })

  test("firecrawl shows only its state token and says nothing about crawling (E18, AC-192-7)", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    const firecrawl = model.records.find((r) => r.component === "firecrawl")
    expect(firecrawl?.cell.kind).toBe("no")
    expect(firecrawl?.cell.token).toBe("absent")
    // Even when swarm-web reads connected, no token describes crawl capability in either direction.
    const mcp: Level3Input = { scopeLabel: "/repo", receivedAt: 1, servers: { "swarm-web": { status: "connected" } } }
    const tokens = collectLiteralTokens(buildStatusCardModel({ read: okRead(payload()), loading: false, mcp }))
    expect(tokens.some((t) => /crawl/i.test(t))).toBe(false)
  })

  test("the seven-component register block stays separate from the ladder and is captioned by its source (R6)", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    expect(model.records.map((r) => r.component).sort()).toEqual([
      "firecrawl",
      "graft",
      "node",
      "obsidian",
      "rtk",
      "runtime",
      "searxng",
    ])
    // Records carry their own source token; they are not folded into ladder rows.
    for (const rec of model.records) expect(rec.cell.sourceToken).toContain("state.json")
  })
})

describe("level 3 vocabulary is exactly what the server can return (R5)", () => {
  const withMcp = (servers: Level3Input["servers"]) =>
    buildStatusCardModel({ read: okRead(payload()), loading: false, mcp: { scopeLabel: "/repo", receivedAt: 1, servers } })

  test("connected / failed / needs_auth map to their existing keys", () => {
    expect(surface(withMcp({ graft: { status: "connected" } }), "graft").visible.labelKey).toBe("mcp.status.connected")
    const failed = surface(withMcp({ graft: { status: "failed", error: "spawn ENOENT" } }), "graft").visible
    expect(failed.labelKey).toBe("mcp.status.failed")
    expect(failed.detailToken).toBe("spawn ENOENT") // verbatim, never paraphrased (E12)
    expect(surface(withMcp({ graft: { status: "needs_auth" } }), "graft").visible.labelKey).toBe("mcp.status.needs_auth")
  })

  test("disabled carries NO cause (E9/E11/R5)", () => {
    const cell = surface(withMcp({ graft: { status: "disabled" } }), "graft").visible
    expect(cell.labelKey).toBe("mcp.status.disabled")
    expect(cell.causeToken).toBeUndefined()
  })

  test("needs_client_registration resolves to its own key, not a borrow (E14)", () => {
    const cell = surface(withMcp({ graft: { status: "needs_client_registration", error: "no client id" } }), "graft").visible
    expect(cell.labelKey).toBe("mcp.status.needs_client_registration")
    expect(cell.detailToken).toBe("no client id")
  })

  test("a server absent from the live map is unknown/not_observed, not 'nothing configured' (E10/E20)", () => {
    const cell = surface(withMcp({}), "graft").visible
    expect(cell.kind).toBe("unknown")
    expect(cell.causeToken).toBe("not_observed")
  })

  test("an unprovided MCP observation (query never enabled) is unknown/not_observed (E20, AC-192-8)", () => {
    const cell = surface(buildStatusCardModel({ read: okRead(payload()), loading: false }), "graft").visible
    expect(cell.kind).toBe("unknown")
    expect(cell.causeToken).toBe("not_observed")
  })
})

describe("freshness is never conflated (spec §4 rule 1, R3)", () => {
  test("observedAt (server) and receivedAt (client) are separate fields with separate values", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    expect(model.freshness.observedAt).toBe("2026-10-21T22:20:39.356Z")
    expect(model.freshness.receivedAt).toBe(1_700_000_000_000)
    expect(model.freshness.observedAt).not.toBe(String(model.freshness.receivedAt))
  })

  test("a failed read publishes no freshness rather than inventing one (R9)", () => {
    const model = buildStatusCardModel({ read: failedRead("server_unreachable"), loading: false })
    expect(model.freshness.observedAt).toBeUndefined()
    expect(model.freshness.receivedAt).toBeUndefined()
  })
})

describe("swarm-web level 1 refuses to borrow another component's health (R2)", () => {
  test("swarm-web installed is unknown/not_observed even though searxng has its own record", () => {
    const model = buildStatusCardModel({ read: okRead(payload()), loading: false })
    const sw = surface(model, "swarm-web")
    expect(sw.installed.kind).toBe("unknown")
    expect(sw.installed.causeToken).toBe("not_observed")
    // Yet level 2 still renders independently from the config file.
    expect(sw.registered.kind).toBe("no") // swarmWeb entry false in the baseline payload
  })
})
