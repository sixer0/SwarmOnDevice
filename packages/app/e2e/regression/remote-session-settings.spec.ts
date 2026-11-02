import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { currentSession } from "../utils/mock-server"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = session("ses_server_b", directoryB, "Server B session")

test("session settings use the remote server context", async ({ page }) => {
  const autonomyWrites: AutonomyWrite[] = []
  await mockServers(page, autonomyWrites)
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  await page.keyboard.press("Control+,")

  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  // Decision C62: autonomous mode is not in Settings; the add menu, the palette and mod+shift+a change it.
  await expect(dialog.locator('[data-action="settings-autonomous-mode"]')).toHaveCount(0)
  expect(autonomyWrites).toEqual([])

  await dialog.getByRole("tab", { name: "Models" }).click()
  await expect(dialog.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
  await expect(dialog.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
})

test("the shortcut changes the mode for the server and the session it was pressed in", async ({ page }) => {
  const autonomyWrites: AutonomyWrite[] = []
  await mockServers(page, autonomyWrites)
  await configureServers(page, [
    { type: "session", server: serverA, sessionId: sessionA.id },
    { type: "session", server: serverB, sessionId: sessionB.id },
  ])

  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByText(sessionA.title).first()).toBeVisible()
  await page.keyboard.press("Control+Shift+A")
  await expect.poll(() => autonomyWrites).toEqual([
    { origin: serverA, directory: directoryA, body: { on: true, sessionID: sessionA.id } },
  ])

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`).click()
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  // Server B's session was never turned on, so the same shortcut turns it on there rather than off.
  await page.keyboard.press("Control+Shift+A")
  await expect.poll(() => autonomyWrites).toEqual([
    { origin: serverA, directory: directoryA, body: { on: true, sessionID: sessionA.id } },
    { origin: serverB, directory: directoryB, body: { on: true, sessionID: sessionB.id } },
  ])
})

type AutonomyWrite = {
  origin: string
  directory?: string
  body: unknown
}

async function configureServers(page: Page, tabs: { type: "session"; server: string; sessionId: string }[] = []) {
  await page.addInitScript(
    ({ serverB, tabs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [serverB] }))
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverB, tabs },
  )
}

async function mockServers(page: Page, autonomyWrites: AutonomyWrite[]) {
  // Only the server holds the mode, per server and session: what the app shows has to come from here.
  const autonomous = new Set<string>()
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = remote ? [sessionB] : [sessionA, childSessionA]
    const requestDirectory = url.searchParams.get("directory")
    if (requestDirectory && requestDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/autonomy/mode" && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { on: boolean; sessionID: string }
      autonomyWrites.push({ origin: url.origin, directory: requestDirectory ?? undefined, body })
      if (body.on) autonomous.add(`${url.origin}/${body.sessionID}`)
      if (!body.on) autonomous.delete(`${url.origin}/${body.sessionID}`)
      return json(route, { on: body.on, externalChange: [] })
    }
    const autonomySession = url.pathname.match(/^\/session\/([^/]+)\/autonomy$/)
    if (autonomySession)
      return json(route, {
        rootID: autonomySession[1],
        on: autonomous.has(`${url.origin}/${autonomySession[1]}`),
        externalChange: [],
        open: 0,
        lines: [],
        intact: true,
        problems: [],
        notFromHere: 0,
      })
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    if (url.pathname === "/global/health") return json(route, { healthy: true })
    if (url.pathname === "/api/provider" || url.pathname === "/api/model" || url.pathname === "/api/agent")
      return json(route, { data: [] })
    if (url.pathname === "/api/model/default") return json(route, { data: null })
    if (["/api/command", "/api/reference", "/api/permission/request", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          worktree: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory })
    if (url.pathname === "/api/session") return json(route, { data: sessions.map(currentSession), cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    const current = sessions.find((session) => url.pathname === `/session/${session.id}`)
    if (current) return json(route, current)
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (
      ["/permission", "/skill", "/command", "/lsp", "/formatter", "/question", "/vcs/diff", "/pty/shells"].includes(
        url.pathname,
      )
    )
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider") return json(route, provider(remote ? "server-b" : "server-a"))
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = {
        id: remote ? sessionB.projectID : "project-server-a",
        worktree: directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, {
        state: directory,
        config: directory,
        worktree: directory,
        directory,
        home: directory,
      })
    if (url.pathname === "/api/path")
      return json(route, { state: directory, config: directory, worktree: directory, directory, home: directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
