import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { installTimelineSettings } from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

// Home pane keyboard focus (row 15c). The search box must hold focus after mod+b while the pane's queries settle:
// the agent snapshot resolves (and is fetched again) after the pane mounted, and the session index arrives late.
// Before the fix those reads suspended a boundary around the search box and Solid took it out of the document.

const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const session = (id: string, title: string, at: number) => ({
  id,
  slug: id,
  projectID: fixture.project.id,
  directory: fixture.directory,
  title,
  version: "dev",
  time: { created: at, updated: at },
})
const sessions = [
  session("ses_focus_alpha_one", "Alpha one", 1700000000000),
  session("ses_focus_alpha_two", "Alpha two", 1700000001000),
  session("ses_focus_alpha_three", "Alpha three", 1700000002000),
]
const current = sessions[0]!

async function setup(page: Page) {
  // Time runs normally; the warm-up jumps it forward so the cached session index is stale on the measured open.
  await page.clock.install()
  await installTimelineSettings(page)
  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
  })
  // Routes of this fork the shared mock does not know (it answers `{}`), where the app expects a list.
  await page.route(
    (url) => url.pathname === "/saved-command",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "[]",
      }),
  )
  // The session index answers late, so the pane mounts before its sessions query has data.
  await page.route(
    (url) => url.pathname === "/api/session",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return route.fallback()
    },
  )
  // A running agent in the snapshot, answered late and differently each time, as the real server does.
  let snapshots = 0
  await page.route(
    (url) => url.pathname === "/global/agents",
    async (route) => {
      const count = ++snapshots
      await new Promise((resolve) => setTimeout(resolve, 200))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          instances: [
            {
              directory: fixture.directory,
              status: { [sessions[count % 2 === 0 ? 1 : 2]!.id]: { type: "busy" } },
              permission: [],
              question: [],
            },
          ],
        }),
      })
    },
  )
  await page.addInitScript(
    (input) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: input.directory, expanded: true }] },
          lastProject: { local: input.directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server: input.server, dirBase64: input.dirBase64, sessionId: input.id }]),
      )
      // Every time the pane's search box leaves the document or loses focus, for the assertion and its message.
      const log: string[] = []
      ;(window as unknown as { __paneFocusLog: string[] }).__paneFocusLog = log
      const start = performance.now()
      const stamp = () => Math.round(performance.now() - start)
      const box = '[data-component="home-session-search"] input'
      document.addEventListener(
        "focusout",
        (event) => {
          const target = event.target as HTMLElement | null
          if (target?.matches?.(box))
            log.push(`focusout connected=${target.isConnected} related=${!!event.relatedTarget}@${stamp()}`)
        },
        true,
      )
      // Suspense hides a boundary by taking its nodes out of the document: a removal record that carries the box.
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.removedNodes)
            if (node instanceof Element && (node.matches(box) || node.querySelector(box)))
              log.push(
                `detached ${node.nodeName}${node.getAttribute("data-component") ? `[${node.getAttribute("data-component")}]` : ""}@${stamp()}`,
              )
      }).observe(document, { childList: true, subtree: true })
    },
    { directory: fixture.directory, server, dirBase64: base64Encode(fixture.directory), id: current.id },
  )
}

const pane = (page: Page) => page.locator('[data-component="home-pane"]')
const search = (page: Page) => pane(page).locator('[data-component="home-session-search"] input')
const composer = (page: Page) => page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')

// mod is the app's own idea of the platform (navigator.platform), not the host's: the device profile may differ.
const pressMod = async (page: Page, key: string) => {
  const mac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+${key}`)
}

async function openSession(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${current.id}`)
  await expect(composer(page)).toBeVisible()
}

/** Watches the search box for `ms` after it took focus: it has to keep it the whole time, in the same node. */
async function expectSearchKeepsFocus(page: Page, ms: number) {
  await expect(search(page)).toBeFocused()
  const result = await search(page).evaluate(
    (input, ms) =>
      new Promise<{ same: boolean; focused: boolean; log: string[] }>((resolve) => {
        // An observation window, not a synchronisation sleep: the defect is focus lost some ms after it landed.
        setTimeout(
          () =>
            resolve({
              same:
                document.querySelector('[data-component="home-pane"] [data-component="home-session-search"] input') ===
                input,
              focused: document.activeElement === input,
              log: (window as unknown as { __paneFocusLog: string[] }).__paneFocusLog,
            }),
          ms,
        )
      }),
    ms,
  )
  expect(result, JSON.stringify(result.log)).toEqual({ same: true, focused: true, log: [] })
}

/**
 * Opens and closes the pane once, so the measured open finds its queries in the cache but stale (as an open after a
 * while does in the app), then clears the probe log.
 */
async function warmPane(page: Page) {
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(search(page)).toBeVisible()
  await pane(page).getByRole("button", { name: "Close", exact: true }).click()
  await expect(pane(page)).toHaveCount(0)
  // Past the session index staleTime (30 s) and the snapshot interval: the next open refetches both, as in the app.
  await page.clock.fastForward(31_000)
  await page.evaluate(() => ((window as unknown as { __paneFocusLog: string[] }).__paneFocusLog.length = 0))
}

test.describe("Home pane focus", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page)
    await openSession(page)
    await warmPane(page)
  })

  test("mod+b from nothing focused puts focus in the search box, keeps it, and Esc closes", async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await pressMod(page, "b")
    await expect(pane(page)).toBeVisible()
    await expectSearchKeepsFocus(page, 500)
    await page.keyboard.press("Escape")
    await expect(pane(page)).toHaveCount(0)
  })

  test("mod+b then typing goes to the search box", async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await pressMod(page, "b")
    await expect(pane(page)).toBeVisible()
    await expect(search(page)).toBeFocused()
    await page.keyboard.type("alp")
    await expect(search(page)).toHaveValue("alp")
    await expectSearchKeepsFocus(page, 500)
    await expect(composer(page)).toHaveText("")
  })

  test("mod+b from the composer moves focus to the search box; Esc in the composer keeps the pane", async ({
    page,
  }) => {
    await composer(page).click()
    await expect(composer(page)).toBeFocused()
    await pressMod(page, "b")
    await expect(pane(page)).toBeVisible()
    await expectSearchKeepsFocus(page, 500)
    await composer(page).click()
    await expect(composer(page)).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(pane(page)).toBeVisible()
  })
})
