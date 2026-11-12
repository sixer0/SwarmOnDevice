// Row 105 (1.2.6): GUIDE pins for the built-in tool-health skill text (OFF-03, SEC-17; 01c 10.1 and 11.9 item 2;
// decisions U7, U19, U21, C8). The ids, status names, reason codes, re-check file and menu label are read from the
// desktop sources that shipped them (rows 90-95, 109), so the text cannot drift from the regime.
// Registration in skill/index.ts is row 106a; this test reads the source file.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const FILE = path.join(ROOT, "opencode", "src", "skill", "tool-health.md")
const TH = path.join(ROOT, "desktop", "src", "main", "tool-health")
const TEXT = readFileSync(FILE, "utf8")
const src = (name: string) => readFileSync(path.join(TH, name), "utf8")

const block = (source: string, start: string, end: string) => {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThanOrEqual(0)
  return source.slice(from, source.indexOf(end, from))
}
const quoted = (source: string) => [...source.matchAll(/"([A-Za-z_.-]+)"/g)].map((m) => m[1])

const SHIPPED_IDS = [...src("registry.ts").matchAll(/^\s+id: "([a-z][a-z0-9-]+)",$/gm)].map((m) => m[1])
const STATUSES = quoted(block(src("types.ts"), "export type ToolHealthStatus", "\n\n"))
const REASONS = quoted(block(src("types.ts"), "export const TOOL_HEALTH_REASONS", "] as const"))
const STATE = src("state.ts")
const DIR = quoted(block(STATE, "export const TOOL_HEALTH_DIR", "\n"))
const RECHECK_FILE = /TOOL_HEALTH_RECHECK_FILE = "([^"]+)"/.exec(STATE)![1]
const STATE_FILE = /TOOL_HEALTH_STATE_FILE = "([^"]+)"/.exec(STATE)![1]
const MENU_LABEL = /"desktop\.menu\.recheckTools": "([^"]+)"/.exec(
  readFileSync(path.join(ROOT, "app", "src", "i18n", "desktop-native.ts"), "utf8"),
)![1]

describe("1.2.6 row 105 tool-health built-in skill text", () => {
  test("shipped sources read: five ids, six statuses, the reason set, the health folder", () => {
    expect(SHIPPED_IDS).toEqual(["runtime", "searxng", "firecrawl", "render-bridge", "layout-runtime"])
    expect(STATUSES.length).toBe(6)
    expect(REASONS.length).toBeGreaterThan(20)
    expect(DIR).toEqual([".swarm", "health"])
  })

  test("OFF-03: names all five shipped ids, and flux3 only as the person's own entry", () => {
    for (const id of SHIPPED_IDS) expect(TEXT).toContain(`| \`${id}\` |`)
    expect(TEXT).toContain("`flux3` is the person's own entry, not one of Swarm's tools")
  })

  test("every shipped status and reason code is explained", () => {
    for (const status of STATUSES) expect(TEXT).toContain(`| \`${status}\` |`)
    for (const reason of REASONS) expect(TEXT).toContain(`\`${reason}\``)
  })

  test("state and re-check files: paths and the request format the desktop reads", () => {
    const dir = `~/${DIR.join("/")}/`
    expect(TEXT).toContain(`\`${dir}${STATE_FILE}\``)
    expect(TEXT).toContain(`\`${dir}${RECHECK_FILE}\``)
    // recheck.ts accepts exactly these keys; anything else, an empty list or an unknown id voids the request.
    expect(src("recheck.ts")).toContain('key !== "ids" && key !== "requestedAt"')
    const example = /```json\n(\{"ids".*\})\n```/.exec(TEXT)
    expect(example).not.toBeNull()
    const request = JSON.parse(example![1]) as Record<string, unknown>
    expect(Object.keys(request).sort()).toEqual(["ids", "requestedAt"])
    expect(Array.isArray(request.ids) && request.ids.length > 0).toBe(true)
    for (const id of request.ids as string[]) expect(SHIPPED_IDS).toContain(id)
    expect(TEXT).toContain("One unknown or misspelt id makes the desktop ignore the whole request")
    expect(TEXT).toContain("Leave `ids` out to check every tool")
    expect(TEXT).toContain("The desktop app takes the file and removes it")
  })

  test("SEC-05/C8: an agent re-check never starts a consent manual tool; the person uses the menu item", () => {
    expect(src("regime.ts")).toContain('c.consent === "manual" && !(request.trigger === "person"')
    expect(TEXT).toContain("A re-check you request never starts a `consent: \"manual\"` tool")
    expect(TEXT).toContain(`**${MENU_LABEL}**`)
  })

  test("OFF-03/C8/SEC-04: never installs, never writes tool-health.json or state.json, proposes entries", () => {
    expect(TEXT).toContain("Swarm never installs a tool on its own")
    expect(TEXT).toContain("never installs")
    expect(TEXT).toContain("Never write `~/.config/swarm/tool-health.json`")
    expect(TEXT).toContain("propose the entry in your final message and let the person add it")
    expect(TEXT).toContain("The desktop app is the only place that starts tools")
  })

  test("SEC-17: loopback curl probes are for interactive sessions only", () => {
    expect(TEXT).toContain("interactive sessions only")
    expect(TEXT).toContain("never set a Host header")
  })

  test("generic text: no machine path, no secret word, no install or start command", () => {
    for (const s of ["/Users/", "Default Project", "gui/501", "Codex", "flux3.py"]) expect(TEXT).not.toContain(s)
    expect(TEXT).not.toMatch(/token/i)
    for (const re of [
      /\b(swarm-setup|brew|pip3?|npm|bun|pnpm|apt(-get)?|port|uv)\s+(install|apply|add|upgrade|remove)\b/i,
      /docker\s+(compose\s+)?(up|start|pull|create|run)\b/i,
      /colima\s+(start|restart)\b/i,
      /launchctl\s+(submit|kickstart|load|bootstrap|start)\b/i,
      /swarm-setup\s+start\b/i,
    ])
      expect(TEXT).not.toMatch(re)
  })

  test("built-in shape: a top heading, no frontmatter, a reasonable size", () => {
    expect(TEXT.startsWith("# ")).toBe(true)
    expect(Buffer.byteLength(TEXT)).toBeLessThan(16_000)
  })
})
