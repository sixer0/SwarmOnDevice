// Swarm 1.3.3 row 84 (ST-12; register 03 s7, id C-35): a sentence that starts with a lower-case letter after a
// sentence-ending full stop is a warning (status REPORT, never FAIL) with the paragraph location and a short excerpt.
// The rule reads running prose only and stays quiet on abbreviations, numbers, markers, names of files, URLs,
// units, symbols, ellipses, code spans, table cells, caption labels and continued direct speech.
import { describe, expect, test } from "bun:test"
import { buildContext, LANGUAGE_SCANNERS } from "../../vendor/src/lib/studio/engine/lint/language/checks"
import { lintLanguage } from "../../vendor/src/lib/studio/engine/lint/language"
import { CONTINUING_ABBREVIATIONS, findLowercaseAfterStop, LOWERCASE_AFTER_STOP_ID } from "../../vendor/src/lib/studio/engine/lint/language/lowercase-after-stop"
import { extractLayers } from "../../vendor/src/lib/studio/engine/lint/language/prose"
import { ABBREVIATIONS } from "../../vendor/src/lib/studio/engine/lint/language/tokenize"
import { getLintDef, isLintImplemented } from "../../vendor/src/lib/studio/registry/lint"
import { releaseFor } from "../../vendor/src/lib/studio/services/render/lint"

const words = (text: string) => findLowercaseAfterStop(text).map((h) => h.word)
const para = (n: number, text: string, extra: Record<string, unknown> = {}) => ({
  blockId: `b${n}`,
  address: `1.0.${n}`,
  type: "paragraph",
  content: { text, ...extra },
})
const snapshot = (blocks: unknown[], language = "ID") => ({ doc: { meta: { language } }, blocks }) as never
const scan = (blocks: unknown[], language: "ID" | "EN" = "ID") =>
  LANGUAGE_SCANNERS["C-35"](buildContext(extractLayers(snapshot(blocks, language)), {}, language))

describe("row 84: lower-case letter after a full stop is found", () => {
  test("Indonesian and English sentences that start in lower case", () => {
    expect(words("Kamera dipasang di gerbang. perekam ditempatkan di ruang kendali.")).toEqual(["perekam"])
    expect(words("The camera sits at the gate. the recorder is in the control room.")).toEqual(["the"])
    expect(words("Tinjauan selesai (2 BLOCKER, 8 MAJOR. seluruhnya diterima) kemarin.")).toEqual(["seluruhnya"])
  })
  test("several in one paragraph, each with an excerpt that shows the stop and the next word", () => {
    const hits = findLowercaseAfterStop("Pekerjaan sipil dan pondasi menara. audit penangkal petir eksisting. perencanaan anggaran.")
    expect(hits.map((h) => h.word)).toEqual(["audit", "perencanaan"])
    expect(hits[0].excerpt).toContain("menara. audit")
    expect(hits[1].excerpt).toContain("eksisting. perencanaan")
    for (const h of hits) expect(h.excerpt.length).toBeLessThanOrEqual(70)
  })
  test("a real sentence end after a unit, a number, a file name, a bracket or a quote is still found", () => {
    expect(words("Beban tiap lokasi 250 W. total 16.450 W.")).toEqual(["total"])
    expect(words("Aturan berlaku bila lebih dari 64 kB. defect dicatat.")).toEqual(["defect"])
    expect(words("Lihat KATALOG-RUMUS.md:408-416. aturan ini wajib.")).toEqual(["aturan"])
    expect(words("Masuk uji terima (Bab 7). hasilnya dicatat.")).toEqual(["hasilnya"])
    expect(words('Label "tidak ditemukan". koreksi diberi tanda.')).toEqual(["koreksi"])
    expect(words("Selesai pada tahun 2024. kemudian dilanjutkan.")).toEqual(["kemudian"])
    expect(words("Rincian ada di berkas spek.md. isinya ringkas.")).toEqual(["isinya"])
  })
})

