// Swarm 1.2.6 row 24 (01g section 4.3): the deterministic filler shared by the synthetic fixture generators and
// by the anonymisation guard (anon_guard.test.ts). The pool is the ICAO spelling alphabet; a word of length L at
// running position p is the p-th pool word of length L (cycling), else pool words concatenated and padded with "x".
// The choice depends only on (L, p), never on a source word. Content-free by construction.

export const POOL = [
  "alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima", "mike",
  "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu",
] as const

/** Every letter token of an anonymised fixture must match this (lowercased), 01g section 4.5 G2. */
export const FILLER_TOKEN_RE = new RegExp(`^(?:${POOL.join("|")}|x)+$`)

/** CAPTION_TOKEN_RE keywords (register N-013): kept on purpose at the start of T-01 captions. */
export const CAPTION_KEYWORDS = ["gambar", "figure", "fig", "grafik", "bagan", "diagram"] as const

const byLen = new Map<number, string[]>()
for (const w of POOL) byLen.set(w.length, [...(byLen.get(w.length) ?? []), w])

export class Filler {
  private p = 0

  word(len: number): string {
    const p = this.p++
    const same = byLen.get(len)
    if (same) return same[p % same.length]
    let out = ""
    for (let i = p; ; i++) {
      const w = POOL[i % POOL.length]
      if (out.length + w.length > len) break
      out += w
    }
    return out + "x".repeat(len - out.length)
  }

  /** Filler of equal length for every letter run; digits become 8; whitespace and punctuation stay. */
  text(s: string): string {
    return s
      .replace(/\p{L}+/gu, (src) => {
        const f = this.word([...src].length)
        if (src.length > 1 && src === src.toUpperCase()) return f.toUpperCase()
        if (src[0] !== src[0].toLowerCase()) return f[0].toUpperCase() + f.slice(1)
        return f
      })
      .replace(/\p{Nd}/gu, "8")
  }

  /** n filler words (sentence building for synthetic fixtures). */
  words(n: number, len = (i: number) => 4 + (i % 5)): string {
    return Array.from({ length: n }, (_, i) => this.word(len(i))).join(" ")
  }

  sentence(n: number): string {
    const w = this.words(n)
    return w[0].toUpperCase() + w.slice(1) + "."
  }
}
