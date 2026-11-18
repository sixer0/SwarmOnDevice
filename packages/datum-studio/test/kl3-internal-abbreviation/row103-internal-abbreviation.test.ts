// Swarm 1.3.3 row 103 (KL-3, register 03 §7 C-37): singkatan internal di judul, keterangan gambar/tabel, dan paragraf.
import { describe, expect, test } from "bun:test"
import type { NormBlock, NormDocSnapshot } from "../../vendor/src/lib/studio/contract"
import { buildContext, LANGUAGE_SCANNERS } from "../../vendor/src/lib/studio/engine/lint/language/checks"
import {
  findInternalAbbreviations,
  INTERNAL_ABBREVIATION_CONFIG,
  INTERNAL_ABBREVIATION_ID,
  internalAbbreviation,
  parseAbbreviationConfig,
  textPlacesOf,
} from "../../vendor/src/lib/studio/engine/lint/language/internal-abbreviation"
import { extractLayers } from "../../vendor/src/lib/studio/engine/lint/language/prose"
import { lintLanguage } from "../../vendor/src/lib/studio/engine/lint/language"
import { isLintImplemented, LINT_REGISTRY } from "../../vendor/src/lib/studio/registry/lint"

let n = 0
function block(type: string, content: unknown, address: string | null = `1.${++n}`): NormBlock {
  return { blockId: `b${++n}`, address, ordinal: n, unitKey: "1", type, content, textPlain: "", contentSha256: "" }
}

function snapshot(blocks: NormBlock[], meta: Record<string, unknown> = {}): NormDocSnapshot {
  return {
    schema: "studio.norm/v1",
    doc: { meta: { language: "ID", ...meta } } as unknown as NormDocSnapshot["doc"],
    units: [],
    blocks,
    numbering: {},
    register: {},
  }
}

function run(s: NormDocSnapshot) {
  return internalAbbreviation(buildContext(extractLayers(s), {}, "ID", s))
}

const reports = (s: NormDocSnapshot) => run(s).filter((i) => i.status === "REPORT")

describe("config (one file, register 03 §7)", () => {
  test("first entry is the internal library abbreviation with the reader-facing name", () => {
    const first = INTERNAL_ABBREVIATION_CONFIG.terms[0]
    expect(first.term).toBe("EKAS")
    expect(first.say).toBe("pustaka pengetahuan teknis GSP")
    expect(first.sayNext).toBe("pustaka teknis")
    expect(INTERNAL_ABBREVIATION_CONFIG.version).toBe(1)
  })

  test("every term has a replacement", () => {
    for (const t of INTERNAL_ABBREVIATION_CONFIG.terms) {
      expect(t.term.trim().length).toBeGreaterThan(0)
      expect(t.say.trim().length).toBeGreaterThan(0)
    }
  })

  test("a malformed config is refused with a reason", () => {
    expect(() => parseAbbreviationConfig({ version: 2, terms: [] })).toThrow(/version/)
    expect(() => parseAbbreviationConfig({ version: 1, terms: [{ term: "X" }] })).toThrow(/say/)
    expect(() => parseAbbreviationConfig({ version: 1, terms: [] })).toThrow(/terms/)
    expect(() => parseAbbreviationConfig(null)).toThrow()
  })
})

