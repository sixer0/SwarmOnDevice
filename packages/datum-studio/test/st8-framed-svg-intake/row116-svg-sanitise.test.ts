// Swarm 1.3.3 row 116 (ST-8, owner decision Q4 = U4): a framed SVG from the bundled frame script
// (gsp-diagram-standard/scripts/bingkai_lembar.py) is accepted ONLY to be converted to a PNG asset. Before any raster
// the SVG is parsed and every unsafe construct is REFUSED BY NAME (never silently stripped):
// script, event-handler attributes, foreignObject, external references (href / xlink:href / CSS url() to anything but
// an internal #id or an inline data:image/png|jpeg URI), external stylesheets and @import, DOCTYPE and entity
// declarations, and oversized input (bytes, elements, depth, attributes, physical size).
// Pure: no store, no port, no render bridge.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  FRAME_MARGIN_MM,
  placeFramedSvg,
  sanitiseSvg,
  SVG_INTAKE_LIMITS,
  SvgIntakeRefusal,
} from "../../src/mcp-host/svg-intake"
import { FIGURE_WIDTH_MM } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"

const SCRIPTS = path.resolve(import.meta.dir, "..", "..", "..", "desktop", "datum", "gsp-diagram-standard", "scripts", "testdata")
const GOLDEN_128 = readFileSync(path.join(SCRIPTS, "golden_128.svg"), "utf8")
const GOLDEN_166 = readFileSync(path.join(SCRIPTS, "golden_166.svg"), "utf8")

const wrap = (inner: string, root = 'width="142mm" height="100mm" viewBox="0 0 142 100"') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${root}>${inner}</svg>`

function refusal(svg: string): SvgIntakeRefusal {
  try {
    sanitiseSvg(svg)
  } catch (e) {
    if (e instanceof SvgIntakeRefusal) return e
    throw e
  }
  throw new Error("expected a refusal, the SVG was accepted")
}

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

describe("row 116: frame-script output is accepted", () => {
  test("golden 128 (142 mm sheet) and golden 166 (180 mm sheet) parse; physical size read from the root", () => {
    const a = sanitiseSvg(GOLDEN_128)
    expect(a.widthMm).toBe(142)
    expect(a.heightMm).toBe(111)
    const b = sanitiseSvg(GOLDEN_166)
    expect(b.widthMm).toBe(180)
    expect(b.heightMm).toBe(131)
  })

  test("the clean output is a re-serialisation of the validated tree (no comment, no XML declaration)", () => {
    const a = sanitiseSvg(GOLDEN_128)
    expect(a.svg.startsWith("<svg ")).toBe(true)
    expect(a.svg).not.toContain("<!--")
    expect(a.svg).not.toContain("<?xml")
    // Re-sanitising the clean output gives the same output (fixed point).
    expect(sanitiseSvg(a.svg).svg).toBe(a.svg)
  })

  test("internal references and inline PNG/JPEG data are allowed", () => {
    const s = wrap(
      `<defs><marker id="head-data"><path d="M0,0 L1,1"/></marker><clipPath id="c-1"><rect width="1" height="1"/></clipPath></defs>` +
        `<path d="M0,0 L9,9" marker-end="url(#head-data)" style="clip-path:url('#c-1')"/>` +
        `<use href="#head-data"/><use xlink:href="#head-data"/>` +
        `<image x="0" y="0" width="5" height="5" href="${PNG_URI}"/>` +
        `<style>.k{fill:url(#c-1)}</style><text>&lt;a &amp; b&gt; &#65;&#x42;</text>`,
    )
    const r = sanitiseSvg(s)
    expect(r.elements).toBeGreaterThan(5)
    expect(r.svg).toContain("&lt;a &amp; b&gt; AB")
  })
})

