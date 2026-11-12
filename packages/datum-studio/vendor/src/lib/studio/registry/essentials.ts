/**
 * Permukaan parameter (SR-05): lapis setiap kunci rinci (`PARAM_SURFACE`) dan
 * kenop esensial berlabel awam (`ESSENTIAL_KNOBS`).
 *
 * Sumber: research/09 §5.2 (daftar ID otoritatif per berkas), §4.3 (kunci baru), §7
 * (28 kenop), diputus D-165; nama dan lapis kunci kontrak baru diselaraskan ke register
 * SR-01 (`masterplan/03_structural_sections_specs.md` §13, D-166, KT-13). Delta atas
 * research/09 karena penyelarasan SR-01:
 * - `type.scale.body.size` (P4T-S04-size) = essential (kenop "Ukuran huruf dasar",
 *   SR-01 PC-06), menggantikan kunci N6 `type.baseSizePt` yang tidak dibuat.
 * - `grid.rederiveForNonA4` (P4G-17) = internal (SR-01 PC-04; tetap kelas T).
 * - `page.customSizeMm` (R-46) = advanced kelas B (register SR-01 §13.1).
 * - `slot.setup` (R-41) = advanced (register SR-01). D-165 KT-10 (putusan controller): dua
 *   kenop Konten bertipe `medan` menulis HANYA `slot.setup.startOnNewPage` dan
 *   `slot.setup.runningHead`; izin lapis diperiksa per kenop (SR-06/SR-07) lewat
 *   `ESSENTIAL_FIELD_PATHS` / `isEssentialFieldPath`. Medan setup lain tetap advanced (403
 *   `PARAM_SURFACE_FORBIDDEN` untuk USER). Total kenop 30 (Konten 7).
 *
 * Lapis "derived" memuat T-hitung (kelas T) dan T-acuan (kelas B ber-`derive`, nilai
 * acuan hanya dapat disematkan preset; D-165 KT-4).
 *
 * Modul murni: tidak mengimpor `params/` (params/index.ts mengisi `surface`).
 */
import type { ParamSurface } from "../contract/enums";
import type { ParamDef } from "../contract/types/params";
import type { EssentialKnobDef } from "../contract/types/v2/template";

/** T2-59 + medan penjelas SR-05 (research/09 §7) untuk UI dan route R03 `kind=essentials`. */
export interface EssentialKnobSpec extends EssentialKnobDef {
  /** Bantuan singkat bahasa awam. */
  help: string;
  /**
   * langsung = nilai kenop = nilai kunci; petaNilai = label pilihan -> nilai kunci;
   * anggota = bool menyisipkan/membuang `member` dari daftar kunci; turunan = kunci
   * dibaca fungsi turunan (research/09 §6.2); medan = bool menulis `field` di dalam objek kunci.
   */
  mapping: "langsung" | "petaNilai" | "anggota" | "turunan" | "medan";
  /** Medan objek untuk pemetaan `medan` (mis. `startOnNewPage` di `slot.setup`). */
  field?: string;
  /** Unsur daftar untuk pemetaan `anggota` (mis. "logo" di `cover.elementOrder`). */
  member?: string;
  /** Kenop enum yang memilih subset urut (daftar), bukan satu nilai. */
  multiple?: boolean;
  /** Rentang kontrol angka. */
  range?: { min?: number; max?: number; step?: number };
}

// ── PARAM_SURFACE (research/09 §5.2 + §4.3) ──────────────────────────────

type IdSpec = number | readonly [number, number];

/** Daftar ID berpadding dua digit: ids("P4C-", 1, [3, 5]) -> P4C-01, P4C-03, P4C-04, P4C-05. */
function ids(prefix: string, ...specs: IdSpec[]): string[] {
  const out: string[] = [];
  for (const s of specs) {
    const [a, b] = typeof s === "number" ? [s, s] : s;
    for (let n = a; n <= b; n++) out.push(`${prefix}${String(n).padStart(2, "0")}`);
  }
  return out;
}

