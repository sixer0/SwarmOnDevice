// Swarm 1.2.8 row 51d (L1-R12 readability, C124): at 1024x640 with 8 long options the decision question stays
// visible. The render half (separate process: it replaces app contexts with `mock.module`) draws the real
// MissionCommand and writes it out; this half styles that markup with the app's Tailwind utilities and measures it in
// headless Chromium (Playwright's browser, or the installed Chrome), inside a stand-in for the side panel
// `[data-mission-side]` (a flex column with a definite height, as in the live 1024x640 layout).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "@playwright/test"
import { compile } from "tailwindcss"
import { createRequire } from "node:module"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const app = new URL("..", import.meta.url).pathname

let dir = ""
let render = { code: -1, output: "" }
let browser: Browser | undefined

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "r12-"))
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel128-r12-question-min-height.render.ts",
    ],
    { cwd: app, stdout: "pipe", stderr: "pipe", env: { ...process.env, R12_DUMP_DIR: dir } },
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
  return compiler.build([...candidates])
}

// The live panel at 1024x640: about 300 px wide, the card capped at about 220 px.
async function open(name: string, panelHeight: number) {
  const html = await readFile(path.join(dir, name), "utf8")
  const page = await browser!.newPage({ viewport: { width: 1024, height: 640 } })
  await page.setContent(
    `<!doctype html><html><head><style>${await stylesFor(html)}</style></head><body style="margin:0;font-size:13px">` +
      `<aside data-mission-side style="display:flex;flex-direction:column;width:300px;height:${panelHeight}px;overflow-y:auto">${html}</aside></body></html>`,
  )
  return page
}

type Measure = {
  bodyHeight: number
  questionLines: number
  questionVisible: number
  firstOptionVisible: boolean
  cardScrolls: boolean
  pageScrollTop: number
}

const measure = (page: Awaited<ReturnType<typeof open>>) =>
  page.evaluate((): Measure => {
    const card = document.querySelector<HTMLElement>("[data-mission-decision]")!
    const body = card.querySelector<HTMLElement>("[data-mission-decision-body]")!
    const question = body.querySelector<HTMLElement>("[data-mission-question]")!
    const option = card.querySelector<HTMLElement>("[data-mission-option]")!
    const b = body.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const q = question.getBoundingClientRect()
    const o = option.getBoundingClientRect()
    const line = parseFloat(getComputedStyle(question).lineHeight)
    // The part of the question a person can see: inside the body, inside the card.
    const top = Math.max(b.top, c.top, q.top)
    const bottom = Math.min(b.bottom, c.bottom, q.bottom)
    const visible = Math.max(0, bottom - top)
    return {
      bodyHeight: b.height,
      questionLines: Math.floor(visible / line),
      questionVisible: visible,
      firstOptionVisible: o.top < c.bottom && o.bottom > c.top,
      cardScrolls: card.scrollHeight > card.clientHeight,
      pageScrollTop: document.scrollingElement!.scrollTop,
    }
  })

test("1.2.8 R-12 render half: 8 options outside the body, question inside", () => {
  if (render.code !== 0) throw new Error(render.output)
  expect(render.output).toContain(" 0 fail")
  expect(render.output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)

test("1.2.8 R-12: at 1024x640 with 8 long options the question keeps at least 3 visible lines", async () => {
  const page = await open("eight.html", 220)
  try {
    const m = await measure(page)
    expect(m.bodyHeight > 0).toBe(true)
    expect(m.questionLines >= 3).toBe(true)
    // The answer buttons stay reachable: the card scrolls inside itself, the page does not.
    expect(m.cardScrolls).toBe(true)
    expect(m.pageScrollTop).toBe(0)
    // Scrolling the card all the way reaches the last option.
    const last = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("[data-mission-decision]")!
      card.scrollTop = card.scrollHeight
      const options = card.querySelectorAll<HTMLElement>("[data-mission-option]")
      const o = options[options.length - 1]!.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      return { count: options.length, visible: o.top < c.bottom && o.bottom > c.top }
    })
    expect(last).toEqual({ count: 8, visible: true })
    // The question's text is reachable in its body's own scroll.
    const reach = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("[data-mission-decision-body]")!
      return { scrolls: body.scrollHeight > body.clientHeight, starts: (body.textContent ?? "").includes("QSTART") }
    })
    expect(reach).toEqual({ scrolls: true, starts: true })
  } finally {
    await page.close()
  }
}, 60_000)

test("1.2.8 R-12: a short decision at 1024x640 is unchanged (body at its content height, options visible, card does not scroll)", async () => {
  const page = await open("two.html", 220)
  try {
    const m = await measure(page)
    const fits = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("[data-mission-decision-body]")!
      // The body is exactly its content height: the floor adds no empty space and nothing is cut.
      return body.clientHeight > 0 && body.scrollHeight === body.clientHeight
    })
    expect(fits).toBe(true)
    expect(m.firstOptionVisible).toBe(true)
    expect(m.cardScrolls).toBe(false)
    expect(m.pageScrollTop).toBe(0)
  } finally {
    await page.close()
  }
}, 60_000)
