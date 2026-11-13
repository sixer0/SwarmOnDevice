// Swarm 1.2.8 row 54 (AC-VIS3a = VIS-3a, F-VISIO 01f §1.3 with the C12 OP-18-4 change of 01_specs.md §5.3; register
// N8-233..N8-236, N8-271, N8-373, N8-477..N8-480; AT-V3-events). BPMN events: start = thin circle, intermediate = double
// circle (r and r - 0.6 mm), end = thick circle (2 x primary stroke), drawn at BPMN_EVENT_DIAMETER_MM at the top centre of
// the node's layout cell; the `event_type` marker (message envelope, timer clock) centred inside; the label block below
// the outline in `<g data-label-pos="below">`, at least LABEL_BELOW_GAP_MM under the outline, counted in the cell height;
// connector ends on the circle. Fixture: test/fixtures/syn128/vis3_bpmn_events.json (synthetic labels). Row 54b adds
// describe "gallery" (VIS-3b) to this file.
// Red at BASE e1f9673772: the event tokens and `event_type` are not in the contract (validateSpec refuses them, the build
// throws), and fit/text has no label-below names. Namespace imports, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as buildMod from "../../vendor/src/lib/studio/engine/diagram/build"
import * as elkMod from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as specMod from "../../vendor/src/lib/studio/engine/diagram/core/spec"
import * as geomMod from "../../vendor/src/lib/studio/engine/diagram/core/geometry"
import * as lintMod from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as textMod from "../../vendor/src/lib/studio/engine/diagram/fit/text"

type J = Record<string, any>
type Pt = [number, number]
type Box = [number, number, number, number]
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis3_bpmn_events.json"), "utf8")) as J
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const WIDTHS = [128, 166] as const
const FIGS = ["events", "events_tb", "events_graph", "events_tagged"] as const
const PRIMARY = 0.45
const T = textMod as J

function build(fig: string, width: number): J {
  return (buildMod as J).buildDiagramSvg({ ...clone(FX[fig]), width_mm: width }, O)
}
async function buildAuto(fig: string, width: number): Promise<J> {
  return (elkMod as J).buildDiagramSvgAuto({ ...clone(FX[fig]), width_mm: width }, O, {}, () => {})
}
const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
const num = (el: string, k: string): number => Number(attr(el, k))
const eventsOf = (fig: string): J[] => (FX[fig].nodes as J[]).filter((n) => String(n.shape ?? "").startsWith("event_"))

/** The single element carrying data-node="<id>" (G-1). */
function nodeEls(svg: string, id: string): string[] {
  return [...svg.matchAll(new RegExp(`<(rect|polygon|path|circle|line)\\b[^>]*data-node="${id}"[^>]*/>`, "g"))].map((m) => m[0])
}
/** Markup between the outline element and its label group (the outline's decorations: inner ring, event marker). */
function decorations(svg: string, el: string): string {
  const rest = svg.slice(svg.indexOf(el) + el.length)
  return rest.slice(0, rest.indexOf('<g data-label-pos="below">'))
}
/** The `<g data-label-pos="below">` group that follows the outline of `id`, and the ink boxes of its texts. */
function labelGroup(svg: string, el: string): { g: string; texts: Array<{ el: string; s: string; box: Box }> } {
  const rest = svg.slice(svg.indexOf(el) + el.length)
  const m = /<g data-label-pos="below">([\s\S]*?)<\/g>/.exec(rest)!
  const texts = [...m[1].matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].map((t) => {
    const e = t[0]
    const spans = [...e.matchAll(/<tspan\b[^>]*x="([^"]*)"[^>]*dy="([^"]*)"[^>]*>([^<]*)<\/tspan>/g)]
    let y = num(e, "y")
    const lines = spans.length
      ? spans.map((sp) => ({ x: Number(sp[1]), y: (y += Number(sp[2])), s: sp[3] }))
      : [{ x: num(e, "x"), y, s: />([^<]*)<\/text>/.exec(e)![1] }]
    const box = (lintMod as J).textBlockBox(
      lines,
      num(e, "font-size"),
      attr(e, "text-anchor") ?? "start",
      "struct",
      Number(attr(e, "font-weight") ?? 400) >= 600,
      Number(attr(e, "letter-spacing") ?? 0) || 0,
    ) as Box
    return { el: e, s: lines.map((l) => l.s).join(" "), box }
  })
  return { g: m[0], texts }
}
function links(svg: string): Pt[][] {
  return [...svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"[^>]*\/>/g)].map((m) =>
    [...m[1].matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])] as Pt),
  )
}

