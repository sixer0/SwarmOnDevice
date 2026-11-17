/**
 * 1.3.3 row 101 (spec KL-2 item 1): the host side of matching mission rows against the GSP technical knowledge
 * library's trigger index (row 99's matcher) at `studio_mission_create` and when a row goes `running`.
 *
 * - Where the library is: the option `libraryRoot` of the mission tools, which start.ts resolved once from
 *   STUDIO_LIBRARY_ROOT (row 151, S8: no environment read here); absent or `null` turns matching off (tests). The index
 *   is the one `resolveTriggerIndexPath` / `readTriggerIndexDoc` give, the same file `studio_library_read` loads.
 * - Text matched: the row's title (rows have no description field). The mission title is matched at create and only
 *   listed in the reply; it is never stored on rows (row 101 decision: a row whose own title names no technical domain
 *   carries no `knowledge`, so the done gate of row 102 does not hold administrative rows of a technical mission).
 * - Never throws: an unreadable library gives `reason`, which the tools put in one reply line and log.
 */
import { LIBRARY_READ_CALL_NAME } from "../library-read.ts"
import { libraryRootOf, loadTriggerIndex, matchKnowledge, resolveTriggerIndexPath, type KnowledgeMatch } from "./knowledge-match.ts"

export type LibraryOptions = { libraryRoot?: string | null }

/** A matcher over one read of the index (read once here, used for every row of a call). */
export function rowKnowledgeMatcher(opts: LibraryOptions): (text: string) => KnowledgeMatch {
  const indexPath = resolveTriggerIndexPath({ libraryRoot: libraryRootOf(opts.libraryRoot) })
  if (!indexPath) return () => ({ domains: [], reason: "index path not known" })
  const loaded = loadTriggerIndex(indexPath)
  const index = loaded.index
  if (!index) return () => ({ domains: [], reason: loaded.reason })
  return (text) => ({ domains: matchKnowledge(text, index) })
}

/**
 * Row 151 (S2): the call that reads a first file and, with mission and row, records the read the done gate counts.
 * The path is printed verbatim (a `skill:` path included: studio_library_read serves it, C33). Said in words, never
 * as `tool_name {json}`: models copy that shape as a text-form tool call (MC-1/MC-3).
 */
export function libraryReadCall(firstFile: string, at?: { mission: string; row: string }): string {
  const where = at ? `, mission ${JSON.stringify(at.mission)}, row ${JSON.stringify(at.row)}` : " (no mission and row: nothing is recorded)"
  return `call the tool ${LIBRARY_READ_CALL_NAME} with path ${JSON.stringify(firstFile)}${where}`
}

type Listed = { row: string; domains: ReadonlyArray<{ domain: string; firstFile: string }> }

/**
 * Reply lines: a heading and one line per matched domain of a row, each with its exact recorded call; mission-title
 * domains (not stored on rows) get the call without mission and row. Nothing when no row matched and the library is
 * readable.
 */
export function knowledgeLines(
  input: { rows: readonly Listed[]; mission?: ReadonlyArray<{ domain: string; firstFile: string }>; unavailable?: string },
  missionId: string,
): string[] {
  if (input.unavailable !== undefined) return [`knowledge: the GSP technical knowledge library is unavailable (${input.unavailable}); no row was matched`]
  const rows = input.rows.filter((r) => r.domains.length > 0)
  const mission = input.mission ?? []
  if (rows.length === 0 && mission.length === 0) return []
  return [
    "knowledge (GSP technical knowledge library): while the row is running, make one call named for it, with these arguments; that read is recorded on the row and lets it close done:",
    ...rows.flatMap((r) => r.domains.map((d) => `  row ${r.row}: ${d.domain} -> ${libraryReadCall(d.firstFile, { mission: missionId, row: r.row })}`)),
    ...mission.map((d) => `  mission title (not stored on rows): ${d.domain} -> ${libraryReadCall(d.firstFile)}`),
  ]
}