describe("row 84: what stays quiet", () => {
  const quiet: Array<[string, string[]]> = [
    [
      "clean Indonesian and English prose",
      [
        "Kamera dipasang di gerbang. Perekam ditempatkan di ruang kendali. Daya cadangan dihitung untuk dua jam.",
        "The camera sits at the gate. The recorder is in the control room. Backup power covers two hours.",
        "Apakah daya cukup? ya, cukup! begitu jawabnya.",
      ],
    ],
    [
      "abbreviations and their continuations",
      [
        "Perangkat berupa kamera, perekam, dll. dan kabel dipasang bertahap.",
        "Sakelar, router, dsb. serta dst. hingga selesai dipasang.",
        "Surat No. dua dan hlm. tiga dirujuk a.n. direktur u.p. sekretaris.",
        "PT Maju Tbk. dan PT. sejahtera menandatangani kontrak.",
        "Use a camera, e.g. a dome, i.e. the fixed type, vs. the moving one.",
        "Budi dkk. menulis laporan; Smith et al. reported the same, etc. and so on.",
        "Dr. sutomo dan Ir. hadi hadir, mis. pada rapat s.d. selesai.",
        "The U.S. standard and the Ph.D. thesis agree; J. smith signed at 10 a.m. sharp.",
        "Kapasitas maks. dua unit dan min. satu unit per lokasi.",
      ],
    ],
    [
      "decimal and thousands separators",
      ["Nilai 3.5 kali dan 1.200 unit, v1.3.3 dipakai.", "Rasio 0.90 dan total 16.450 W. Beban 1.600 W tercatat."],
    ],
    [
      "numbered headings and list markers",
      [
        "1. siapkan data 2. kirim berkas 3. tunggu jawaban",
        "a. pertama, kamera dipasang",
        "Urutannya: 1. survei; 2. rancang; 3. bangun.",
        "1.2. latar belakang kajian",
        "2.1.3. ruang lingkup pekerjaan",
        "ii. tahap kedua dimulai setelah survei",
        "Langkah berikut: a. periksa daya, b. periksa kabel.",
      ],
    ],
    [
      "file names, paths and versions",
      [
        "Rincian ada di spek.md dan docs/spek.md pada v1.3.3 serta src/lib/studio/index.ts.",
        "Berkas dibuka. spek.md berisi angka uji.",
        "Folder dibaca. docs/spek.md memuat rincian dan ./rak/isi.txt memuat daftar.",
        "Versi dicatat. v1.3.3 dipakai sejak kemarin.",
        "Nama ditulis utuh. faktor_puncak dipakai dalam rumus.",
      ],
    ],
    [
      "URLs and e-mail addresses",
      [
        "Lihat https://example.test/a.b/c dan www.example.test untuk rincian, atau tulis ke tim@example.test hari ini.",
        "Situs dibuka. https://example.test memuat dokumen.",
        "Alamat dicatat. tim@example.test menerima laporan.",
        "Situs dibuka. www.example.test memuat dokumen dan example.test menjadi cadangan.",
      ],
    ],
    [
      "units and symbols that are lower-case by rule",
      [
        "Daya dihitung. kW dipakai sebagai satuan dan kVA untuk daya semu.",
        "Tebal diukur. mm dipakai untuk pelat dan km untuk jarak.",
        "Rugi = P×(1÷η−1). kVA ≥ (P÷PF)×margin.",
        "Efisiensi dicatat. η = 0,90 dipakai.",
        "Varian 48 m kritis. h = 54 kritis pada varian 54 m. h = 60 batas kritis.",
        "Durasi ditetapkan. t = 2 jam dipakai dan pH dicatat. mAh tidak dijumlahkan.",
        "Catatan tinjauan dibaca. m12: kriteria saling bertentangan.",
      ],
    ],
    [
      "ellipses",
      [
        "Daftar berlanjut... dan seterusnya sampai habis.",
        "Berkas 00_... dan 01_... dibaca.",
        "Ia berhenti… lalu melanjutkan. Kalimat berikut benar.",
        "Jeda . . . lalu lanjut.",
      ],
    ],
    [
      "code spans (md-lite text with backticks)",
      [
        "Jalankan `npm run build. lalu test` dari folder proyek.",
        "Perintah selesai. `render` dipanggil sekali.",
        "Isi `a. b. c` dibaca apa adanya.",
      ],
    ],
    [
      "table cells written as a pipe row",
      [
        "Faktor | datasheet sel [R4]. tinjauan M3 | tidak ditemukan (asumsi uji). basis angka | kurva contoh",
        "| kolom a. satu | kolom b. dua | kolom c. tiga |",
      ],
    ],
    [
      "the label part of a caption or numbered heading",
      [
        "Gambar 3. peta lokasi dua belas titik",
        "Tabel 2.1. daftar beban per lokasi",
        "Figure 4. site map of the twelve locations",
        "Table A.2. load per site",
        "Lampiran B. daftar rujukan",
        "Bab 7. uji terima",
      ],
    ],
    [
      "quoted direct speech that continues after the closing quote",
      [
        '"Kami siap." kata komandan regu.',
        "“Daya cukup untuk dua jam.” ujar teknisi itu.",
        '"We are ready." said the team lead.',
        "Ia menjawab (lihat Bab 2.) dan melanjutkan.",
      ],
    ],
  ]
  for (const [name, cases] of quiet) {
    test(name, () => {
      for (const text of cases) expect(words(text), text).toEqual([])
    })
  }
  test("every word of the existing ABBREVIATIONS set, and of the continuing set, does not end a sentence", () => {
    for (const a of [...ABBREVIATIONS, ...CONTINUING_ABBREVIATIONS]) {
      expect(words(`Rujukan ${a}. berikut dibaca.`), a).toEqual([])
      expect(words(`Rujukan ${a[0].toUpperCase()}${a.slice(1)}. berikut dibaca.`), a).toEqual([])
    }
  })
})

