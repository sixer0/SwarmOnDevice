// Row 165D (decisions C188/C189), end to end through the MCP write path (studio_document_create -> import -> render ->
// studio_file_verify -> studio_mission_get deliverables), real store/host/bridge, fake PageEngine only:
// - F113-11 (CP-19): a NOTA (template datum-nota -> datum-gsp-rev-a-preset -> datum-gsp-preset, whose faces say
//   "IBM Plex Sans Cond") is written with the exact family "IBM Plex Sans Condensed" in the DOCX runs, the DOCX
//   fontTable and the HTML @font-face rules; the short name occurs nowhere as a family.
// - F56-2 (CP-17): studio_render lists, studio_file_verify saves and the deliverables read reports the DATUM title
//   name (`<Judul> <YYYY-MM-DD>.<ext>` for the NOTA date form, paths.ts datumDateFileName), zero underscores; the
//   C51 store name is still reported as finalFileName.
// Needs the command sandbox off (127.0.0.1 port + Unix socket). No network, no model.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { DATUM_FILENAME_PATTERN } from "../../vendor/src/lib/studio/contract/env"
import { renderNota, startRig, storePath, type Rig } from "./_host.ts"

type S = Record<string, any>
const M = "2026-11-08_row165d-nota"
const TITLE = "Nota uji jalur tulis row 165D"
const DATUM_NAME = new RegExp(DATUM_FILENAME_PATTERN)
let rig: Rig

beforeAll(async () => {
  rig = await startRig("write-path")
  const mission = await rig.h.call("studio_mission_create", {
    mission: {
      id: M,
      title: "Row 165D mission",
      type: "feature-release",
      owner: "master-controller",
      project: { dir: rig.project },
      rows: [{ id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "opus" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass", review: "gate" }],
      decisions: [{ id: "U1", by: "user", date: "2026-11-08", text: "go" }],
    },
  })
  if (mission.ok !== true) console.log(`[row165d] mission create: ${mission._text}`)
}, 120_000)

afterAll(async () => {
  await rig?.stop()
})

function familiesOf(xml: string): string[] {
  return [...xml.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"|<w:font w:name="([^"]+)"/g)].map((m) => m[1] ?? m[2]!)
}

test("row 165D: NOTA via the MCP write path - Condensed family everywhere, delivered under the DATUM title name", async () => {
  const { id, outputs } = await renderNota(rig.h, { mission: M, docKey: "row-1-nota", title: TITLE, formats: ["docx", "html"] })
  const docx = outputs.find((o) => o.format === "DOCX")!
  const html = outputs.find((o) => o.format === "HTML")!

  // F113-11: DOCX runs + fontTable, HTML @font-face
  const zip = unzipSync(new Uint8Array(readFileSync(storePath(rig, docx.id))))
  const documentXml = strFromU8(zip["word/document.xml"]!)
  const fontTable = strFromU8(zip["word/fontTable.xml"]!)
  const headerFooter = Object.keys(zip).filter((k) => /^word\/(header|footer)\d*\.xml$/.test(k)).map((k) => strFromU8(zip[k]!)).join("")
  const runFamilies = new Set([...familiesOf(documentXml), ...familiesOf(headerFooter)])
  const tableFamilies = new Set(familiesOf(fontTable))
  const htmlText = readFileSync(storePath(rig, html.id), "utf8")
  const faceFamilies = new Set([...htmlText.matchAll(/@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"]+)/g)].map((m) => m[1]!.trim()))
  const evidence = { runFamilies: [...runFamilies].sort(), tableFamilies: [...tableFamilies].sort(), faceFamilies: [...faceFamilies].sort() }
  console.log(`[row165d] fonts ${JSON.stringify(evidence)}`)
  expect(runFamilies.has("IBM Plex Sans Condensed")).toBe(true)
  expect(runFamilies.has("IBM Plex Sans Cond")).toBe(false)
  expect(tableFamilies.has("IBM Plex Sans Condensed")).toBe(true)
  expect(tableFamilies.has("IBM Plex Sans Cond")).toBe(false)
  expect(faceFamilies.has("IBM Plex Sans Condensed")).toBe(true)
  expect(faceFamilies.has("IBM Plex Sans Cond")).toBe(false)

  // F56-2: studio_render lists the DATUM name; the C51 name stays finalFileName
  const names = { docx: docx.fileName, html: html.fileName, finalDocx: docx.finalFileName }
  console.log(`[row165d] render names ${JSON.stringify(names)}`)
  for (const o of [docx, html]) {
    expect(typeof o.fileName).toBe("string")
    expect(DATUM_NAME.test(o.fileName)).toBe(true)
    expect(o.fileName.startsWith(`${TITLE} `)).toBe(true)
    expect(o.fileName).not.toContain("_")
    expect(o.finalFileName).toMatch(/_rev\d+_/)
  }

  // F56-2: studio_file_verify saves under the DATUM name inside the project
  const dl = path.join(rig.project, "docs", M)
  const v = await rig.h.call("studio_file_verify", { fileId: html.id, downloadDir: dl, expectedSha256: html.sha256 })
  console.log(`[row165d] file_verify ${JSON.stringify({ ok: v.ok, savedTo: v.savedTo, deliveredFileName: v.deliveredFileName, code: v.code ?? null })}`)
  expect(v.ok).toBe(true)
  expect(v.savedTo).toBe(path.join(dl, html.fileName))
  expect(existsSync(path.join(dl, html.fileName))).toBe(true)
  expect(existsSync(path.join(dl, html.finalFileName))).toBe(false)
  expect(path.basename(String(v.savedTo))).not.toContain("_")

  // F56-2: the deliverables read reports the DATUM name per output
  const g = await rig.h.call("studio_mission_get", { mission: M, include: ["deliverables"] })
  const d = ((g.deliverables ?? []) as S[]).find((x) => x.documentId === id)
  console.log(`[row165d] deliverables ${JSON.stringify(d?.outputs?.map((o: S) => ({ format: o.format, fileName: o.fileName, finalFileName: o.finalFileName })) ?? g._text)}`)
  expect(d).toBeDefined()
  expect((d!.outputs as S[]).map((o) => o.fileName).sort()).toEqual([docx.fileName, html.fileName].sort())
}, 240_000)
