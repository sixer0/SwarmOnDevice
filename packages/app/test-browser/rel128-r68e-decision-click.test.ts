// Swarm 1.2.8 row 68e (C175, live RC2 line 16): every visible decision button in the session's Mission Control takes
// the click. Live, at 1280x800 and 1024x640, a decision card was drawn and visible but `elementFromPoint` over its
// buttons was the map area `[data-mission-main]` and a real click did nothing. Cause: in sheet mode the main area was
// `overflow-hidden`, which is still a scroll container; a programmatic scroll (the dock's Files button calls
// scrollIntoView on the deliverables inside the closed sheet; any focus/scrollIntoView does the same) left it scrolled,
// so the CLOSED sheet (translated below the area, `inert`) was scrolled into view: painted, but inert, so not hit.
// The render half (separate process: it replaces app contexts with `mock.module`) draws the real MissionControl closed
// and open; this half styles that markup with the app's Tailwind utilities in headless Chromium (Playwright's browser,
// or the installed Chrome) inside a stand-in for the Activity pane, switches between the two rendered states the way
// the component does (the side panel's class and `inert`), and asserts counts/booleans only (C77).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "@playwright/test"
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
  dir = await mkdtemp(path.join(tmpdir(), "r68e-"))
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel128-r68e-decision-click.render.ts",
    ],
    { cwd: app, stdout: "pipe", stderr: "pipe", env: { ...process.env, R68E_DUMP_DIR: dir } },
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

// The side panel's two rendered states, read from the render half's markup.
function sideState(html: string) {
  const tag = html.match(/<aside[^>]*data-mission-side[^>]*>/)?.[0] ?? ""
  return { cls: tag.match(/class="([^"]*)"/)?.[1] ?? "", inert: /\sinert(=|\s|>)/.test(tag) }
}

// The Activity pane at the right of the window: 372 px wide, its own scroll, the pane header above the section and the
// existing Agents view below it (live layout, row 136 M6).
async function open(viewport: { width: number; height: number }) {
  const closed = await readFile(path.join(dir, "closed.html"), "utf8")
  const opened = await readFile(path.join(dir, "open.html"), "utf8")
  const page = await browser!.newPage({ viewport })
  await page.setContent(
    `<!doctype html><html><head><style>${await stylesFor(closed + opened)}</style></head>` +
      `<body style="margin:0;font-size:13px;display:flex;justify-content:flex-end">` +
      `<div data-test-pane style="display:flex;flex-direction:column;width:372px;height:${viewport.height}px;overflow-y:auto">` +
      `<div style="height:150px;flex:none"></div>${closed}<div style="height:900px;flex:none"></div></div></body></html>`,
  )
  await page.evaluate(
    ({ closed, opened }) => {
      const w = window as unknown as { __states: unknown; __clicks: string[] }
      w.__states = { closed, opened }
      w.__clicks = []
      // Solid delegates onClick to the document: a click whose target is in the button reaches its handler.
      document.addEventListener("click", (event) => {
        const option = (event.target as Element | null)?.closest?.("[data-mission-option]") as HTMLElement | null
        if (option) w.__clicks.push(option.dataset.missionOption ?? "")
      })
    },
    { closed: sideState(closed), opened: sideState(opened) },
  )
  return page
}

// What MissionControl does to the side panel when the sheet opens or closes.
async function sheet(page: Page, state: "open" | "closed", settle = true) {
  await page.evaluate((state) => {
    const s = (window as unknown as { __states: Record<string, { cls: string; inert: boolean }> }).__states[
      state === "open" ? "opened" : "closed"
    ]
    const side = document.querySelector<HTMLElement>("[data-mission-side]")!
    side.className = s.cls
    side.toggleAttribute("inert", s.inert)
  }, state)
  if (settle) await page.waitForTimeout(400) // the sheet's 250 ms slide
}

type Hits = { buttons: number; visible: number; hit: number; first: number[] | null; main: number; section: number }

