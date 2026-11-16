// Source lints U-LINT-01..U-LINT-03 (AC-02, AC-33, AC-36, AC-37, AC-39, AC-42) and the
// rendered-tree half of U-I18N-02 ("no ^office\. string on screen").
import { afterEach, describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { OFFICE_JS_URL } from "../constants"
import "./solid-test"

const { mount, settle } = await import("./harness")

const pkg = `${import.meta.dir}/../..`
const src = `${pkg}/src`

// Product source only: tests, fixtures and the test harness are excluded.
async function product() {
  const files = await Array.fromAsync(new Glob("**/*.{ts,tsx}").scan({ cwd: src }))
  const kept = files.filter((file) => !/\.test\.tsx?$|\.fixture\.ts$|views\/(harness\.tsx|solid-test\.ts)$|api\/fake-bridge\.ts$|state\/test-store\.ts$/.test(file))
  return Promise.all(
    kept.map(async (file) => ({ file, code: (await Bun.file(`${src}/${file}`).text()).replace(/^\s*\/\/.*$/gm, "") })),
  )
}

const offenders = (files: { file: string; code: string }[], pattern: RegExp, allowed: string[] = []) =>
  files.filter((entry) => pattern.test(entry.code) && !allowed.includes(entry.file)).map((entry) => entry.file)

describe("U-LINT-01 no HTML sinks (SC-40)", () => {
  test("no innerHTML, outerHTML, insertAdjacentHTML, document.write or Solid innerHTML prop", async () => {
    const files = await product()
    expect(files.length).toBeGreaterThan(20)
    expect(offenders(files, /innerHTML|outerHTML|insertAdjacentHTML|document\.write\b|textContent=\{|\binnerText=/)).toEqual([])
  })
})

describe("U-LINT-02 source rules", () => {
  test("no history routing, no formulas assignment, no document.settings", async () => {
    const files = await product()
    expect(offenders(files, /history\.(pushState|replaceState)/)).toEqual([])
    expect(offenders(files, /\.formulas(Local|R1C1)?\s*=[^=]/)).toEqual([])
    expect(offenders(files, /document\.settings/)).toEqual([])
  })

  test("insertText and values/numberFormat assignments only in the adapter files", async () => {
    const files = await product()
    expect(offenders(files, /\binsertText\s*\(/, ["host/word.ts", "host/memory.ts"])).toEqual([])
    expect(offenders(files, /\.(values|numberFormat)\s*=[^=]/, ["host/excel.ts", "host/memory.ts"])).toEqual([])
  })

  test("index.html loads Office.js from exactly the RC-1 URL", async () => {
    const html = await Bun.file(`${pkg}/index.html`).text()
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1])
    expect(scripts.filter((url) => url!.startsWith("http"))).toEqual([OFFICE_JS_URL])
  })
})

describe("U-LINT-03 no secrets in the built pane (AC-39)", () => {
  // Runs over dist/pane after `vite build`; without a build there is nothing to scan.
  // Secret VALUES are refused. Three NAMES appear by construction and are allowed only in their
  // known non-secret form (M8-05 report, finding F-1): the `swo1_` prefix constant (token format
  // check), the hey-api client's default auth header name, and the generated SDK's header-parameter
  // descriptors `key:"x-swarm-desktop-nonce"` (the pane never sets that header; the bridge strips it).
  test("dist/pane holds no token, Authorization header, desktop nonce or Basic-auth user", async () => {
    const dist = `${pkg}/dist/pane`
    const files = await Array.fromAsync(new Glob("**/*").scan({ cwd: dist })).catch(() => [] as string[])
    if (files.length === 0) return
    const found = await Promise.all(
      files.map(async (file) => {
        const text = await Bun.file(`${dist}/${file}`).text()
        // Source maps carry the SDK's source text (types, doc comments); only values are checked there.
        const code = !file.endsWith(".map")
        return [
          // A token value (prefix plus 43 base64url characters), not the prefix constant itself.
          /swo1_[A-Za-z0-9_-]{43}/.test(text) ? `${file}: token` : "",
          /\bBasic [A-Za-z0-9+/=]{8,}/.test(text) ? `${file}: Basic credential` : "",
          /opencode:/.test(text) ? `${file}: basic-auth user` : "",
          code && /x-swarm-desktop-nonce/i.test(text.replaceAll('key:"x-swarm-desktop-nonce"', "")) ? `${file}: nonce` : "",
          code && /Authorization/.test(text.replaceAll('??"Authorization"', "")) ? `${file}: Authorization` : "",
        ].filter(Boolean)
      }),
    )
    expect(found.flat()).toEqual([])
  })
})

describe("U-I18N-02 rendered tree", () => {
  const open: Awaited<ReturnType<typeof mount>>[] = []
  afterEach(() => open.splice(0).forEach((pane) => pane.unmount()))

  test("no rendered text or accessible name is a raw office.* key, in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      for (const options of [{ noOffice: true }, {}, { token: true }, { token: true, acknowledged: true, readOnly: true }]) {
        const pane = await mount({ ...options, locale })
        open.push(pane)
        await settle()
        const texts = [...pane.container.querySelectorAll("*")].flatMap((el) => [
          ...[...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent ?? ""),
          el.getAttribute("aria-label") ?? "",
          el.getAttribute("placeholder") ?? "",
          el.getAttribute("title") ?? "",
        ])
        expect(texts.filter((text) => /^office\./.test(text.trim()))).toEqual([])
      }
    }
  })
})
