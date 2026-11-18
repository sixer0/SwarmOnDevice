// Swarm 1.3.3 row 85 (ST-12; register 03 s7, id C-36): a sentence without a predicate is a warning (status REPORT,
// never FAIL) with the paragraph location and the sentence. A heuristic without a parser, built for precision:
// a sentence is reported only when it carries no predicate sign at all. Headings, list items, table cells, captions,
// labels, "term: explanation", quoted sentences, short fragments and code spans stay quiet by construction.
import { describe, expect, test } from "bun:test"
import { buildContext, LANGUAGE_SCANNERS } from "../../vendor/src/lib/studio/engine/lint/language/checks"
import { lintLanguage } from "../../vendor/src/lib/studio/engine/lint/language"
import { extractLayers } from "../../vendor/src/lib/studio/engine/lint/language/prose"
import {
  findSentencesWithoutPredicate,
  hasPredicate,
  MIN_WORDS,
  SENTENCE_WITHOUT_PREDICATE_ID,
} from "../../vendor/src/lib/studio/engine/lint/language/sentence-without-predicate"
import { getLintDef, isLintImplemented } from "../../vendor/src/lib/studio/registry/lint"
import { releaseFor } from "../../vendor/src/lib/studio/services/render/lint"

const found = (text: string, language: "ID" | "EN" = "ID") => findSentencesWithoutPredicate(text, language).map((h) => h.sentence)
const para = (n: number, text: string, extra: Record<string, unknown> = {}) => ({
  blockId: `b${n}`,
  address: `1.0.${n}`,
  type: "paragraph",
  content: { text, ...extra },
})
const snapshot = (blocks: unknown[], language = "ID") => ({ doc: { meta: { language } }, blocks }) as never
const scan = (blocks: unknown[], language: "ID" | "EN" = "ID") =>
  LANGUAGE_SCANNERS["C-36"](buildContext(extractLayers(snapshot(blocks, language)), {}, language))

describe("row 85: a sentence without a predicate is found", () => {
  test("Indonesian note fragments joined by full stops", () => {
    expect(found("Kamera dipasang di gerbang. Survei dan pengukuran lapangan di dua belas lokasi. Hasilnya dicatat.")).toEqual([
      "Survei dan pengukuran lapangan di dua belas lokasi.",
    ])
    expect(found("Kajian ini memuat tujuh bab. Bab 5 arsitektur dan figur. Bab 7 rekomendasi dan uji terima.")).toEqual([
      "Bab 5 arsitektur dan figur.",
      "Bab 7 rekomendasi dan uji terima.",
    ])
  })
  test("fragments after a full stop followed by lower case (the C-35 boundary) are read as sentences", () => {
    expect(found("Lingkup luar meliputi pekerjaan sipil. audit penangkal petir eksisting. survei dan pengukuran lapangan.")).toEqual([
      "audit penangkal petir eksisting.",
      "survei dan pengukuran lapangan.",
    ])
  })
  test("an equals sign or `sebagai` is not a predicate", () => {
    expect(found("Angka dihitung ulang. Vonis = vonis uji, bukan klaim kepatuhan.")).toEqual(["Vonis = vonis uji, bukan klaim kepatuhan."])
    expect(found("Rumus dikutip persis. Konvensi akhir umur delapan puluh persen sebagai pembanding.")).toEqual([
      "Konvensi akhir umur delapan puluh persen sebagai pembanding.",
    ])
  })
  test("English fragments", () => {
    expect(found("The camera sits at the gate. Two cameras per site for the twelve locations. The recorder is in the control room.", "EN")).toEqual([
      "Two cameras per site for the twelve locations.",
    ])
    expect(found("Backup power covers two hours. A single spare path for each segment of the tree.", "EN")).toEqual([
      "A single spare path for each segment of the tree.",
    ])
  })
  test("each finding carries the sentence and its word count", () => {
    const hits = findSentencesWithoutPredicate("Daya dihitung per lokasi. Praktik pengadaan cakram dan suku cadang.")
    expect(hits).toEqual([{ sentence: "Praktik pengadaan cakram dan suku cadang.", words: 6 }])
  })
})

