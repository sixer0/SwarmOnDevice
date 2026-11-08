// Row 175 (user 2026-11-08): the macOS About panel shows only the name, one version line and the
// last-update date. The date is the build commit date (electron.vite.config.ts SWARM_BUILD_DATE,
// `git log -1 --format=%cs`), not the run time. The MIT/OpenCode notices ship as
// Resources/LICENSE, NOTICE and THIRD_PARTY_LICENSES.txt (electron-builder.config.ts extraResources).
import type { AboutPanelOptionsOptions } from "electron"

const MONTHS: Record<"id" | "en", string[]> = {
  id: ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
}

/** "2026-11-08" -> "8 November 2026" (id) / "November 8, 2026" (en); undefined for anything else. */
export function formatBuildDate(iso: string | undefined, locale: string): string | undefined {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return undefined
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  if (locale.startsWith("en")) return `${MONTHS.en[month - 1]} ${day}, ${m[1]}`
  return `${day} ${MONTHS.id[month - 1]} ${m[1]}`
}

/**
 * macOS renders: applicationName, then "Version <applicationVersion> (<version>)", then credits, then copyright.
 * version "" drops the "(1.2.1)" build suffix; copyright is always set so Info.plist's NSHumanReadableCopyright
 * is not shown; credits "" keeps the credits area empty. The date sits in the copyright line.
 */
export function aboutPanelOptions(input: {
  name: string
  version: string
  buildDate: string | undefined
  locale: string
}): AboutPanelOptionsOptions {
  const date = formatBuildDate(input.buildDate, input.locale)
  const updated = input.locale.startsWith("en") ? "Updated" : "Diperbarui"
  return {
    applicationName: input.name,
    applicationVersion: input.version,
    version: "",
    credits: "",
    copyright: date ? `${updated} ${date}` : "",
  }
}
