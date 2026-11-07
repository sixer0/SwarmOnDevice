// Row 165I (C196, verification/24_row165g_security.md L1 + L2): delivered and saved file names never carry control,
// bidi, zero-width or line/paragraph separator characters. Such a name is REJECTED as a whole (fallback to the safe
// store/token name), not stripped. Real code only: contract/env.ts, scripts/studio/mcp/datum-name.ts and
// figure-tools.ts. No server, no browser, no network.
import { describe, expect, test } from "bun:test"

const { DATUM_FILENAME_PATTERN, DATUM_NAME_UNSAFE_CHARS } = await import("../../vendor/src/lib/studio/contract/env")
const { safeDatumName } = await import("../../vendor/scripts/studio/mcp/datum-name")
const { standaloneFileName } = await import("../../vendor/scripts/studio/mcp/figure-tools")

const DATUM = new RegExp(DATUM_FILENAME_PATTERN)

/** One code point of every refused range (first and last where it is a range). */
const UNSAFE = [
  ["NUL", 0x0000], ["US", 0x001f], ["DEL", 0x007f], ["C1 PAD", 0x0080], ["C1 NEL", 0x0085], ["C1 APC", 0x009f],
  ["ALM", 0x061c], ["ZWSP", 0x200b], ["ZWNJ", 0x200c], ["ZWJ", 0x200d], ["LRM", 0x200e], ["RLM", 0x200f],
  ["LS", 0x2028], ["PS", 0x2029], ["LRE", 0x202a], ["RLO", 0x202e], ["WJ", 0x2060], ["LRI", 0x2066], ["PDI", 0x2069], ["BOM", 0xfeff],
] as const

const fig = (svg: string, png = svg.replace(/\.svg$/, ".png")) => ({ standalone: { fileName: { svg, png } } })

describe("row 165I L2: DATUM_FILENAME_PATTERN and safeDatumName refuse control/bidi/zero-width names", () => {
  test("clean names still pass (no regression)", () => {
    for (const n of ["Gambar 4.1 Alur data.png", "Gambar 4.1 Alur data.svg", "Laporan akhir 012-GSP-KT-XI-2026 RevA.docx", "Lembar bukti 2026-11-02.pdf", "Gambar 4.1 Bagan ā é.svg"]) {
      expect({ n, pattern: DATUM.test(n), safe: safeDatumName(n) }).toEqual({ n, pattern: true, safe: true })
    }
  })

  test("the RLO name 'Gambar 4.1 x\\u202Egvs.png' is refused", () => {
    const n = "Gambar 4.1 x‮gvs.png"
    expect(DATUM.test(n)).toBe(false)
    expect(safeDatumName(n)).toBe(false)
  })

  for (const [label, cp] of UNSAFE) {
    test(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${label}) is refused in every name form`, () => {
      const c = String.fromCharCode(cp)
      expect(DATUM_NAME_UNSAFE_CHARS.test(c)).toBe(true)
      for (const n of [`Gambar 4.1 Alur${c}gnp.exe.png`, `Laporan${c} 012-GSP-KT-XI-2026 RevA.html`, `Lembar ${c}bukti 2026-11-02.pdf`]) {
        expect({ n, pattern: DATUM.test(n), safe: safeDatumName(n) }).toEqual({ n, pattern: false, safe: false })
      }
    })
  }
})

describe("row 165I L1: stand-alone figure name is rejected (token fallback), not stripped", () => {
  test("the RLO name 'Gambar 4.1 x\\u202Egvs.png' falls back to the token name", () => {
    expect(standaloneFileName(fig("Gambar 4.1 x‮gvs.svg", "Gambar 4.1 x‮gvs.png"), "png", "TOKEN.png")).toBe("TOKEN.png")
    expect(standaloneFileName(fig("Gambar 4.1 x‮gvs.svg"), "svg", "TOKEN.svg")).toBe("TOKEN.svg")
  })
  for (const [label, cp] of UNSAFE) {
    test(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${label}) -> token name`, () => {
      const c = String.fromCharCode(cp)
      expect(standaloneFileName(fig(`Gambar 4.1 Alur${c}x.svg`), "svg", "TOKEN.svg")).toBe("TOKEN.svg")
      expect(standaloneFileName(fig(`Gambar 4.1 Alur${c}x.svg`), "png", "TOKEN.png")).toBe("TOKEN.png")
    })
  }
  test("a clean name is kept; separators and dots still handled as before", () => {
    expect(standaloneFileName(fig("Gambar 4.1 Alur data.svg"), "svg", "TOKEN.svg")).toBe("Gambar 4.1 Alur data.svg")
    expect(standaloneFileName(fig("Gambar 4.1 Alur data.svg"), "png", "TOKEN.png")).toBe("Gambar 4.1 Alur data.png")
    expect(standaloneFileName(fig("../../x.svg"), "svg", "TOKEN.svg")).toBe("x.svg")
    expect(standaloneFileName(fig("..svg"), "svg", "TOKEN.svg")).toBe("TOKEN.svg")
  })
  test("a non-NFC name falls back (same rule as safeDatumName)", () => {
    expect(standaloneFileName(fig("Gambar 4.1 Café.svg"), "svg", "TOKEN.svg")).toBe("TOKEN.svg")
  })
})
