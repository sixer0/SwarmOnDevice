// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2, decision U12): the preview inside the
// EXISTING file tab, rendered through the real gate (`FilePreviewGate`, the component file-tabs.tsx wraps around its
// tab content) with the app contexts it reads replaced. P-numbers name the §8.2 acceptance checks.
import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { createComponent, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { dict } from "@/i18n/en"
import { dict as id } from "@/i18n/id"

const viteSolid = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = viteSolid("@babel/core")
const presets = [
  [viteSolid.resolve("babel-preset-solid"), { generate: "dom" }],
  [viteSolid.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
]
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /packages\/(ui|session-ui|app)\/src\/.*\.tsx$/ }, async (args) => ({
      contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
      loader: "js",
    }))
  },
})

// Every request the test DOM would make (fetch, XHR, subresources) goes through happy-dom's interceptor: recorded, and
// answered locally so nothing leaves the machine.
const requests: string[] = []
const happy = (globalThis as any).happyDOM
happy.settings.fetch.interceptor = {
  beforeAsyncRequest: async ({ request }: { request: Request }) => {
    requests.push(request.url)
    return new Response("", { status: 204 })
  },
  beforeSyncRequest: ({ request }: { request: Request }) => {
    requests.push(request.url)
    return { status: 204, statusText: "No Content", ok: true, url: request.url, redirected: false, headers: new Headers(), body: Buffer.from("") }
  },
}
// happy-dom also loads <link> stylesheets and <script src> of documents made by DOMParser, which Chromium never does
// (a DOMParser document has no browsing context). The sanitiser parses the untrusted HTML with DOMParser, so those
// loads are switched off here; what is counted is what the rendered tab itself requests. The Chromium-level count
// (webRequest) is packages/desktop/test/file-preview-electron.
Object.assign(happy.settings, { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true })
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  requests.push(String(input instanceof Request ? input.url : input))
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

type Content = { type: "text" | "binary"; content: string; encoding?: "base64"; mimeType?: string }
const [files, setFiles] = createStore<Record<string, { path: string; name: string; loaded?: boolean; content?: Content }>>({})
const disk: Record<string, Content> = {}
const loads: string[] = []
const opened: string[] = []
let table: Record<string, string> = dict

const override = async (path: string, values: Record<string, unknown>) => {
  const real = await import(path)
  mock.module(path, () => ({ ...real, ...values }))
}
await override("@/context/file", {
  useFile: () => ({
    get: (path: string) => files[path],
    load: async (path: string) => {
      loads.push(path)
      // The server answers a missing file with empty text (handlers/file.ts:99).
      setFiles(path, { path, name: path, loaded: true, content: disk[path] ?? { type: "text", content: "" } })
    },
  }),
})
await override("@/context/language", {
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => params?.[name] ?? ""),
  }),
})
await override("@/context/platform", {
  usePlatform: () => ({ platform: "desktop", openPath: async (path: string) => void opened.push(path) }),
})
await override("@/context/sdk", { useSDK: () => () => ({ directory: "/work/proj/" }) })
await override("@/context/server", { useServer: () => ({ isLocal: () => true }) })

const { FilePreviewGate } = await import(new URL("../src/pages/session/file-preview.tsx", import.meta.url).pathname)

