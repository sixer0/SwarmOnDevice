import { describe, expect, test } from "bun:test"
import { desktopNativePluralCategories } from "./desktop-native"

const appLocales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "uk",
  "th",
  "tr",
  "zh",
  "zht",
  "hi",
  "nl",
  "id",
  "vi",
  "it",
  "ur",
  "pa",
  "az",
  "fi",
  "sv",
  "am",
  "bg",
  "bn",
  "ca",
  "cs",
  "dv",
  "dz",
  "el",
  "et",
  "fa",
  "fo",
  "hr",
  "hu",
  "hy",
  "is",
  "ka",
  "km",
  "lo",
  "lt",
  "lv",
  "mk",
  "mn",
  "ms",
  "my",
  "ne",
  "ro",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "tg",
  "tk",
  "uz",
] as const
const desktopLocales = appLocales
const pluralCategories = new Map(
  appLocales.map(
    (locale) =>
      [
        locale,
        desktopNativePluralCategories(locale).filter((category) => category !== "one" && category !== "other"),
      ] as const,
  ),
)

// Narrow presence-only exemption, branch B of the 2026-10-21 i18n propagation decision
// (`docs/2026-10-19_opencode_swarm_rebrand/decisions/decisions.md`: "A if a credential exists, else B";
// no credential was supplied). Keys landed in the `en` and `id` tables only, ahead of the translation
// lane, so this list excuses PRESENCE of exactly those keys in every locale other than `en` and `id`.
// It does not change what any other assertion checks: values, placeholders, plural variants and `extra`
// keys are still enforced for these same keys once a locale carries them. Proper closure is
// `bun run translate:app -- all`, which translates them and retires this list.
// Deliberate batches live here, each real in `en`+`id` and absent in the other 60 locales:
//   - the original three (branch B): `command.project.openNumber` and `settings.tab.servers` (app
//     table) plus `ui.toast.ariaLabel` (ui table — row 170's accessible region name, see
//     packages/ui/src/v2/components/toast-v2.tsx:21);
//   - six more landed by blueprint-10 row 204 (session 6, CONTROLLER GATE ruling (i) in decisions.md):
//     the Home status card's four level names plus its level-4 non-claim (`setup.status.installed`,
//     `.registered`, `.visible`, `.used`, `.notClaimed`) and the freed sixth slot
//     `mcp.status.needs_client_registration`, which also repairs the dangling key referenced at
//     packages/app/src/components/dialog-select-mcp.tsx:13;
//   - one more by blueprint-11 row 249 (session 6, USER DECISIONS 2026-10-22 item 1: the i18n cap moved
//     six → seven by explicit user decision, spent entirely on the apply-consequence sentence
//     `setup.lanes.apply_warning` shown by the lane controls on the Home card);
//   - two more for the Knowledge Library row in Settings (`settings.general.row.knowledgeLibrary.title`
//     and `.description`, decision C2 in `docs/2026-11-01_knowledge_library_default/decisions/decisions.md`);
//   - twenty-three more for autonomous mode (`settings.general.row.autonomous.*`, `command.permissions.autonomous.*`,
//     `toast.permissions.autonomous.*`, `session.autonomy.marker`, `session.map.filter.decisions`,
//     `session.map.decisions.*` and `notification.autonomy.blocked`, decision C18 in the same file, widening C2;
//     one fewer since decision C62 removed the Settings row and its disabled reason);
//   - one more for a held decision's timeline row (`ui.messagePart.notRun.deferred`, routed by the controller to row 77
//     of the same task);
//   - eight more for the U11 autonomy rules (`toast.permissions.autonomous.scan.title`, `session.autonomy.consent.*`,
//     `session.autonomy.archive.*` and `settings.general.row.autonomous.scripts`, register U11 approved at gate G-U11,
//     row 159 of the same task);
//   - ten more for the U14 tools dialog (`dialog.tools.*` and `command.tools.install`, register U14 approved at
//     gate G-U14, row 228 of the same task);
//   - one more for the tools dialog's retry countdown (`dialog.tools.retryIn`, senior finding 4 of row 239, U14 fix
//     pass row 246 under decision C82 of the same task);
//   - five more for main's native install confirmation (`desktop.setupTools.confirm.*`, security finding F1 of row
//     238, decision C80; requested by row 245 and written by row 246 of the same task);
//   - one more for the archive row's mark on an archive that is a link (`session.autonomy.archive.unsafe`, row 162
//     of the same task, the archive route's `unsafe` field from row 152).
//   - seven more for main's native Install Command Line Tool menu and dialogs (`desktop.menu.installCli`,
//     `desktop.cli.*`, decision C121 of the same task).
//   - forty-two more for 1.1.1 (consent dialog, Decisions view, session switcher), decision P6 of
//     docs/2026-11-03_swarm_1_1_1_patch (`dialog.autonomyBypass.*`, `session.map.decisions.*` additions and
//     `session.header.sessions.*`).
//   - two more for the 1.1.1 healing loop F3, decision P12 of the same task: the composer's hint when the mode is on
//     but approvals are not bypassed (`session.autonomy.notBypassed`) and its palette command
//     (`command.permissions.autonomous.reconsent`).
//   - twenty-five more for main's native Update from File and Undo Last Update menu items and their dialogs
//     (`desktop.menu.updateFromFile`, `desktop.menu.undoLastUpdate`, `desktop.patch.*`), register BN-30..BN-54 with
//     section 14.5 of docs/2026-11-02_swarm_system_patch_updates, row 54.
//   - seven more for main's native Install DATUM Studio for Claude menu item and dialogs
//     (`desktop.menu.installDatumStudio`, `desktop.datumStudio.*`), decisions C63/C64 of
//     docs/2026-11-06_swarm_1_2_0_datum_installer (EN and ID only), row 34b.
//   - five more for the document preview inside the existing file tab (`file.preview.*`), decision U12 and studio
//     spec §8.2 of the same task (EN and ID only), row 112.
//   - fifty-seven more for mission control (`session.mission.*`), decision C127 (3) of the same task (EN and ID only),
//     row 128.
//   - two more for the mission control expand toggle (`session.mission.expand`, `session.mission.collapse`), decision
//     C175 of the same task (EN and ID only), row 133b.
//   - three more for the Mission Control empty and unavailable states (`session.mission.empty`, `emptyHint`,
//     `unavailable`), row 180 of the same task (EN and ID only).
//   - two more for the Mission Control not-started and paused status line (`session.mission.line.notStarted`,
//     `session.mission.line.paused`), row 190 (decision L48) of docs/2026-11-05_swarm_linux_installer_patcher
//     (EN and ID only).
//   - two more for the Claude Code compatibility switch in Settings (`settings.general.row.claudeCompat.title`,
//     `.description`), row 192 (decision L49, spec 191 §2.2) of the same task (EN and ID only).
//   - two more for the Mission Control approved-not-started line and the self-approved (autonomous) label
//     (`session.mission.line.approvedNotStarted`, `session.mission.approval.autonomous`), row 197 (decision L57,
//     security finding S194-03) of the same task (EN and ID only).
//   - four more for 1.2.6 (row 109 of docs/2026-11-12_swarm_1_2_6_patch, UX-03): the Mission Control drift line
//     (`session.mission.line.drift`, MC-09) and the checkpoint group with its Revert action and confirm
//     (`session.autonomy.checkpoint.title`, `.revert`, `.confirm`, P-01c), EN and ID only.
// Widening this list is a decision, not drift: `parity-exemption-guard.test.ts` fails the suite on any
// two-hundred-and-twenty-second entry, on any non-literal/wildcard, and if `en` or `id` ever stops carrying an exempt key.
const UNTRANSLATED_KEY_PRESENCE_EXEMPTION: readonly string[] = [
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
  "session.mission.title",
  "session.mission.select",
  "session.mission.hq",
  "session.mission.you",
  "session.mission.swarm",
  "session.mission.readFailed",
  "session.mission.type.research",
  "session.mission.type.debug",
  "session.mission.type.featureRelease",
  "session.mission.type.document",
  "session.mission.status.draft",
  "session.mission.status.approved",
  "session.mission.status.running",
  "session.mission.status.paused",
  "session.mission.status.done",
  "session.mission.agent.running",
  "session.mission.agent.review",
  "session.mission.agent.issue",
  "session.mission.agent.blocked",
  "session.mission.agent.done",
  "session.mission.agent.waiting",
  "session.mission.agent.aria",
  "session.mission.decision.beacon",
  "session.mission.decision.open",
  "session.mission.decision.recommended",
  "session.mission.decision.answered",
  "session.mission.decision.recorded",
  "session.mission.decision.more",
  "session.mission.decision.failed",
  "session.mission.dock.decisions",
  "session.mission.dock.files",
  "session.mission.command",
  "session.mission.command.onTrack",
  "session.mission.command.held",
  "session.mission.feed.agent",
  "session.mission.chip.why",
  "session.mission.chip.unblock",
  "session.mission.unblock.text",
  "session.mission.why.none",
  "session.mission.why.list",
  "session.mission.input.placeholder",
  "session.mission.input.aria",
  "session.mission.input.send",
  "session.mission.input.tooLong",
  "session.mission.input.failed",
  "session.mission.detail.deliverable",
  "session.mission.deliverables",
  "session.mission.deliverables.final",
  "session.mission.deliverable.draft",
  "session.mission.deliverable.review",
  "session.mission.deliverable.final",
  "session.mission.deliverable.verified",
  "session.mission.deliverable.unverified",
  "session.mission.deliverable.notInProject",
  "session.mission.deliverable.open",
  "session.mission.prompt.answer",
  "session.mission.prompt.instruction",
  "session.mission.expand",
  "session.mission.collapse",
  "session.mission.empty",
  "session.mission.emptyHint",
  "session.mission.unavailable",
  "session.mission.line.notStarted",
  "session.mission.line.paused",
  "settings.general.row.claudeCompat.title",
  "settings.general.row.claudeCompat.description",
  "session.mission.line.approvedNotStarted",
  "session.mission.approval.autonomous",
  "session.mission.line.drift",
  "session.autonomy.checkpoint.title",
  "session.autonomy.checkpoint.revert",
  "session.autonomy.checkpoint.confirm",
]
// Locales the exemption never applies to. `en` is every domain's source, and `id` is the second
// maintained locale: it already carries every exempt key, so it stays fully enforced like the rest.
const NEVER_EXEMPT_LOCALES: readonly string[] = ["en", "id"]

