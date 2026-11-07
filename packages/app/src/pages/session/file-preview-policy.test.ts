// Row 112 (studio spec §8.2): unit tests of the file-tab preview rules. The P-number on each test is the §8.2
// acceptance check it covers; the Electron-level proofs are in packages/desktop/test/file-preview-electron.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  buildHtmlPreviewDocument,
  companionCandidates,
  countPdfPages,
  createPdfObjectUrl,
  htmlTextFromContent,
  isPreviewPathAllowed,
  fileNameOf,
  isStudioOutputName,
  isStudioOutputPath,
  pdfBytesFromContent,
  PREVIEW_HTML_CSP,
  PREVIEW_HTML_SANDBOX,
  STUDIO_DATUM_NAME_PATTERN,
  STUDIO_FINAL_NAME_PATTERN,
  previewKindFromPath,
  stripCssUrls,
} from "./file-preview-policy"

/** A minimal, valid multi-page PDF (one /Pages root with /Count n, n /Page objects). */
function syntheticPdf(pages: number) {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>"),
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

// happy-dom (unlike Chromium, where a DOMParser document has no browsing context) starts loading <link> stylesheets,
// <script src> and <iframe> pages of a parsed document. Keep the test DOM from loading anything so the run stays
// offline; <iframe> removal is proven in Chromium by packages/desktop/test/file-preview-electron.
const happy = (globalThis as { happyDOM?: { settings: { disableIframePageLoading: boolean; navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM
if (happy) {
  happy.settings.disableIframePageLoading = true
  happy.settings.navigation.disableChildFrameNavigation = true
  Object.assign(happy.settings, {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  })
}

describe("file-tab preview kinds (P3: everything else keeps the existing view)", () => {
  test("pdf, html, docx and the office formats get a preview kind", () => {
    expect(previewKindFromPath("out/GSP-Laporan_rev3.pdf")).toBe("pdf")
    expect(previewKindFromPath("out/a.HTML")).toBe("html")
    expect(previewKindFromPath("out/a.htm")).toBe("html")
    expect(previewKindFromPath("out/a.docx")).toBe("docx")
    expect(previewKindFromPath("out/a.xlsx")).toBe("office")
    expect(previewKindFromPath("out/a.pptx")).toBe("office")
  })

  test("png, svg, source files and extensionless names keep the existing media/text view", () => {
    for (const path of ["a.png", "a.svg", "a.jpg", "a.mp3", "a.ts", "README", ".pdf", "dir.pdf/file", undefined])
      expect({ path, kind: previewKindFromPath(path) }).toEqual({ path, kind: undefined })
  })
})

describe("allowed roots (the tab path stays inside the session root)", () => {
  test("relative paths inside the session root are allowed", () => {
    for (const path of ["a.pdf", "out/studio/GSP-Laporan_rev3.pdf", "deep/./x.html"])
      expect({ path, ok: isPreviewPathAllowed(path) }).toEqual({ path, ok: true })
  })

  test("absolute, climbing, home, scheme, backslash and NUL paths are refused", () => {
    for (const path of [
      "/etc/hosts.pdf",
      "/Users/someone/Documents/a.pdf",
      "../outside.pdf",
      "out/../../outside.pdf",
      "..",
      "~/a.pdf",
      "file:///etc/a.pdf",
      "https://example.invalid/a.pdf",
      "C:\\a.pdf",
      "out\\..\\..\\a.pdf",
      "a\0.pdf",
      "",
      undefined,
    ])
      expect({ path, ok: isPreviewPathAllowed(path) }).toEqual({ path, ok: false })
  })
})

describe("P4: DOCX companion lookup order", () => {
  test("same stem, .pdf preferred, then .html", () => {
    expect(companionCandidates("out/GSP-Laporan_rev3.docx")).toEqual([
      "out/GSP-Laporan_rev3.pdf",
      "out/GSP-Laporan_rev3.html",
    ])
  })
  test("non-docx files have no companion", () => {
    expect(companionCandidates("out/a.pdf")).toEqual([])
  })
})

describe("P1: PDF bytes and page count", () => {
  test("a base64 binary %PDF- content is a PDF; text, other binaries and empty content are not", () => {
    const pdf = syntheticPdf(3)
    expect(pdfBytesFromContent({ type: "binary", encoding: "base64", content: base64(pdf) })).toEqual(pdf)
    expect(pdfBytesFromContent({ type: "text", content: "%PDF-1.4" })).toBeUndefined()
    expect(pdfBytesFromContent({ type: "binary", encoding: "base64", content: base64(new Uint8Array([1, 2, 3, 4, 5])) })).toBeUndefined()
    expect(pdfBytesFromContent({ type: "binary", encoding: "base64", content: "" })).toBeUndefined()
    expect(pdfBytesFromContent({ type: "binary", encoding: "base64", content: "!!not-base64!!" })).toBeUndefined()
    expect(pdfBytesFromContent(undefined)).toBeUndefined()
  })

  test("the page count follows Studio's countPdfPages rule (/Pages /Count first, else /Type /Page objects)", () => {
    expect(countPdfPages(syntheticPdf(1))).toBe(1)
    expect(countPdfPages(syntheticPdf(3))).toBe(3)
    expect(countPdfPages(syntheticPdf(12))).toBe(12)
    const noCount = new TextEncoder().encode("%PDF-1.4\n<< /Type /Page >> << /Type /Page >> << /Type /Pages /Kids [] >>")
    expect(countPdfPages(noCount)).toBe(2)
  })

  test("HTML text comes from a text content only", () => {
    expect(htmlTextFromContent({ type: "text", content: "<p>x</p>" })).toBe("<p>x</p>")
    expect(htmlTextFromContent({ type: "text", content: "   " })).toBeUndefined()
    expect(htmlTextFromContent({ type: "binary", content: "PHA+" })).toBeUndefined()
  })
})

describe("P7: the blob URL is revoked", () => {
  test("revoke calls revokeObjectURL once with the created URL", () => {
    const created: Blob[] = []
    const revoked: string[] = []
    const api = {
      createObjectURL: (blob: Blob) => {
        created.push(blob)
        return "blob:oc://renderer/1"
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    }
    const handle = createPdfObjectUrl(syntheticPdf(2), api)
    expect(handle.url).toBe("blob:oc://renderer/1")
    expect(created[0]?.type).toBe("application/pdf")
    handle.revoke()
    handle.revoke()
    expect(revoked).toEqual(["blob:oc://renderer/1"])
  })
})

describe("P2, P6: the HTML srcdoc", () => {
  const hostile = `<!DOCTYPE html><html><head><title>doc</title>
<meta http-equiv="refresh" content="0;url=https://example.invalid/r">
<base href="https://example.invalid/">
<link rel="stylesheet" href="https://example.invalid/s.css"><link rel="dns-prefetch" href="//example.invalid">
<style>@import url("https://example.invalid/i.css"); body{background:url(https://example.invalid/b.png)} .f{src:url(data:font/woff2;base64,AAAA)}</style>
<script>document.title='x'</script>
</head><body onload="document.title='y'">
<p id="top" style="background-image:url('http://127.0.0.1:9/p.png')">Hello</p>
<a id="ext" href="https://example.invalid/page">external</a>
<a id="js" href="javascript:alert(1)">js</a>
<a id="anchor" href="#top">anchor</a>
<img id="remote" src="http://127.0.0.1:9/x.png"><img id="inline" src="data:image/png;base64,iVBORw0KGgo=">
<object data="https://example.invalid/o"></object><embed src="https://example.invalid/e">
<form action="https://example.invalid/post"><input id="in" formaction="https://example.invalid/x"></form>
<svg><a href="https://example.invalid/svg"><text>s</text></a><image href="https://example.invalid/i.png"></image><use href="#top"></use></svg>
<script src="https://example.invalid/x.js"></script>
</body></html>`
  const out = buildHtmlPreviewDocument(hostile)
  const doc = new DOMParser().parseFromString(out, "text/html")

  test("the sandbox token list is empty: no allow-scripts, no allow-same-origin", () => {
    expect(PREVIEW_HTML_SANDBOX).toBe("")
  })

  test("the §8.2 CSP is the first element of <head>, verbatim", () => {
    expect(PREVIEW_HTML_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:")
    const first = doc.head.firstElementChild
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy")
    expect(first?.getAttribute("content")).toBe(PREVIEW_HTML_CSP)
    expect(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length).toBe(1)
  })

  test("scripts, handlers, frames, embeds, links, base and meta refresh are gone", () => {
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/\son[a-z]+=/i)
    expect(out).not.toMatch(/javascript:/i)
    for (const selector of ["script", "iframe", "object", "embed", "link", "base", "meta[http-equiv]:not([http-equiv=\"Content-Security-Policy\"])"])
      expect({ selector, n: doc.querySelectorAll(selector).length }).toEqual({ selector, n: 0 })
  })

  test("no URL that could navigate or fetch survives; #anchors and data: images do", () => {
    expect(out).not.toContain("example.invalid")
    expect(out).not.toContain("127.0.0.1")
    expect(doc.getElementById("ext")?.hasAttribute("href")).toBe(false)
    expect(doc.getElementById("ext")?.textContent).toBe("external")
    expect(doc.getElementById("js")?.hasAttribute("href")).toBe(false)
    expect(doc.getElementById("anchor")?.getAttribute("href")).toBe("#top")
    expect(doc.getElementById("remote")?.hasAttribute("src")).toBe(false)
    expect(doc.getElementById("inline")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=")
    expect(doc.getElementById("in")?.hasAttribute("formaction")).toBe(false)
    expect(doc.querySelector("form")?.hasAttribute("action")).toBe(false)
    expect(doc.querySelector("use")?.getAttribute("href")).toBe("#top")
    expect(out).toContain("data:font/woff2;base64,AAAA")
    expect(out).toContain("Hello")
  })

  test("CSS url() other than data: and @import are cut", () => {
    expect(stripCssUrls("a{background:url(https://x.invalid/b.png) no-repeat}")).toBe("a{background:none no-repeat}")
    expect(stripCssUrls("@import 'https://x.invalid/a.css'; b{}")).toBe(" b{}")
    expect(stripCssUrls("f{src:url('data:font/woff2;base64,AA')}")).toBe("f{src:url('data:font/woff2;base64,AA')}")
  })

  test("a Studio-shaped document (own CSP meta, inline styles, data: fonts) keeps its content and gets one CSP", () => {
    const studio = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'"><style data-studio="structural">.st-p{margin:0}@font-face{font-family:X;src:url(data:font/woff2;base64,AAAA)}</style></head><body><p class="st-p">Laporan Kerja</p></body></html>`
    const result = new DOMParser().parseFromString(buildHtmlPreviewDocument(studio), "text/html")
    expect(result.documentElement.getAttribute("lang")).toBe("id")
    expect(result.querySelector(".st-p")?.textContent).toBe("Laporan Kerja")
    expect(result.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length).toBe(1)
    expect(result.querySelector("style")?.textContent).toContain("url(data:font/woff2;base64,AAAA)")
  })
})

// Row 112b (decision C101): only a Studio output .html opens rendered by default. The rule is the file name (C51).
describe("row 112b: Studio output recognition (C51 file name)", () => {
  test("Studio final names and template preview names match, in any folder", () => {
    for (const path of [
      "docs/misi-a/studio/GSP-LAP-001/rev-3/GSP-LAP-001_rev3_20261107T101500Z_0a1b2c3d.html",
      "GSP-Pratinjau-Templat_rev0_20261107T101500Z_deadbeef.html",
      "out/ART-c0123456789abcdefghijklmn_rev0_20261107T101500Z_12345678.pdf",
      "GSP-LAP-001_rev12_20261107T101500Z_0a1b2c3d.docx",
    ])
      expect({ path, studio: isStudioOutputPath(path) }).toEqual({ path, studio: true })
  })

  test("ordinary project files and near-misses do not match", () => {
    for (const path of [
      "index.html",
      "public/report.html",
      "out/GSP-Laporan_rev3.html",
      "docs/misi-a/studio/notes.html",
      "GSP-LAP-001_rev3_20261107T101500Z_0A1B2C3D.html",
      "GSP-LAP-001_rev3_20261107T101500Z_0a1b2c3.html",
      "GSP-LAP-001_rev03_20261107T101500Z_0a1b2c3d.html",
      "GSP-LAP-001_rev3_20261107T101500_0a1b2c3d.html",
      "GSP-LAP-001_rev3_20261107T101500Z_0a1b2c3d.htm",
      "-bad_rev3_20261107T101500Z_0a1b2c3d.html",
      undefined,
    ])
      expect({ path, studio: isStudioOutputPath(path) }).toEqual({ path, studio: false })
  })

  test("the pattern is a verbatim copy of Studio's FINAL_FILENAME_PATTERN (C51)", () => {
    const env = readFileSync(
      new URL("../../../../datum-studio/vendor/src/lib/studio/contract/env.ts", import.meta.url).pathname,
      "utf8",
    )
    const vendored = /export const FINAL_FILENAME_PATTERN =\s*"((?:[^"\\]|\\.)*)"/.exec(env)?.[1]
    expect(vendored).toBeDefined()
    expect(JSON.parse(`"${vendored}"`)).toBe(STUDIO_FINAL_NAME_PATTERN)
  })
})

// Row 165D (F56-2, CP-17): Studio delivers outputs under the DATUM title name; the file tab recognises it, and the
// path policy stays one safe segment (no traversal, no separators, no underscore, allowed extensions only).
describe("row 165D: delivered DATUM title names are Studio outputs", () => {
  // Row 165E (C192): a DATUM name is a Studio output only when the path is a registered deliverable.
  const DATUM_PATHS = [
    "docs/misi-a/Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.docx",
    "docs/misi-a/Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.html",
    "Lembar Bukti Pemantauan Iklim Ruang Simpan Gedung B 013-GSP-KT-XI-2026 RevA.pdf",
    "docs/misi-a/Nota uji gerbang verifikasi row 143c 2026-11-08.html",
    "Gambar 4.1 Arsitektur sistem pemantauan iklim ruang simpan arsip.svg",
    "Fiksur Konvensi Angka B-FIX 015-GSP-KT-XI-2026 RevA 1a2b3c4d.pdf",
  ]
  test("DATUM names (number + Rev, ISO date, figure, collision suffix) match when the path is registered", () => {
    const registered = new Set(DATUM_PATHS)
    for (const path of DATUM_PATHS)
      expect({ path, studio: isStudioOutputPath(path, registered) }).toEqual({ path, studio: true })
    for (const path of DATUM_PATHS) expect(isStudioOutputName(fileNameOf(path))).toBe(true)
  })

  test("unsafe or non-DATUM names do not match", () => {
    for (const path of [
      "docs/misi-a/Laporan_akhir 012-GSP-KT-XI-2026 RevA.html",
      "docs/misi-a/.hidden 012-GSP-KT-XI-2026 RevA.html",
      "docs/misi-a/ spasi 012-GSP-KT-XI-2026 RevA.html",
      "docs/misi-a/Laporan 012-GSP-KT-XI-2026 RevA.exe",
      "docs/misi-a/Laporan 012-GSP-KT-XI-2026.html",
      "docs/misi-a/Laporan‮ 012-GSP-KT-XI-2026 RevA.html",
      "docs/misi-a/report.html",
      "index.html",
    ])
      expect({ path, studio: isStudioOutputPath(path) }).toEqual({ path, studio: false })
  })

  test("the DATUM pattern is a verbatim copy of Studio's DATUM_FILENAME_PATTERN", () => {
    const env = readFileSync(
      new URL("../../../../datum-studio/vendor/src/lib/studio/contract/env.ts", import.meta.url).pathname,
      "utf8",
    )
    const vendored = /export const DATUM_FILENAME_PATTERN =\s*"((?:[^"\\]|\\.)*)"/.exec(env)?.[1]
    expect(vendored).toBeDefined()
    expect(JSON.parse(`"${vendored}"`)).toBe(STUDIO_DATUM_NAME_PATTERN)
  })

  // Row 165I (C196, verification/24 L2): the same control/bidi/zero-width/separator set as Studio is refused.
  test("names with control, bidi, zero-width or separator characters are not Studio outputs", () => {
    expect(isStudioOutputName("Gambar 4.1 x‮gvs.png")).toBe(false)
    expect(isStudioOutputName("Gambar 4.1 xgvs.png")).toBe(true)
    for (const cp of [0x0000, 0x001f, 0x007f, 0x0080, 0x0085, 0x009f, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
      const c = String.fromCharCode(cp)
      for (const name of [`Gambar 4.1 Alur${c}gnp.exe.png`, `Laporan${c} 012-GSP-KT-XI-2026 RevA.html`, `Lembar ${c}bukti 2026-11-02.pdf`])
        expect({ cp, name, studio: isStudioOutputName(name) }).toEqual({ cp, name, studio: false })
    }
  })
})

// Row 165E (decision C192, security narrowing): the file tab renders a title-named .html only when it is a registered
// Studio output (a deliverable of the session's mission found in the project), never by the name pattern alone.
describe("row 165E: a DATUM-named file is a Studio output only when registered", () => {
  test("an ordinary user .html named like a DATUM output stays code view (not a Studio output)", () => {
    for (const path of [
      "Laporan 2026-11-02.html",
      "docs/catatan/Laporan 2026-11-02.html",
      "docs/misi-a/Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.html",
      "Gambar 1 Denah kantor.svg",
    ]) {
      expect({ path, studio: isStudioOutputPath(path) }).toEqual({ path, studio: false })
      expect({ path, studio: isStudioOutputPath(path, new Set(["docs/misi-a/lain 2026-11-02.html"])) }).toEqual({
        path,
        studio: false,
      })
    }
  })

  test("registration is per exact path: the same name in another folder is not registered", () => {
    const registered = new Set(["docs/misi-a/Laporan 2026-11-02.html"])
    expect(isStudioOutputPath("docs/misi-a/Laporan 2026-11-02.html", registered)).toBe(true)
    expect(isStudioOutputPath("Laporan 2026-11-02.html", registered)).toBe(false)
    expect(isStudioOutputPath("docs/misi-b/Laporan 2026-11-02.html", registered)).toBe(false)
  })

  test("a registered path that is not a DATUM/Studio name never counts (registration cannot widen the rule)", () => {
    const registered = new Set(["index.html", "docs/misi-a/Laporan_akhir 2026-11-02.html"])
    expect(isStudioOutputPath("index.html", registered)).toBe(false)
    expect(isStudioOutputPath("docs/misi-a/Laporan_akhir 2026-11-02.html", registered)).toBe(false)
  })

  test("the C51 store name still decides by name alone, registered or not", () => {
    const path = "docs/misi-a/GSP-LAP-001_rev3_20261107T101500Z_0a1b2c3d.html"
    expect(isStudioOutputPath(path)).toBe(true)
    expect(isStudioOutputPath(path, new Set())).toBe(true)
  })

  test("the registry is keyed by directory and fed from the deliverables' project paths", async () => {
    const { registerStudioOutputs, registeredStudioOutputs, resetStudioOutputRegistry } = await import(
      "./studio-output-registry"
    )
    resetStudioOutputRegistry()
    const path = "docs/misi-a/Laporan 2026-11-02.html"
    expect(isStudioOutputPath(path, registeredStudioOutputs("/proj/a"))).toBe(false)
    registerStudioOutputs("/proj/a", [path, null, undefined, ""])
    expect(isStudioOutputPath(path, registeredStudioOutputs("/proj/a"))).toBe(true)
    expect(isStudioOutputPath(path, registeredStudioOutputs("/proj/b"))).toBe(false)
    expect(isStudioOutputPath(path, registeredStudioOutputs(undefined))).toBe(false)
    registerStudioOutputs(undefined, ["docs/x/Laporan 2026-11-02.html"])
    expect(registeredStudioOutputs("/proj/a").size).toBe(1)
    resetStudioOutputRegistry()
  })
})
