// Swarm 1.2.6 row 24, flow F3 (T-13), 01g section 5.2: synthetic large document (01g section 4.6, no source).
// Filler prose, tables and headings in enough volume for at least 217 rendered pages and far more than the
// per-page 5000 ink boxes the BASE overlap measurement keeps (`OVERLAP_DEFAULT_ARGS.maxBoxes`), so BASE ends in
// MEASURE_TRUNCATED. Row 115 renders it through the real bridge (`*.acc.ts`) and records measuredPages/totalPages;
// whether BASE truncates is verified there (it needs the bridge). Deterministic: same options, same output.
import { Filler } from "./filler"

export interface BigDocOptions {
  chapters?: number
  sectionsPerChapter?: number
  paragraphsPerSection?: number
  wordsPerParagraph?: number
  tableRows?: number
}

export interface BigDocChapter {
  title: string
  markdown: string
}

export const BIG_DOC_DEFAULTS: Required<BigDocOptions> = {
  chapters: 18,
  sectionsPerChapter: 12,
  paragraphsPerSection: 6,
  wordsPerParagraph: 90,
  tableRows: 8,
}

export function bigDocChapters(opts: BigDocOptions = {}): BigDocChapter[] {
  const o = { ...BIG_DOC_DEFAULTS, ...opts }
  const fl = new Filler()
  const out: BigDocChapter[] = []
  for (let c = 0; c < o.chapters; c++) {
    const lines: string[] = []
    for (let s = 0; s < o.sectionsPerChapter; s++) {
      lines.push(`## ${fl.sentence(3).slice(0, -1)}`, "")
      for (let p = 0; p < o.paragraphsPerSection; p++) {
        const parts: string[] = []
        for (let left = o.wordsPerParagraph; left > 0; left -= 15) parts.push(fl.sentence(Math.min(15, left)))
        lines.push(parts.join(" "), "")
      }
      lines.push(`| ${fl.words(4, () => 5).split(" ").join(" | ")} |`, "| --- | --- | --- | --- |")
      for (let r = 0; r < o.tableRows; r++) lines.push(`| ${fl.words(4, () => 6).split(" ").join(" | ")} |`)
      lines.push("")
    }
    out.push({ title: fl.sentence(3).slice(0, -1), markdown: lines.join("\n") })
  }
  return out
}

/** Word count of the generated document (a page estimate for the acceptance record: about 450 words per page). */
export function bigDocWords(chapters: BigDocChapter[]): number {
  return chapters.reduce((n, c) => n + (c.markdown.match(/\p{L}+/gu)?.length ?? 0), 0)
}
