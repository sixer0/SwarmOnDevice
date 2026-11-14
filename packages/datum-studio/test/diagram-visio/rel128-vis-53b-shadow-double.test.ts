// Swarm 1.2.8 row 53b (C75 item 3, Visio minimum; defects that predate 1.2.8, seen in test/eye/53/htag_shadowed_128.png
// and htag_doubled_128.png). (1) A `shadowed` node is drawn as: offset shadow rectangle, a paper rectangle over the node
// box, then the hatch (if any), the outline and the texts, so no shadow line shows inside the node or crosses its tag.
// (2) A `doubled` node's inner divider lies below the text block (label, sub) with >= DOUBLED_DIVIDER_CLEAR_MM from the
// text ink and from the inner rectangle, or is not drawn when no such band exists; it never crosses the label or tag.
// Figures: the row 53 `doubled` / `shadowed` tag figures (test/fixtures/syn128/htag_all_shapes.json) plus variants
// built here (hatched shadowed, sub line, wrapped label); synthetic labels; 128 and 166 mm; sync and production (auto).
// Red at BASE e1f9673772: the shadowed node has fill="none" and nothing covers the shadow; the divider is at h/2 through
// the label. Namespace imports, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as buildMod from "../../vendor/src/lib/studio/engine/diagram/build"
import * as elkMod from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as lintMod from "../../vendor/src/lib/studio/engine/diagram/fit/lint"

type J = Record<string, any>
type Box = [number, number, number, number]
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "htag_all_shapes.json"), "utf8")) as J
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const WIDTHS = [128, 166] as const
const PAPER = "#FCFCFB"
const INK200 = "#C3CBD1"
const CLEAR = 0.4 // DOUBLED_DIVIDER_CLEAR_MM
const EPS = 0.011 // 2-decimal rounding of the printed coordinates

function variant(base: string, edit: (n1: J) => void): J {
  const s = clone(FX[base])
  edit(s.nodes[0])
  return s
}
const FIGS: Record<string, J> = {
  shadowed: FX.shadowed,
  shadowed_hatched: variant("shadowed", (n) => (n.class = { ...n.class, accent: true })),
  shadowed_sub: variant("shadowed", (n) => (n.sub = "Rincian sintetis")),
  doubled: FX.doubled,
  doubled_sub: variant("doubled", (n) => (n.sub = "Rincian sintetis")),
  doubled_wrapped: variant("doubled", (n) => (n.label = "Langkah sintetis dengan label panjang yang dibungkus menjadi dua baris")),
  doubled_untagged: variant("doubled", (n) => delete n.tag),
}

async function render(fig: string, width: number, auto: boolean): Promise<J> {
  const spec = { ...clone(FIGS[fig]), width_mm: width }
  return auto ? (elkMod as J).buildDiagramSvgAuto(spec, O, {}, () => {}) : (buildMod as J).buildDiagramSvg(spec, O)
}

