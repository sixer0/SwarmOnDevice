// Swarm 1.2.9 row 40, AC-B01b (N9-117): the setup copy of the classification word list
// (`packages/setup/src/vault/classified.ts`, N9-082) cannot drift from the mirror's list
// (`MIRROR_CLASSIFIED_WORDS`, src/memory/vault-mirror.ts). Test only: vault-mirror.ts is read, never changed.
// Red at BASE d4282fcfd8: the setup module does not exist, so the import rejects.
// The four words appear here only as rule subjects (synthetic corpus, syn129).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { VaultMirror } from "../../src/memory/vault-mirror"

interface SetupClassified {
  readonly CLASSIFIED_WORDS: readonly string[]
  readonly classificationWord: (text: string) => string | undefined
}

// A computed specifier keeps the setup package's sources out of this package's typecheck program
// (test/session/installed-tools.test.ts uses the same pattern).
const load = async () =>
  (await import(path.join(import.meta.dir, "..", "..", "..", "setup", "src", "vault", "classified.ts"))) as SetupClassified

const MATCHED_CORPUS = [
  "TERBATAS",
  "RAHASIA",
  "CONFIDENTIAL",
  "RESTRICTED",
  "terbatas",
  "rahasia",
  "confidential",
  "restricted",
  "Terbatas",
  "RaHaSia",
  "Confidential",
  "reStricted",
  "SANGAT RAHASIA",
  "RAHASIA-1",
  "(TERBATAS)",
  "RAHASIA​",
]

const UNMATCHED_CORPUS = [
  "terbatasnya",
  "RESTRICTED_ACCESS",
  "unrestricted",
  "confidentiality",
  "",
  "mission m-syn129, 2026-11-14, status done",
]

// S9-10: B01 is an accident guard. These deliberate spellings are pinned as "not matched" so the
// behaviour is explicit (release note RN-07 states the limit).
const S9_10_NOT_MATCHED = [
  "RA­HASIA", // soft hyphen inside the word
  "RAHA​SIA", // U+200B inside the word
  "ＲＡＨＡＳＩＡ", // fullwidth RAHASIA
  "R&#65;HASIA", // HTML entity
]

describe("AC-B01b setup classification words stay equal to the mirror's", () => {
  test("the word list equals MIRROR_CLASSIFIED_WORDS in value and order", async () => {
    const setup = await load()
    expect([...setup.CLASSIFIED_WORDS]).toEqual([...VaultMirror.MIRROR_CLASSIFIED_WORDS])
  })

  test("same verdict as classified() on the corpus; a hit is always a list entry", async () => {
    const setup = await load()
    const mirror: readonly string[] = VaultMirror.MIRROR_CLASSIFIED_WORDS
    const corpus = [...MATCHED_CORPUS, ...UNMATCHED_CORPUS, ...S9_10_NOT_MATCHED]
    expect(corpus.length).toBeGreaterThanOrEqual(20)
    for (const s of corpus) {
      const word = setup.classificationWord(s)
      expect({ s, matched: word !== undefined }).toEqual({ s, matched: VaultMirror.classified(s) })
      if (word !== undefined) expect(mirror).toContain(word)
    }
    for (const s of MATCHED_CORPUS) expect({ s, matched: VaultMirror.classified(s) }).toEqual({ s, matched: true })
    for (const s of UNMATCHED_CORPUS) expect({ s, matched: VaultMirror.classified(s) }).toEqual({ s, matched: false })
  })

  test("S9-10: soft hyphen, U+200B inside, fullwidth and an HTML entity are not matched", async () => {
    const setup = await load()
    for (const s of S9_10_NOT_MATCHED) {
      expect({ s, word: setup.classificationWord(s) }).toEqual({ s, word: undefined })
      expect({ s, matched: VaultMirror.classified(s) }).toEqual({ s, matched: false })
    }
  })

  // 1.3.0 row 134 (AC-S6b, F7, N13-418): opencode's vault inbox check slugs the name with its own copy of slugify; it
  // must give the setup copy's slug on every case here, or a slug-only hit would pass one check and not the other.
  test("N13-418: SessionTools.slugify equals setup slugify on the corpus and the slug cases", async () => {
    const setup = (await load()) as SetupClassified & { readonly slugify: (name: string) => string }
    const { SessionTools } = await import("../../src/session/tools")
    const cases = [
      ...MATCHED_CORPUS,
      ...UNMATCHED_CORPUS,
      ...S9_10_NOT_MATCHED,
      "TERBATAS_note",
      "  --Rahasia__Plan--  ",
      "x".repeat(60),
      "a-b".repeat(20),
      "Mission m-syn129: report (draft) 2026-11-14",
      "---",
      "Ünïcode naïve",
    ]
    for (const name of cases)
      expect({ name, slug: SessionTools.slugify(name) }).toEqual({ name, slug: setup.slugify(name) })
  })

  test("the result is the list entry in capitals, never the matched text", async () => {
    const setup = await load()
    expect(setup.classificationWord("ini rahasia")).toBe("RAHASIA")
    expect(setup.classificationWord("SANGAT RaHaSia")).toBe("RAHASIA")
    expect(setup.classificationWord("(terbatas)")).toBe("TERBATAS")
  })
})
