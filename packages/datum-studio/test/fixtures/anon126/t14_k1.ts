// Swarm 1.2.6 row 24, flow F5 (T-14 / D01), 01g section 5.2: synthetic prose whose D01 audit (audit_docx,
// `auditText` against an empty register) yields exactly `total` findings across `chapters` chapters
// (01g section 4.6, no source). One decision-bearing number per prose unit ("8,8": a decimal comma form, never a
// structural number), so each unit gives one finding. Row 49 wraps these units into its SERAH-tier test document.
import { Filler } from "./filler"

export interface D01Chapter {
  title: string
  paragraphs: string[]
}

export const D01_TOTAL = 145
export const D01_CHAPTERS = 3

export function d01Chapters(total = D01_TOTAL, chapters = D01_CHAPTERS): D01Chapter[] {
  const fl = new Filler()
  const out: D01Chapter[] = Array.from({ length: chapters }, () => ({ title: fl.sentence(2).slice(0, -1), paragraphs: [] }))
  for (let i = 0; i < total; i++) {
    const head = fl.sentence(6).slice(0, -1)
    out[i % chapters].paragraphs.push(`${head} 8,8 ${fl.words(5)}.`)
  }
  return out
}

/** Markdown of one chapter (headings carry no digits, so no structural numbers). */
export function d01Markdown(c: D01Chapter): string {
  return [`## ${c.title}`, "", ...c.paragraphs.flatMap((p) => [p, ""])].join("\n")
}
