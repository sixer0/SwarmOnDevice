// Swarm 1.2.6 row 101 (W-01, G-02, M-05/U15): GUIDE pins on the bundled datum-house-style skill.
// The skill used to teach captions that start with "GAMBAR n.m", while Studio prints that label itself (row 27
// refuses the token at submit, row 28 fails a wrapped caption). These pins hold the corrected caption rule and the
// delivered-name rule `<Judul> <nomor> Rev<X> rev<N>` (row 75), and tie both to the Studio constants they quote.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const DESKTOP = path.resolve(import.meta.dir, "..")
const SKILL = path.join(DESKTOP, "datum/datum-house-style/SKILL.md")
const REF08 = path.join(DESKTOP, "datum/datum-house-style/references/08-skema-diagram.md")
const STUDIO = path.resolve(DESKTOP, "../datum-studio/vendor/src/lib/studio/contract")

const read = (p: string) => fs.readFile(p, "utf8")
const flat = (s: string) => s.replace(/\s+/g, " ")

const RULE = "Studio prints the label; the caption never starts with it; at most 100 characters."

// Caption examples that teach writing the label token: a backticked `GAMBAR n.m` / `TABEL n.m` followed by
// "then the/one sentence", or a code span whose caption text opens with the token.
const TEACHES_TOKEN = [
  /`(?:GAMBAR|Gambar|TABEL|Tabel|Figure)\s*\d+(?:\.\d+)*`\)?,?\s+then\s+(?:the|one)\s+sentence/,
  /label in bold capitals with its number/,
  /`(?:GAMBAR|Gambar|Figure|Fig\.)\s*\d+(?:[.\-]\d+)*\s+[A-Za-z][^`]*`/,
]

async function captionMax() {
  const src = await read(path.join(STUDIO, "schema/figure-bounds.ts"))
  return Number(src.match(/export const CAPTION_GUIDE_MAX_CHARS = (\d+);/)?.[1])
}

async function namePattern() {
  const src = await read(path.join(STUDIO, "env.ts"))
  const lit = src.match(/export const DATUM_FILENAME_PATTERN =\s*("(?:[^"\\]|\\.)*");/)?.[1]
  expect(lit).toBeDefined()
  return new RegExp(JSON.parse(lit!))
}

for (const [name, file] of [
  ["SKILL.md", SKILL],
  ["references/08-skema-diagram.md", REF08],
] as const) {
  test(`${name}: caption rule says Studio prints the label, no token, at most 100 characters, one line`, async () => {
    const text = flat(await read(file))
    expect(text).toContain(RULE)
    expect(text).toContain("CAPTION_TOKEN_DUPLICATE")
    expect(text).toContain("CAPTION_WRAP")
    expect(text).toMatch(/It is one line: a verdict that names the actor and the number/)
    expect(text).toMatch(/SOURCE line below/)
  })

  test(`${name}: no example teaches a caption that starts with the label token`, async () => {
    const text = flat(await read(file))
    for (const re of TEACHES_TOKEN) expect(text).not.toMatch(re)
  })

  test(`${name}: the caption limit equals CAPTION_GUIDE_MAX_CHARS and the example fits it`, async () => {
    const max = await captionMax()
    expect(max).toBe(100)
    const text = flat(await read(file))
    expect(text).toContain(`at most ${max} characters`)
    const example = text.match(/the number \(`([^`]+)`\)/)?.[1]
    expect(example).toBeDefined()
    expect(example!.length).toBeLessThanOrEqual(max)
    expect(example).toMatch(/\d/)
    expect(example).not.toMatch(/^\s*(gambar|figure|fig\.|grafik|bagan|diagram|tabel)\s*[A-Z]?\d/i)
  })
}

test("SKILL.md: delivered file name rule is `<Judul> <nomor> Rev<X> rev<N>` and its examples pass DATUM_FILENAME_PATTERN", async () => {
  const text = flat(await read(SKILL))
  expect(text).toContain("`<Judul> <nomor> Rev<X> rev<N>`")
  expect(text).toContain("`<Judul> <nomor> Rev<X> rev<N>.<ext>`")
  expect(text).toMatch(/Studio appends ` rev<N>` to every file it renders/)
  const re = await namePattern()
  const examples = [...text.matchAll(/`([^`]*\d{3}-GSP-[A-Z]+-[IVX]+-\d{4} Rev[A-Z] rev\d+\.(?:pdf|docx))`/g)].map((m) => m[1])
  expect(examples.length).toBeGreaterThan(0)
  for (const n of examples) expect(n).toMatch(re)
  expect("Rencana Anggaran Biaya 008-GSP-RAB-VIII-2026 RevD rev256.pdf").toMatch(re)
})
