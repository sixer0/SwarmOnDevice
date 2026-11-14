// Swarm 1.2.8 row 36 (AC-HW13, H-W13, register N8-384; ledger class PROBE). The 1.2.7 audit measured the upload
// (idempotent across sessions, EXIF warning) but did not check the byte chain into `word/media/` (handoff 2026-11-13
// §1, row W-13). This probe follows an uploaded synthetic PNG from the asset store to the DOCX part:
//   upload file steps of storeAssetRow (writeAssetFile at the content-addressed shard path + linkAssetCopy, under a
//   mkdtemp STUDIO_WORKSPACE_ROOT) -> a v2 image block `asset: "sha256:<hex>"` -> renderSnapshot (DOCX, the service
//   orchestrator; preloadAssetBytes reads the stored file through the same assetLookup shape the render services
//   pass) -> unzipped DOCX.
// Red condition (01_specs.md AC-HW13): the `word/media/fig-<sha 32>.png` bytes differ from the asset, or the name
// prefix is not the first 32 hex of the asset sha256 (V/engine/docx/figures/media.ts:5,115). The DB row and the MCP
// tool layer are out of this probe (covered through the real host by 1.2.6 row 51, row51-asset-reference.test.ts).
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { strFromU8, unzipSync } from "fflate"
import { useStudioEnv } from "../ported/_env"

useStudioEnv()
const K = await import("../engine-rev-a/row143a/_kit")
const R = await import("../ported/renderers/_kit")
const { decodeImageDetailed } = await import("../../vendor/src/lib/studio/services/images/decode")
const { assetRelPath, assetShardRelPath, linkAssetCopy, writeAssetFile } = await import("../../vendor/src/lib/studio/services/images/store")
const { renderSnapshot } = await import("../../vendor/src/lib/studio/services/render/pure/render")

type Rec = Record<string, any>
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

// Synthetic raster: 320 x 180 white PNG with a diagonal line (renderers kit), never a real picture.
const PNG = R.makePng(320, 180, 5)
const SHA = sha(PNG)

async function upload(): Promise<string> {
  const img = decodeImageDetailed({ bytes: PNG })
  expect(img.sha256).toBe(SHA)
  const relPath = assetShardRelPath(img.sha256, img.mime)
  await writeAssetFile(relPath, img.bytes, img.sha256, {})
  await linkAssetCopy(relPath, assetRelPath(img.sha256, img.mime), img.bytes, img.sha256, {})
  return relPath
}

function docWithImage(): Rec {
  const doc = clone(K.loadCase("case01.json"))
  const blocks = doc.sections.content.chapters[0].sections[0].blocks as Rec[]
  blocks.splice(1, 0, { type: "image", asset: `sha256:${SHA}`, caption: { text: "Gambar uji aset sintetis" }, source: { text: "Data sintetis uji." } })
  return doc
}

let docx: Record<string, Uint8Array> | null = null
let lookups: string[] = []
async function rendered(): Promise<Record<string, Uint8Array>> {
  if (docx) return docx
  const relPath = await upload()
  lookups = []
  const r = await renderSnapshot(K.compose(docWithImage()) as never, await K.template(), {
    formats: ["DOCX"],
    measureLayout: false,
    naming: { title: "Laporan Uji Aset", docNumber: "002/UJI/NT/XI/2026", rev: "A", revisionNo: 1 },
    assetLookup: async (s: string) => {
      lookups.push(s)
      return s === SHA ? { relPath, mime: "image/png" } : null
    },
  })
  // No browser in a unit run: BROWSER_UNAVAILABLE (chart/diagram figures of case01) is the only error allowed; the
  // DOCX itself must not fail.
  console.log(`HW13 render errors: ${JSON.stringify(r.errors.map((e) => [e.code, String(e.message).slice(0, 120)]))}`)
  expect(r.failed).toEqual([])
  expect(r.errors.filter((e) => e.code !== "BROWSER_UNAVAILABLE")).toEqual([])
  const f = r.files.find((x) => x.format === "DOCX")
  expect(f).toBeDefined()
  docx = unzipSync(typeof f!.data === "string" ? new TextEncoder().encode(f!.data) : f!.data)
  return docx
}

describe("rel128 probe H-W13: uploaded PNG bytes reach word/media unchanged, named by their sha256", () => {
  test("the render reads the stored asset by its sha256 (assetLookup called)", async () => {
    await rendered()
    expect(lookups).toContain(SHA)
  }, 120_000)

  test("word/media holds fig-<first 32 hex of sha256>.png", async () => {
    const zip = await rendered()
    const media = Object.keys(zip).filter((p) => p.startsWith("word/media/fig-"))
    expect(media).toContain(`word/media/fig-${SHA.slice(0, 32)}.png`)
  }, 120_000)

  test("the media part is byte-identical to the uploaded asset", async () => {
    const zip = await rendered()
    const part = zip[`word/media/fig-${SHA.slice(0, 32)}.png`]
    expect(part.byteLength).toBe(PNG.byteLength)
    expect(sha(part)).toBe(SHA)
    expect(Buffer.from(part).equals(Buffer.from(PNG))).toBe(true)
  }, 120_000)

  test("the document relationship points at that part", async () => {
    const zip = await rendered()
    const rels = strFromU8(zip["word/_rels/document.xml.rels"])
    expect(rels).toContain(`Target="media/fig-${SHA.slice(0, 32)}.png"`)
    expect(rels).toContain(`Id="rIdFig${SHA.slice(0, 32)}"`)
  }, 120_000)
})
