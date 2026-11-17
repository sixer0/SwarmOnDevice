// Swarm 1.3.3 row 149 (security L3): the framed-SVG intake bounds the render cost, not only the text.
//   A billion-laughs sheet of nested <use>, a <use> cycle, a heavy filter: each refused by name, with the limit
//   stated, in well under 1 s (the check is linear over the parsed tree; nothing is rasterised).
//   The real frame-script goldens still pass.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sanitiseSvg, SVG_INTAKE_LIMITS, SvgIntakeRefusal } from "../../src/mcp-host/svg-intake"

const SCRIPTS = path.resolve(import.meta.dir, "..", "..", "..", "desktop", "datum", "gsp-diagram-standard", "scripts")
const GOLDEN_128 = readFileSync(path.join(SCRIPTS, "testdata", "golden_128.svg"), "utf8")
const GOLDEN_166 = readFileSync(path.join(SCRIPTS, "testdata", "golden_166.svg"), "utf8")

const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="142mm" height="100mm" viewBox="0 0 142 100">${body}</svg>`

/** Refusal plus elapsed ms. */
function refuse(svg: string): { e: SvgIntakeRefusal; ms: number } {
  const t0 = performance.now()
  try {
    sanitiseSvg(svg)
  } catch (e) {
    const ms = performance.now() - t0
    if (e instanceof SvgIntakeRefusal) return { e, ms }
    throw e
  }
  throw new Error("not refused")
}

/** Billion laughs: level k holds `fan` uses of level k-1. */
function useBomb(levels: number, fan: number): string {
  let defs = '<path id="l0" d="M0 0h1"/>'
  for (let k = 1; k <= levels; k++) defs += `<g id="l${k}">${Array.from({ length: fan }, () => `<use href="#l${k - 1}"/>`).join("")}</g>`
  return wrap(`<defs>${defs}</defs><use href="#l${levels}"/>`)
}

describe("row 149: <use> expansion", () => {
  test("billion laughs (10 levels x 10 uses = 10^10 drawn elements in ~100 elements of text) is refused under 1 s", () => {
    const svg = useBomb(10, 10)
    expect(svg.length).toBeLessThan(4000)
    const { e, ms } = refuse(svg)
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(["svg_expansion_too_large", "svg_use_too_many"]).toContain(e.details.reason as string)
    expect(e.details.limit).toBeGreaterThan(0)
    expect(ms).toBeLessThan(1000)
  })

  test("the same bomb at the 2 MiB text cap (wide fan) is still refused under 1 s", () => {
    const { e, ms } = refuse(useBomb(6, 400))
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(ms).toBeLessThan(1000)
  })

  test("<use> instances are counted transitively: 3 x 1000 + 1000 in <defs> > 2000, far under the element cap", () => {
    // Each level is a single use pointing to a tiny target, so the element cap is not hit first.
    const svg = wrap(`<defs><path id="p" d="M0 0h1"/><g id="a">${'<use href="#p"/>'.repeat(1000)}</g></defs><use href="#a"/><use href="#a"/><use href="#a"/>`)
    const { e, ms } = refuse(svg)
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(e.details).toMatchObject({ reason: "svg_use_too_many", limit: SVG_INTAKE_LIMITS.maxUseInstances })
    expect(e.message).toContain(`more than ${SVG_INTAKE_LIMITS.maxUseInstances} <use> instances`)
    expect(ms).toBeLessThan(1000)
  })

  test("expanded elements are capped: a path-heavy symbol used 40 times", () => {
    const sym = `<symbol id="s">${'<path d="M0 0h1"/>'.repeat(2000)}</symbol>`
    const { e } = refuse(wrap(`<defs>${sym}</defs>${'<use href="#s"/>'.repeat(40)}`))
    expect(e.details).toMatchObject({ reason: "svg_expansion_too_large", limit: SVG_INTAKE_LIMITS.maxExpandedElements })
  })

  test("a reference chain deeper than the limit is refused", () => {
    let defs = '<path id="c0" d="M0 0h1"/>'
    for (let k = 1; k <= SVG_INTAKE_LIMITS.maxReferenceDepth + 2; k++) defs += `<use id="c${k}" href="#c${k - 1}"/>`
    const { e } = refuse(wrap(`<defs>${defs}</defs><use href="#c${SVG_INTAKE_LIMITS.maxReferenceDepth + 2}"/>`))
    expect(e.details).toMatchObject({ reason: "svg_reference_too_deep", limit: SVG_INTAKE_LIMITS.maxReferenceDepth })
  })
})

describe("row 149: recursion is refused", () => {
  const cases: Array<[string, string]> = [
    ["two uses pointing at each other", '<defs><use id="a" href="#b"/><use id="b" xlink:href="#a"/></defs><use href="#a"/>'],
    ["a use inside the group it references", '<g id="g"><rect width="1" height="1"/><use href="#g"/></g>'],
    ["a pattern filled with itself", '<defs><pattern id="p" width="4" height="4"><rect width="2" height="2" fill="url(#p)"/></pattern></defs><rect width="10" height="10" fill="url(#p)"/>'],
    ["a self-referencing use", '<use id="u" href="#u"/>'],
  ]
  for (const [name, body] of cases) {
    test(name, () => {
      const { e, ms } = refuse(wrap(body))
      expect(e.code).toBe("ASSET_TYPE_UNSUPPORTED")
      expect(e.details.reason).toBe("svg_reference_cycle")
      expect(e.message).toContain("recursion is not allowed")
      expect(ms).toBeLessThan(1000)
    })
  }
})

describe("row 149: filter cost", () => {
  const vbSide = 142
  const kernelCap = SVG_INTAKE_LIMITS.maxFilterKernelFraction * vbSide
  test("huge blur and morphology kernels are refused by name, with the limit, under 1 s", () => {
    for (const prim of [`<feGaussianBlur stdDeviation="1000"/>`, `<feMorphology operator="dilate" radius="5000"/>`, `<feDropShadow stdDeviation="2 900"/>`]) {
      const { e, ms } = refuse(wrap(`<defs><filter id="f">${prim}</filter></defs><rect width="10" height="10" filter="url(#f)"/>`))
      expect(e.code).toBe("ASSET_TOO_LARGE")
      expect(e.details.reason).toBe("svg_filter_kernel_too_large")
      expect(e.details.limit).toBeCloseTo(kernelCap, 3)
      expect(ms).toBeLessThan(1000)
    }
  })

  test("primitiveUnits=objectBoundingBox kernels are bounded to 2% of the box", () => {
    const { e } = refuse(wrap(`<defs><filter id="f" primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="0.5"/></filter></defs><rect width="10" height="10" filter="url(#f)"/>`))
    expect(e.details).toMatchObject({ reason: "svg_filter_kernel_too_large", limit: 0.02 })
  })

  test("too many primitives in one filter, and in the sheet", () => {
    const one = refuse(wrap(`<defs><filter id="f">${'<feOffset dx="1"/>'.repeat(17)}</filter></defs>`)).e
    expect(one.details).toMatchObject({ reason: "svg_filter_too_many_primitives", limit: SVG_INTAKE_LIMITS.maxFilterPrimitivesPerFilter })
    const filters = Array.from({ length: 5 }, (_, i) => `<filter id="f${i}">${'<feOffset dx="1"/>'.repeat(16)}</filter>`).join("")
    const all = refuse(wrap(`<defs>${filters}</defs>`)).e
    expect(all.details).toMatchObject({ reason: "svg_filter_too_many_primitives", limit: SVG_INTAKE_LIMITS.maxFilterPrimitives, count: 80 })
  })

  test("a filtered element repeated through <use> counts every instance", () => {
    const svg = wrap(`<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><rect id="r" width="5" height="5" filter="url(#f)"/></defs>${'<use href="#r"/>'.repeat(70)}`)
    const { e, ms } = refuse(svg)
    expect(e.details).toMatchObject({ reason: "svg_filter_too_many_uses", limit: SVG_INTAKE_LIMITS.maxFilteredElements })
    expect(ms).toBeLessThan(1000)
  })

  test("filter region and primitive subregion size are bounded", () => {
    const bbox = refuse(wrap(`<defs><filter id="f" width="1000%"><feOffset dx="1"/></filter></defs>`)).e
    expect(bbox.details).toMatchObject({ reason: "svg_filter_region_too_large", limit: 3, element: "filter", attribute: "width" })
    const user = refuse(wrap(`<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100000"><feOffset dx="1"/></filter></defs>`)).e
    expect(user.details).toMatchObject({ reason: "svg_filter_region_too_large", attribute: "height" })
    const sub = refuse(wrap(`<defs><filter id="f"><feFlood width="99999" flood-color="#000"/></filter></defs>`)).e
    expect(sub.details).toMatchObject({ reason: "svg_filter_region_too_large", element: "feFlood" })
  })

  test("a modest drop shadow inside the limits is accepted", () => {
    const s = sanitiseSvg(wrap(`<defs><filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0.5" dy="0.5" stdDeviation="0.8"/></filter></defs><rect width="10" height="10" filter="url(#f)"/>`))
    expect(s.elements).toBe(5)
  })
})

