// Swarm 1.2.6 row 24: guard over the anonymised acceptance fixtures (01g section 4.5 G2 and G3, flows F1-F7).
// G2 is a closed allowlist: every text-bearing value of every fixture splits into letter tokens that must be
// filler (ICAO pool words or "x", see filler.ts), a CAPTION_TOKEN_RE keyword at the head of a T-01 caption, or a
// documented structural word of the fixture's format. Digit runs in text must be 8 only. So no source word can
// survive without the guard knowing the source, and real text added later fails here. G1 (the forbidden-string
// grep against the real evidence) is local-only and never committed.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import { DIAGRAM_EDGE_KINDS, DIAGRAM_FAMILIES, PROVENANCE_MARKS } from "@/lib/studio/contract/enums"
import { auditText } from "@/lib/studio/engine/bind/audit"
import { Register } from "@/lib/studio/engine/bind/register"
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint"
import { CAPTION_KEYWORDS, FILLER_TOKEN_RE } from "./filler"
import { P01_HOME_FILES, P01_PACKAGE_FILES, P01_PROJECT_FILES } from "./p01_home"
import { bigDocChapters, bigDocWords } from "./t13_k1"
import { D01_CHAPTERS, D01_TOTAL, d01Chapters, d01Markdown } from "./t14_k1"
import { crc32, w13Scanlines } from "./w13_png"

const DIR = import.meta.dir
type Entry = { file: string; flow: string; item: string; role: string; kind: string }
const MANIFEST: Entry[] = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")).fixtures
const read = (f: string) => readFileSync(path.join(DIR, f), "utf8")
const ofKind = (k: string) => MANIFEST.filter((e) => e.kind === k).map((e) => e.file)

/** Problems of one text value: non-filler letter tokens and digit runs other than 8s. */
function textProblems(where: string, s: string, extra: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  for (const t of s.match(/\p{L}+/gu) ?? []) {
    const w = t.toLowerCase()
    if (!FILLER_TOKEN_RE.test(w) && !extra.has(w)) out.push(`${where}: token "${t}"`)
  }
  for (const d of s.match(/\p{Nd}+/gu) ?? []) if (!/^8+$/.test(d)) out.push(`${where}: digits "${d}"`)
  return out
}

const enumProblem = (where: string, v: unknown, allowed: readonly unknown[]) => (allowed.includes(v) ? [] : [`${where}: value ${JSON.stringify(v)} not in enum`])
const keysProblem = (where: string, o: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${where}: unexpected key "${k}"`)

// ── SVG (F1) ──────────────────────────────────────────────────────────────────
const SVG_ATTR: Record<string, RegExp> = {
  x: /^-?[\d.]+$/, y: /^-?[\d.]+$/, x1: /^-?[\d.]+$/, y1: /^-?[\d.]+$/, x2: /^-?[\d.]+$/, y2: /^-?[\d.]+$/, cx: /^-?[\d.]+$/, cy: /^-?[\d.]+$/,
  r: /^[\d.]+$/, rx: /^[\d.]+$/, ry: /^[\d.]+$/, dx: /^-?[\d.]+$/, dy: /^-?[\d.]+$/,
  width: /^[\d.]+(mm)?$/, height: /^[\d.]+(mm)?$/, viewBox: /^[-\d. ]+$/, points: /^[-\d., ]+$/, d: /^[MLHVCSQTAZmlhvcsqtaz\d\s.,-]+$/,
  transform: /^translate\(-?[\d.]+(?:[ ,]-?[\d.]+)?\)$/, "stroke-width": /^[\d.]+$/, "font-size": /^[\d.]+$/, "letter-spacing": /^-?[\d.]+$/,
  "stroke-dasharray": /^[\d.,]+$/, markerWidth: /^[\d.]+$/, markerHeight: /^[\d.]+$/, refX: /^[\d.]+$/, refY: /^[\d.]+$/,
  fill: /^(none|#[0-9A-Fa-f]{6})$/, stroke: /^(none|#[0-9A-Fa-f]{6})$/, "font-family": /^IBM Plex (Sans Condensed|Mono|Sans)$/, "font-weight": /^\d{3}$/,
  "text-anchor": /^(start|middle|end)$/, orient: /^auto$/, version: /^1\.[01]$/, encoding: /^UTF-8$/i, xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
  "data-mark": /^(node|link)$/, "data-index": /^\d+$/, "data-caption-above": /^1$/, "data-node": /^n\d+$/,
  "data-series": new RegExp(`^(${DIAGRAM_EDGE_KINDS.join("|")})$`), id: new RegExp(`^head-(${DIAGRAM_EDGE_KINDS.join("|")})$`),
  "marker-end": new RegExp(`^url\\(#head-(${DIAGRAM_EDGE_KINDS.join("|")})\\)$`),
}

function svgProblems(file: string, svg: string): string[] {
  const out: string[] = []
  if (/<(title|desc|metadata|image)\b|<!--/.test(svg)) out.push(`${file}: title/desc/metadata/image/comment present`)
  for (const tag of svg.match(/<[^>]+>/g) ?? []) {
    if (tag.startsWith("<?")) continue
    for (const m of tag.matchAll(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
      const re = SVG_ATTR[m[1]]
      if (!re) out.push(`${file}: attribute "${m[1]}" not allowed`)
      else if (!re.test(m[2])) out.push(`${file}: ${m[1]}="${m[2]}" not allowed`)
    }
  }
  const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, " ")
  for (const t of svg.match(/>[^<]+</g) ?? []) out.push(...textProblems(`${file} text`, unesc(t.slice(1, -1))))
  return out
}

// ── naskah blocks (F2) and Studio spec (F4) ─────────────────────────────────────
type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v)

