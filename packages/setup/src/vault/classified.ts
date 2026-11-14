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
// Pure: no imports, no filesystem access. Both inbox writers (mcpproxy/proxy.ts vaultWrite and
// vault/writer.ts writeInboxNote) call classificationWord before anything is written.

export const CLASSIFIED_WORDS = ["TERBATAS", "RAHASIA", "CONFIDENTIAL", "RESTRICTED"] as const

// Built exactly as the mirror's matcher: whole word, case-insensitive.
const CLASSIFIED = new RegExp(`\\b(?:${CLASSIFIED_WORDS.join("|")})\\b`, "i")

/** The list entry (in capitals) whose word the text holds as a whole word, or undefined.
 *  Returns the list entry, never the matched text itself. */
export function classificationWord(text: string): string | undefined {
  const match = CLASSIFIED.exec(text)
  if (match === null) return undefined
  const upper = match[0].toUpperCase()
  return CLASSIFIED_WORDS.find((word) => word === upper)
}
