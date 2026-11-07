// Row 130 (masterplan/01_specs_mission_control_ui.md §5.3, §6 items 5-19, 38, 41): HQ deck geometry, and the
// component rendered in the DOM (mission-hq.render.ts, own process: it compiles Solid JSX and mocks the language context).
import { describe, expect, test } from "bun:test"
import { fixtureMission, TYPE_PHASES } from "./mission-hq.fixture"
import {
  agentLabel,
  checkpointFill,
  HQ_TOKENS,
  hqMode,
  hqScene,
  lanesScene,
  RADIAL_MIN_WIDTH,
  radialScene,
  STATUS_COLOR,
} from "./mission-hq-scene"

describe("HQ scene", () => {
  for (const type of Object.keys(TYPE_PHASES)) {
    test(`${type}: rooms are the type's phases in order, one agent spot per non-dropped row`, () => {
      const model = fixtureMission(type)
      const ids = TYPE_PHASES[type].map(([id]) => id)
      for (const scene of [radialScene(model), lanesScene(model)]) {
        const rooms = scene.mode === "radial" ? scene.rooms : scene.lanes
        expect(rooms.map((r) => r.phase.id)).toEqual(ids)
        const spots = rooms.flatMap((r) => r.agents.map((a) => a.rowId))
        expect(spots.sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"])
        expect(spots).not.toContain("9")
      }
    })
  }

  test("radial when wide and 4 or 5 phases; lanes below 540 px or with another phase count", () => {
    const four = fixtureMission("research")
    const five = fixtureMission("feature-release")
    const six = fixtureMission("feature-release", { extraPhase: true })
    expect(hqMode(four, RADIAL_MIN_WIDTH)).toBe("radial")
    expect(hqMode(five, 1280)).toBe("radial")
    expect(hqMode(four, RADIAL_MIN_WIDTH - 1)).toBe("lanes")
    expect(hqMode(five, 420)).toBe("lanes")
    expect(six.phases.length).toBe(6)
    expect(hqMode(six, 1280)).toBe("lanes")
    expect(hqScene(five, 900).mode).toBe("radial")
    expect(hqScene(five, 420).mode).toBe("lanes")
  })

  test("radial positions are the master's (V6:284) and every room keeps a conduit from the deck", () => {
    const five = radialScene(fixtureMission("feature-release"))
    expect(five.rooms.map((r) => r.x)).toEqual([180, 820, 180, 820, 500])
    expect(five.width).toBe(1000)
    expect(five.height).toBe(668)
    const four = radialScene(fixtureMission("debug"))
    expect(four.rooms.map((r) => r.x)).toEqual([195, 805, 195, 805])
    for (const room of [...five.rooms, ...four.rooms]) {
      for (const n of Object.values(room.conduit)) expect(Number.isFinite(n)).toBe(true)
      // conduit starts on the deck rim ellipse (rx 192, ry 60 around cx, cy + 14)
      const e = ((room.conduit.x1 - 500) / 192) ** 2 + ((room.conduit.y1 - 352) / 60) ** 2
      expect(Math.abs(e - 1)).toBeLessThan(1e-9)
    }
    expect(five.spokes.length).toBe(16)
  })

  test("lanes grow by one line per 4 agents and the viewBox fits them", () => {
    const scene = lanesScene(fixtureMission("feature-release"))
    expect(scene.width).toBe(400)
    let y = 94
    for (const lane of scene.lanes) {
      expect(lane.y).toBe(y)
      const lines = Math.max(1, Math.ceil(lane.phase.rows.length / 4))
      expect(lane.h).toBe(14 + lines * 82)
      y += 26 + lines * 82
    }
    expect(scene.height).toBe(y + 30)
  })

  test("labels cut to 12 characters + ellipsis; checkpoint bar fill", () => {
    expect(agentLabel("Render bridge")).toBe("Render bridg…")
    expect(agentLabel("Short")).toBe("Short")
    expect(agentLabel("Exactly12chr")).toBe("Exactly12chr")
    expect(checkpointFill({ checkpoint: { n: 2, m: 5 }, status: "running" })).toBeCloseTo(0.4)
    expect(checkpointFill({ checkpoint: null, status: "done" })).toBe(1)
    expect(checkpointFill({ checkpoint: null, status: "running" })).toBe(0)
    expect(checkpointFill({ checkpoint: { n: 1, m: 0 }, status: "waiting" })).toBe(0)
  })

  test("theme: status and family colours map to app v2 tokens (light/dark follow the app)", () => {
    for (const token of Object.values(STATUS_COLOR)) expect(HQ_TOKENS[token]).toContain("--v2-")
    for (const f of ["plan", "research", "build", "verify", "ship"]) expect(HQ_TOKENS[`--hq-f-${f}`]).toContain("--v2-")
  })
})

test("component renders each mission type, the beacon rule, n/m and pct, and the narrow layout", async () => {
  const run = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", "./src/pages/session/swarm/mission-hq.render.ts"],
    { cwd: new URL("../../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).not.toContain(" 0 pass")
}, 60_000)