describe("row 84: the scanner in the language module", () => {
  test("is registered as C-35, a warning by registry (limit lapor, never blocks ingest)", () => {
    expect(LOWERCASE_AFTER_STOP_ID).toBe("C-35")
    expect(typeof LANGUAGE_SCANNERS["C-35"]).toBe("function")
    const def = getLintDef("C-35")!
    expect(def.module).toBe("language")
    expect(def.limit).toBe("lapor")
    expect(def.blocksIngest).toBe(false)
  })
  test("one REPORT per paragraph with the paragraph address and excerpts; never FAIL", () => {
    const out = scan([
      para(1, "Kalimat pertama benar. Kalimat kedua juga benar."),
      para(2, "Kamera dipasang di gerbang. perekam di ruang kendali. kabel ditarik. daya disiapkan."),
      para(3, "Hasil dicatat. angka diperiksa ulang."),
    ])
    expect(out.map((i) => i.status)).toEqual(["REPORT", "REPORT"])
    expect(out.every((i) => i.checkId === "C-35")).toBe(true)
    expect(out[0].address).toBe("1.0.2")
    expect(out[0].detail).toContain("1.0.2")
    expect(out[0].detail).toContain("3 kalimat")
    expect(out[0].detail).toContain("gerbang. perekam")
    expect(out[0].detail).toContain("dan 1 lagi")
    expect(out[1].address).toBe("1.0.3")
    expect(out[1].detail).toContain("dicatat. angka")
  })
  test("a clean document is one PASS", () => {
    const out = scan([para(1, "Kalimat pertama benar. Kalimat kedua juga benar."), para(2, "Perangkat dll. dan kabel siap.")])
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe("PASS")
    expect(scan([]).map((i) => i.status)).toEqual(["PASS"])
  })
  test("English documents are scanned too", () => {
    const out = scan([para(1, "The camera sits at the gate. the recorder is inside.")], "EN")
    expect(out.map((i) => i.status)).toEqual(["REPORT"])
  })
  test("only running prose is read: tables, lists, headings, code blocks and figure captions are not", () => {
    const bad = "Baris satu. baris dua."
    const out = scan([
      { blockId: "t1", address: "1.0.1", type: "table", content: { rows: [[{ text: bad }]], caption: { text: bad } } },
      { blockId: "l1", address: "1.0.2", type: "list", content: { style: "bullet", items: [{ text: bad }] } },
      para(3, bad, { role: "heading" }),
      { blockId: "m1", address: "1.0.4", type: "monoBlock", content: { text: bad } },
      { blockId: "d1", address: "1.0.5", type: "diagram", content: { caption: { text: bad } } },
    ])
    expect(out.map((i) => i.status)).toEqual(["PASS"])
  })
  test("paragraphs given as runs and aside bodies are read", () => {
    const out = scan([
      { blockId: "p1", address: "2.0.1", type: "paragraph", content: { runs: [{ b: true, t: "Cap wajib." }, { t: " seluruh angka adalah data uji." }] } },
      { blockId: "a1", address: "2.0.2", type: "aside", content: { label: { text: "Catatan" }, body: [{ text: "Angka diperiksa. hasilnya dicatat." }] } },
    ])
    expect(out.map((i) => [i.status, i.address])).toEqual([
      ["REPORT", "2.0.1"],
      ["REPORT", "2.0.2"],
    ])
  })
  test("a unit that carries the original md-lite text keeps its code spans quiet", () => {
    const layers = extractLayers(snapshot([para(1, "Perintah selesai. `render` dipanggil sekali.")]))
    expect(layers.prose[0].text).toBe("Perintah selesai. render dipanggil sekali.") // prose.ts strips the backticks
    const withRaw = { ...layers, prose: layers.prose.map((u) => ({ ...u, raw: "Perintah selesai. `render` dipanggil sekali." })) }
    expect(LANGUAGE_SCANNERS["C-35"](buildContext(withRaw, {}, "ID")).map((i) => i.status)).toEqual(["PASS"])
  })
  test("more than 50 paragraphs with findings: 50 listed, the rest summed, all REPORT", () => {
    const out = scan(Array.from({ length: 53 }, (_, i) => para(i + 1, "Hasil dicatat. angka diperiksa.")))
    expect(out).toHaveLength(51)
    expect(out.every((i) => i.status === "REPORT")).toBe(true)
    expect(out[50].detail).toContain("3 temuan di 3 paragraf lain")
  })
  test("a warning never blocks: the release status of a report that holds only these findings is PASS", () => {
    const out = scan([para(1, "Hasil dicatat. angka diperiksa.")])
    expect(out.some((i) => i.status === "FAIL")).toBe(false)
    for (const tier of ["TERBIT", "SERAH"] as const) expect(releaseFor(out, tier)).toBe("PASS")
    expect(releaseFor(out, "NOTA")).not.toBe("FAIL") // the rule is not registered for NOTA
  })
  test("through lintLanguage: REPORT once the staged marker is gone from the registry row, NOT_RUN with the registry reason until then", () => {
    const def = getLintDef("C-35")!
    const out = lintLanguage(snapshot([para(1, "Hasil dicatat. angka diperiksa.")]), {}).filter((i) => i.checkId === "C-35")
    if (isLintImplemented(def)) expect(out.map((i) => [i.status, i.address])).toEqual([["REPORT", "1.0.1"]])
    else expect(out).toEqual([{ checkId: "C-35", status: "NOT_RUN", detail: def.notRunReason }])
  })
})