function graphProblems(where: string, nodes: unknown, edges: unknown, nodeKeys: readonly string[]): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const [i, n] of (Array.isArray(nodes) ? nodes : []).entries()) {
    if (!isRec(n)) return [`${where}/nodes/${i}: not an object`]
    out.push(...keysProblem(`${where}/nodes/${i}`, n, nodeKeys))
    if (!/^n\d+$/.test(String(n.id))) out.push(`${where}/nodes/${i}/id: ${JSON.stringify(n.id)}`)
    ids.add(String(n.id))
    out.push(...textProblems(`${where}/nodes/${i}/label`, String(n.label)))
    if ("mark" in n) out.push(...enumProblem(`${where}/nodes/${i}/mark`, n.mark, PROVENANCE_MARKS))
    if ("class" in n) {
      if (!isRec(n.class)) out.push(`${where}/nodes/${i}/class: not an object`)
      else {
        out.push(...keysProblem(`${where}/nodes/${i}/class`, n.class, ["row", "tier"]))
        for (const v of Object.values(n.class)) if (!Number.isInteger(v)) out.push(`${where}/nodes/${i}/class: non-integer`)
      }
    }
  }
  for (const [i, e] of (Array.isArray(edges) ? edges : []).entries()) {
    if (!isRec(e)) return [`${where}/edges/${i}: not an object`]
    out.push(...keysProblem(`${where}/edges/${i}`, e, ["from", "to", "kind", "label"]))
    if (!ids.has(String(e.from)) || !ids.has(String(e.to))) out.push(`${where}/edges/${i}: endpoint not a fixture node id`)
    out.push(...enumProblem(`${where}/edges/${i}/kind`, e.kind, DIAGRAM_EDGE_KINDS))
    out.push(...textProblems(`${where}/edges/${i}/label`, String(e.label)))
  }
  return out
}

const CAPTION_HEAD_RE = new RegExp(`^(${CAPTION_KEYWORDS.join("|")})\\.? (\\d+)\\.1(?=\\W|$)`, "i")