describe("KL-3 fixture: one warning in each of the three places", () => {
  const s = snapshot([
    block("chapter", { key: "3", title: { text: "Dasar Teknis EKAS" } }, "3"),
    block("chart", {
      type: "chart",
      caption: { inline: { text: "Rugi optik per ruas menurut katalog EKAS" } },
      source: { inline: { runs: [{ t: "SUMBER  " }, { t: "Perhitungan Bab 4" }] } },
    }, "3.0.2"),
    block("paragraph", { type: "paragraph", text: "Dasar teknisnya adalah pustaka pengetahuan EKAS berupa lapis teks." }, "3.0.3"),
  ])
  const out = reports(s)

  test("three warnings, REPORT only, never FAIL", () => {
    expect(out.length).toBe(3)
    expect(run(s).some((i) => i.status === "FAIL")).toBe(false)
  })

  test("each warning names the place, the address and the replacement", () => {
    expect(out.map((i) => i.address)).toEqual(["3", "3.0.2", "3.0.3"])
    expect(out[0].detail).toContain("judul")
    expect(out[1].detail).toContain("keterangan")
    expect(out[2].detail).toContain("paragraf")
    expect(out[0].detail).toContain('"EKAS"')
    // penyebutan pertama: nama lengkap; sesudahnya: nama pendek
    expect(out[0].detail).toContain('"pustaka pengetahuan teknis GSP"')
    expect(out[1].detail).toContain('"pustaka teknis"')
    expect(out[2].detail).toContain('"pustaka teknis"')
  })
})

describe("matching", () => {
  const hits = (t: string) => findInternalAbbreviations([{ text: t, code: false }]).filter((h) => !h.exempt).length

  test("whole word, case-insensitive, inside brackets and before punctuation", () => {
    expect(hits("menurut EKAS.")).toBe(1)
    expect(hits("menurut ekas, lalu Ekas;")).toBe(2)
    expect(hits("(EKAS) dan [EKAS] dan \"EKAS\"")).toBe(3)
    expect(hits("bukan EKAS: sumber luar")).toBe(1)
    expect(hits("EKAS-nya dan non-EKAS")).toBe(2)
  })

  test("not a part of another word", () => {
    expect(hits("bekas tempat")).toBe(0)
    expect(hits("EKASA EKAS2 XEKAS")).toBe(0)
  })

  test("file paths, file and folder names, URLs are exempt", () => {
    expect(hits("lihat /Applications/Swarm.app/knowledge-library/ekas-lapis-teks.")).toBe(0)
    expect(hits("folder ekas-lapis-teks berisi lapis teks")).toBe(0)
    expect(hits("berkas EKAS.md dan ekas_index.json")).toBe(0)
    expect(hits("C:\\data\\EKAS\\bab1")).toBe(0)
    expect(hits("https://contoh.test/EKAS/a dan www.ekas.test")).toBe(0)
    expect(hits("lihat EKAS/bab-3")).toBe(0)
  })

  test("code spans are exempt (md-lite backticks and code runs)", () => {
    const s = snapshot([
      block("paragraph", { type: "paragraph", text: "Kunci `EKAS` dipakai di konfigurasi." }),
      block("paragraph", { type: "paragraph", runs: [{ t: "Kunci " }, { t: "EKAS", code: true }, { t: " dipakai." }] }),
    ])
    expect(reports(s).length).toBe(0)
  })
})