describe("row 149: url(#id) in <style> is counted as if the rule hit every element", () => {
  test("a heavy pattern named from <style> is refused; a gradient or small clipPath is allowed", () => {
    const heavy = `<pattern id="p" width="2" height="2">${'<path d="M0 0h1"/>'.repeat(2000)}</pattern>`
    const { e, ms } = refuse(wrap(`<style>.x{fill:url(#p)}</style><defs>${heavy}</defs>${'<rect class="x" width="1" height="1"/>'.repeat(30)}`))
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(e.details).toMatchObject({ reason: "svg_expansion_too_large", limit: SVG_INTAKE_LIMITS.maxExpandedElements })
    expect(e.message).toContain("url(#id) in <style>")
    expect(ms).toBeLessThan(1000)
    const ok = sanitiseSvg(wrap(`<style>.x{fill:url(#g)}.y{clip-path:url(#c)}</style><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><rect class="x y" width="10" height="10"/>`))
    expect(ok.elements).toBe(8)
  })
})

describe("row 149: real sheets are untouched", () => {
  test("the frame-script goldens pass, and an ordinary marker / hatch sheet passes", () => {
    expect(sanitiseSvg(GOLDEN_128).widthMm).toBe(142)
    expect(sanitiseSvg(GOLDEN_166).widthMm).toBe(180)
    const hatch = `<pattern id="datum-hatch45" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1.6" stroke="#666" stroke-width="0.3"/></pattern>`
    const marker = `<marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0 0L4 2L0 4z"/></marker>`
    const lines = Array.from({ length: 200 }, (_, i) => `<line x1="0" y1="${i / 2}" x2="100" y2="${i / 2}" marker-end="url(#m)"/>`).join("")
    const boxes = Array.from({ length: 50 }, (_, i) => `<rect x="${i}" y="0" width="1" height="1" fill="url(#datum-hatch45)"/>`).join("")
    const s = sanitiseSvg(wrap(`<defs>${hatch}${marker}</defs>${lines}${boxes}`))
    expect(s.elements).toBeGreaterThan(250)
  })
})