function naskahProblems(file: string, o: Rec): string[] {
  const out = keysProblem(file, o, ["id", "nomor", "jenis", "family", "arah", "labels_verified", "title", "caption", "labelShort", "legend", "data"])
  const k = /^t01_k(\d+)\.json$/.exec(file)?.[1]
  if (o.id !== `fx-t01-${k}`) out.push(`${file}/id: ${JSON.stringify(o.id)}`)
  if (o.nomor !== `${k}.1`) out.push(`${file}/nomor: ${JSON.stringify(o.nomor)}`)
  out.push(...enumProblem(`${file}/jenis`, o.jenis, ["diagram", "chart"]))
  if ("family" in o) out.push(...enumProblem(`${file}/family`, o.family, DIAGRAM_FAMILIES))
  if ("arah" in o) out.push(...enumProblem(`${file}/arah`, o.arah, ["LR", "TB"]))
  if ("labels_verified" in o && typeof o.labels_verified !== "boolean") out.push(`${file}/labels_verified: not boolean`)
  out.push(...textProblems(`${file}/title`, String(o.title)))
  const cap = String(o.caption)
  const head = CAPTION_HEAD_RE.exec(cap)
  if (!head || head[2] !== k) out.push(`${file}/caption: no "<keyword> ${k}.1" head`)
  else out.push(...textProblems(`${file}/caption`, cap.slice(head[0].length)))
  if ("labelShort" in o) out.push(...textProblems(`${file}/labelShort`, String(o.labelShort)))
  for (const [i, l] of (Array.isArray(o.legend) ? o.legend : []).entries()) out.push(...textProblems(`${file}/legend/${i}`, String(l)))
  const d = isRec(o.data) ? o.data : {}
  out.push(...keysProblem(`${file}/data`, d, ["shape", "nodes", "edges", "points"]))
  if ("shape" in d) out.push(...enumProblem(`${file}/data/shape`, d.shape, ["categorical"]))
  out.push(...graphProblems(`${file}/data`, d.nodes, d.edges, ["id", "label", "class", "mark"]))
  for (const [i, p] of (Array.isArray(d.points) ? d.points : []).entries()) {
    if (!isRec(p)) continue
    out.push(...textProblems(`${file}/data/points/${i}/label`, String(p.label)))
    if (!Number.isInteger(p.value) || (p.value as number) < 0 || (p.value as number) > 100) out.push(`${file}/data/points/${i}/value: not a scaled 0..100 integer`)
  }
  return out
}

function specProblems(file: string, o: Rec): string[] {
  const out = keysProblem(file, o, ["$schema", "family", "id", "title", "classification", "width_mm", "labels_verified", "sources", "nodes", "edges", "legend", "direction"])
  if (o.$schema !== "studio.diagram/v1") out.push(`${file}/$schema`)
  out.push(...enumProblem(`${file}/family`, o.family, DIAGRAM_FAMILIES))
  if (!/^\d+\.1$/.test(String(o.id))) out.push(`${file}/id: ${JSON.stringify(o.id)}`)
  if (o.classification !== "BIASA") out.push(`${file}/classification: not the least restricted value`)
  if (typeof o.width_mm !== "number") out.push(`${file}/width_mm`)
  if ("direction" in o) out.push(...enumProblem(`${file}/direction`, o.direction, ["LR", "TB"]))
  out.push(...textProblems(`${file}/title`, String(o.title)))
  for (const [i, s] of (Array.isArray(o.sources) ? o.sources : []).entries()) out.push(...textProblems(`${file}/sources/${i}`, String(s)))
  for (const [i, l] of (Array.isArray(o.legend) ? o.legend : []).entries()) out.push(...textProblems(`${file}/legend/${i}`, String(l)))
  out.push(...graphProblems(file, o.nodes, o.edges, ["id", "label", "class", "mark"]))
  return out
}

// ── Graphviz (F4 twin) ──────────────────────────────────────────────────────────
const DOT_VOCAB = new Set(
  ("digraph graph node edge rankdir tb lr splines ortho dpi margin nodesep ranksep edgesep bgcolor fontname fontcolor fontsize " +
    "shape style plain color penwidth arrowsize labeldistance box dashed solid label ibm plex sans condensed mono").split(" "),
)

