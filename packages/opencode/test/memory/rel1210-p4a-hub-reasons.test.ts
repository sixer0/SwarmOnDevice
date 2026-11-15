// 1.3.0 row 57, AC-P4a (N10-178): the vault hub says why notes are not copied, per class, counts only (01d §3.6,
// N10-064 `notCopiedByClass`, N10-065 `notCopied` and `exportHint`). Classes in the fixed order device, secret,
// classified, unsafe; only non-zero classes are listed; the export hint (the person copies a note in Swarm's memory
// view) appears only when at least one device-only note is not copied. The hub never names an uncopied note: none of
// the fixture note words, ids or the secret value, and no classification marking word.
// Red at BASE a3e3c4c93a: `render` has no `notCopiedByClass` and the hub line has no per-class counts.
// `render` is pure: no disk, no vault, no HOME. Inputs are row 40's synthetic stores (fixtures/rel1210-p4/).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { VaultMirror } from "../../src/memory/vault-mirror"

type Item = VaultMirror.RenderInput["items"][number]
type Lang = "en" | "id"

const P4 = path.join(import.meta.dir, "fixtures", "rel1210-p4")
const fixture = (name: string): { items: Item[] } => JSON.parse(fs.readFileSync(path.join(P4, name), "utf8"))
const pick = (name: string, id: string) => fixture(name).items.find((item) => item.id === id)!

// One item per class (N10-227, N10-228, N10-229) and one clean note that is copied.
const DEVICE = pick("device-only.json", "p4d-001")
const SECRET = pick("secret-looking.json", "p4s-001")
const CLASSIFIED = pick("classified.json", "p4c-001")
const CLEAN = pick("device-only.json", "p4d-003")
// A clean note whose id the mirror cannot use as a name (fails `ITEM_ID`): the fourth class.
const UNSAFE: Item = { ...CLEAN, id: "p4u 001", text: "Nimbard columns are counted twice." }

const HUB = {
  en: {
    head: (n: number) => `${n} notes are not copied here: `,
    device: (n: number) => `${n} kept on this device only`,
    secret: (n: number) => `${n} secret-looking`,
    classified: (n: number) => `${n} marked as classified`,
    unsafe: (n: number) => `${n} with a name Swarm cannot use`,
    hint: "You can copy a note kept on this device to the vault in Swarm's memory view (Copy to vault). Secret-looking and classified notes are never copied.",
  },
  id: {
    head: (n: number) => `${n} catatan tidak disalin ke sini: `,
    device: (n: number) => `${n} hanya di perangkat ini`,
    secret: (n: number) => `${n} tampak berisi rahasia`,
    classified: (n: number) => `${n} ditandai sebagai dokumen berklasifikasi`,
    unsafe: (n: number) => `${n} dengan nama yang tidak dapat dipakai Swarm`,
    hint: "Anda dapat menyalin catatan yang hanya di perangkat ini ke vault di tampilan memori Swarm (Salin ke vault). Catatan yang tampak berisi rahasia atau berklasifikasi tidak pernah disalin.",
  },
} as const

type Counts = { device: number; secret: number; classified: number; unsafe: number }
const ORDER = ["device", "secret", "classified", "unsafe"] as const

/** The expected hub tail: the one counts line, then the hint paragraph only when device > 0. */
const golden = (lang: Lang, counts: Counts) => {
  const L = HUB[lang]
  const total = ORDER.reduce((sum, key) => sum + counts[key], 0)
  const parts = ORDER.filter((key) => counts[key] > 0).map((key) => L[key](counts[key]))
  const line = `${L.head(total)}${parts.join(", ")}.`
  return counts.device > 0 ? `\n\n${line}\n\n${L.hint}\n` : `\n\n${line}\n`
}

const render = (lang: Lang, items: Item[]) =>
  VaultMirror.render({ key: "dir-p4a0a1b2c3d4e5f6a7b8c9d0", folder: "syn-project-p4a0a1", projectName: "Syn Project P4", language: lang, items })
const hubOf = (result: ReturnType<typeof render>) => result.files.find((file) => file.path === "index.md")!.content

// Words of the uncopied notes (text, body, refs) that no copied note and no hub label uses: none may reach the hub.
const words = (item: Item) =>
  [item.text, item.body ?? "", ...(item.refs ?? []).map((ref) => ("path" in ref ? (ref.path ?? "") : ""))]
    .join(" ")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []
