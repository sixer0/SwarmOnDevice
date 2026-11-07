// Row 165D (F113-12, CP-13/15; decision C188): a NOTA written through the MCP write path prints NO second
// "Klasifikasi : TERBATAS" line in the foot (below the register). The classification line belongs under the number
// in the cover control block (F56-1, row 165A); the NOTA has no cover, and its classification stays in the running
// head (right) and the register's right cell (DT-28c, manual_id.txt p.14).
// The engine change is row 165A's (html/base/shell.ts, docx/package/header-footer.ts; file request by 165D); this test
// is the proof: it FAILS before that edit and must PASS after it.
// Needs the command sandbox off (127.0.0.1 port + Unix socket). No network, no model.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { strFromU8, unzipSync } from "fflate"
import { renderNota, startRig, storePath, type Rig } from "./_host.ts"

let rig: Rig

beforeAll(async () => {
  rig = await startRig("foot-classification")
}, 120_000)

afterAll(async () => {
  await rig?.stop()
})

const text = (xml: string) => xml.replace(/<[^>]+>/g, "")

test("row 165D (F113-12): NOTA foot has the register only, no Klasifikasi line; head and register keep TERBATAS", async () => {
  const { outputs } = await renderNota(rig.h, { mission: "2026-11-08_row165d-foot", docKey: "nota-foot", title: "Nota uji kaki row 165D", formats: ["docx", "html"] })
  const docx = outputs.find((o) => o.format === "DOCX")!
  const html = outputs.find((o) => o.format === "HTML")!
  const zip = unzipSync(new Uint8Array(readFileSync(storePath(rig, docx.id))))
  const footers = Object.keys(zip).filter((k) => /^word\/footer\d*\.xml$/.test(k)).map((k) => text(strFromU8(zip[k]!)))
  const headers = Object.keys(zip).filter((k) => /^word\/header\d*\.xml$/.test(k)).map((k) => text(strFromU8(zip[k]!)))
  const page = readFileSync(storePath(rig, html.id), "utf8")
  const evidence = {
    footers,
    headersHaveLevel: headers.some((h) => h.includes("TERBATAS")),
    htmlRegCls: (page.match(/class="reg-cls/g) ?? []).length,
    htmlPageKlasifikasi: (page.match(/\\A"\s*"Klasifikasi/g) ?? []).length,
  }
  console.log(`[row165d foot] ${JSON.stringify(evidence)}`)
  expect(footers.length).toBeGreaterThan(0)
  for (const f of footers) {
    expect(f).not.toContain("Klasifikasi")
    expect(f).toContain("TERBATAS") // the register's right cell keeps the level
  }
  expect(evidence.headersHaveLevel).toBe(true)
  expect(evidence.htmlRegCls).toBe(0)
  expect(evidence.htmlPageKlasifikasi).toBe(0)
}, 240_000)
