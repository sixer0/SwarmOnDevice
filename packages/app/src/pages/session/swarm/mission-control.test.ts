// Row 133: mission control mount (spec §6 items 1-4, 35-37, §11). Pure rules here; the mount itself is rendered in the
// test DOM by mission-control.render.ts (own process: it compiles Solid JSX and mocks the language context).
import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import {
  agentsFilterFallsBack,
  dockItems,
  missionEyebrow,
  missionLayoutOf,
  offersAgentsView,
  showSelector,
  SIDEBAR_MIN_WIDTH,
} from "./mission-control-layout"
import type { MissionOption } from "./mission-model"

const t = (table: Record<string, string>) => (key: string) => table[key] ?? key

describe("mission control shell rules", () => {
  test("sidebar above 760 px, bottom sheet at or below it (C59, V6:96)", () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(761)
    expect(missionLayoutOf(420)).toBe("sheet")
    expect(missionLayoutOf(760)).toBe("sheet")
    expect(missionLayoutOf(761)).toBe("sidebar")
    expect(missionLayoutOf(900)).toBe("sidebar")
    expect(missionLayoutOf(1280)).toBe("sidebar")
    expect(missionLayoutOf(0)).toBe("sheet") // before the first measurement
  })

  test("Agents view is reachable with one agent when the session has a mission (C127, §11)", () => {
    expect(offersAgentsView(1, 0)).toBe(false)
    expect(offersAgentsView(0, 0)).toBe(false)
    expect(offersAgentsView(1, 1)).toBe(true)
    expect(offersAgentsView(0, 2)).toBe(true)
    expect(offersAgentsView(2, 0)).toBe(true) // the pre-1.2.1 rule still holds
  })

  test("row 136 L1 (C145): the remembered Agents filter is kept while the missions are still loading", () => {
    // one agent, first list not answered yet: keep the filter
    expect(agentsFilterFallsBack(1, { known: false, count: 0 })).toBe(false)
    // first list answered with missions: keep it
    expect(agentsFilterFallsBack(1, { known: true, count: 2 })).toBe(false)
    // first list answered, no missions, one agent: fall back to All
    expect(agentsFilterFallsBack(1, { known: true, count: 0 })).toBe(true)
    expect(agentsFilterFallsBack(0, { known: true, count: 0 })).toBe(true)
    // several agents: never
    expect(agentsFilterFallsBack(2, { known: true, count: 0 })).toBe(false)
  })

  test("eyebrow: type, plus the status when not running, in EN and ID", () => {
    expect(missionEyebrow({ type: "research", status: "running" }, t(en))).toBe("Research")
    expect(missionEyebrow({ type: "feature-release", status: "paused" }, t(en))).toBe("Feature / release · Paused")
    expect(missionEyebrow({ type: "document", status: "done" }, t(id))).toBe(
      `${id["session.mission.type.document"]} · ${id["session.mission.status.done"]}`,
    )
    expect(missionEyebrow({ type: "debug", status: "cancelled" }, t(en))).toBe("Debug · cancelled")
  })

  test("selector only with two or more missions; dock counts", () => {
    const option = (n: number): MissionOption => ({
      id: `m${n}`,
      title: `M${n}`,
      type: "debug",
      status: "running",
      pct: 0,
      openDecisions: 0,
    })
    expect(showSelector([])).toBe(false)
    expect(showSelector([option(1)])).toBe(false)
    expect(showSelector([option(1), option(2)])).toBe(true)
    expect(dockItems({ openDecisions: 2, deliverables: [], finalCount: 0 })).toEqual({ decisions: 2, files: null })
    expect(dockItems({ openDecisions: 0, deliverables: [{}, {}] as never, finalCount: 1 })).toEqual({
      decisions: 0,
      files: { final: 1, total: 2 },
    })
  })
})

test("mount renders with a fake source, switches missions, toggles the sheet, and stays absent without missions", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./src/pages/session/swarm/mission-control.render.ts",
    ],
    { cwd: new URL("../../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
  expect(output).toContain(" 13 pass") // row 136a: +2 M6 tests; row 133b: +5 expand toggle tests
}, 60_000)