/** Daftar ID eksplisit per lapis (transkripsi research/09 §5.2; per berkas sumber). */
export const PARAM_SURFACE_LISTS: Readonly<Record<ParamSurface, readonly string[]>> = {
  essential: [
    ...ids("P3-", 23),
    ...ids("PD-", 1),
    ...ids("P4C-", 14),
    "P4T-S04-size",
    ...ids("P4G-", 16),
    ...ids("P4S-", 1, 15, 20),
    ...ids("P4V-", 3, 8),
    ...ids("P4A-", 4),
    ...ids("P6-", 2),
    ...ids("R-", 22),
    // Kunci kontrak baru.
    ...ids("R-", 42, 44, 45, 47, 55, 56, 57, 58),
  ],
  advanced: [
    ...ids("P3-", 1, 18),
    ...ids("P4C-", [1, 7], [8, 13], [15, 17], 23, [25, 33], 35),
    ...ids("P4T-", [1, 5], [10, 13], 15, 16),
    ...ids("P4T-X", 2, 3, 4, 6, 7, 9, 10, 11, 12),
    ...ids("P4G-", 4, 5, 8),
    ...ids("P4R-", [1, 8], [12, 15]),
    ...ids("P4S-", [4, 8], [10, 13], 16, 17, [21, 26]),
    ...ids("P4V-", 5, 6, 7, 9, 12, 13, 14, 15, 16),
    ...ids("P4K-", 1, 2, 4, 5, 6),
    ...ids("P4A-", 1, 8),
    ...ids("P5-", 3, 4, 7, 8, 9, 12, 13, 24, 26, 27, 28, [30, 37], 41, 62),
    ...ids("P6-", 19, 30),
    ...ids("P7-", 5, [7, 12], 13, 16, 27, 32, 35, 36),
    // Swarm 1.2.6 row 72 (T-18/W-10): kuota gambar dan alasan pengecualian, kenop penyusun templat seperti R-81..R-83.
    ...ids("P7-", 37, 38),
    ...ids("P9-", [9, 31], 40, 44, 47, 48),
    ...ids("R-", 15, 16, 20, 21, 26, 27, 33, 34, 36),
    // Kunci kontrak baru.
    ...ids("R-", 41, 43, 46, 48, 49, 50, 51, 52, 54),
    // RQ-8: judul/catatan daftar isi, kelas lebar gambar/lembar simbol.
    ...ids("R-", [59, 62]),
    // FIX-FIG (D-257): resolusi gambar raster aturan ukuran asli K-2.
    ...ids("R-", 65),
    // FIX-TL (D-351/D-352): kedalaman daftar isi `toc.levels`, pola R-59/R-60 (lanjutan ADMIN).
    ...ids("R-", 66),
    // Ronde cakupan DATUM Rev A (C06; D-631, D-635): R-67..R-80 opt-in lanjutan (research/38 §1.1, syarat C-1).
    ...ids("R-", [67, 80]),
    // Row 122c (Swarm 1.2.0, C96 R42-D1): R-81..R-83 = data templat Rev A row 122 (pernyataan metode, distribusi,
    // datum geodetik), kelas B, bawaan kosong; disetel penyusun templat, bukan kenop awam -> advanced seperti R-67..R-80.
    ...ids("R-", [81, 83]),
  ],
  derived: [
    ...ids("P3-", 4, 6, 7, 8, 11, 16, 19, 21),
    ...ids("P4T-", 17),
    ...ids("P4T-X", 1, 5, 8),
    ...ids("P4G-", [1, 3], 6, 7, 9, 10, 11, 12, 13, 15),
    ...ids("P4R-", 11),
    ...ids("P4S-", 2, 3, 27),
    ...ids("P4V-", 2, 11),
    ...ids("P4A-", 3),
    ...ids("P5-", 10, 14, 18, 45, 46, 47, 58, 67, 68),
    ...ids("P6-", 26),
    ...ids("P7-", 20, 30, 31),
    ...ids("P9-", 4, 36, 38, 45, 51),
    ...ids("R-", 13),
    // Kunci kontrak baru (T-acuan).
    ...ids("R-", 53),
    // RQ-8: lebar gambar/lembar simbol (T-hitung, figureWidthFromClass).
    ...ids("R-", 63, 64),
  ],
  internal: [
    ...ids("P1-", [1, 4]),
    ...ids("P3-", 2, 3, 5, 9, 10, 12, 13, 14, 15, 17, 20, 22, 24),
    ...ids("P11-", [1, 44]),
    ...ids("P15-", [1, 31]),
    ...ids("P16-", [1, 8]),
    ...ids("PA-", 1),
    ...ids("PB-", 1),
    ...ids("PC-", 1),
    ...ids("P4C-", 18, 19, 20, 21, 22, 24, 34),
    ...ids("P4T-", [6, 9], 14, 18),
    ...ids("P4T-X", 13, 14),
    ...ids("P4G-", 14, 17),
    ...ids("P4R-", 9, 10),
    ...ids("P4S-", 9, 14, 18, 19),
    ...ids("P4V-", 1, 4, 10),
    ...ids("P4K-", 3),
    ...ids("P4A-", 2, 5, 6, 7, 9, 10),
    ...ids("P5-", 1, 2, 5, 6, 11, 15, 16, 17, [19, 23], 25, 29, 38, 39, 40, 42, 43, 44, [48, 57], 59, 60, 61, [63, 66]),
    ...ids("P6-", 1, [3, 18], [20, 25], 27, 28, 29, [31, 43]),
    ...ids("P7-", [1, 4], 6, 14, 15, 17, 18, 19, [21, 26], 28, 29, 33, 34),
    ...ids("P8-", 1, 2),
    ...ids("P9-", [1, 3], [5, 8], [32, 35], 37, 39, 41, 42, 43, 46, 49, 50, [52, 55]),
    ...ids("P10-", [1, 42]),
    ...ids("R-", [1, 12], 14, 17, 18, 19, 23, 24, 25, 28, 29, 30, 31, 32, 35, 37),
    // Kunci kontrak baru.
    ...ids("R-", 38, 39, 40),
  ],
};

