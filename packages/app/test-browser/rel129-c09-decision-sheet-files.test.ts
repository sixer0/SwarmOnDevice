// Swarm 1.2.9 row 57 (AC-C09, N9-138; rc4 O-1): at 1024x640, the dock's Files in the decision sheet scrolled the side
// panel to the deliverables, so the decision options went out of the sheet and no click could reach them. Rule (b)
// (01c §3.10): with an open decision Files scrolls the panel no further than keeps the options' top edge inside it;
// without one it still brings the deliverables into view.
// The render half (separate process: it replaces app contexts with `mock.module`) draws the real MissionControl with
// the sheet closed, with and without a decision, and writes the source of the function showFiles runs
// (`missionFilesScroll`). This half styles that markup with the app's Tailwind utilities in headless Chromium inside a
// stand-in for the Activity pane (as 1.2.8 R-68e), wires the Files dock button the way MissionControl does (open the
// sheet, then run that function), clicks it like a person, and asserts counts/booleans only (C77).
// At BASE there is no such function: showFiles was `deliverables.scrollIntoView({ block: "nearest" })`
// (mission-control.tsx:105-108 at d4282fcfd8), which is what this half runs when the render half wrote none.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "@playwright/test"
import { compile } from "tailwindcss"
import { createRequire } from "node:module"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const app = new URL("..", import.meta.url).pathname
const BASE_SHOW_FILES = `function (aside, deliverables) { deliverables.scrollIntoView({ block: "nearest" }) }`

let dir = ""
let render = { code: -1, output: "" }
let browser: Browser | undefined

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "c09-"))
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/rel129-c09-decision-sheet-files.render.ts",
    ],
    { cwd: app, stdout: "pipe", stderr: "pipe", env: { ...process.env, C09_DUMP_DIR: dir } },
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

// The Activity pane at the right of the window: 372 px wide, its own scroll, the pane header above the section and the
// existing Agents view below it (live layout, row 136 M6). The Files button does what MissionControl's showFiles does:
// the sheet opens (translate and inert go) and the side panel scroll function runs in the same tick.
async function open(viewport: { width: number; height: number }, file: "decision.html" | "nodecision.html") {
  const closed = await readFile(path.join(dir, file), "utf8")
  const scrollSource = existsSync(path.join(dir, "files-scroll.js"))
    ? await readFile(path.join(dir, "files-scroll.js"), "utf8")
    : BASE_SHOW_FILES
  const page = await browser!.newPage({ viewport })
  await page.setContent(
    `<!doctype html><html><head><style>${await stylesFor(closed)}</style></head>` +
      `<body style="margin:0;font-size:13px;display:flex;justify-content:flex-end">` +
      `<div data-test-pane style="display:flex;flex-direction:column;width:372px;height:${viewport.height}px;overflow-y:auto">` +
      `<div style="height:150px;flex:none"></div>${closed}<div style="height:900px;flex:none"></div></div></body></html>`,
  )
  await page.evaluate((scrollSource) => {
    const filesScroll = new Function(`return (${scrollSource})`)() as (aside: HTMLElement, d: HTMLElement) => void
    const files = document.querySelector<HTMLElement>("[data-mission-dock-item='files']")!
    files.addEventListener("click", () => {
      const aside = document.querySelector<HTMLElement>("[data-mission-side]")!
      aside.classList.remove("translate-y-[105%]")
      aside.removeAttribute("inert")
      document.querySelector<HTMLElement>("[data-mission-control]")!.dataset.missionSheet = "open"
      filesScroll(aside, document.querySelector<HTMLElement>("[data-mission-side] > div.mt-1\\.5")!)
    })
  }, scrollSource)
  return page
}

// A person's click on the Files dock button, then the sheet's 250 ms slide.
async function clickFiles(page: Page) {
  await page.click("[data-mission-dock-item='files']")
  await page.waitForTimeout(400)
}

type Hits = { options: number; hit: number; inside: number; sheetOpen: boolean }

// Per option: elementFromPoint at its centre must be inside that option, and the centre must lie in the side panel.
const hits = (page: Page) =>
  page.evaluate((): Hits => {
    const aside = document.querySelector<HTMLElement>("aside[data-mission-side]")!.getBoundingClientRect()
    const options = [...document.querySelectorAll<HTMLElement>("[data-mission-option]")]
    let hit = 0
    let inside = 0
    for (const option of options) {
      const r = option.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      if (x >= aside.left && x < aside.right && y >= aside.top && y < aside.bottom) inside++
      if (document.elementFromPoint(x, y)?.closest("[data-mission-option]") === option) hit++
    }
    const sheetOpen =
      document.querySelector<HTMLElement>("[data-mission-control]")!.dataset.missionSheet === "open" &&
      !document.querySelector("[data-mission-side]")!.hasAttribute("inert")
    return { options: options.length, hit, inside, sheetOpen }
  })

// Without a decision: the deliverables block's top lies inside the side panel after Files.
const deliverablesShown = (page: Page) =>
  page.evaluate(() => {
    const aside = document.querySelector<HTMLElement>("aside[data-mission-side]")!.getBoundingClientRect()
    const top = document.querySelector<HTMLElement>("[data-mission-side] > div.mt-1\\.5")!.getBoundingClientRect().top
    return top >= aside.top && top < aside.bottom
  })

// A person's mouse press on each option reaches that option (the event's target is inside it).
async function clicksReach(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: string[] }
    w.__clicks = []
    document.addEventListener("click", (event) => {
      const option = (event.target as Element | null)?.closest?.("[data-mission-option]") as HTMLElement | null
      if (option) w.__clicks.push(option.dataset.missionOption ?? "")
    })
  })
  const centres = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-mission-option]")].map((o) => {
      const r = o.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2, o.dataset.missionOption ?? ""] as const
    }),
  )
  let reached = 0
  for (const [x, y, id] of centres) {
    await page.mouse.click(x, y)
    const last = await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks.at(-1) ?? "")
    if (last === id) reached++
  }
  return reached
}

const VIEWPORTS = [
  { width: 1024, height: 640 },
  { width: 1280, height: 800 },
]

test("1.2.9 C09 render half: Files with and without a decision; showFiles' scroll function written", () => {
  if (render.code !== 0) throw new Error(render.output)
  expect(render.output).toContain(" 0 fail")
  expect(render.output).toMatch(/ [1-9][0-9]* pass/)
}, 60_000)

for (const viewport of VIEWPORTS) {
  const at = `${viewport.width}x${viewport.height}`

  test(`1.2.9 C09 ${at}: after Files with an open decision every option is in the sheet and takes the click`, async () => {
    const page = await open(viewport, "decision.html")
    try {
      await clickFiles(page)
      const h = await hits(page)
      expect(h.sheetOpen).toBe(true)
      expect(h.options).toBe(3)
      expect(h.inside).toBe(3)
      expect(h.hit).toBe(3)
      expect(await clicksReach(page)).toBe(3)
    } finally {
      await page.close()
    }
  }, 60_000)

  test(`1.2.9 C09 ${at}: without a decision Files still brings the deliverables into view`, async () => {
    const page = await open(viewport, "nodecision.html")
    try {
      await clickFiles(page)
      expect((await hits(page)).sheetOpen).toBe(true)
      expect(await deliverablesShown(page)).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)
}