function syntheticPdf(pages: number) {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ")
  let body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`
  for (let i = 0; i < pages; i++) body += `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`
  return Buffer.from(body + "trailer\n<< /Root 1 0 R >>\n%%EOF\n")
}
const pdfContent = (pages: number): Content => ({
  type: "binary",
  content: syntheticPdf(pages).toString("base64"),
  encoding: "base64",
  mimeType: "application/pdf",
})
const HOSTILE_HTML = `<!DOCTYPE html><html><head><title>before</title><script>document.title='x'</script>
<link rel="stylesheet" href="https://example.invalid/s.css"></head>
<body><p>Laporan</p><img src="http://127.0.0.1:9/pixel.png"><a id="out" href="https://example.invalid/page">link</a>
<script>fetch("https://example.invalid/beacon")</script></body></html>`

// Row 112b (C101): Studio output names (C51) open rendered; any other .html opens as code.
const STUDIO_HTML = "docs/misi-a/studio/GSP-LAP-001/rev-3/GSP-LAP-001_rev3_20261107T101500Z_0a1b2c3d.html"
const STUDIO_PREVIEW_HTML = "GSP-Pratinjau-Templat_rev0_20261107T101500Z_deadbeef.html"

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
let dispose = () => {}
const revoked: string[] = []
const realRevoke = URL.revokeObjectURL
beforeEach(() => {
  requests.length = 0
  loads.length = 0
  opened.length = 0
  revoked.length = 0
  table = dict
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
    realRevoke.call(URL, url)
  }
})
afterEach(() => {
  dispose()
  dispose = () => {}
  URL.revokeObjectURL = realRevoke
  document.body.innerHTML = ""
  for (const key of Object.keys(files)) setFiles(key, undefined as never)
  for (const key of Object.keys(disk)) delete disk[key]
})

/** Mounts the gate as file-tabs.tsx does: `children` stands for the existing code/media view of the tab. */
async function open(path: string, content: Content | undefined, loaded = true) {
  if (content) disk[path] = content
  setFiles(path, { path, name: path, loaded, content })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(FilePreviewGate, {
        path,
        get state() {
          return files[path]
        },
        get children() {
          const existing = document.createElement("div")
          existing.setAttribute("data-testid", "existing-view")
          return existing
        },
      }),
    host,
  )
  await tick(5)
}
const existing = () => document.querySelector('[data-testid="existing-view"]')
const preview = () => document.querySelector('[data-component="file-preview"]')
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)

describe("P1, P7: a Studio PDF output opens inside the file tab", () => {
  test("Chromium's viewer frame gets a blob: URL, no sandbox, and the PDF's own page count", async () => {
    await open("out/GSP-Laporan_rev3.pdf", pdfContent(3))
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-slot="file-preview-pdf"]')
    expect(preview()?.getAttribute("data-kind")).toBe("pdf")
    expect(existing()).toBeNull()
    expect(frame?.getAttribute("src")).toMatch(/^blob:/)
    expect(frame?.getAttribute("data-page-count")).toBe("3")
    expect(frame?.hasAttribute("sandbox")).toBe(false)
    expect(frame?.getAttribute("title")).toBe("GSP-Laporan_rev3.pdf")
  })

  test("closing the tab revokes the blob URL (P7)", async () => {
    await open("out/a.pdf", pdfContent(2))
    const src = document.querySelector('iframe[data-slot="file-preview-pdf"]')!.getAttribute("src")!
    expect(revoked).toEqual([])
    dispose()
    dispose = () => {}
    expect(revoked).toEqual([src])
  })

  test("new bytes for the same tab revoke the old URL first", async () => {
    await open("out/a.pdf", pdfContent(2))
    const first = document.querySelector('iframe[data-slot="file-preview-pdf"]')!.getAttribute("src")!
    setFiles("out/a.pdf", "content", pdfContent(5))
    await tick(5)
    const frame = document.querySelector('iframe[data-slot="file-preview-pdf"]')!
    expect(revoked).toContain(first)
    expect(frame.getAttribute("src")).not.toBe(first)
    expect(frame.getAttribute("data-page-count")).toBe("5")
  })

  test("a .pdf whose bytes are not a PDF keeps the existing view", async () => {
    await open("out/fake.pdf", { type: "text", content: "not a pdf" })
    expect(preview()).toBeNull()
    expect(existing()).not.toBeNull()
  })
})

describe("P2, P6: a Studio HTML output previews statically", () => {
  test("sandbox is empty, the CSP is injected, the script did not run and nothing was requested", async () => {
    const title = document.title
    await open(STUDIO_HTML, { type: "text", content: HOSTILE_HTML })
    await tick(50)
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-slot="file-preview-html"]')!
    expect(frame.getAttribute("sandbox")).toBe("")
    const srcdoc = frame.getAttribute("srcdoc")!
    expect(srcdoc).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`)
    expect(srcdoc).not.toMatch(/<script/i)
    expect(srcdoc).not.toContain("example.invalid")
    expect(srcdoc).not.toContain("127.0.0.1")
    expect(srcdoc).toContain("Laporan")
    expect(document.title).toBe(title)
    expect(requests).toEqual([])
  })

  test("the link inside the preview has no target left to navigate to (P6)", async () => {
    await open(STUDIO_PREVIEW_HTML, { type: "text", content: HOSTILE_HTML })
    const srcdoc = document.querySelector('iframe[data-slot="file-preview-html"]')!.getAttribute("srcdoc")!
    const doc = new DOMParser().parseFromString(srcdoc, "text/html")
    expect(doc.getElementById("out")?.hasAttribute("href")).toBe(false)
  })

  test("Show source flips the same tab back to the existing code view, and back", async () => {
    await open(STUDIO_HTML, { type: "text", content: "<p>x</p>" })
    expect(existing()).toBeNull()
    button(dict["file.preview.showSource"])!.click()
    await tick()
    expect(existing()).not.toBeNull()
    expect(document.querySelector('iframe[data-slot="file-preview-html"]')).toBeNull()
    button(dict["file.preview.showPreview"])!.click()
    await tick()
    expect(existing()).toBeNull()
    expect(document.querySelector('iframe[data-slot="file-preview-html"]')).not.toBeNull()
  })
})

describe("row 112b (C101): an ordinary project .html opens as code, with the preview toggle", () => {
  for (const path of ["index.html", "public/report.html", "out/GSP-Laporan_rev3.html", "docs/misi-a/studio/notes.html"])
    test(`${path} opens in the existing code view; Show preview renders it, Show source returns`, async () => {
      await open(path, { type: "text", content: HOSTILE_HTML })
      await tick(20)
      expect(existing()).not.toBeNull()
      expect(preview()).toBeNull()
      expect(document.querySelector("iframe")).toBeNull()
      button(dict["file.preview.showPreview"])!.click()
      await tick()
      expect(existing()).toBeNull()
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-slot="file-preview-html"]')!
      expect(frame.getAttribute("sandbox")).toBe("")
      expect(frame.getAttribute("srcdoc")).not.toMatch(/<script/i)
      button(dict["file.preview.showSource"])!.click()
      await tick()
      expect(existing()).not.toBeNull()
      expect(document.querySelector("iframe")).toBeNull()
      expect(requests).toEqual([])
    })

  test("a Studio output .html opens rendered by default (the match case)", async () => {
    await open(STUDIO_PREVIEW_HTML, { type: "text", content: "<p>pratinjau</p>" })
    expect(existing()).toBeNull()
    expect(preview()?.getAttribute("data-kind")).toBe("html")
    expect(button(dict["file.preview.showSource"])).toBeDefined()
  })
})