const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
const num = (el: string, k: string) => Number(attr(el, k))
type El = { el: string; at: number }
const all = (svg: string, re: RegExp): El[] => [...svg.matchAll(re)].map((m) => ({ el: m[0], at: m.index! }))
const rectBox = (el: string): Box => [num(el, "x"), num(el, "y"), num(el, "x") + num(el, "width"), num(el, "y") + num(el, "height")]
const sameBox = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - b[i]) <= EPS)
const within = (inner: Box, outer: Box) => inner[0] >= outer[0] - EPS && inner[1] >= outer[1] - EPS && inner[2] <= outer[2] + EPS && inner[3] <= outer[3] + EPS
const hits = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/** Ink boxes of the texts drawn inside `box` (label, sub, tag), with document order. */
function textsIn(svg: string, box: Box): Array<{ box: Box; at: number; tag: boolean; s: string }> {
  const out: Array<{ box: Box; at: number; tag: boolean; s: string }> = []
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const head = `<text${m[1]}>`
    const tsp = [...m[2].matchAll(/<tspan\b([^>]*)>([^<]*)<\/tspan>/g)]
    const x0 = num(head, "x")
    let y = num(head, "y")
    const lines = tsp.length
      ? tsp.map((t) => {
          const te = `<tspan${t[1]}>`
          if (attr(te, "y") !== undefined) y = num(te, "y")
          else if (attr(te, "dy") !== undefined) y += num(te, "dy")
          return { x: attr(te, "x") !== undefined ? num(te, "x") : x0, y, s: t[2] }
        })
      : [{ x: x0, y, s: m[2] }]
    const bold = attr(head, "font-weight") === "600"
    const b = (lintMod as J).textBlockBox(lines, num(head, "font-size"), attr(head, "text-anchor") ?? "start", /Mono/.test(attr(head, "font-family") ?? "") ? "data" : "struct", bold, Number(attr(head, "letter-spacing") ?? 0)) as Box | null
    if (b && within([lines[0].x, lines[0].y, lines[0].x, lines[0].y], box)) out.push({ box: b, at: m.index!, tag: bold && attr(head, "letter-spacing") !== undefined, s: lines.map((l) => l.s).join(" ") })
  }
  return out
}

function nodeRect(svg: string): El {
  const m = /<rect\b[^>]*data-node="n1"[^>]*\/>/.exec(svg)
  expect(m, "n1 outline rect").not.toBeNull()
  return { el: m![0], at: m!.index }
}

const RUNS = WIDTHS.flatMap((w) => [false, true].map((auto) => [w, auto] as const))

describe("shadowed: shadow behind a filled node (C75 item 3a)", () => {
  for (const fig of ["shadowed", "shadowed_hatched", "shadowed_sub"]) {
    for (const [W, auto] of RUNS) {
      test(`${fig} @${W} ${auto ? "auto" : "sync"}: shadow, then a paper interior, then hatch/outline/texts; no shadow ink inside the node`, async () => {
        const r = await render(fig, W, auto)
        const svg = r.svg as string
        const node = nodeRect(svg)
        const nb = rectBox(node.el)
        const shadows = all(svg, /<rect\b[^>]*\/>/g).filter((e) => attr(e.el, "stroke") === INK200 && attr(e.el, "fill") === "none")
        expect(shadows.length, "one shadow rect").toBe(1)
        const sh = shadows[0]
        const sb = rectBox(sh.el)
        expect(sb[0] > nb[0] && sb[1] > nb[1], "shadow offset right/down").toBe(true)
        expect(sh.at < node.at, "shadow drawn before the node outline").toBe(true)
        // the node interior is filled: a paper rect equal to the node box, after the shadow and before the outline
        const paper = all(svg, /<rect\b[^>]*\/>/g).filter((e) => attr(e.el, "fill") === PAPER && attr(e.el, "stroke") === undefined && sameBox(rectBox(e.el), nb) && e.at > sh.at && e.at < node.at)
        expect(paper.length, "paper interior between shadow and outline").toBe(1)
        // hatch (accent) and the node's texts are drawn after the paper, so the paper hides neither
        const hatch = svg.indexOf("datum-hatch-clip")
        const hatchAt = Math.max(hatch, svg.search(/<g\b[^>]*stroke[^>]*><line\b/))
        if (fig === "shadowed_hatched") expect(hatchAt > paper[0].at, "hatch after the paper").toBe(true)
        const texts = textsIn(svg, nb)
        expect(texts.some((t) => t.tag), "tag drawn").toBe(true)
        for (const t of texts) expect(t.at > paper[0].at, `text ${t.s} after the paper`).toBe(true)
        // every part of the shadow's top and left lines that lies inside the node (crossing the tag at BASE) is covered
        const topLine: Box = [sb[0], sb[1], sb[2], sb[1]]
        const leftLine: Box = [sb[0], sb[1], sb[0], sb[3]]
        for (const ln of [topLine, leftLine]) {
          const inside: Box = [Math.max(ln[0], nb[0]), Math.max(ln[1], nb[1]), Math.min(ln[2], nb[2]), Math.min(ln[3], nb[3])]
          expect(within(inside, rectBox(paper[0].el)), "shadow line inside the node covered by paper").toBe(true)
        }
        expect((lintMod as J).lintDiagramGeometry(svg).defects, "0 engine defects").toEqual([])
        expect(((r.report.geometry ?? []) as J[]).map((i) => i.checkId).filter((id) => /^GEOM_/.test(id) && id !== "GEOM_ARROW_TANGENT"), "0 geometry ids").toEqual([])
      })
    }
  }
})

