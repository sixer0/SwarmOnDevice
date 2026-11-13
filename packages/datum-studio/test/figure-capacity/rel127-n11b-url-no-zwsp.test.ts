// Swarm 1.2.7 row 40b (AC-N11, decision C39): row 40's ID-list break rule must not touch URLs. A token that contains
// "://", starts with "www." or is a mailto: address (leading brackets/quotes ignored) is one unbreakable segment, for
// the DT-10a estimate and both renderers alike: DOCX gets no U+200B inside it (copying the URL out of Word would carry
// the hidden characters and break the link) and HTML gets no <wbr> inside it (one shared rule, so the estimate never
// counts a break a renderer does not make). Long ID lists in the same paragraph still break. Synthetic inputs only;
// rendered in process through the row 143a kit (case01 table replaced), no browser, no store.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"

// Own env scope: the row 143a kit sets the Studio env once per process (cached module) and restores it after the first
// file that imported it, so a second kit user in the same run must not rely on that side effect.
useStudioEnv()
const K = await import("../engine-rev-a/row143a/_kit")
const fit = await import("../../vendor/src/lib/studio/engine/table-fit")
const writeClient = await import("../../vendor/scripts/studio/mcp/write-client")

type Rec = Record<string, any>
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const block = (rows: string[][]): Rec =>
  writeClient.tableBlock(rows, "Tabel tautan sintetis", "Sumber sintetis uji.", null, () => {}, "uji", "Bab uji", () => {}) as Rec

function docWith(columns: unknown, rows: unknown): Rec {
  const doc = clone(K.loadCase("case01.json"))
  const [{ block: tbl }] = K.blocksOfType(doc, "table").filter((x) => JSON.stringify(x.block).includes("Jumlah titik sensor"))
  tbl.columns = columns
  tbl.rows = rows
  return doc
}
async function render(columns: unknown, rows: unknown): Promise<{ html: string; xml: string }> {
  const snap = K.compose(docWith(columns, rows))
  return { html: await K.renderHtml(snap), xml: K.docXml(await K.renderDocx(snap)) }
}
const count = (s: string, needle: string): number => s.split(needle).length - 1
const ZW = "​"

const URLS = [
  "https://example.org/a/b/c/d/e",
  "www.example.org/doc/one/two",
  "mailto:ops@example.org,audit@example.org",
  "(https://example.net/x/y/z)",
]
const IDS = "R-01/R-02/R-03/R-04/R-05"

describe("rel127 N-11b: URLs are never broken by the ID-list rule", () => {
  test("breakableSegments keeps every URL form whole; ID lists still split", () => {
    for (const u of URLS) expect(fit.breakableSegments(u)).toEqual([u])
    expect(fit.breakableSegments("HTTPS://EXAMPLE.ORG/A/B/C/D")).toEqual(["HTTPS://EXAMPLE.ORG/A/B/C/D"])
    expect(fit.breakableSegments(IDS)).toEqual(["R-01/", "R-02/", "R-03/", "R-04/", "R-05"])
  })

  test("tableBreakRuns: a URL paragraph gets no mark; a URL beside an ID list marks only the list", () => {
    expect(fit.tableBreakRuns([{ t: URLS[0] }], ZW)).toBeNull()
    const out = fit.tableBreakRuns([{ t: `${URLS[0]} ${IDS}` }], ZW) as { t: string }[]
    expect(out[0].t).toBe(`${URLS[0]} R-01/${ZW}R-02/${ZW}R-03/${ZW}R-04/${ZW}R-05`)
  })

  test("DOCX document.xml carries each URL contiguous with no U+200B; HTML has no <wbr> inside a URL", async () => {
    const b = block([["Tautan", "Keterangan"], ...URLS.map((u) => [u, "uji"]), [`${URLS[0]} ${IDS}`, "campuran"]])
    const { html, xml } = await render(b.columns, b.rows)
    for (const u of URLS) {
      // A bracketed URL is rendered as its own (link-styled) run; look for the URL itself.
      const esc = u.replace(/^\(|\)$/g, "").replace(/&/g, "&amp;")
      expect({ u, inXml: xml.includes(esc) }).toEqual({ u, inXml: true })
      expect({ u, inHtml: html.includes(esc) }).toEqual({ u, inHtml: true })
    }
    // Only the ID list breaks: 4 separators, nothing else.
    expect(count(xml, ZW)).toBe(4)
    expect(count(xml, ZW)).toBe(count(xml, `/${ZW}`))
    expect(count(html, "<wbr>")).toBe(4)
  }, 60_000)
})