const labelWords = new Set(
  Object.values(HUB)
    .flatMap((L) => [L.hint, ...ORDER.map((key) => L[key](1)), L.head(1)])
    .flatMap((text) => text.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []),
)
const fixtureWords = (lang: Lang, uncopied: Item[], copied: Item[]) => {
  // Allowed: what the hub says with the copied notes alone (banner, headings, their lines), plus the hub labels.
  const baseline = hubOf(render(lang, copied)).toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []
  const allowed = new Set([...copied.flatMap(words), ...labelWords, ...baseline])
  return [...new Set(uncopied.flatMap(words))].filter((word) => !allowed.has(word))
}
// Classification marking words as the fixtures write them (N10-144; RESTRICTED is the fixture's word).
const MARKINGS = new RegExp(`\\b(?:${VaultMirror.MIRROR_CLASSIFIED_WORDS.join("|")})\\b`)

const CASES: { name: string; items: Item[]; counts: Counts; uncopied: Item[]; copied: Item[] }[] = [
  {
    name: "all four classes non-zero",
    items: [DEVICE, SECRET, CLASSIFIED, UNSAFE, CLEAN],
    counts: { device: 1, secret: 1, classified: 1, unsafe: 1 },
    uncopied: [DEVICE, SECRET, CLASSIFIED, UNSAFE],
    copied: [CLEAN],
  },
  {
    name: "only classified",
    items: [CLASSIFIED, CLEAN],
    counts: { device: 0, secret: 0, classified: 1, unsafe: 0 },
    uncopied: [CLASSIFIED],
    copied: [CLEAN],
  },
  {
    name: "only device (export hint present)",
    items: [DEVICE, pick("device-only.json", "p4d-002"), CLEAN],
    counts: { device: 2, secret: 0, classified: 0, unsafe: 0 },
    uncopied: [DEVICE, pick("device-only.json", "p4d-002")],
    copied: [CLEAN],
  },
  {
    name: "device = 0 (no hint)",
    items: [SECRET, CLASSIFIED, CLEAN],
    counts: { device: 0, secret: 1, classified: 1, unsafe: 0 },
    uncopied: [SECRET, CLASSIFIED],
    copied: [CLEAN],
  },
]

describe("AC-P4a hub reasons per class (N10-178)", () => {
  for (const lang of ["en", "id"] as const) {
    for (const c of CASES) {
      test(`${lang}: ${c.name}`, () => {
        const result = render(lang, c.items)
        expect(result.notCopiedByClass).toEqual(c.counts)
        expect(result.notCopied).toBe(ORDER.reduce((sum, key) => sum + c.counts[key], 0))
        expect(result.unsafe).toBe(c.counts.unsafe)
        const hub = hubOf(result)
        expect(hub.endsWith(golden(lang, c.counts))).toBe(true)
        expect(hub.includes(HUB[lang].hint)).toBe(c.counts.device > 0)
        // Counts only: no fixture note word, id or secret value of an uncopied note, no classification marking word.
        const forbidden = fixtureWords(lang, c.uncopied, c.copied)
        expect(forbidden.length).toBeGreaterThan(0)
        expect(forbidden.filter((word) => hub.toLowerCase().includes(word))).toEqual([])
        expect(c.uncopied.filter((item) => hub.includes(item.id)).map((item) => item.id)).toEqual([])
        expect(hub.includes("plimbo-0000")).toBe(false)
        expect(MARKINGS.test(hub)).toBe(false)
        if (lang === "en") expect(VaultMirror.classified(hub)).toBe(false)
      })
    }
  }

  test("no uncopied note: no line and no hint", () => {
    for (const lang of ["en", "id"] as const) {
      const result = render(lang, [CLEAN])
      expect(result.notCopiedByClass).toEqual({ device: 0, secret: 0, classified: 0, unsafe: 0 })
      expect(result.notCopied).toBe(0)
      const hub = hubOf(result)
      expect(hub.includes(HUB[lang].head(0))).toBe(false)
      expect(hub.includes(HUB[lang].hint)).toBe(false)
    }
  })

  test("an exported device-only note is copied and not counted; an archived member adds nothing", () => {
    const exported = { ...DEVICE, vaultAllowed: true } as Item
    const result = render("en", [exported, ...fixture("device-only.json").items.filter((item) => item.id === "p4d-m01")])
    expect(result.notCopiedByClass).toEqual({ device: 0, secret: 0, classified: 0, unsafe: 0 })
    expect(result.notCopied).toBe(0)
  })
})