describe("row 85: the owner's prose guide (panduan_gaya_bahasa_dokumen.md section 3)", () => {
  // 3.5 Paragraf genset, naskah lama: the only "before" example whose fault is a sentence without a predicate.
  const before35 =
    "kVA ≥ P×1,2 ÷ η ÷ PF ÷ derating — basis dikoreksi: genset menanggung input UPS (bukan output). rumus dasar KATALOG-RUMUS.md:385-390 §10 (Mahon, PDF 136. mekanisme derating PDF 40-42 :392-394). derating dibagi bukan dikali"
  const after35 =
    "Genset harus sanggup memasok daya masuk UPS, bukan hanya beban di sisi keluarannya, karena UPS sendiri membuang sebagian daya sebagai panas. Kapasitas tiap genset dihitung dari beban lokasi ditambah cadangan pertumbuhan 20 %, dibagi efisiensi UPS 0,90, faktor daya 0,80, dan faktor penurunan kemampuan 0,90 untuk kondisi lokasi. Untuk kantor pusat hasilnya 12,04 kVA, dan untuk kedua belas lokasi 30,46 kVA. Angka ini belum mencakup arus mula beban, pengisian ulang baterai, dan pendingin ruangan, yang baru dapat dihitung setelah lembar data pabrikan tersedia. Rumus diletakkan di blok rumus tersendiri, dan rujukannya di baris sumber."
  const after31 =
    "Kajian ini menilai apakah empat subsistem Pusat Kendali Terpadu di dua belas lokasi layak dilanjutkan ke tahap rancangan rinci. Seluruh angka di dalamnya adalah data uji fiktif dan tidak boleh dipakai sebagai dasar pengadaan. Dasar teknisnya diambil dari pustaka pengetahuan EKAS, dan setiap angka yang berasal dari luar pustaka itu diberi tanda. Perhitungan sudah diperiksa ulang oleh pihak kedua, tetapi belum disahkan oleh insinyur penanggung jawab, sehingga hasilnya berstatus usulan."
  const after33a =
    "Menambah jalur ketiga tidak membuat jaringan lebih tersedia. Pada susunan dua jalur kerja dengan satu cadangan, layanan terganggu begitu dua dari tiga jalur putus, dan dengan tiga jalur aktif peluang kejadian itu lebih besar daripada pada susunan satu jalur kerja dengan satu cadangan. Hasilnya 99,9967 % berbanding 99,9989 %, atau sekitar 17 menit berbanding 6 menit terputus dalam setahun. Susunan tiga jalur layak dipilih hanya bila tujuannya menjaga kapasitas penuh saat satu jalur putus."
  const after33b =
    "Angka ini peka terhadap mutu tiap ruas. Bila ketidaktersediaan satu ruas naik dari 0,1 % menjadi 0,5 %, ketersediaan susunan tiga jalur turun menjadi 99,92 %, setara tujuh jam terputus per tahun. Karena itu angka ketersediaan di bab ini adalah hasil analisis dengan asumsi yang disederhanakan, dan belum boleh dikutip sebagai jaminan layanan."
  const after32 =
    "Tanpa cadangan 98,91 % (terputus sekitar 96 jam per tahun). Dengan satu jalur cadangan per ruas 99,9989 % (sekitar 6 menit per tahun). Jalur cadangan tunggal sudah cukup. Susunan tiga jalur tidak menambah ketersediaan. Rumusnya berasal dari luar EKAS."

  test('the "before" paragraph of 3.5 is flagged: the reference fragment that stands where a sentence should', () => {
    expect(found(before35)).toEqual(["rumus dasar KATALOG-RUMUS.md:385-390 §10 (Mahon, PDF 136."])
  })
  test('every "after" paragraph (3.1, 3.2, 3.3, 3.5) is quiet', () => {
    for (const text of [after31, after32, after33a, after33b, after35]) expect(found(text)).toEqual([])
  })
  test("the sentences of rules 8, 9 and of table 3.6 are quiet", () => {
    expect(found("Layanan tersedia 99,9967 %, atau terputus sekitar 17 menit dalam setahun.")).toEqual([])
    expect(
      found("Pustaka teknis tidak memuat ambang resistans pembumian, sehingga nilai 5 ohm di sini adalah persyaratan pemilik, bukan ketentuan standar."),
    ).toEqual([])
    expect(found("Dasar teknis diambil dari pustaka. Ambang resistans pembumian tidak ditemukan di EKAS.")).toEqual([])
  })
})