function exemptFromPresence(key: string, locale: string) {
  return UNTRANSLATED_KEY_PRESENCE_EXEMPTION.includes(key) && !NEVER_EXEMPT_LOCALES.includes(locale)
}

const domains = [
  {
    name: "app",
    source: "./en.ts",
    target: (locale: string) => `./${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "ui",
    source: "../../../ui/src/i18n/en.ts",
    target: (locale: string) => `../../../ui/src/i18n/${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "desktop",
    source: "../../../desktop/src/renderer/i18n/en.ts",
    target: (locale: string) => `../../../desktop/src/renderer/i18n/${locale}.ts`,
    locales: desktopLocales,
  },
] as const

describe("i18n parity", () => {
  test("non-English locales have every English key and required plural variants", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = Object.keys(source).filter(
          (key) => !Object.hasOwn(target, key) && !exemptFromPresence(key, locale),
        )
        const extra = Object.keys(target)
          .filter((key) => !Object.hasOwn(source, key))
          .sort()
        const expected = pluralFamilies(source)
          .flatMap((key) => (pluralCategories.get(locale) ?? []).map((category) => `${key}.${category}`))
          .sort()
        expect({ domain: domain.name, locale, missing, extra }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          extra: expected,
        })
      }
    }
  })

  test("non-English locales preserve English placeholders", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const mismatched = Object.keys(source).filter(
          (key) => Object.hasOwn(target, key) && placeholders(source[key]).join() !== placeholders(target[key]).join(),
        )
        const pluralMismatched = pluralFamilies(source).flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join()),
        )
        expect({ domain: domain.name, locale, mismatched, pluralMismatched }).toEqual({
          domain: domain.name,
          locale,
          mismatched: [],
          pluralMismatched: [],
        })
      }
    }
  })

  test("non-English locales translate targeted unseen session keys", async () => {
    const source = await dictionary("./en.ts")
    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"]) {
        expect(target[key]).toBeDefined()
        expect(target[key]).not.toBe(source[key])
      }
    }
  })

  test("changed-file summary keys preserve rendered English copy and localize complete phrases", async () => {
    const source = await dictionary("../../../ui/src/i18n/en.ts")
    expect(source["ui.sessionTurn.diffs.changed.one"].replace("{{count}}", "1")).toBe("1 Changed file")
    expect(source["ui.sessionTurn.diffs.changed.other"].replace("{{count}}", "2")).toBe("2 Changed files")
    expect(source["ui.sessionTurn.diffs.changed"]).toBeUndefined()

    for (const locale of appLocales) {
      const target = await dictionary(`../../../ui/src/i18n/${locale}.ts`)
      for (const key of ["ui.sessionTurn.diffs.changed.one", "ui.sessionTurn.diffs.changed.other"]) {
        expect(target[key].trim()).not.toBe("")
        expect(placeholders(target[key])).toEqual(["count"])
      }
    }
  })
})

describe("i18n plural parity", () => {
  test("locale-specific categories exist and preserve count placeholders", async () => {
    for (const domain of domains.slice(0, 2)) {
      const source = await dictionary(domain.source)
      const families = pluralFamilies(source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => !Object.hasOwn(target, variant)),
        )
        const mismatched = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter(
              (variant) =>
                Object.hasOwn(target, variant) &&
                placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join(),
            ),
        )
        expect({ domain: domain.name, locale, missing, mismatched }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          mismatched: [],
        })
      }
    }
  })
})

async function dictionary(file: string) {
  const module: unknown = await import(file)
  if (typeof module !== "object" || module === null || !("dict" in module) || !isDictionary(module.dict)) {
    throw new Error(`Invalid translation dictionary: ${file}`)
  }
  return module.dict
}

function isDictionary(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === "string")
}

function placeholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]).sort()
}

function pluralFamilies(dictionary: Record<string, string>) {
  return Object.keys(dictionary)
    .filter(
      (key) =>
        key.endsWith(".one") &&
        dictionary[key].includes("{{count}}") &&
        dictionary[`${key.slice(0, -4)}.other`]?.includes("{{count}}"),
    )
    .map((key) => key.slice(0, -4))
}