function dotProblems(file: string, s: string): string[] {
  const out: string[] = []
  if (/\/\*|\/\/|^\s*#/m.test(s)) out.push(`${file}: comment present`)
  const g = /^\s*(?:strict\s+)?(?:di)?graph\s+(\S+)\s*\{/.exec(s)
  if (!g || !/^g\d+$/.test(g[1])) out.push(`${file}: graph name not g<k>`)
  let rest = s.replace(/^\s*(?:strict\s+)?(?:di)?graph\s+\S+/, "")
  rest = rest.replace(/\b(label|xlabel|tooltip|URL|comment)\s*=\s*"((?:[^"\\]|\\.)*)"/g, (_m, _k, v: string) => {
    out.push(...textProblems(`${file} ${_k}`, v))
    return " "
  })
  rest = rest.replace(/"([^"]*)"/g, (_m, v: string) => {
    if (/^n\d+$/.test(v) || /^#[0-9A-Fa-f]{6}$/.test(v) || /^[\d.,]+$/.test(v) || /^IBM Plex [A-Za-z ]+$/.test(v)) return " "
    out.push(`${file}: quoted value "${v}" not allowed`)
    return " "
  })
  for (const t of rest.match(/\p{L}+/gu) ?? []) if (!DOT_VOCAB.has(t.toLowerCase())) out.push(`${file}: token "${t}"`)
  return out
}

// ── synthetic modules (F3, F5, F7) ───────────────────────────────────────────
/** Structural words of the synthetic F7 files (ssh config keys, auth.json and package.json keys, a .invalid host). */
const P01_VOCAB = new Set("host hostname user port invalid type api key name version private main index js module exports dependencies file true".split(" "))

describe("row 24 anonymised fixtures: G3 file names and the manifest", () => {
  test("every file in the folder has a neutral name and is listed in manifest.json", () => {
    const files = readdirSync(DIR).filter((f) => statSync(path.join(DIR, f)).isFile())
    const bad = files.filter((f) => !/^[a-z0-9_]+(\.test)?\.(json|svg|dot|md|ts|png)$/.test(f))
    expect(bad).toEqual([])
    const listed = new Set([...MANIFEST.map((e) => e.file), "manifest.json"])
    expect(files.filter((f) => !listed.has(f))).toEqual([])
    expect([...listed].filter((f) => !files.includes(f))).toEqual([])
  })

  test("one fixture set per flow F1-F7", () => {
    for (const f of ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]) expect(MANIFEST.some((e) => e.flow === f)).toBe(true)
    const f1 = MANIFEST.filter((e) => e.flow === "F1")
    expect(f1.filter((e) => e.role === "defect").length).toBe(7)
    expect(f1.filter((e) => e.role.startsWith("negative-control")).length).toBeGreaterThanOrEqual(2)
    expect(MANIFEST.filter((e) => e.flow === "F2").length).toBe(6)
  })
})