describe("places", () => {
  test("sources list: a path is quiet, a sentence still warns", () => {
    const s = snapshot([
      block("sourceRegisterEntry", { id: "S-01", citation: { text: "Katalog rumus, berkas 4 Knowledge Bank/ekas-lapis-teks/KATALOG-RUMUS.md:385" } }, "F:references/1"),
      block("sourceRegisterEntry", { id: "S-02", citation: { text: "ekas-lapis-teks/ASUMSI-BAKU.md" } }, "F:references/2"),
    ])
    expect(reports(s).length).toBe(0)
    const s2 = snapshot([block("sourceRegisterEntry", { id: "S-14", citation: { text: "Eksternal bukan dari EKAS: Dwight" } }, "F:references/14")])
    expect(reports(s2).length).toBe(1)
  })

  test("document title, section and appendix titles, aside, control sheet statement, table caption and source", () => {
    const s = snapshot(
      [
        block("cover", { mode: "auto", data: { titleLines: [{ text: "Kajian EKAS" }] } }, "F:cover"),
        block("controlSheet", { mode: "auto", data: { title: { text: "Lembar Kendali" }, methodStatement: { text: "Angka dikutip dari EKAS." } } }, "F:controlSheet"),
        block("section", { title: { text: "Rujukan EKAS" } }, "3.1"),
        block("appendix", { key: "B", title: { text: "Daftar EKAS" } }, "B"),
        block("aside", { label: { text: "Catatan EKAS" }, body: [{ text: "Isi EKAS." }] }, "3.2"),
        block("table", { type: "table", caption: { text: "Tabel EKAS" }, source: { text: "SUMBER EKAS" }, columns: [{ role: "text" }], rows: [{ cells: [{ text: "EKAS" }] }] }, "3.3"),
      ],
      { title: "Kajian EKAS" },
    )
    const out = reports(s)
    // cover title (meta.title not counted twice), statement, section, appendix, aside label + body, table caption + source = 8
    expect(out.length).toBe(8)
    expect(out.filter((i) => i.detail!.includes("judul")).length).toBe(4)
    expect(out.filter((i) => i.detail!.includes("keterangan")).length).toBe(2)
  })

  test("meta.title is read when there is no cover block", () => {
    expect(reports(snapshot([], { title: "Kajian EKAS" })).length).toBe(1)
  })

  test("table cells, list items, code blocks and figure specs are not scanned", () => {
    const s = snapshot([
      block("table", { type: "table", columns: [{ role: "text" }], rows: [{ cells: [{ text: "EKAS" }] }] }),
      block("list", { type: "list", style: "bullet", items: [{ text: "EKAS" }] }),
      block("monoBlock", { type: "monoBlock", label: { text: "Kode" }, lines: [{ text: "EKAS" }] }),
      block("diagram", { type: "diagram", caption: { inline: { text: "Arsitektur" } }, spec: { title: "EKAS", nodes: [{ label: "EKAS" }] } }),
    ])
    expect(run(s).map((i) => i.status)).toEqual(["PASS"])
  })
})

describe("never throws, never blocks", () => {
  test("odd shapes give PASS", () => {
    const odd = [
      snapshot([]),
      snapshot([block("paragraph", null), block("chapter", { title: 7 }), block("chart", { caption: "EKAS teks lepas" })]),
      { ...snapshot([]), blocks: undefined } as unknown as NormDocSnapshot,
      { ...snapshot([]), doc: undefined } as unknown as NormDocSnapshot,
    ]
    for (const s of odd) {
      const out = internalAbbreviation(buildContext({ prose: [], narrative: [], lists: [] }, {}, "ID", s))
      expect(out.every((i) => i.status === "PASS" || i.status === "REPORT")).toBe(true)
    }
  })

  test("a context without the snapshot is NOT_RUN with a reason, not PASS", () => {
    const out = internalAbbreviation(buildContext({ prose: [], narrative: [], lists: [] }, {}, "ID"))
    expect(out.map((i) => i.status)).toEqual(["NOT_RUN"])
  })

  test("a caption given as a plain string is read", () => {
    const places = textPlacesOf(snapshot([block("chart", { caption: "Grafik EKAS" }, "4.1")]))
    expect(places.map((p) => p.place)).toEqual(["keterangan"])
  })

  test("scanner is registered under C-37; through lintLanguage it never yields FAIL", () => {
    expect(LANGUAGE_SCANNERS[INTERNAL_ABBREVIATION_ID]).toBe(internalAbbreviation)
    const s = snapshot([block("paragraph", { type: "paragraph", text: "Menurut EKAS, nilainya 5 ohm." })])
    const c37 = lintLanguage(s, {}).filter((i) => i.checkId === "C-37")
    const def = LINT_REGISTRY.find((d) => d.id === "C-37")!
    expect(def.module).toBe("language")
    if (isLintImplemented(def)) {
      // registry staged marker removed (request to the registry owner): the rule runs
      expect(c37.map((i) => i.status)).toEqual(["REPORT"])
    } else {
      // staged: NOT_RUN with the registry reason, never PASS
      expect(c37.map((i) => i.status)).toEqual(["NOT_RUN"])
    }
    expect(c37.some((i) => i.status === "FAIL")).toBe(false)
  })
})