describe("P4: a .docx shows its same-stem companion, else the hint", () => {
  test("with a sibling .pdf the tab shows it, labelled with the companion's name", async () => {
    disk["out/GSP-Laporan_rev3.pdf"] = pdfContent(4)
    await open("out/GSP-Laporan_rev3.docx", { type: "binary", content: "UEsDBA==", encoding: "base64" })
    await tick(5)
    expect(loads).toEqual(["out/GSP-Laporan_rev3.pdf", "out/GSP-Laporan_rev3.html"])
    expect(document.querySelector('[data-slot="file-preview-companion"]')?.textContent).toBe(
      "Preview from GSP-Laporan_rev3.pdf",
    )
    expect(document.querySelector('iframe[data-slot="file-preview-pdf"]')?.getAttribute("data-page-count")).toBe("4")
  })

  test("with only a sibling .html the tab shows the HTML", async () => {
    disk["out/b.html"] = { type: "text", content: "<p>companion</p>" }
    await open("out/b.docx", { type: "binary", content: "UEsDBA==", encoding: "base64" })
    await tick(5)
    expect(document.querySelector('[data-slot="file-preview-companion"]')?.textContent).toBe("Preview from b.html")
    expect(document.querySelector('iframe[data-slot="file-preview-html"]')?.getAttribute("sandbox")).toBe("")
  })

  test("without a companion it shows the studio_render hint, in EN and in ID", async () => {
    await open("out/c.docx", { type: "binary", content: "UEsDBA==", encoding: "base64" })
    await tick(5)
    expect(document.querySelector('[data-slot="file-preview-note"]')?.textContent).toBe(dict["file.preview.docxHint"])
    expect(dict["file.preview.docxHint"]).toContain("studio_render")
    dispose()
    table = id
    await open("out/c.docx", { type: "binary", content: "UEsDBA==", encoding: "base64" })
    await tick(5)
    expect(document.querySelector('[data-slot="file-preview-note"]')?.textContent).toBe(id["file.preview.docxHint"])
  })
})

describe("xlsx and pptx: the stated 1.2.0 limit with the existing open-in-default-app call", () => {
  test("the note is shown and Open hands the file under the session root to the OS", async () => {
    await open("out/Anggaran.xlsx", { type: "binary", content: "UEsDBA==", encoding: "base64" })
    expect(document.querySelector('[data-slot="file-preview-note"]')?.textContent).toBe(dict["file.preview.none"])
    button(dict["common.open"])!.click()
    await tick()
    expect(opened).toEqual(["/work/proj/out/Anggaran.xlsx"])
  })
})

describe("P3 and allowed roots: everything else keeps the existing view", () => {
  for (const [path, content] of [
    ["img/logo.png", { type: "binary", content: "iVBORw0KGgo=", encoding: "base64", mimeType: "image/png" }],
    ["img/logo.svg", { type: "text", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }],
    ["src/index.ts", { type: "text", content: "export {}" }],
  ] as const)
    test(`${path} renders the existing view untouched`, async () => {
      await open(path, content as Content)
      expect(preview()).toBeNull()
      expect(existing()).not.toBeNull()
    })

  for (const path of ["../outside.pdf", "/Users/someone/secret.pdf", "out/../../outside.html"])
    test(`a path outside the session root is refused: ${path}`, async () => {
      await open(path, pdfContent(1))
      expect(preview()).toBeNull()
      expect(document.querySelector("iframe")).toBeNull()
      expect(existing()).not.toBeNull()
    })

  test("a file still loading keeps the existing view (its loading text)", async () => {
    await open("out/a.pdf", undefined, false)
    expect(preview()).toBeNull()
    expect(existing()).not.toBeNull()
  })
})

describe("P8: no new panel or route", () => {
  const root = new URL("../src/", import.meta.url).pathname
  const read = (file: string) => readFileSync(root + file, "utf8")

  test("the preview is mounted only by the two existing file-tab views (V1 and V2 content())", () => {
    const tabs = read("pages/session/file-tabs.tsx")
    expect(tabs.split("<FilePreviewGate").length - 1).toBe(2)
    expect(tabs).toContain('import { FilePreviewGate } from "@/pages/session/file-preview"')
  })

  test("the preview module adds no route, portal, dialog or panel", () => {
    const source = read("pages/session/file-preview.tsx")
    for (const banned of ["@solidjs/router", "<Route", "Portal", "useDialog", "Panel", "window.open", "webview"])
      expect({ banned, found: source.includes(banned) }).toEqual({ banned, found: false })
  })
})