describe("row 85: what counts as a predicate (precision over recall)", () => {
  const withPredicate: Array<[string, string[]]> = [
    ["verbal affixes me-, ber-, di-, ter-, -kan", [
      "Genset memasok daya masuk seluruh lokasi.",
      "Ketersediaan jaringan berbanding lurus dengan mutu ruas.",
      "Seluruh angka uji dicatat pada lembar hitung.",
      "Gerbang pemeriksaan orang kedua masih terbuka.",
      "Aktifkan penskalaan jendela pada semua jalur panjang.",
      "Seluruh temuan TERKONFIRMASI oleh pihak kedua kemarin.",
    ]],
    ["copula and predicate markers", [
      "Seluruh angka kajian ini adalah data uji fiktif.",
      "Pilihan kedua ialah genset per lokasi.",
      "Sasaran pemilik yaitu resistans lima ohm.",
      "Pada rak pustaka ada tiga katalog rumus.",
      "Nilai lima ohm bukan ketentuan standar pemilik.",
    ]],
    ["modal, aspect and negation followed by a word", [
      "Kelas rating genset tidak dapat diklaim.",
      "Lembar data pabrikan belum kami terima.",
      "Rute cadangan akan lewat sisi selatan kota.",
      "Uji tahunan baterai wajib tiap bulan Januari.",
    ]],
    ["base verbs", [
      "Empat ruas panjang gagal terhadap anggaran uji.",
      "Setiap lokasi butuh desain pembumian tersendiri.",
      "Beban transit naik menuju akar pohon jaringan.",
    ]],
    ["adjectival predicates that can be recognised safely", [
      "Susunan tiga jalur lebih buruk daripada susunan dua jalur.",
      "Angka ketersediaan ini peka terhadap mutu ruas.",
      "Radius proteksi kelas empat itu besar.",
      "Biaya pemasangan jalur ketiga sangat mahal.",
    ]],
    ["nominal and numeral predicates that can be recognised safely", [
      "Untuk kantor pusat hasilnya 12,04 kVA, dan untuk kedua belas lokasi 30,46 kVA.",
      "Panjang ruas terjauh dari kantor pusat 40 km.",
      "Nilai itu persyaratan pemilik untuk semua lokasi.",
      "Celah katalog rumus hanya tentang metode perencanaan kapasitas umum.",
    ]],
  ]
  for (const [name, sentences] of withPredicate) {
    test(`Indonesian: ${name}`, () => {
      for (const s of sentences) expect([s, hasPredicate(s, "ID")]).toEqual([s, true])
      expect(found(sentences.join(" "))).toEqual([])
    })
  }
  test("words that only look like affixed verbs are not predicates", () => {
    for (const s of [
      "Menara dan mesin diesel di terminal tersebut.",
      "Berkas dan berita acara menurut metode terbaik.",
      "Diagram distribusi digital terhadap dinding terminal.",
      "Rekan dekan sebagai pembanding pekan terakhir.",
    ]) {
      expect([s, hasPredicate(s, "ID")]).toEqual([s, false])
    }
  })
  test("English: auxiliaries, -ed, listed verbs, pronoun subjects, plural subject before a content word, imperatives", () => {
    const sentences = [
      "The recorder is in the control room.",
      "Backup power covers two hours of load.",
      "The team installed four cameras per site.",
      "They monitor the gate from the control room.",
      "The cameras monitor the gate at night.",
      "The system aggregates traffic from twelve sites.",
      "Replace the battery bank after ten years.",
      "It's the only path to the root.",
    ]
    for (const s of sentences) expect([s, hasPredicate(s, "EN")]).toEqual([s, true])
    expect(found(sentences.join(" "), "EN")).toEqual([])
  })
  test("an English sentence inside an Indonesian document is quiet when it carries an unambiguous auxiliary", () => {
    expect(found("Catatan pabrikan dikutip utuh. The rating is valid for prime power only.")).toEqual([])
  })
})