describe("row 116: each forbidden construct is refused by name", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["script element", wrap("<script>alert(1)</script>"), /script element/],
    ["script element (upper case)", wrap("<SCRIPT>alert(1)</SCRIPT>"), /script element/],
    ["foreignObject", wrap('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'), /foreignObject element/],
    ["event handler onload", wrap('<rect width="1" height="1" onload="alert(1)"/>'), /event-handler attribute onload/],
    ["event handler on root", `<svg xmlns="http://www.w3.org/2000/svg" width="142mm" height="100mm" viewBox="0 0 142 100" onclick="x()"></svg>`, /event-handler attribute onclick/],
    ["external href", wrap('<use href="https://evil.example/x.svg#a"/>'), /external reference href/],
    ["external xlink:href", wrap('<image width="1" height="1" xlink:href="file:///etc/passwd"/>'), /external reference xlink:href/],
    ["javascript href", wrap('<use href="javascript:alert(1)"/>'), /external reference href/],
    ["svg data URI (not png/jpeg)", wrap('<image width="1" height="1" href="data:image/svg+xml;base64,PHN2Zz4="/>'), /external reference href/],
    ["data URI on use", wrap(`<use href="${PNG_URI}"/>`), /external reference href/],
    ["external url() in attribute", wrap('<rect width="1" height="1" fill="url(https://evil.example/p.svg#g)"/>'), /external reference url\(/],
    ["external url() in style attribute", wrap('<rect width="1" height="1" style="fill:url(other.svg#g)"/>'), /external reference url\(/],
    ["file url in @font-face", wrap('<style>@font-face{font-family:"X";src:url("file:///Applications/x.ttf")}</style>'), /external reference url\(.*file:/],
    ["@import", wrap('<style>@import "https://evil.example/a.css";</style>'), /@import/],
    ["CSS escape (could hide url or @import)", wrap("<style>.a{background:\\75rl(x)}</style>"), /CSS escape/],
    ["image-set", wrap('<style>.a{background:image-set("x.png" 1x)}</style>'), /CSS function image-set/],
    ["xml-stylesheet PI", `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/a.css"?>${wrap("")}`, /processing instruction <\?xml-stylesheet/],
    ["DOCTYPE", `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${wrap("")}`, /DOCTYPE declaration/],
    ["internal entity subset", `<!DOCTYPE svg [<!ENTITY a "aaaa">]>${wrap("<text>&a;</text>")}`, /DOCTYPE declaration/],
    ["undeclared entity reference", wrap("<text>&lol;</text>"), /entity reference &lol;/],
    ["xml:base", wrap('<g xml:base="https://evil.example/"><use href="#a"/></g>'), /xml:base/],
    ["foreign namespace", wrap('<g xmlns:h="http://www.w3.org/1999/xhtml"/>'), /namespace http:\/\/www\.w3\.org\/1999\/xhtml/],
    ["namespaced element", wrap('<h:iframe xmlns:h="http://www.w3.org/2000/svg"/>'), /namespaced element <h:iframe>/],
    ["unknown element", wrap("<iframe/>"), /element <iframe> is not allowed/],
    ["animation (can rewrite href)", wrap('<set attributeName="href" to="https://evil.example"/>'), /element <set> is not allowed/],
    ["feImage", wrap('<filter id="f"><feImage href="#x"/></filter>'), /element <feImage> is not allowed/],
    ["anchor", wrap('<a href="#x"><rect width="1" height="1"/></a>'), /element <a> is not allowed/],
  ]
  for (const [name, svg, re] of cases) {
    test(name, () => {
      const e = refusal(svg)
      expect(e.message).toMatch(re)
      expect(e.code).toBe("ASSET_TYPE_UNSUPPORTED")
      expect(e.details.reason).toBe("svg_unsafe")
      expect(typeof e.details.construct).toBe("string")
    })
  }

  test("a refusal never returns a cleaned copy (nothing is stripped silently)", () => {
    expect(() => sanitiseSvg(wrap('<rect width="1" height="1"/><script/>'))).toThrow(SvgIntakeRefusal)
  })
})

describe("row 116: malformed input and limits", () => {
  test("not an SVG / malformed XML", () => {
    expect(refusal("<html></html>").details.reason).toBe("svg_malformed")
    expect(refusal(wrap("<g><rect/></svg>")).details.reason).toBe("svg_malformed")
    expect(refusal(wrap("") + "<svg/>").details.reason).toBe("svg_malformed")
    expect(refusal(wrap('<rect width="1" width="2"/>')).details.reason).toBe("svg_malformed")
  })

  test("size in mm and a viewBox are required on the root", () => {
    expect(refusal(wrap("", 'width="500" height="300" viewBox="0 0 500 300"')).details.reason).toBe("svg_size_units")
    expect(refusal(wrap("", 'width="142mm" height="100mm"')).details.reason).toBe("svg_viewbox_missing")
  })

  test(`physical size ${SVG_INTAKE_LIMITS.minSideMm}..${SVG_INTAKE_LIMITS.maxSideMm} mm`, () => {
    const e = refusal(wrap("", 'width="420mm" height="100mm" viewBox="0 0 420 100"'))
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(e.details.reason).toBe("svg_dimensions")
  })

  test(`bytes > ${SVG_INTAKE_LIMITS.maxBytes}`, () => {
    const e = refusal(wrap(`<text>${"x".repeat(SVG_INTAKE_LIMITS.maxBytes)}</text>`))
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(e.details.reason).toBe("svg_too_large")
  })

  test(`elements > ${SVG_INTAKE_LIMITS.maxElements}`, () => {
    const e = refusal(wrap("<g/>".repeat(SVG_INTAKE_LIMITS.maxElements + 1)))
    expect(e.code).toBe("ASSET_TOO_LARGE")
    expect(e.details.reason).toBe("svg_too_many_elements")
  })

  test(`nesting depth > ${SVG_INTAKE_LIMITS.maxDepth}`, () => {
    const n = SVG_INTAKE_LIMITS.maxDepth + 1
    const e = refusal(wrap("<g>".repeat(n) + "</g>".repeat(n)))
    expect(e.details.reason).toBe("svg_too_deep")
  })

  test(`attributes per element > ${SVG_INTAKE_LIMITS.maxAttributes}`, () => {
    const attrs = Array.from({ length: SVG_INTAKE_LIMITS.maxAttributes + 1 }, (_, i) => `data-a${i}="1"`).join(" ")
    expect(refusal(wrap(`<g ${attrs}/>`)).details.reason).toBe("svg_too_many_attributes")
  })
})

describe("row 116: placement at the chosen width (skill limit: sheet = figure + 14 mm)", () => {
  test("the frame margin is the skill's 14 mm and the widths are the contract's 128 / 166 mm", () => {
    expect(FRAME_MARGIN_MM).toBe(14)
    expect({ ...FIGURE_WIDTH_MM }).toEqual({ text: 128, full: 166 })
  })

  test("142 mm sheet: text prints at 128 mm (factor 0.90), full at 166 mm", () => {
    const s = sanitiseSvg(GOLDEN_128)
    const t = placeFramedSvg(s, "text")
    expect(t.widthMm).toBe(128)
    expect(t.heightMm).toBeCloseTo((111 * 128) / 142, 3)
    expect(t.svg).toContain('width="128mm"')
    const f = placeFramedSvg(s, "full")
    expect(f.widthMm).toBe(166)
  })

  test("180 mm sheet (166 mm figure) at text width is refused with a message, not shrunk", () => {
    const s = sanitiseSvg(GOLDEN_166)
    let err: SvgIntakeRefusal | undefined
    try {
      placeFramedSvg(s, "text")
    } catch (e) {
      err = e as SvgIntakeRefusal
    }
    expect(err).toBeInstanceOf(SvgIntakeRefusal)
    expect(err!.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err!.details).toMatchObject({ reason: "framed_sheet_too_wide", sheetWidthMm: 180, figureWidthMm: 166, width: "text", columnMm: 128 })
    expect(err!.message).toContain("180 mm")
    expect(err!.message).toContain('"full"')
    expect(placeFramedSvg(s, "full").widthMm).toBe(166)
  })
})
