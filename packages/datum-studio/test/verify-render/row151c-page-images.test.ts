// Row 151c: page-image retention (C161 L5) and the never-silent page note (controller DEFECT-157-1).
// - pruneVerifyImages keeps the newest VERIFY_IMAGES_KEEP (20) folders under <store>/verify/ plus the current one,
//   like row 70a's kept previews, and never follows or removes a link or a non-id name.
// - pageImagesNote names every listed page without an image and why, plus the bridge's approximation note; the
//   studio_render text gets one "pages note" line.
import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pageImagesNote, pruneVerifyImages, VERIFY_IMAGES_KEEP } from "../../src/mcp-host/verify/verify-outputs"
import { verificationLines } from "../../src/mcp-host/verify/render-wrapper"
import type { OutputVerificationReport } from "../../src/mcp-host/verify/types"

describe("row 151c L5: page images are pruned like row 70a's previews", () => {
  it("keeps the newest 20 folders (current included), removes older ones; links and odd names are untouched", () => {
    expect(VERIFY_IMAGES_KEEP).toBe(20)
    const v = mkdtempSync(join(tmpdir(), "row151c-verify-"))
    const outside = mkdtempSync(join(tmpdir(), "row151c-outside-"))
    writeFileSync(join(outside, "keep.png"), "x")
    const t0 = Date.now() / 1000 - 10_000
    for (let i = 0; i < 25; i++) {
      const d = join(v, `out${String(i).padStart(3, "0")}`)
      mkdirSync(d)
      writeFileSync(join(d, "witness-p001.png"), "png")
      utimesSync(d, t0 + i, t0 + i)
    }
    symlinkSync(outside, join(v, "linked"))
    mkdirSync(join(v, "odd name"))
    // current = the OLDEST folder: it stays although it is the oldest.
    const removed = pruneVerifyImages(v, "out000")
    const left = readdirSync(v).sort()
    expect(removed).toBe(5)
    expect(left.filter((n) => n.startsWith("out"))).toEqual(["out000", ...Array.from({ length: 19 }, (_, i) => `out${String(i + 6).padStart(3, "0")}`)])
    expect(left).toContain("linked")
    expect(left).toContain("odd name")
    expect(existsSync(join(outside, "keep.png"))).toBe(true)
  })

  it("a missing verify folder is not an error", () => {
    expect(pruneVerifyImages(join(tmpdir(), "row151c-none-" + Date.now()), "x")).toBe(0)
  })
})

describe("row 151c (DEFECT-157-1): a page without an image is never silent", () => {
  it("names pages past the 12-image cap, pages the image layout does not have, and the bridge's approximation", () => {
    expect(pageImagesNote([1, 2, 3], new Set([1, 2, 3]), [1, 2, 3], { pageCount: 3 }, 3)).toBeNull()
    expect(pageImagesNote([1, 2, 3, 4, 5, 6, 7], new Set([1, 2, 3, 4, 5, 6]), [1, 2, 3, 4, 5, 6, 7], { pageCount: 6 }, 7)).toBe("pages 7 not imaged (the image layout has 6 pages, the print has 7)")
    expect(pageImagesNote(Array.from({ length: 14 }, (_, i) => i + 1), new Set(Array.from({ length: 12 }, (_, i) => i + 1)), Array.from({ length: 12 }, (_, i) => i + 1), { pageCount: 14 }, 14)).toBe("pages 13,14 not imaged (at most 12 images per render)")
    expect(pageImagesNote([1, 2], new Set([1, 2]), [1, 2], { pageCount: 2, approximate: "pages cut by the bridge's line-break estimate, not by the printer" }, 2)).toBe("images approximate: pages cut by the bridge's line-break estimate, not by the printer")
  })

  it("studio_render text: one 'pages note' line next to the images", () => {
    const report = {
      overall: "verified",
      scope: "DOCUMENT",
      layoutWitness: true,
      outputs: [{ outputId: "o1", format: "HTML", state: "verified", checks: [], pages: [{ n: 1, png: "/s/verify/o1/witness-p001.png", findings: 0 }, { n: 2, png: null, findings: 0 }] }],
    } as unknown as OutputVerificationReport
    const lines = verificationLines(report, { made: 1, reason: null, note: "pages 2 not imaged (the image layout has 1 pages, the print has 2)" })
    expect(lines).toContain("  pages note: pages 2 not imaged (the image layout has 1 pages, the print has 2)")
    expect(verificationLines(report, { made: 1, reason: null }).some((l) => l.includes("pages note"))).toBe(false)
    // The images line and the witness line are the only page lines when there is no note (no "none imaged" next to real images).
    expect(verificationLines(report, { made: 1, reason: null }).filter((l) => l.startsWith("  pages"))).toEqual(["  pages: /s/verify/o1/witness-p001.png", "  pages are witness images (approximation of the printed page; not a deliverable)"]) // 1.2.7 row 35 (N-5, N7-140)
    // The bridge's approximation text (with an apostrophe) is printed.
    expect(verificationLines(report, { made: 1, reason: null, note: "images approximate: pages cut by the bridge's line-break estimate, not by the printer" })).toContain("  pages note: images approximate: pages cut by the bridge's line-break estimate, not by the printer")
  })
})

describe("row 151c (DEFECT-157-1): the bridge's approximation note reaches the host", async () => {
  const rt = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  const HELLO = { ok: true, electron: "42.3.3", chrome: "x", sandbox: true, contextIsolation: true, nodeIntegration: false, network: "blocked" }
  const reply = (extra: Record<string, unknown>) => async (req: { op: string }) =>
    (req.op === "hello" ? HELLO : { ok: true, layout: "flow", media: "print", pageCount: 1, pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages: [{ n: 1, dst: "/s/verify/o1/witness-p001.png", width: 1239, height: 1753, bytes: 1, sha256: "a".repeat(64) }], ...extra }) as never
  it("rasterizeHtmlPages carries `approximate` when the bridge sends it, and leaves it out otherwise", async () => {
    try {
      rt.setRenderBridgeTransport(reply({ approximate: "pages cut by the bridge's line-break estimate, not by the printer" }))
      expect((await rt.rasterizeHtmlPages({ src: "/s/d.html", dstDir: "/s/verify/o1" })).approximate).toBe("pages cut by the bridge's line-break estimate, not by the printer")
      rt.setRenderBridgeTransport(reply({ approximate: null }))
      expect("approximate" in (await rt.rasterizeHtmlPages({ src: "/s/d.html", dstDir: "/s/verify/o1" }))).toBe(false)
    } finally {
      rt.setRenderBridgeTransport(null)
    }
  })
})