describe("row 85: what stays quiet by construction", () => {
  const fragment = "survei dan pengukuran lapangan di dua belas lokasi"
  test(`fragments under ${MIN_WORDS} words`, () => {
    expect(found("Kamera dipasang di gerbang. Video. Daya cadangan. Tiga menara baru. Hasilnya dicatat.")).toEqual([])
    expect(found("Kepekaan diuji pada tiga nilai. 0,2 % → 99,9868 %. 0,5 % → 99,9178 % (7,2 jam).")).toEqual([])
  })
  test('definitions and labels in "term: explanation" form', () => {
    expect(found(`Cap data: ${fragment}. Sumber: katalog rumus pabrikan edisi kedua belas.`)).toEqual([])
    expect(found("Hasil dicatat. Tangga klaim (agen-lapor): tingkat satu untuk semua kartu hitung.")).toEqual([])
    // a colon after a long lead is not a label
    expect(found("Hasil dicatat. Empat subsistem utama di dua belas lokasi kajian: video, serat, daya, petir.")).toHaveLength(1)
  })
  test("a lead-in that ends with a colon, and a last line without closing punctuation (label)", () => {
    expect(found("Rumus batang tunggal dari sumber luar pustaka teknis:")).toEqual([])
    expect(found(`Hasil dicatat. ${fragment}`)).toEqual([])
    expect(found(`Hasil dicatat. ${fragment}.`)).toHaveLength(1)
  })
  test("a short run-in heading at the start of a paragraph", () => {
    expect(found("Aksi penutup dan penerima. Kepala badan menerima kajian ini sebagai bahan keputusan.")).toEqual([])
    // the same words later in the paragraph are a fragment
    expect(found("Kepala badan menerima kajian ini. Aksi penutup dan penerima.")).toEqual(["Aksi penutup dan penerima."])
    // a lone sentence is not a heading
    expect(found("Aksi penutup dan penerima.")).toEqual(["Aksi penutup dan penerima."])
  })
  test("inline list items", () => {
    expect(found("(a) rumus resistans batang tunggal dari luar pustaka. (b) kelas optik jarak jauh tanpa angka.")).toEqual([])
    expect(found("1. survei rute serat optik utama. 2. lembar data pabrikan untuk genset.")).toEqual([])
    expect(found("Hasil dicatat. a) kelas optik jarak jauh tanpa angka.")).toEqual([])
  })
  test("sentences inside quotes", () => {
    expect(found(`Label pada kartu ditulis utuh. "Survei dan pengukuran lapangan di lokasi." Hasilnya dicatat.`)).toEqual([])
    expect(found(`Pemilik menulis "Biaya terlalu besar. Jadwal pekerjaan sipil dan pondasi menara. Mohon ditinjau." pada suratnya.`)).toEqual([])
    expect(found("Label pada kartu ditulis utuh. “Survei dan pengukuran lapangan di lokasi.” Hasilnya dicatat.")).toEqual([])
  })
  test("code spans (when the unit carries the original md-lite text)", () => {
    expect(found("Perintah dijalankan sekali. `studio_render` untuk dokumen dan lampiran akhir.")).toEqual([])
    const layers = extractLayers(snapshot([para(1, "Perintah dijalankan sekali. Keluaran untuk dokumen dan lampiran akhir.")]))
    const withRaw = { ...layers, prose: layers.prose.map((u) => ({ ...u, raw: "Perintah dijalankan sekali. `studio_render` untuk dokumen dan lampiran akhir." })) }
    expect(LANGUAGE_SCANNERS["C-36"](buildContext(withRaw, {}, "ID")).map((i) => i.status)).toEqual(["PASS"])
  })
  test("formulas", () => {
    expect(found("Rugi dihitung per ruas. Total rugi = panjang × rugi per kilometer + jumlah konektor × rugi konektor.")).toEqual([])
  })
  test("identifiers, file names and codes are not read as words", () => {
    expect(found("Hasil dicatat. KATALOG-RUMUS.md:408-416 A-28 L01 rev2 05_calc_rev2.md.")).toEqual([])
    expect(hasPredicate("Sumber angka di berkas terima_data.md dan dibuat_ulang.md.", "ID")).toBe(false)
  })
  test("table cells: a pipe row stored as a paragraph", () => {
    expect(found(`A-33 | ${fragment}. | skenario kerja | datasheet sel pabrikan. | ${fragment}.`)).toEqual([])
  })
  test("headings, list items, captions, tables and code blocks are not in the prose layer", () => {
    const blocks = [
      { blockId: "h", address: "1.0.1", type: "heading", content: { text: `Judul ${fragment}.` } },
      para(2, `Judul bab: ${fragment}.`, { role: "kicker" }),
      { blockId: "l", address: "1.0.3", type: "list", content: { style: "bullet", items: [{ text: `${fragment}.` }, { text: "audit penangkal petir eksisting di lokasi." }] } },
      { blockId: "t", address: "1.0.4", type: "table", content: { rows: [[{ text: `${fragment}.` }]] } },
      { blockId: "f", address: "1.0.5", type: "image", content: { caption: { text: `Hasil ${fragment}.` } } },
      { blockId: "m", address: "1.0.6", type: "monoBlock", content: { text: `${fragment}.` } },
      para(7, "Kamera dipasang di gerbang. Perekam ditempatkan di ruang kendali."),
    ]
    expect(scan(blocks)).toEqual([{ checkId: "C-36", status: "PASS", detail: "1 paragraf prosa tanpa kalimat yang jelas tidak berpredikat" }])
  })
  test("clean Indonesian and English prose", () => {
    expect(
      found(
        "Kamera dipasang di gerbang. Perekam ditempatkan di ruang kendali. Daya cadangan dihitung untuk dua jam. Jalur cadangan tunggal sudah cukup. Rumusnya berasal dari luar pustaka teknis.",
      ),
    ).toEqual([])
    expect(
      found("The camera sits at the gate. The recorder is in the control room. Backup power covers two hours. A third path does not add availability.", "EN"),
    ).toEqual([])
    expect(found("")).toEqual([])
  })
})