/** Unsur skala huruf yang `leading`-nya turunan beracuan (research/09 §5.2: 8 unsur). */
const SCALE_LEADING_DERIVED = new Set(["01", "03", "04", "05", "08", "09", "10", "13"]);

const SURFACE_BY_ID: ReadonlyMap<string, ParamSurface> = new Map(
  (Object.keys(PARAM_SURFACE_LISTS) as ParamSurface[]).flatMap((s) => PARAM_SURFACE_LISTS[s].map((id) => [id, s] as const)),
);

/**
 * Sumber tunggal lapis (SR-01 §13.5): daftar ID eksplisit, lalu pola untuk dua
 * keluarga besar yang seragam (skala huruf P4T-S*, parameter chart P7X).
 */
export const PARAM_SURFACE = {
  byId: SURFACE_BY_ID,
  /** P4T-S*: size = derived (body.size ada di byId sebagai essential); leading 8 unsur = derived; atribut lain = advanced. */
  scaleAttr(id: string): ParamSurface | undefined {
    const m = /^P4T-S(\d{2})-([a-zA-Z]+)$/.exec(id);
    if (!m) return undefined;
    if (m[2] === "size") return "derived";
    if (m[2] === "leading") return SCALE_LEADING_DERIVED.has(m[1]) ? "derived" : "advanced";
    return "advanced";
  },
  /** registry/charts.ts: 99 bawaan tampilan per jenis chart = advanced. */
  groups: { P7X: "advanced" } as Readonly<Record<string, ParamSurface>>,
} as const;

/** Lapis satu kunci; `undefined` = belum dipetakan (dicegat skrip hitung SR-05). */
export function paramSurfaceOf(def: Pick<ParamDef, "id" | "group">): ParamSurface | undefined {
  return PARAM_SURFACE.byId.get(def.id) ?? PARAM_SURFACE.scaleAttr(def.id) ?? PARAM_SURFACE.groups[def.group];
}

// ── Kenop esensial (research/09 §7 + D-165 KT-10; 30 kenop) ────────────────────────────

export const ESSENTIAL_MAX_PER_GROUP = 8;
export const ESSENTIAL_MAX_TOTAL = 60;