describe("doubled: inner divider clear of the label (C75 item 3b)", () => {
  for (const fig of ["doubled", "doubled_sub", "doubled_wrapped", "doubled_untagged"]) {
    for (const [W, auto] of RUNS) {
      test(`${fig} @${W} ${auto ? "auto" : "sync"}: divider below the text block, >= ${CLEAR} mm from text ink and inner line, or absent`, async () => {
        const r = await render(fig, W, auto)
        const svg = r.svg as string
        const node = nodeRect(svg)
        const nb = rectBox(node.el)
        const after = svg.slice(node.at + node.el.length)
        const inner = /^<rect\b[^>]*\/>/.exec(after)
        expect(inner, "inner rect right after the outline").not.toBeNull()
        const ib = rectBox(inner![0])
        expect(within(ib, nb) && ib[0] > nb[0], "inner rect inside").toBe(true)
        const rest = after.slice(inner![0].length)
        const divider = /^<line\b[^>]*\/>/.exec(rest)
        const texts = textsIn(svg, nb).filter((t) => !t.tag)
        expect(texts.length, "label (and sub) found").toBeGreaterThan(0)
        const tag = textsIn(svg, nb).find((t) => t.tag)
        if (fig !== "doubled_untagged") {
          expect(tag, "tag drawn").toBeDefined()
          // tag still readable: inside the inner rectangle, clear of its lines
          expect(tag!.box[0] > ib[0] && tag!.box[1] > ib[1], "tag inside the inner rect").toBe(true)
        }
        const textBottom = Math.max(...texts.map((t) => t.box[3]))
        if (divider) {
          const dy = num(divider[0], "y1")
          expect(num(divider[0], "y2")).toBe(dy)
          for (const t of [...texts, ...(tag ? [tag] : [])]) {
            expect(hits(t.box, [ib[0], dy - 0.1, ib[2], dy + 0.1]), `divider clear of "${t.s}"`).toBe(false)
          }
          expect(dy - textBottom, "divider below the text ink by the clearance").toBeGreaterThanOrEqual(CLEAR - EPS)
          expect(ib[3] - dy, "divider above the inner bottom line by the clearance").toBeGreaterThanOrEqual(CLEAR - EPS)
        } else {
          // no divider only when the band below the text is too small
          expect(ib[3] - textBottom, "no band for a divider").toBeLessThan(2 * CLEAR + EPS)
        }
        expect((lintMod as J).lintDiagramGeometry(svg).defects, "0 engine defects").toEqual([])
        expect(((r.report.geometry ?? []) as J[]).map((i) => i.checkId).filter((id) => /^GEOM_/.test(id) && id !== "GEOM_ARROW_TANGENT"), "0 geometry ids").toEqual([])
      })
    }
  }
  test("the row 53 doubled figure keeps a divider (the band below a one-line label is wide enough)", async () => {
    for (const W of WIDTHS) {
      const svg = (await render("doubled", W, false)).svg as string
      const node = nodeRect(svg)
      expect(/^<rect\b[^>]*\/><line\b/.test(svg.slice(node.at + node.el.length)), `@${W}`).toBe(true)
    }
  })
})