describe("row 85: the scanner in the language module", () => {
  test("the id and the registry row: C-36, group C, module language, warning", () => {
    expect(SENTENCE_WITHOUT_PREDICATE_ID).toBe("C-36")
    const def = getLintDef("C-36")!
    expect([def.group, def.module, def.limit, def.blocksIngest]).toEqual(["C", "language", "lapor", false])
    expect(typeof LANGUAGE_SCANNERS["C-36"]).toBe("function")
  })
  test("one REPORT per paragraph with its address and the sentence; PASS when clean", () => {
    const out = scan([
      para(1, "Kamera dipasang di gerbang. Perekam ditempatkan di ruang kendali."),
      para(2, "Lingkup luar meliputi pekerjaan sipil. audit penangkal petir eksisting. survei dan pengukuran lapangan. keamanan siber tingkat kebijakan umum."),
      { blockId: "a", address: "1.0.3", type: "aside", content: { label: { text: "Catatan" }, body: [{ text: "Angka diperiksa ulang. Praktik pengadaan cakram dan suku cadang." }] } },
    ])
    expect(out.map((i) => [i.checkId, i.status, i.address])).toEqual([
      ["C-36", "REPORT", "1.0.2"],
      ["C-36", "REPORT", "1.0.3"],
    ])
    expect(out[0].detail).toContain("1.0.2: 3 kalimat tanpa predikat")
    expect(out[0].detail).toContain('"audit penangkal petir eksisting."')
    expect(out[0].detail).toContain('"survei dan pengukuran lapangan."')
    expect(out[0].detail).toContain("dan 1 lagi di paragraf ini")
    expect(out[1].detail).toContain('"Praktik pengadaan cakram dan suku cadang."')
    expect(scan([para(1, "Kamera dipasang di gerbang.")]).map((i) => i.status)).toEqual(["PASS"])
    expect(scan([]).map((i) => i.status)).toEqual(["PASS"])
  })
  test("a long sentence is shortened in the detail", () => {
    const long = `Angka diperiksa ulang. Daftar ${Array.from({ length: 40 }, (_, i) => `perangkat${"x".repeat(i % 3)} cadangan`).join(", ")}.`
    const out = scan([para(1, long)])
    expect(out[0].status).toBe("REPORT")
    expect(out[0].detail!.length).toBeLessThan(330)
    expect(out[0].detail).toContain("…")
  })
  test("more than 50 paragraphs: 50 issues and one summary, all REPORT", () => {
    const blocks = Array.from({ length: 53 }, (_, i) => para(i + 1, "Angka diperiksa ulang. Praktik pengadaan cakram dan suku cadang."))
    const out = scan(blocks)
    expect(out).toHaveLength(51)
    expect(out.every((i) => i.status === "REPORT")).toBe(true)
    expect(out[50].detail).toBe("dan 3 kalimat tanpa predikat di 3 paragraf lain tidak dirinci (peringatan)")
  })
  test("the language of the document selects the word lists", () => {
    const en = "The recorder is in the control room. Two cameras per site for the twelve locations."
    expect(scan([para(1, en)], "EN").map((i) => i.status)).toEqual(["REPORT"])
    const id = "Perekam ditempatkan di ruang kendali. Dua kamera per lokasi untuk dua belas lokasi."
    expect(scan([para(1, id)], "ID").map((i) => i.status)).toEqual(["REPORT"])
  })
  test("a warning never blocks: REPORT only, release stays PASS", () => {
    const out = scan([para(1, "Angka diperiksa ulang. Praktik pengadaan cakram dan suku cadang.")])
    expect(out.some((i) => i.status === "FAIL")).toBe(false)
    for (const tier of ["TERBIT", "SERAH"] as const) expect(releaseFor(out, tier)).toBe("PASS")
    expect(releaseFor(out, "NOTA")).not.toBe("FAIL") // the rule is not registered for NOTA
  })
  test("through lintLanguage: REPORT once the staged marker is gone from the registry row, NOT_RUN with the registry reason until then", () => {
    const def = getLintDef("C-36")!
    const out = lintLanguage(snapshot([para(1, "Angka diperiksa ulang. Praktik pengadaan cakram dan suku cadang.")]), {}).filter((i) => i.checkId === "C-36")
    if (isLintImplemented(def)) expect(out.map((i) => [i.status, i.address])).toEqual([["REPORT", "1.0.1"]])
    else expect(out).toEqual([{ checkId: "C-36", status: "NOT_RUN", detail: def.notRunReason }])
  })
})

