// Swarm 1.2.6 fix row FX-10 (gate 04 F4): the person-facing tool-health messages must name a place that exists.
// There is no "Settings > Tools" page: tools are installed through the "Install tools" command (command palette,
// Settings category; app install-tools-command.tsx, en.ts "command.tools.install") or the tools offer Swarm shows
// after an install or update (setup-tools-offer.tsx). Red before FX-10: NOT_INSTALLED and START_CONTAINERS_MISSING
// pointed to "Settings > Tools".
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { toolHealthMessage } from "./regime"
import { TOOL_HEALTH_REASONS } from "./types"

const EN = readFileSync(path.join(import.meta.dir, "..", "..", "..", "..", "app", "src", "i18n", "en.ts"), "utf8")
const COMMAND = /"command\.tools\.install": "([^"]+)"/.exec(EN)![1]
const CATEGORY = /"command\.category\.settings": "([^"]+)"/.exec(EN)![1]
const tool = { id: "searxng", label: "Web search (SearXNG)" }

describe("FX-10 F4: tool-health messages route to the real installer", () => {
  test("no message names a Settings > Tools page", () => {
    for (const reason of TOOL_HEALTH_REASONS) expect(toolHealthMessage(tool, reason, "x", { seconds: 1, dep: "runtime" })).not.toContain("Settings > Tools")
  })

  test("NOT_INSTALLED and START_CONTAINERS_MISSING name the Install tools command in the Settings category", () => {
    expect(COMMAND).toBe("Install tools")
    expect(CATEGORY).toBe("Settings")
    for (const reason of ["NOT_INSTALLED", "START_CONTAINERS_MISSING"] as const) {
      const text = toolHealthMessage(tool, reason, "")
      expect(text).toContain(`"${COMMAND}" command (command palette, ${CATEGORY})`)
    }
  })
})
