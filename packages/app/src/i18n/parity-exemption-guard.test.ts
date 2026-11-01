import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Self-check for the narrow i18n parity exemption declared in `parity.test.ts`.
//
// Why this file exists: the exemption is a deliberate, bounded weakening of a completeness invariant
// (branch B of the 2026-10-21 decision in
// `docs/2026-10-19_opencode_swarm_rebrand/decisions/decisions.md`). Its safety depends entirely on
// staying bounded — thirty-seven entries as of row 77 of the 2026-11-01 Knowledge Library task, up from thirty-six
// at its decision C18, twelve at its decision C2, ten at blueprint-11 row 249 (session 6), nine at row 204 and the original three.
// This guard is the mechanism that keeps the exception from becoming the norm: any entry beyond the
// approved set, any wildcard, or any relaxation of the `missing: []` assertion fails the suite here
// instead of quietly passing the gate it is supposed to police.
//
// It reads the gate's source text on purpose. Importing `parity.test.ts` would re-register its tests
// inside this file, and the guard must bite even if someone edits the list into something the gate
// itself would happily accept.

const gateSource = readFileSync(join(import.meta.dir, "parity.test.ts"), "utf8")

const APPROVED_EXEMPT_KEYS = [
  "command.project.openNumber",
  "settings.tab.servers",
  "ui.toast.ariaLabel",
  "setup.status.installed",
  "setup.status.registered",
  "setup.status.visible",
  "setup.status.used",
  "setup.status.notClaimed",
  "mcp.status.needs_client_registration",
  "setup.lanes.apply_warning",
  "settings.general.row.knowledgeLibrary.title",
  "settings.general.row.knowledgeLibrary.description",
  "settings.general.row.autonomous.title",
  "settings.general.row.autonomous.description",
  "settings.general.row.autonomous.disabledReason",
  "command.permissions.autonomous.enable",
  "command.permissions.autonomous.disable",
  "toast.permissions.autonomous.on.title",
  "toast.permissions.autonomous.off.title",
  "session.autonomy.marker",
  "session.map.filter.decisions",
  "session.map.decisions.group.waiting",
  "session.map.decisions.group.decided",
  "session.map.decisions.group.limited",
  "session.map.decisions.category.not_routine",
  "session.map.decisions.category.queue_full",
  "session.map.decisions.category.decider_unavailable",
  "session.map.decisions.category.folder_not_trusted",
  "session.map.decisions.category.plan_mode",
  "session.map.decisions.category.app_state",
  "session.map.decisions.category.asks_every_time",
  "session.map.decisions.outcome.ran",
  "session.map.decisions.outcome.notRun",
  "session.map.decisions.undo.confirm",
  "session.map.decisions.marker.externalChange",
  "notification.autonomy.blocked",
  "ui.messagePart.notRun.deferred",
]

function arrayLiteral(name: string) {
  const declaration = new RegExp(`const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`)
  const match = gateSource.match(declaration)
  if (!match) {
    throw new Error(
      `parity.test.ts no longer declares "const ${name}: readonly string[] = [...]" exactly as this guard expects. ` +
        `Either the exemption was retired (then delete this file in the same commit) or its shape changed (then update both files deliberately).`,
    )
  }
  return [...match[1].matchAll(/"([^"]*)"/g)].map((found) => found[1])
}

describe("i18n parity exemption guard", () => {
  const exemptKeys = arrayLiteral("UNTRANSLATED_KEY_PRESENCE_EXEMPTION")

  test("the exemption holds exactly the thirty-seven approved keys and nothing else", () => {
    expect([...exemptKeys].sort()).toEqual([...APPROVED_EXEMPT_KEYS].sort())
    expect(exemptKeys.length).toBe(37)
    expect(new Set(exemptKeys).size).toBe(37)
  })

  test("every exemption entry is a literal dotted key, never a wildcard or pattern", () => {
    for (const key of exemptKeys) {
      // Underscores are allowed inside segments because the gate-approved key
      // `mcp.status.needs_client_registration` (decisions.md gate-195 item (i)) spells its union member that way;
      // segments must still start with a letter, so wildcards, brackets, spaces and slashes stay rejected.
      expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/)
    }
  })

  test("`en` and `id` stay outside the exemption", () => {
    expect(arrayLiteral("NEVER_EXEMPT_LOCALES").sort()).toEqual(["en", "id"])
  })

  test("the exemption can only relieve the presence filter, nothing else in the gate", () => {
    // Two occurrences means the helper declaration plus the single `missing` call site in the first
    // parity test. A third would mean the exemption reached the placeholder, plural or `extra` checks.
    expect(gateSource.split("exemptFromPresence").length - 1).toBe(2)
    // Both completeness assertions must still demand a literally empty `missing` array. If either one
    // became a threshold (`missing.slice`, `missing.length`), the exemption would start absorbing real
    // drift instead of only the named keys.
    expect(gateSource.split("missing: []").length - 1).toBe(2)
    expect(gateSource).not.toMatch(/missing\.(slice|length|filter|some|every)/)
  })

  test("the source locale `en` still carries every exempted key in its own domain", async () => {
    // If a key ever disappeared from `en.ts`, the parity gate could not notice: `missing` is computed
    // from `Object.keys(source)`. That would leave the call site announcing the raw key string —
    // precisely the regression row 170 measured (`packages/ui/src/v2/components/toast-v2.tsx:21`).
    const sources = [
      {
        domain: "app",
        file: "./en.ts",
        keys: [
          "command.project.openNumber",
          "settings.tab.servers",
          "setup.status.installed",
          "setup.status.registered",
          "setup.status.visible",
          "setup.status.used",
          "setup.status.notClaimed",
          "mcp.status.needs_client_registration",
          "setup.lanes.apply_warning",
          "settings.general.row.knowledgeLibrary.title",
          "settings.general.row.knowledgeLibrary.description",
          "settings.general.row.autonomous.title",
          "settings.general.row.autonomous.description",
          "settings.general.row.autonomous.disabledReason",
          "command.permissions.autonomous.enable",
          "command.permissions.autonomous.disable",
          "toast.permissions.autonomous.on.title",
          "toast.permissions.autonomous.off.title",
          "session.autonomy.marker",
          "session.map.filter.decisions",
          "session.map.decisions.group.waiting",
          "session.map.decisions.group.decided",
          "session.map.decisions.group.limited",
          "session.map.decisions.category.not_routine",
          "session.map.decisions.category.queue_full",
          "session.map.decisions.category.decider_unavailable",
          "session.map.decisions.category.folder_not_trusted",
          "session.map.decisions.category.plan_mode",
          "session.map.decisions.category.app_state",
          "session.map.decisions.category.asks_every_time",
          "session.map.decisions.outcome.ran",
          "session.map.decisions.outcome.notRun",
          "session.map.decisions.undo.confirm",
          "session.map.decisions.marker.externalChange",
          "notification.autonomy.blocked",
        ],
      },
      {
        domain: "ui",
        file: "../../../ui/src/i18n/en.ts",
        keys: ["ui.toast.ariaLabel", "ui.messagePart.notRun.deferred"],
      },
    ]
    for (const source of sources) {
      await testEnCarriesKeys(source)
    }
  })
})

async function testEnCarriesKeys(source: { domain: string; file: string; keys: string[] }) {
  const dict: Record<string, string> = (await import(source.file)).dict
  for (const key of source.keys) {
    expect({ domain: source.domain, key, present: Object.hasOwn(dict, key) }).toEqual({
      domain: source.domain,
      key,
      present: true,
    })
    expect(dict[key].trim()).not.toBe("")
    expect(dict[key]).not.toBe(key)
  }
}