// Bug report from row 86: a lint rule must never throw on a valid document. The scanner and the finder return PASS /
// no findings for every optional shape the language checks receive.
describe("row 85: odd document shapes never throw", () => {
  const meta = { meta: { language: "ID" } }
  const shapes: Array<[string, unknown]> = [
    ["empty blocks (empty chapter)", { doc: meta, blocks: [] }],
    ["no doc", { blocks: [] }],
    ["table-only chapter", { doc: meta, blocks: [{ blockId: "t", address: "1.0.1", type: "table", content: { rows: [[{ text: "survei dan pengukuran lapangan di dua belas lokasi." }]] } }] }],
    ["heading and list only", { doc: meta, blocks: [{ blockId: "h", type: "heading", content: { text: "Bab satu" } }, { blockId: "l", type: "list", content: { items: [] } }] }],
    ["paragraph without content", { doc: meta, blocks: [{ blockId: "p", type: "paragraph" }] }],
    ["paragraph with empty content", { doc: meta, blocks: [{ blockId: "p", type: "paragraph", content: {} }] }],
    ["paragraph with empty runs", { doc: meta, blocks: [{ blockId: "p", type: "paragraph", content: { runs: [] } }] }],
    ["aside without body", { doc: meta, blocks: [{ blockId: "a", type: "aside", content: {} }] }],
  ]
  for (const [name, s] of shapes) {
    test(`${name}: scanner PASS, lintLanguage gives C-36 PASS`, () => {
      expect(LANGUAGE_SCANNERS["C-36"](buildContext(extractLayers(s as never), {}, "ID")).map((i) => i.status)).toEqual(["PASS"])
      expect(lintLanguage(s as never, {}).filter((i) => i.checkId === "C-36").map((i) => i.status)).toEqual(["PASS"])
    })
  }
  test("a context without layers, without prose, or with units that have no text: PASS, never a throw", () => {
    for (const ctx of [{}, { layers: {} }, { layers: { prose: null } }, { layers: { prose: [null, { blockId: "x" }, { blockId: "y", text: null }, { blockId: "z", text: 5 }] } }]) {
      expect(LANGUAGE_SCANNERS["C-36"](ctx as never).map((i) => i.status)).toEqual(["PASS"])
    }
  })
  test("the finder returns no findings for text that is not a string", () => {
    for (const t of [undefined, null, 5, {}]) expect(findSentencesWithoutPredicate(t as never)).toEqual([])
  })
  test("a snapshot without `blocks`: lintLanguage does not throw and C-36 never warns or fails", () => {
    // extractLayers (prose.ts, not this row's file) reads `s.blocks` without a guard, so lintLanguage turns the
    // module error into NOT_RUN for every language rule; request filed for `s.blocks ?? []`. Once it lands: PASS.
    const out = lintLanguage({ doc: meta } as never, {}).filter((i) => i.checkId === "C-36")
    expect(out).toHaveLength(1)
    expect(["PASS", "NOT_RUN"]).toContain(out[0].status)
  })
})
