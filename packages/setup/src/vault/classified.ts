// Classification words for the vault inbox (Swarm 1.2.9 row 40, B01; register N9-082, N9-059, N9-075).
//
// WHY A COPY: packages/setup declares no dependencies and must not import opencode (mcpproxy/proxy.ts
// header), so this list is a copy of opencode's MIRROR_CLASSIFIED_WORDS (src/memory/vault-mirror.ts).
// The opencode-side drift test test/memory/rel129-b01-classified-words-drift.test.ts pins the two lists
// equal and the two matchers to the same verdicts.
//
// SCOPE: an accident guard, not a filter against deliberate spellings. Spaced letters, invisible
// characters inside a word, look-alike letters and HTML entities pass (pinned "not matched" by the
// drift test; release note RN-07).
//
// Pure: no imports, no filesystem access. Both inbox writers (mcpproxy/proxy.ts runVault and
// vault/writer.ts writeInboxNote) call classifiedNote before anything is written or created
// (row 67c: one check, one slugify, shared by both writers and the proxy's audit name guard).

/** @internal test seam */
export const CLASSIFIED_WORDS = ["TERBATAS", "RAHASIA", "CONFIDENTIAL", "RESTRICTED"] as const

// Built exactly as the mirror's matcher: whole word, case-insensitive.
const CLASSIFIED = new RegExp(`\\b(?:${CLASSIFIED_WORDS.join("|")})\\b`, "i")

/** The list entry (in capitals) whose word the text holds as a whole word, or undefined.
 *  Returns the list entry, never the matched text itself.
 *  @internal test seam */
export function classificationWord(text: string): string | undefined {
  const match = CLASSIFIED.exec(text)
  if (match === null) return undefined
  const upper = match[0].toUpperCase()
  return CLASSIFIED_WORDS.find((word) => word === upper)
}

/** The note's file-name slug (r94): lowercase, non-alnum runs to "-", trim, 40-char cap, "note"
 *  fallback. The single copy used by both inbox writers, so the generated file names and the
 *  slug check below cannot drift apart. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return s === "" ? "note" : s
}

/** B01 (S9-03): the classification word held by the name as given, by its slug, or by the
 *  content, checked in that order; undefined when the note is clean. Pass "" as content to check
 *  a name alone. */
export function classifiedNote(name: string, content: string): string | undefined {
  return classificationWord(name) ?? classificationWord(slugify(name)) ?? classificationWord(content)
}