describe("events", () => {
  test("label-below names (N8-477..N8-479) and values (OP20-6)", () => {
    expect([...(T.LABEL_BELOW_SHAPES ?? [])].sort()).toEqual(
      ["event_end", "event_intermediate", "event_start", "gateway_complex", "gateway_exclusive", "gateway_inclusive", "gateway_parallel"],
    )
    expect(T.LABEL_BELOW_GAP_MM).toBe(1.0)
    expect(T.BPMN_EVENT_DIAMETER_MM).toBe(8.0)
    expect(T.BPMN_GATEWAY_SIZE_MM).toBe(11.0)
  })

  test("the fixture holds 3 events x 3 event_type (none, message, timer)", () => {
    const pairs = eventsOf("events").map((n) => `${n.shape}/${n.event_type ?? "none"}`).sort()
    const want = ["event_end", "event_intermediate", "event_start"].flatMap((s) => ["message", "none", "timer"].map((t) => `${s}/${t}`)).sort()
    expect(pairs).toEqual(want)
  })

  test("event shapes and event_type pass validateSpec; event_type on a task is P1-event_type", () => {
    for (const fig of FIGS) {
      const fails = ((specMod as J).validateSpec((specMod as J).loadSpec(clone(FX[fig]))) as J[]).filter((i) => i.status === "FAIL")
      expect(fails.map((i) => i.checkId), fig).toEqual([])
    }
    const bad = ((specMod as J).validateSpec((specMod as J).loadSpec(clone(FX.event_type_on_task))) as J[]).filter((i) => i.status === "FAIL")
    expect(bad.map((i) => i.checkId)).toEqual(["P1-event_type"])
    expect(bad[0].pointer).toBe("/nodes/1/event_type")
  })

  for (const W of WIDTHS) {
    test(`outlines @${W}: circle at BPMN_EVENT_DIAMETER_MM; start 0.45, intermediate double (r - 0.6, no data-node), end 0.9`, () => {
      const svg = build("events", W).svg as string
      for (const n of eventsOf("events")) {
        const els = nodeEls(svg, n.id)
        expect(els.length, n.id).toBe(1)
        expect(els[0].startsWith("<circle"), n.id).toBe(true)
        expect(num(els[0], "r")).toBeCloseTo(8.0 / 2, 2)
        expect(num(els[0], "stroke-width")).toBeCloseTo(n.shape === "event_end" ? 2 * PRIMARY : PRIMARY, 3)
        const deco = decorations(svg, els[0])
        const inner = [...deco.matchAll(/<circle\b[^>]*\/>/g)].map((m) => m[0]).filter((c) => num(c, "r") > 3)
        if (n.shape === "event_intermediate") {
          expect(inner.length, n.id).toBe(1)
          expect(num(inner[0], "cx")).toBe(num(els[0], "cx"))
          expect(num(inner[0], "cy")).toBe(num(els[0], "cy"))
          expect(num(inner[0], "r")).toBeCloseTo(4.0 - 0.6, 2)
          expect(num(inner[0], "stroke-width")).toBeCloseTo(PRIMARY, 3)
        } else expect(inner.length, n.id).toBe(0)
        expect(deco).not.toContain("data-node")
        expect(deco).not.toContain("data-mark")
      }
    })

    test(`event_type marker @${W}: centred in the circle, inside the inner ring, hair stroke; none draws nothing`, () => {
      const svg = build("events", W).svg as string
      for (const n of eventsOf("events")) {
        const el = nodeEls(svg, n.id)[0]
        const [cx, cy, r] = [num(el, "cx"), num(el, "cy"), num(el, "r")]
        const deco = decorations(svg, el)
        const parts = [...deco.matchAll(/<(rect|path|circle)\b[^>]*\/>/g)].map((m) => m[0]).filter((p) => !(p.startsWith("<circle") && num(p, "r") > 3))
        const type = n.event_type ?? "none"
        if (type === "none") {
          expect(parts, n.id).toEqual([])
          continue
        }
        expect(parts.length, n.id).toBe(2)
        expect(parts[0].startsWith(type === "message" ? "<rect" : "<circle"), n.id).toBe(true)
        for (const p of parts) expect(attr(p, "stroke-width"), n.id).toBe("0.2")
        const pts: Pt[] = []
        for (const p of parts) {
          if (p.startsWith("<rect")) pts.push([num(p, "x"), num(p, "y")], [num(p, "x") + num(p, "width"), num(p, "y") + num(p, "height")])
          else if (p.startsWith("<circle")) pts.push([num(p, "cx") - num(p, "r"), num(p, "cy") - num(p, "r")], [num(p, "cx") + num(p, "r"), num(p, "cy") + num(p, "r")])
          else for (const m of attr(p, "d")!.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)) pts.push([Number(m[1]), Number(m[2])])
        }
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        // the marker's box is centred on the circle centre (the timer box is its face, the hands lie inside it)
        expect((Math.min(...xs) + Math.max(...xs)) / 2, n.id).toBeCloseTo(cx, 1)
        expect((Math.min(...ys) + Math.max(...ys)) / 2, n.id).toBeCloseTo(cy, 1)
        const inner = r - 0.6 - PRIMARY / 2
        for (const p of pts) expect(Math.hypot(p[0] - cx, p[1] - cy), n.id).toBeLessThan(inner)
      }
    })

    test(`label below @${W}: <g data-label-pos="below"> after the outline, centred, >= LABEL_BELOW_GAP_MM under the outline stroke, in the cell height`, () => {
      for (const fig of FIGS) {
        const svg = build(fig, W).svg as string
        for (const n of eventsOf(fig)) {
          const el = nodeEls(svg, n.id)[0]
          const [cx, cy, r, sw] = [num(el, "cx"), num(el, "cy"), num(el, "r"), num(el, "stroke-width")]
          const { texts } = labelGroup(svg, el)
          const label = texts.find((t) => t.s.replace(/\s+/g, " ").includes(String(n.label).split(" ")[0]))!
          expect(label, `${fig}/${n.id}`).toBeDefined()
          for (const t of texts) {
            expect(t.box[1] - (cy + r + sw / 2), `${fig}/${n.id} ${t.s}`).toBeGreaterThanOrEqual(1.0 - 1e-6)
            expect((t.box[0] + t.box[2]) / 2, `${fig}/${n.id} ${t.s}`).toBeCloseTo(cx, 1)
          }
          // the layout cell: top = outline top, height = nodeSize (label-below height, lattice-locked; graph pad 1 is the lowest)
          const [, h] = (geomMod as J).nodeSize(n, { x: 128 / 12, y: (13.5 * 25.4) / 72 }, undefined, 1)
          for (const t of texts) expect(t.box[3], `${fig}/${n.id}`).toBeLessThanOrEqual(cy - r + h + 1e-6)
        }
      }
    })

    test(`connectors @${W}: every connector end at an event lies on its circle; arrowheads touch the outline`, () => {
      for (const fig of ["events", "events_graph", "events_tagged"] as const) {
        const svg = build(fig, W).svg as string
        const circles = eventsOf(fig).map((n) => nodeEls(svg, n.id)[0]).map((el) => ({ cx: num(el, "cx"), cy: num(el, "cy"), r: num(el, "r") }))
        let ends = 0
        let heads = 0
        for (const pl of links(svg)) {
          pl.forEach((e, k) => {
            if (k !== 0 && k !== pl.length - 1) return
            const c = circles.find((q) => Math.abs(e[0] - q.cx) < 12 && Math.abs(e[1] - q.cy) < 12)
            if (!c) return
            expect(Math.abs(Math.hypot(e[0] - c.cx, e[1] - c.cy) - c.r), `${fig} end ${e}`).toBeLessThanOrEqual(0.05)
            ends++
            if (k === pl.length - 1) heads++
          })
        }
        expect(ends, fig).toBeGreaterThanOrEqual(fig === "events" ? 12 : fig === "events_graph" ? 2 : 4)
        expect(heads, fig).toBeGreaterThanOrEqual(fig === "events" ? 6 : 1)
      }
    })

    test(`TB @${W}: an arrow into an event lands on the circle top; a connector leaving downwards starts under the label`, () => {
      const svg = build("events_tb", W).svg as string
      const ls = links(svg)
      for (const n of eventsOf("events_tb")) {
        const el = nodeEls(svg, n.id)[0]
        const [cx, cy, r] = [num(el, "cx"), num(el, "cy"), num(el, "r")]
        const into = ls.find((pl) => Math.abs(pl[pl.length - 1][0] - cx) < 0.05 && Math.abs(pl[pl.length - 1][1] - (cy - r)) < 0.05)
        const out = ls.find((pl) => Math.abs(pl[0][0] - cx) < 4 && pl[0][1] > cy && pl[0][1] < cy + 20)
        const { texts } = labelGroup(svg, el)
        const bottom = Math.max(...texts.map((t) => t.box[3]))
        if (n.id !== "a") expect(into, n.id).toBeDefined()
        if (n.id !== "d") {
          expect(out, n.id).toBeDefined()
          expect(out![0][1], n.id).toBeGreaterThan(bottom)
        }
      }
    })

    test(`tags @${W}: in the label block, one line above the label, centred (R20-C37); hatch clipped to the circle`, () => {
      const svg = build("events_tagged", W).svg as string
      for (const n of eventsOf("events_tagged")) {
        const el = nodeEls(svg, n.id)[0]
        const { texts } = labelGroup(svg, el)
        const tag = texts.find((t) => t.s === n.tag)!
        const label = texts.find((t) => t.s === n.label)!
        expect(attr(tag.el, "text-anchor")).toBe("middle")
        expect(attr(tag.el, "font-weight")).toBe("600")
        expect(tag.box[3]).toBeLessThanOrEqual(label.box[1] + 1e-6)
        if (n.sub) expect(texts.find((t) => t.s === n.sub)!.box[1]).toBeGreaterThanOrEqual(label.box[3] - 1e-6)
      }
      const clip = /<clipPath id="datum-hatch-clip-[^"]+">(<[^>]+>)<\/clipPath>/.exec(svg)
      expect(clip).not.toBeNull()
      expect(clip![1].startsWith("<circle")).toBe(true)
      expect(num(clip![1], "r")).toBeCloseTo(4.0, 2)
    })

    test(`0 geometry defects @${W}, sync and production (auto) path; no geometry REPORT, no FAIL`, async () => {
      for (const fig of FIGS) {
        for (const r of [build(fig, W), await buildAuto(fig, W)]) {
          expect((lintMod as J).lintDiagramGeometry(r.svg).defects, fig).toEqual([])
          expect(((r.report.geometry ?? []) as J[]).map((i) => i.checkId), fig).toEqual([])
          expect(((r.report.issues ?? []) as J[]).filter((i) => i.status === "FAIL"), fig).toEqual([])
        }
      }
    })
  }

  test("cell height: the label-below cell = outline + outer stroke + gap + label block (+ tag) + margin, lattice-locked", () => {
    const L = { x: 128 / 12, y: (13.5 * 25.4) / 72 }
    for (const n of [...eventsOf("events"), ...eventsOf("events_tagged")]) {
      const [w, h] = (geomMod as J).nodeSize(n, L, undefined, 1)
      const need = T.labelBelowHeightMm(n, w)
      expect(need, n.id).toBeGreaterThan(8.0 + PRIMARY + 1.0)
      expect(h, n.id).toBeGreaterThanOrEqual(need - 1e-9)
      expect(h - need, n.id).toBeLessThan(L.y)
    }
  })

  test("lint: a label block moved onto its outline, or onto another node, is textOverNode naming that node", () => {
    const svg = build("events", 128).svg as string
    const el = nodeEls(svg, "s0")[0]
    const { g } = labelGroup(svg, el)
    const up = g.replace(/ y="([\d.]+)"/g, (_, y) => ` y="${(Number(y) - 3).toFixed(2)}"`)
    const d1 = ((lintMod as J).lintDiagramGeometry(svg.replace(g, up)).defects as J[]).filter((k) => k.kind === "textOverNode")
    expect(d1.map((k) => k.other)).toContain("s0")
    const m0 = nodeEls(svg, "m0")[0]
    const dx = num(m0, "cx") - num(el, "cx")
    const over = g.replace(/ x="([\d.]+)"/g, (_, x) => ` x="${(Number(x) + dx).toFixed(2)}"`).replace(/ y="([\d.]+)"/g, (_, y) => ` y="${(Number(y) - 4.5).toFixed(2)}"`)
    const d2 = ((lintMod as J).lintDiagramGeometry(svg.replace(g, over)).defects as J[]).filter((k) => k.kind === "textOverNode")
    expect(d2.map((k) => k.other)).toContain("m0")
  })
})
