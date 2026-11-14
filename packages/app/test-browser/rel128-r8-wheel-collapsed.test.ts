// Swarm 1.2.8 row 30 (AC-R8, N8-323): a mouse wheel over a collapsed Decisions entry scrolls the list.
// The render half (separate process: it replaces app contexts with `mock.module`) draws the real DecisionList with 12
// collapsed entries and writes it out; this half styles that markup with the app's Tailwind utilities and the
// accordion's own stylesheet and wheels over it in headless Chromium (Playwright's browser, or the installed Chrome).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "@playwright/test"
import { compile } from "tailwindcss"
import { createRequire } from "node:module"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const app = new URL("..", import.meta.url).pathname
const accordionCss = new URL("../../ui/src/v2/components/accordion-v2.css", import.meta.url).pathname

let dir = ""
let render = { code: -1, output: "" }
let browser: Browser | undefined

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "r8-"))
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel128-r8-wheel-collapsed.render.ts",
    ],
    { cwd: app, stdout: "pipe", stderr: "pipe", env: { ...process.env, R8_DUMP_DIR: dir } },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  render = { code, output }
  browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, channel: "chrome" }))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

// Tailwind v4 builds exactly the utilities the markup names; the accordion's stylesheet is plain CSS.
async function stylesFor(html: string) {
  const twDir = path.dirname(path.dirname(createRequire(import.meta.url).resolve("tailwindcss")))
  const compiler = await compile(`@import "tailwindcss";`, {
    base: twDir,
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(twDir, "index.css") : path.resolve(base, id)
      return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") }
    },
  })
  const candidates = new Set<string>()
  for (const match of html.matchAll(/class="([^"]*)"/g)) for (const c of match[1].split(/\s+/)) if (c) candidates.add(c)
  return compiler.build([...candidates]) + "\n" + (await readFile(accordionCss, "utf8"))
}

// The side panel's Decisions tab: a narrow column with a fixed height, the list filling it (flex-1 min-h-0).
async function open(name: string) {
  const html = await readFile(path.join(dir, name), "utf8")
  const page = await browser!.newPage({ viewport: { width: 1024, height: 640 } })
  await page.setContent(
    `<!doctype html><html><head><style>${await stylesFor(html)}</style></head><body style="margin:0">` +
      `<div style="display:flex;flex-direction:column;width:320px;height:400px">${html}</div></body></html>`,
  )
  return page
}

async function wheelOver(page: Page, selector: string, nth: number, dy: number) {
  const box = await page.locator(selector).nth(nth).boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(20, box!.height / 2))
  await page.mouse.wheel(0, dy)
}

const scrollTop = (page: Page, selector: string) =>
  page.evaluate((s) => document.querySelector<HTMLElement>(s)!.scrollTop, selector)

async function settle(page: Page, read: () => Promise<number>) {
  // The wheel scroll lands asynchronously; wait until it moves, then a little longer for it to finish.
  for (let i = 0; i < 40 && (await read()) === 0; i++) await page.waitForTimeout(50)
  await page.waitForTimeout(200)
}

test("1.2.8 R-8 render half: collapsed bodies carry no overscroll-contain, an expanded one keeps it", () => {
  if (render.code !== 0) throw new Error(render.output)
  expect(render.output).toContain(" 0 fail")
  expect(render.output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)

test("1.2.8 R-8: a wheel over the 3rd of 12 collapsed Decisions entries scrolls the list", async () => {
  const page = await open("collapsed.html")
  try {
    const list = "[data-map-decisions]"
    const can = await page.evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s)!
      return { overflow: el.scrollHeight > el.clientHeight, entries: el.querySelectorAll("[data-decision]").length }
    }, list)
    expect(can).toEqual({ overflow: true, entries: 12 })
    expect(await scrollTop(page, list)).toBe(0)
    await wheelOver(page, `${list} [data-map-decision-body]`, 2, 200)
    await settle(page, () => scrollTop(page, list))
    expect(await scrollTop(page, list)).toBeGreaterThan(0)
  } finally {
    await page.close()
  }
}, 60_000)

test("1.2.8 R-8: an expanded long entry scrolls its own body first, the list stays put", async () => {
  const page = await open("expanded.html")
  try {
    const list = "[data-map-decisions]"
    const body = `${list} [data-decision="r8_01"] [data-map-decision-body]`
    const overflow = await page.evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s)!
      return el.scrollHeight > el.clientHeight
    }, body)
    expect(overflow).toBe(true)
    await wheelOver(page, body, 0, 100)
    await settle(page, () => scrollTop(page, body))
    expect(await scrollTop(page, body)).toBeGreaterThan(0)
    expect(await scrollTop(page, list)).toBe(0)
  } finally {
    await page.close()
  }
}, 60_000)
