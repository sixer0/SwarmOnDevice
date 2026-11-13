// Swarm 1.2.7 row 37b (C32/C42; 01c N-10, N-11, T-11, T-12 "Text changes"): the Studio agent guide states the
// behaviour that rows 38 (23fa01c9fe), 40/40b (1639f5fce9 / 8b01658f66), 39 (919eda657f) and 36b (f02113dc03)
// landed. Each sentence sits in the section an agent reads for that tool. The numbers it quotes are read from the
// exported constants of the code (no source-text greps, row 48c / M2-09b); the render line, the retire codes and the
// furniture line are pinned by behaviour in their own tests (rel127-n10, row 36b).
// Red at 04067a9d02: none of the four sentences is in the guide.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { TABLE_BREAK_AFTER, TABLE_BREAK_MIN_CHARS, isUrlToken } from "../../vendor/src/lib/studio/engine/table-fit"
import { INLINE_V2_DIAGRAM_REQUIRED } from "../../vendor/scripts/studio/mcp/figure-tools"

const ROOT = path.join(import.meta.dir, "..", "..")
const GUIDE = readFileSync(path.join(ROOT, "vendor", "docs", "STUDIO-AGENT-GUIDE.md"), "utf8")
const flat = (s: string) => s.replace(/\s+/g, " ")
const section = (from: string, to: string) => {
  const s = GUIDE.indexOf(from)
  return s < 0 ? "" : flat(GUIDE.slice(s, GUIDE.indexOf(to, s + from.length)))
}

const S4 = section("## 4. Bentuk isi v2", "\n### 4.1 ")
const S412 = section("#### 4.1.2 ", "\n### 4.2 ")
const S83 = section("### 8.3 ", "\n### 8.4 ")
const S84 = section("### 8.4 ", "\n### 8.5 ")

describe("rel127 37b: guide sentences for N-10, N-11, T-11, T-12", () => {
  test("N-10 (8.3): studio_write render failure names code and check; retry reuses the document; retire refusals are by design", () => {
    expect(S83).toContain(
      "Render gagal: teks memuat kode dan cek (mis. FIGURE_OVER_CAPACITY (DT-10a)); perbaiki isi lalu ulangi studio_write yang sama (dokumen yang sama dipakai).",
    )
    expect(S83).toContain("`berkas: tidak dirender (galat <kode> (<cek>))`")
    expect(S83).toContain("`NOT_BOUND_TO_ROW`")
    expect(S83).toContain("`NO_CURRENT_DELIVERABLE`")
  })

  test("N-11 (4): ID lists without spaces break after , ; / above 16 characters; URLs never break", () => {
    expect(TABLE_BREAK_MIN_CHARS).toBe(16)
    expect([...TABLE_BREAK_AFTER]).toEqual([",", ";", "/"])
    expect(isUrlToken("https://example.test/a")).toBe(true)
    const min = String(TABLE_BREAK_MIN_CHARS)
    expect(S4).toContain(
      `Lebar tabel (DT-10a): daftar ID tanpa spasi dipatah setelah , ; / bila lebih dari ${min} karakter; URL (\`://\`, \`www.\`, \`mailto:\`) tidak pernah dipatah dan dihitung utuh.`,
    )
  })

  test("T-11 (4.1.2 step 2): direction through patch.spec; top-level direction refused; inline v2 needs family and nodes", () => {
    expect([...INLINE_V2_DIAGRAM_REQUIRED]).toEqual(["family", "nodes"])
    const step2 = S412.slice(S412.indexOf("2. **Revisi sebagian.**"), S412.indexOf("3. **Baca `FIGURE_GRAPH_DELTA`.**"))
    expect(step2).toContain('Arah alur: patch {spec:{direction:"LR"}} (TB/LR); kunci direction di tingkat atas ditolak.')
    expect(step2).toContain("Diagram v2 inline (tanpa `$schema`) hanya wajib `family` dan `nodes`")
  })

  test("T-12 (8.4): the standalone preview prints its furniture line", () => {
    expect(S84).toContain(
      "Hasil mandiri memuat perabot: jumlah baris KUNCI dan SUMBER serta tingginya (mm), dicetak `perabot: KUNCI <k> baris, SUMBER <s> baris, tinggi <h> mm`.",
    )
  })
})