export const ESSENTIAL_KNOBS: readonly EssentialKnobSpec[] = [
  // Global dokumen (8).
  {
    id: "EK-G01",
    scope: "global",
    label: "Ukuran kertas",
    help: "Ukuran halaman untuk semua keluaran",
    keys: ["page.size"],
    control: "enum",
    options: [
      { value: "A4", label: "A4" },
      { value: "A3", label: "A3" },
      { value: "A5", label: "A5" },
      { value: "Letter", label: "Letter" },
      { value: "Legal", label: "Legal" },
      { value: "F4", label: "F4" },
    ],
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-G02",
    scope: "global",
    label: "Orientasi",
    help: "Tegak atau mendatar; dapat diubah per bagian",
    keys: ["page.orientation"],
    control: "enum",
    options: [
      { value: "portrait", label: "Tegak" },
      { value: "landscape", label: "Mendatar" },
    ],
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-G03",
    scope: "global",
    label: "Kerapatan margin",
    help: "Rapat = margin x0,75, Lega = x1,25 dari acuan gaya",
    keys: ["grid.marginDensity"],
    control: "enum",
    options: [
      { value: "compact", label: "Rapat" },
      { value: "standard", label: "Sedang" },
      { value: "wide", label: "Lega" },
    ],
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-G04",
    scope: "global",
    label: "Warna aksen",
    help: "Satu warna penekanan (label bab, sorotan grafik)",
    keys: ["color.interior.signal"],
    control: "color",
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-G05",
    scope: "global",
    label: "Ukuran huruf dasar",
    help: "Ukuran teks badan, 8-12 pt; judul dan keterangan ikut menyesuaikan",
    keys: ["type.scale.body.size"],
    control: "number",
    range: { min: 8, max: 12, step: 0.5 },
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-G06",
    scope: "global",
    label: "Bahasa",
    help: "Bahasa label otomatis (Bab, Lampiran, Daftar Isi)",
    keys: ["doc.language"],
    control: "enum",
    options: [
      { value: "ID", label: "Indonesia" },
      { value: "EN", label: "Inggris" },
    ],
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-G07",
    scope: "global",
    label: "Klasifikasi bawaan",
    help: "Tingkat kerahasiaan yang tercetak",
    keys: ["classification.level"],
    control: "enum",
    options: [
      { value: "Biasa", label: "Biasa" },
      { value: "Terbatas", label: "Terbatas" },
      { value: "Rahasia", label: "Rahasia" },
      { value: "Sangat Rahasia", label: "Sangat Rahasia" },
    ],
    class: "K",
    mapping: "langsung",
  },
  {
    id: "EK-G08",
    scope: "global",
    label: "Kolom catatan bukti",
    help: "Kolom catatan bukti di sisi halaman; bila tidak tampil, teks menjadi lebih lebar",
    keys: ["layout.railMode"],
    control: "enum",
    options: [
      { value: "auto", label: "Otomatis (muncul bila ada sitasi per paragraf)" },
      { value: "A", label: "Selalu tampil (kolom catatan bukti di margin)" },
      { value: "B", label: "Tidak tampil (teks lebih lebar)" },
    ],
    class: "B",
    mapping: "petaNilai",
  },
  // Sampul (7).
  {
    id: "EK-cover-01",
    scope: "cover",
    label: "Tampilkan logo",
    help: "Logo organisasi di sampul",
    keys: ["cover.elementOrder"],
    control: "bool",
    class: "B",
    mapping: "anggota",
    member: "logo",
  },
  {
    id: "EK-cover-02",
    scope: "cover",
    label: "Tampilkan paragraf pengantar",
    help: "Paragraf ringkas di bawah judul sampul",
    keys: ["cover.elementOrder"],
    control: "bool",
    class: "B",
    mapping: "anggota",
    member: "standfirst",
  },
  {
    id: "EK-cover-03",
    scope: "cover",
    label: "Tampilkan baris cakupan",
    help: "Baris sumber yang dicakup dokumen",
    keys: ["cover.elementOrder"],
    control: "bool",
    class: "B",
    mapping: "anggota",
    member: "baris cakupan",
  },
  {
    id: "EK-cover-04",
    scope: "cover",
    label: "Tampilkan blok kendali",
    help: "Nomor, revisi, dan penyusun dokumen",
    keys: ["cover.elementOrder"],
    control: "bool",
    class: "B",
    mapping: "anggota",
    member: "blok kendali",
  },
  {
    id: "EK-cover-05",
    scope: "cover",
    label: "Tampilkan pita segel",
    help: "Pita warna di tepi atas sampul",
    keys: ["device.sealBand.enabled"],
    control: "bool",
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-cover-06",
    scope: "cover",
    label: "Tampilkan teks tepi sampul",
    help: "Teks identitas (jenis dokumen, subjek, bahasa, revisi, bulan, tahun; sesuai setelan isi) berdiri di tepi luar sampul dan halaman pembatas bagian (sesuai setelan penempatan)",
    keys: ["device.spine.enabled"],
    control: "bool",
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-cover-07",
    scope: "cover",
    label: "Teks jenis dokumen",
    help: "Teks di atas judul sampul; kosong berarti tidak tampil",
    keys: ["cover.kicker.text"],
    control: "text",
    class: "B",
    mapping: "langsung",
  },
  // Lembar kendali (1).
  {
    id: "EK-controlSheet-01",
    scope: "controlSheet",
    label: "Tampilkan pita segel",
    help: "Pita warna di tepi atas lembar kendali",
    keys: ["device.sealBand.enabled"],
    control: "bool",
    class: "B",
    mapping: "langsung",
  },
  // Tanda tangan (1).
  {
    id: "EK-signatureBlock-01",
    scope: "signatureBlock",
    label: "Letak tanda tangan",
    help: "Di lembar kendali atau di halaman tersendiri",
    keys: ["slot.placement"],
    control: "enum",
    options: [
      { value: "inControlSheet", label: "Di lembar kendali" },
      { value: "standalone", label: "Halaman tersendiri" },
    ],
    class: "B",
    mapping: "petaNilai",
  },
  // Daftar isi (2).
  {
    id: "EK-toc-01",
    scope: "toc",
    label: "Bentuk daftar isi di Word",
    help: "Keduanya memuat kolom nomor halaman. Daftar isi Word: entri dan nomor halaman disusun ulang saat Word memperbarui daftar isi. Tabel tetap: entri apa adanya; nomor halaman memakai nomor tertulis atau rujukan ke judul. Halaman web selalu menampilkan tabel yang sama",
    keys: ["render.toc.mode"],
    control: "enum",
    options: [
      { value: "field", label: "Daftar isi Word (entri dan nomor halaman ikut diperbarui)" },
      { value: "static", label: "Tabel tetap (entri tetap; nomor halaman dari rujukan judul)" },
    ],
    class: "B",
    mapping: "petaNilai",
  },
  {
    id: "EK-toc-02",
    scope: "toc",
    label: "Tampilkan pita segel",
    help: "Pita warna di tepi atas daftar isi",
    keys: ["device.sealBand.enabled"],
    control: "bool",
    class: "B",
    mapping: "langsung",
  },
  // Konten (5).
  {
    id: "EK-chapter-01",
    scope: "chapter",
    label: "Label nomor bab",
    help: "Tulis {n} di tempat nomor, mis. BAB {n} menjadi BAB 1",
    keys: ["chapter.kicker.pattern"],
    control: "text",
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-chapter-02",
    scope: "chapter",
    label: "Garis penanda di atas judul bab",
    help: "Garis tipis berkisi di atas judul setiap bab",
    keys: ["device.datumRule.enabled"],
    control: "bool",
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-chapter-06",
    scope: "chapter",
    label: "Bab mulai di halaman baru",
    help: "Setiap bab dimulai pada halaman baru",
    keys: ["slot.setup"],
    control: "bool",
    class: "B",
    mapping: "medan",
    field: "startOnNewPage",
  },
  {
    id: "EK-chapter-07",
    scope: "chapter",
    label: "Kepala halaman di halaman bab",
    help: "Baris kepala halaman (judul dokumen, klasifikasi) di halaman bab",
    keys: ["slot.setup"],
    control: "bool",
    class: "B",
    mapping: "medan",
    field: "runningHead",
  },
  {
    id: "EK-chapter-03",
    scope: "chapter",
    label: "Lebar tabel",
    help: "Selebar kolom teks atau bentang penuh halaman",
    keys: ["table.widthClass"],
    control: "enum",
    options: [
      { value: "text", label: "Selebar kolom teks" },
      { value: "full", label: "Bentang penuh" },
    ],
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-chapter-04",
    scope: "chapter",
    label: "Lebar grafik",
    help: "Selebar kolom teks atau bentang penuh halaman",
    keys: ["chart.widthClass"],
    control: "enum",
    options: [
      { value: "text", label: "Selebar kolom teks" },
      { value: "full", label: "Bentang penuh" },
    ],
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-chapter-05",
    scope: "chapter",
    label: "Lebar diagram",
    help: "Selebar kolom teks atau bentang penuh halaman",
    keys: ["diagram.widthClass"],
    control: "enum",
    options: [
      { value: "text", label: "Selebar kolom teks" },
      { value: "full", label: "Bentang penuh" },
    ],
    class: "B",
    mapping: "turunan",
  },
  // Referensi (1).
  {
    id: "EK-sourceRegister-01",
    scope: "sourceRegister",
    label: "Kolom daftar sumber",
    help: "Kolom yang tampil di daftar sumber, berurutan",
    keys: ["sourceRegister.columns"],
    control: "enum",
    multiple: true,
    options: [
      { value: "DOKUMEN", label: "Dokumen" },
      { value: "VERSI/TANGGAL", label: "Versi/tanggal" },
      { value: "BAHASA/HALAMAN", label: "Bahasa/halaman" },
      { value: "KLASIFIKASI", label: "Klasifikasi" },
      { value: "DIPAKAI DI", label: "Dipakai di" },
    ],
    class: "B",
    mapping: "langsung",
  },
  // Lampiran (3).
  {
    id: "EK-appendix-01",
    scope: "appendix",
    label: "Label nomor lampiran",
    help: "Teks memuat {n}; kosong berarti ikut label bab (LAMPIRAN {n})",
    keys: ["appendix.kicker.pattern"],
    control: "text",
    class: "B",
    mapping: "langsung",
  },
  {
    id: "EK-appendix-02",
    scope: "appendix",
    label: "Orientasi halaman lampiran",
    help: "Tegak atau mendatar untuk halaman lampiran",
    keys: ["page.orientation"],
    control: "enum",
    options: [
      { value: "portrait", label: "Tegak" },
      { value: "landscape", label: "Mendatar" },
    ],
    class: "B",
    mapping: "turunan",
  },
  {
    id: "EK-appendix-03",
    scope: "appendix",
    label: "Garis penanda di atas judul lampiran",
    help: "Garis tipis berkisi di atas judul setiap lampiran",
    keys: ["device.datumRule.enabled"],
    control: "bool",
    class: "B",
    mapping: "langsung",
  },
];

