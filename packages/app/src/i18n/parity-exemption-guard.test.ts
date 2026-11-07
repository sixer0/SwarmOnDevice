import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Self-check for the narrow i18n parity exemption declared in `parity.test.ts`.
//
// Why this file exists: the exemption is a deliberate, bounded weakening of a completeness invariant
// (branch B of the 2026-10-21 decision in
// `docs/2026-10-19_opencode_swarm_rebrand/decisions/decisions.md`). Its safety depends entirely on
// staying bounded — one hundred and forty-nine entries as of row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (five more for the document preview inside the existing file tab, decision U12, studio spec §8.2), one hundred and forty-four entries as of row 34b of docs/2026-11-06_swarm_1_2_0_datum_installer (seven more for the native Install DATUM Studio for Claude menu item and dialogs, decisions C63/C64), one hundred and thirty-seven entries as of row 54 of docs/2026-11-02_swarm_system_patch_updates (twenty-five more for the native Update from File and Undo Last Update menu items and dialogs, register BN-30..BN-54), one hundred and twelve entries as of decision P12 (two more for the 1.1.1 healing loop F3: the not-bypassed hint and its palette command), one hundred and ten as of decision P6 (forty-two more for 1.1.1: consent dialog, Decisions view, session switcher) of docs/2026-11-03_swarm_1_1_1_patch, sixty-eight as of decision C121 (Install Command Line Tool), sixty-one as of row 162 (U11 archive row), sixty as of row 246 (U14 fix pass, C80 and C82), fifty-four as of row 228 (register U14, gate G-U14), forty-four as of row 159 (register U11, gate G-U11) of the 2026-11-01 Knowledge Library
// task, up from thirty-six since its decision C62 of the 2026-11-01 Knowledge Library task removed one,
// thirty-seven as of its row 77, up from thirty-six
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
  "toast.permissions.autonomous.scan.title",
  "session.autonomy.consent.title",
  "session.autonomy.consent.allow",
  "session.autonomy.consent.named",
  "session.autonomy.archive.title",
  "session.autonomy.archive.empty",
  "session.autonomy.archive.confirm",
  "session.autonomy.archive.unsafe",
  "settings.general.row.autonomous.scripts",
  "dialog.tools.title",
  "dialog.tools.body",
  "dialog.tools.terms",
  "dialog.tools.install",
  "dialog.tools.later",
  "dialog.tools.terminal",
  "dialog.tools.healthy",
  "dialog.tools.skipped",
  "dialog.tools.failed",
  "command.tools.install",
  "dialog.tools.retryIn",
  "desktop.setupTools.confirm.title",
  "desktop.setupTools.confirm.message",
  "desktop.setupTools.confirm.detail",
  "desktop.setupTools.confirm.install",
  "desktop.setupTools.confirm.cancel",
  "desktop.menu.installCli",
  "desktop.cli.confirm.message",
  "desktop.cli.confirm.detail",
  "desktop.cli.done.message",
  "desktop.cli.done.detail",
  "desktop.cli.done.pathHint",
  "desktop.cli.failed.message",
  "dialog.autonomyBypass.title",
  "dialog.autonomyBypass.intro",
  "dialog.autonomyBypass.archive",
  "dialog.autonomyBypass.refused",
  "dialog.autonomyBypass.waits",
  "dialog.autonomyBypass.secrets",
  "dialog.autonomyBypass.report",
  "dialog.autonomyBypass.scope",
  "dialog.autonomyBypass.accept",
  "session.map.decisions.group.history",
  "session.map.decisions.details.show",
  "session.map.decisions.details.hide",
  "session.map.decisions.by.mainAgent",
  "session.map.decisions.by.rules",
  "session.map.decisions.by.model",
  "session.map.decisions.state.waiting",
  "session.map.decisions.state.allowed",
  "session.map.decisions.state.refused",
  "session.map.decisions.state.stopped",
  "session.map.decisions.what.bash",
  "session.map.decisions.what.edit",
  "session.map.decisions.what.read",
  "session.map.decisions.what.outside",
  "session.map.decisions.what.web",
  "session.map.decisions.what.other",
  "session.map.decisions.category.irreversible",
  "session.map.decisions.category.admin_rights",
  "session.map.decisions.category.outside_write_held",
  "session.map.decisions.category.system_service",
  "session.map.decisions.category.process_not_own",
  "session.map.decisions.category.unreadable_command",
  "session.map.decisions.category.by_main_agent",
  "session.map.decisions.category.delete_compound",
  "session.map.decisions.category.credential_change",
  "session.map.decisions.category.script_flagged",
  "session.map.decisions.category.archived",
  "session.map.decisions.note.bypassOn",
  "session.map.decisions.note.report",
  "session.header.sessions.label",
  "session.header.sessions.empty",
  "session.header.sessions.current",
  "session.header.sessions.open",
  "session.autonomy.notBypassed",
  "command.permissions.autonomous.reconsent",
  "desktop.menu.updateFromFile",
  "desktop.menu.undoLastUpdate",
  "desktop.patch.picker.title",
  "desktop.patch.picker.filter",
  "desktop.patch.cancel",
  "desktop.patch.invalid.message",
  "desktop.patch.invalid.detail",
  "desktop.patch.newKey.message",
  "desktop.patch.newKey.detail",
  "desktop.patch.confirm.message",
  "desktop.patch.confirm.detail",
  "desktop.patch.confirm.migration",
  "desktop.patch.confirm.update",
  "desktop.patch.undo.confirm.message",
  "desktop.patch.undo.confirm.detail",
  "desktop.patch.undo.confirm.undo",
  "desktop.patch.undo.none.message",
  "desktop.patch.undo.blocked.message",
  "desktop.patch.undo.blocked.detail",
  "desktop.patch.result.updated.message",
  "desktop.patch.result.undone.message",
  "desktop.patch.result.failed.message",
  "desktop.patch.result.failed.detail",
  "desktop.patch.result.running.detail",
  "desktop.patch.result.recover.detail",
  "desktop.menu.installDatumStudio",
  "desktop.datumStudio.confirm.message",
  "desktop.datumStudio.confirm.detail",
  "desktop.datumStudio.done.message",
  "desktop.datumStudio.done.detail",
  "desktop.datumStudio.done.pathHint",
  "desktop.datumStudio.failed.message",
  "file.preview.showSource",
  "file.preview.showPreview",
  "file.preview.companion",
  "file.preview.docxHint",
  "file.preview.none",
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

  test("the exemption holds exactly the hundred-and-forty-nine approved keys and nothing else", () => {
    expect([...exemptKeys].sort()).toEqual([...APPROVED_EXEMPT_KEYS].sort())
    expect(exemptKeys.length).toBe(149)
    expect(new Set(exemptKeys).size).toBe(149)
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
          "toast.permissions.autonomous.scan.title",
          "session.autonomy.consent.title",
          "session.autonomy.consent.allow",
          "session.autonomy.consent.named",
          "session.autonomy.archive.title",
          "session.autonomy.archive.empty",
          "session.autonomy.archive.confirm",
          "session.autonomy.archive.unsafe",
          "settings.general.row.autonomous.scripts",
          "dialog.tools.title",
          "dialog.tools.body",
          "dialog.tools.terms",
          "dialog.tools.install",
          "dialog.tools.later",
          "dialog.tools.terminal",
          "dialog.tools.healthy",
          "dialog.tools.skipped",
          "dialog.tools.failed",
          "command.tools.install",
          "dialog.tools.retryIn",
          "desktop.setupTools.confirm.title",
          "desktop.setupTools.confirm.message",
          "desktop.setupTools.confirm.detail",
          "desktop.setupTools.confirm.install",
          "desktop.setupTools.confirm.cancel",
          "desktop.menu.installCli",
          "desktop.cli.confirm.message",
          "desktop.cli.confirm.detail",
          "desktop.cli.done.message",
          "desktop.cli.done.detail",
          "desktop.cli.done.pathHint",
          "desktop.cli.failed.message",
          "dialog.autonomyBypass.title",
          "dialog.autonomyBypass.intro",
          "dialog.autonomyBypass.archive",
          "dialog.autonomyBypass.refused",
          "dialog.autonomyBypass.waits",
          "dialog.autonomyBypass.secrets",
          "dialog.autonomyBypass.report",
          "dialog.autonomyBypass.scope",
          "dialog.autonomyBypass.accept",
          "session.map.decisions.group.history",
          "session.map.decisions.details.show",
          "session.map.decisions.details.hide",
          "session.map.decisions.by.mainAgent",
          "session.map.decisions.by.rules",
          "session.map.decisions.by.model",
          "session.map.decisions.state.waiting",
          "session.map.decisions.state.allowed",
          "session.map.decisions.state.refused",
          "session.map.decisions.state.stopped",
          "session.map.decisions.what.bash",
          "session.map.decisions.what.edit",
          "session.map.decisions.what.read",
          "session.map.decisions.what.outside",
          "session.map.decisions.what.web",
          "session.map.decisions.what.other",
          "session.map.decisions.category.irreversible",
          "session.map.decisions.category.admin_rights",
          "session.map.decisions.category.outside_write_held",
          "session.map.decisions.category.system_service",
          "session.map.decisions.category.process_not_own",
          "session.map.decisions.category.unreadable_command",
          "session.map.decisions.category.by_main_agent",
          "session.map.decisions.category.delete_compound",
          "session.map.decisions.category.credential_change",
          "session.map.decisions.category.script_flagged",
          "session.map.decisions.category.archived",
          "session.map.decisions.note.bypassOn",
          "session.map.decisions.note.report",
          "session.header.sessions.label",
          "session.header.sessions.empty",
          "session.header.sessions.current",
          "session.header.sessions.open",
          "session.autonomy.notBypassed",
          "command.permissions.autonomous.reconsent",
          "desktop.menu.updateFromFile",
          "desktop.menu.undoLastUpdate",
          "desktop.patch.picker.title",
          "desktop.patch.picker.filter",
          "desktop.patch.cancel",
          "desktop.patch.invalid.message",
          "desktop.patch.invalid.detail",
          "desktop.patch.newKey.message",
          "desktop.patch.newKey.detail",
          "desktop.patch.confirm.message",
          "desktop.patch.confirm.detail",
          "desktop.patch.confirm.migration",
          "desktop.patch.confirm.update",
          "desktop.patch.undo.confirm.message",
          "desktop.patch.undo.confirm.detail",
          "desktop.patch.undo.confirm.undo",
          "desktop.patch.undo.none.message",
          "desktop.patch.undo.blocked.message",
          "desktop.patch.undo.blocked.detail",
          "desktop.patch.result.updated.message",
          "desktop.patch.result.undone.message",
          "desktop.patch.result.failed.message",
          "desktop.patch.result.failed.detail",
          "desktop.patch.result.running.detail",
          "desktop.patch.result.recover.detail",
          "desktop.menu.installDatumStudio",
          "desktop.datumStudio.confirm.message",
          "desktop.datumStudio.confirm.detail",
          "desktop.datumStudio.done.message",
          "desktop.datumStudio.done.detail",
          "desktop.datumStudio.done.pathHint",
          "desktop.datumStudio.failed.message",
          "file.preview.showSource",
          "file.preview.showPreview",
          "file.preview.companion",
          "file.preview.docxHint",
          "file.preview.none",
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