// A decision button counts as visible when its centre is inside the window and inside every clipping ancestor;
// it is reachable when elementFromPoint at that centre is the button or inside it.
const hits = (page: Page) =>
  page.evaluate((): Hits => {
    const buttons = [...document.querySelectorAll<HTMLElement>("[data-mission-decision] button")]
    let visible = 0
    let hit = 0
    let first: number[] | null = null
    for (const button of buttons) {
      const r = button.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      if (r.width === 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
      let inside = true
      for (let a = button.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a)
        if (s.overflowX === "visible" && s.overflowY === "visible") continue
        const c = a.getBoundingClientRect()
        if (x < c.left || x >= c.right || y < c.top || y >= c.bottom) {
          inside = false
          break
        }
      }
      if (!inside) continue
      visible++
      const at = document.elementFromPoint(x, y)
      if (at && button.contains(at)) hit++
      if (!first && button.matches("[data-mission-option]")) first = [x, y]
    }
    return {
      buttons: buttons.length,
      visible,
      hit,
      first,
      main: document.querySelector<HTMLElement>("[data-mission-main]")!.scrollTop,
      section: document.querySelector<HTMLElement>("[data-mission-control]")!.scrollTop,
    }
  })

// A person's mouse press on the first visible option: the click must reach that option's handler.
async function realClick(page: Page, h: Hits) {
  if (!h.first) return true
  const before = await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks.length)
  await page.mouse.click(h.first[0]!, h.first[1]!)
  return page.evaluate((n) => (window as unknown as { __clicks: string[] }).__clicks.length === n + 1, before)
}

async function expectReachable(page: Page, mustShow: boolean) {
  const h = await hits(page)
  expect(h.buttons).toBe(3)
  if (mustShow) expect(h.visible > 0).toBe(true)
  expect(h.hit).toBe(h.visible)
  expect(await realClick(page, h)).toBe(true)
  return h
}

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 640 },
]

test("1.2.8 R-68e render half: closed and open sheet rendered, an option click answers", () => {
  if (render.code !== 0) throw new Error(render.output)
  expect(render.output).toContain(" 0 fail")
  expect(render.output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)

for (const viewport of VIEWPORTS) {
  const at = `${viewport.width}x${viewport.height}`

  test(`1.2.8 R-68e ${at}: first open — every visible decision button takes the click`, async () => {
    const page = await open(viewport)
    try {
      await sheet(page, "open")
      await expectReachable(page, true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test(`1.2.8 R-68e ${at}: dock Files (scrollIntoView into the sheet), then the sheet closes and reopens`, async () => {
    const page = await open(viewport)
    try {
      // showFiles(): the sheet opens and the deliverables are scrolled into view in the same tick.
      await sheet(page, "open", false)
      await page.evaluate(() =>
        document.querySelector("[data-mission-side] > div.mt-1\\.5")?.scrollIntoView({ block: "nearest" }),
      )
      await page.waitForTimeout(400)
      // A click on the stage puts the sheet away: nothing of it may stay visible-but-dead.
      await sheet(page, "closed")
      const closed = await expectReachable(page, false)
      expect(closed.main).toBe(0)
      expect(closed.section).toBe(0)
      // "Decisions" again; the side panel still shows the deliverables (Files scrolled it there), so the person scrolls
      // it back up to the card: every visible button answers.
      await sheet(page, "open")
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("[data-mission-side]")!.scrollTop = 0
      })
      await expectReachable(page, true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test(`1.2.8 R-68e ${at}: a scroll pushed into the closed sheet (focus/scrollIntoView) cannot leave it visible`, async () => {
    const page = await open(viewport)
    try {
      await sheet(page, "closed")
      await page.evaluate(() => {
        const option = document.querySelector<HTMLElement>("[data-mission-option]")!
        option.scrollIntoView({ block: "nearest" })
        const main = document.querySelector<HTMLElement>("[data-mission-main]")!
        main.scrollTop = main.scrollHeight
        const section = document.querySelector<HTMLElement>("[data-mission-control]")!
        section.scrollTop = section.scrollHeight
      })
      const closed = await expectReachable(page, false)
      expect(closed.main).toBe(0)
      expect(closed.section).toBe(0)
      await sheet(page, "open")
      await expectReachable(page, true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test(`1.2.8 R-68e ${at}: after the Activity pane scrolls, and with the map panned when the decision opens`, async () => {
    const page = await open(viewport)
    try {
      await sheet(page, "open")
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("[data-test-pane]")!.scrollTop = 120
      })
      await expectReachable(page, true)
      await sheet(page, "closed")
      await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>("[data-mission-stage]")!
        stage.scrollTop = stage.scrollHeight
        document.querySelector<HTMLElement>("[data-test-pane]")!.scrollTop = 60
      })
      await sheet(page, "open")
      await expectReachable(page, true)
    } finally {
      await page.close()
    }
  }, 60_000)
}