/** research/09 §7 + KT-10: Global 8, Sampul 7, Lembar kendali 1, Tanda tangan 1, Daftar isi 2, Konten 7, Referensi 1, Lampiran 3. */
export const ESSENTIAL_KNOB_COUNT = 30;

/** Kenop untuk satu kelompok ("global" atau sectionType slot). */
export function essentialKnobsFor(scope: string): readonly EssentialKnobSpec[] {
  return ESSENTIAL_KNOBS.filter((k) => k.scope === scope);
}

/**
 * Jalur medan yang dibuka kenop esensial bertipe `medan` di dalam kunci induk yang
 * lapisnya BUKAN essential: kunci -> daftar medan (mis. `slot.setup` -> startOnNewPage,
 * runningHead). Pemeriksa izin (SR-06/SR-07) mengizinkan USER menulis medan ini saja;
 * medan lain kunci itu mengikuti lapis kuncinya.
 */
export const ESSENTIAL_FIELD_PATHS: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const k of ESSENTIAL_KNOBS) {
    if (k.mapping !== "medan" || !k.field) continue;
    for (const key of k.keys) {
      const arr = m.get(key) ?? [];
      if (!arr.includes(k.field)) arr.push(k.field);
      m.set(key, arr);
    }
  }
  return m;
})();

/** true bila `field` di dalam `key` dibuka kenop esensial (lihat ESSENTIAL_FIELD_PATHS). */
export function isEssentialFieldPath(key: string, field: string): boolean {
  return ESSENTIAL_FIELD_PATHS.get(key)?.includes(field) ?? false;
}