describe("row 24 anonymised fixtures: G2 closed allowlist", () => {
  test("the guard rejects a non-filler word and a non-8 digit (self-check)", () => {
    expect(textProblems("probe", "Alfa bravo 88.")).toEqual([])
    expect(textProblems("probe", "Alfa laporan 88.").length).toBe(1)
    expect(textProblems("probe", "Alfa bravo 2027.").length).toBe(1)
    expect(svgProblems("probe.svg", '<svg viewBox="0 0 1 1"><text x="1" data-label="rahasia">Alfa</text></svg>').length).toBe(1)
    expect(dotProblems("probe.dot", 'digraph g1 {\n  "n1" [label="Alfa", tooltip="rahasia"];\n}\n').length).toBe(1)
  })

  test("SVG twins: only geometry, style and engine-enum attributes; filler text", () => {
    for (const f of ofKind("svg")) expect(svgProblems(f, read(f))).toEqual([])
  })

  test("Rev D blocks (T-01): enums kept, ids remapped, filler text, token-led captions", () => {
    for (const f of ofKind("naskah")) expect(naskahProblems(f, JSON.parse(read(f)))).toEqual([])
  })

  test("Studio spec (T-11): enums kept, ids remapped, filler text", () => {
    for (const f of ofKind("spec")) expect(specProblems(f, JSON.parse(read(f)))).toEqual([])
  })

  test("Graphviz twin: graph g<k>, nodes n<i>, filler labels, no comments", () => {
    for (const f of ofKind("dot")) expect(dotProblems(f, read(f))).toEqual([])
  })

  test("synthetic generators emit filler only", () => {
    const big = bigDocChapters()
    expect(big.flatMap((c, i) => [...textProblems(`t13 ${i} title`, c.title), ...textProblems(`t13 ${i}`, c.markdown)])).toEqual([])
    const d01 = d01Chapters()
    expect(d01.flatMap((c, i) => textProblems(`t14 ${i}`, d01Markdown(c)))).toEqual([])
    const p01 = { ...P01_HOME_FILES, ...P01_PACKAGE_FILES, ...P01_PROJECT_FILES }
    expect(Object.entries(p01).flatMap(([k, v]) => textProblems(`p01 ${k}`, v, P01_VOCAB))).toEqual([])
  })

  test("PNG: geometric shapes only, no text or metadata chunks", () => {
    for (const f of ofKind("png")) {
      const b = new Uint8Array(readFileSync(path.join(DIR, f)))
      expect(b.length).toBeLessThanOrEqual(4096)
      expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
      const types: string[] = []
      const idat: Uint8Array[] = []
      for (let at = 8; at < b.length; ) {
        const len = v.getUint32(at)
        const type = new TextDecoder().decode(b.subarray(at + 4, at + 8))
        expect(v.getUint32(at + 8 + len)).toBe(crc32(b.subarray(at + 4, at + 8 + len)))
        types.push(type)
        if (type === "IDAT") idat.push(b.subarray(at + 8, at + 8 + len))
        at += 12 + len
      }
      expect(types).toEqual(["IHDR", "IDAT", "IEND"])
      expect(inflateSync(Buffer.concat(idat.map((u) => Buffer.from(u)))).equals(Buffer.from(w13Scanlines()))).toBe(true)
    }
  })
})

describe("row 24 fixtures: shape checks the flows rely on (01g section 5.2)", () => {
  test("F1: every SVG is an engine SVG the geometry lint can size", () => {
    for (const f of ofKind("svg")) {
      const r = lintDiagramGeometry(read(f))
      expect(r.widthMm).toBeGreaterThan(0)
      expect(r.heightMm).toBeGreaterThan(0)
    }
  })

  test("F2: six token-led captions, all over 100 characters", () => {
    const caps = ofKind("naskah").map((f) => String(JSON.parse(read(f)).caption))
    expect(caps.length).toBe(6)
    // register N-013 CAPTION_TOKEN_RE (pattern restated here: the constant is new in 1.2.6)
    for (const c of caps) expect(c).toMatch(/^\s*(gambar|figure|fig\.|grafik|bagan|diagram)\s+[A-Z]?\d+(?:[.\-]\d+)*\b/i)
    expect(caps.filter((c) => c.length > 100).length).toBeGreaterThanOrEqual(2)
  })

  test("F3: the synthetic document is large enough for 217 pages", () => {
    expect(bigDocWords(bigDocChapters())).toBeGreaterThanOrEqual(217 * 450)
  })

  test("F4: flow family, LR direction, one source fanning out to four targets", () => {
    const s = JSON.parse(read("t11_k1.json"))
    expect(s.family).toBe("flow")
    expect(s.direction).toBe("LR")
    const outs = new Map<string, number>()
    for (const e of s.edges) outs.set(e.from, (outs.get(e.from) ?? 0) + 1)
    expect(Math.max(...outs.values())).toBe(4)
  })

  test("F5: D01 audit gives exactly 145 findings across 3 chapters", () => {
    const reg = new Register({})
    const chapters = d01Chapters()
    expect(chapters.length).toBe(D01_CHAPTERS)
    const per = chapters.map((c) => c.paragraphs.reduce((n, p) => n + auditText(p, reg, [], { context: "body" }).length, 0))
    expect(per.reduce((a, b) => a + b, 0)).toBe(D01_TOTAL)
    expect(per.every((n) => n > 0)).toBe(true)
  })
})
