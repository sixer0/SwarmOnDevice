/**
 * Kategori parameter untuk editor templat dan panel pratinjau (U02; D-626, D-627, D-630;
 * `research/39_param_categories.md`). Satu tabel dan satu helper pengelompokan bersama:
 * kategori -> subkelompok (namespace; S1 memecah `chart.kind` dan `type.scale`) -> parameter.
 *
 * Aturan hanya membaca `group` dan `key` (tidak pernah `chapter`):
 * 1. Pengecualian grup katalog: baris terpanjang yang cocok menang (`.` di akhir = awalan,
 *    selain itu kunci persis).
 * 2. Tanpa pengecualian: default grup.
 * 3. Grup `R` tanpa default: override kunci persis, lalu segmen kedua untuk `render.*`,
 *    lalu namespace. Yang tak terpetakan jatuh ke "Lainnya" sehingga uji U02 gagal
 *    sampai kategorinya diputuskan.
 * Murni (tanpa React); hanya label tampilan, tanpa perubahan nilai, registri, atau keluaran.
 */
import type { ParamDef, ParamGroup } from "@/lib/studio/contract/types/params";
import { namespaceLabel } from "./param-labels";

export type ParamCategoryId =
  | "warna"
  | "tipografi"
  | "halaman-grid"
  | "sampul"
  | "lembar-kendali"
  | "kepala-kaki"
  | "tabel"
  | "gambar-chart"
  | "diagram-simbol"
  | "bukti-angka"
  | "penomoran-klasifikasi"
  | "bahasa"
  | "lint-pemeriksaan"
  | "renderer-ekspor"
  | "lainnya";

export interface ParamCategory {
  id: ParamCategoryId;
  /** Label tampilan berbahasa Indonesia. */
  label: string;
  /** Deskripsi satu baris, tampil di bawah judul kategori. */
  help: string;
  /** Urutan tampilan, 1 = pertama. */
  order: number;
}

/**
 * Urutan tetap research/39 "Category list"; tidak bergantung saringan atau urutan registri.
 * D-632: label dan deskripsi memakai istilah umum pengguna kantor (grid, chart, file, Word,
 * header, footer), tanpa jargon pengembang (lint, renderer, run, DOCX). Id tetap sehingga
 * status buka (`cat:<id>`) dan uji tidak berubah.
 */
export const PARAM_CATEGORIES: readonly ParamCategory[] = (
  [
    ["warna", "Warna", "Palet warna dokumen, peran tiap warna, dan latar halaman."],
    ["tipografi", "Tipografi", "Font, ketebalan, dan ukuran teks untuk judul, isi, dan caption."],
    ["halaman-grid", "Halaman & grid", "Ukuran kertas, margin, grid, garis penanda, dan kolom catatan."],
    ["sampul", "Sampul", "Isi dan urutan halaman sampul, teks tepi, dan identitas organisasi."],
    ["lembar-kendali", "Lembar kendali", "Riwayat revisi, alur verifikasi, distribusi, dan tanda tangan."],
    ["kepala-kaki", "Header & footer", "Isi header dan footer, blok register, pita segel, dan cap terbit."],
    ["tabel", "Tabel", "Garis dan kepala tabel, caption, baris sumber, dan tabel spesifikasi."],
    ["gambar-chart", "Gambar & chart", "Aturan umum chart, pengaturan tiap jenis chart, dan gambar."],
    ["diagram-simbol", "Diagram & simbol", "Diagram, simbol standar, dan lembar gambar teknik."],
    ["bukti-angka", "Bukti, angka & satuan", "Tanda asal data, penulisan angka dan satuan, serta hitungan biaya."],
    ["penomoran-klasifikasi", "Penomoran & klasifikasi", "Nomor dan jenis dokumen, klasifikasi, pola nama file, dan daftar isi."],
    ["bahasa", "Bahasa", "Bahasa dokumen, gaya penulisan, surat dinas, dan kosakata."],
    ["lint-pemeriksaan", "Pemeriksaan otomatis", "Cek otomatis yang dijalankan sebelum dokumen terbit."],
    ["renderer-ekspor", "Pembuatan file & ekspor", "Cara file Word, HTML, PNG, dan PDF dibuat."],
    ["lainnya", "Lainnya", "Pengaturan yang belum masuk kategori mana pun."],
  ] as const
).map(([id, label, help], i) => ({ id, label, help, order: i + 1 }));

/** research/39 tabel A: default per grup katalog. Grup tanpa baris (P12-P14, R) tidak punya default. */
export const GROUP_DEFAULT_CATEGORY: Readonly<Partial<Record<ParamGroup, ParamCategoryId>>> = {
  P1: "lint-pemeriksaan",
  P3: "penomoran-klasifikasi",
  P4C: "warna",
  P4T: "tipografi",
  P4G: "halaman-grid",
  P4R: "halaman-grid",
  P4S: "kepala-kaki",
  P4V: "sampul",
  P4K: "lembar-kendali",
  P4A: "kepala-kaki",
  P5: "bukti-angka",
  P6: "bukti-angka",
  P7: "gambar-chart",
  P8: "gambar-chart",
  P7X: "gambar-chart",
  P9: "diagram-simbol",
  P10: "diagram-simbol",
  P11: "bahasa",
  P15: "renderer-ekspor",
  P16: "lint-pemeriksaan",
  PA: "lint-pemeriksaan",
  PB: "lint-pemeriksaan",
  PC: "bahasa",
  PD: "bukti-angka",
};

export interface CatalogException {
  /** E01-E30 (research/39 tabel B). */
  row: string;
  group: ParamGroup;
  /** Diakhiri `.` = awalan kunci; selain itu kunci persis. */
  match: string;
  category: ParamCategoryId;
  /** Jumlah kunci yang ditangkap menurut research/39 (sebelum baris lebih panjang menang). */
  n: number;
}

export const CATALOG_EXCEPTIONS: readonly CatalogException[] = (
  [
    ["E01", "P1", "content.", "bukti-angka", 1],
    ["E02", "P3", "doc.language", "bahasa", 1],
    ["E03", "P3", "artifact.format", "renderer-ekspor", 1],
    ["E04", "P3", "artifact.pdf.", "renderer-ekspor", 1],
    ["E05", "P3", "artifact.pageReconciliation.", "lint-pemeriksaan", 1],
    ["E06", "P3", "artifact.lint.", "lint-pemeriksaan", 1],
    ["E07", "P4S", "device.datumRule.", "halaman-grid", 6],
    ["E08", "P4S", "device.evidenceRail.", "halaman-grid", 3],
    ["E09", "P4S", "device.spine.", "sampul", 6],
    ["E10", "P4V", "wrapper.", "kepala-kaki", 1],
    ["E11", "P4A", "chapter.kicker.", "penomoran-klasifikasi", 1],
    ["E12", "P4A", "chapter.datumRule.", "halaman-grid", 1],
    ["E13", "P4A", "caption.", "tabel", 1],
    ["E14", "P4A", "source.", "tabel", 1],
    ["E15", "P4A", "table.", "tabel", 2],
    ["E16", "P5", "table.", "tabel", 16],
    ["E17", "P5", "caption.", "tabel", 4],
    ["E18", "P5", "caption.chart.", "gambar-chart", 1],
    ["E19", "P5", "source.", "tabel", 3],
    ["E20", "P5", "artifact.mustBeCalledInProse", "tabel", 1],
    ["E21", "P5", "specTable.", "tabel", 2],
    ["E22", "P5", "aside.", "halaman-grid", 2],
    ["E23", "P6", "classification.", "penomoran-klasifikasi", 8],
    ["E24", "P6", "doc.urgency", "penomoran-klasifikasi", 1],
    ["E25", "P6", "compliance.", "lint-pemeriksaan", 3],
    ["E26", "P6", "normativeQuote.", "bahasa", 1],
    ["E27", "P6", "letter.", "bahasa", 5],
    ["E28", "P6", "color.", "warna", 1],
    ["E29", "P6", "photocopy.", "lint-pemeriksaan", 1],
    ["E30", "P11", "jury.", "lint-pemeriksaan", 6],
  ] as const
).map(([row, group, match, category, n]) => ({ row, group, match, category, n }));

const EXCEPTIONS_BY_GROUP: ReadonlyMap<ParamGroup, readonly CatalogException[]> = (() => {
  const m = new Map<ParamGroup, CatalogException[]>();
  for (const e of CATALOG_EXCEPTIONS) m.set(e.group, [...(m.get(e.group) ?? []), e]);
  return m;
})();

/** research/39 tabel C: lima override kunci persis untuk grup R. */
export const R_EXACT_OVERRIDES: Readonly<Record<string, ParamCategoryId>> = {
  "slot.setup": "halaman-grid",
  "slot.placement": "lembar-kendali",
  "render.docx.headerFooterStyles": "kepala-kaki",
  "render.section.registerBlockLayout": "kepala-kaki",
  "render.section.numberSeparator": "penomoran-klasifikasi",
};

/** research/39 tabel C: kategori per segmen kedua kunci `render.<seg>.*`. */
export const R_RENDER_SEGMENT_CATEGORY: Readonly<Record<string, ParamCategoryId>> = {
  docx: "renderer-ekspor",
  section: "halaman-grid",
  rail: "halaman-grid",
  derivation: "bukti-angka",
  caption: "tabel",
  table: "tabel",
  specTable: "tabel",
  list: "tipografi",
  run: "tipografi",
  toc: "penomoran-klasifikasi",
  cover: "sampul",
  runningHead: "kepala-kaki",
  spacer: "renderer-ekspor",
  html: "renderer-ekspor",
  png: "renderer-ekspor",
  draft: "renderer-ekspor",
  // C06 (D-635 (1); research/38 §1.4): segmen kunci ronde cakupan R-74, R-76, R-77.
  rhythm: "halaman-grid",
  nota: "penomoran-klasifikasi",
  ruleIndex: "penomoran-klasifikasi",
};

/** research/39 tabel C: kategori per namespace grup R (selain `render`). */
export const R_NAMESPACE_CATEGORY: Readonly<Record<string, ParamCategoryId>> = {
  runningHead: "kepala-kaki",
  org: "kepala-kaki",
  lint: "lint-pemeriksaan",
  image: "gambar-chart",
  chart: "gambar-chart",
  symbolSheet: "diagram-simbol",
  symbol: "diagram-simbol",
  diagram: "diagram-simbol",
  table: "tabel",
  page: "halaman-grid",
  grid: "halaman-grid",
  doc: "penomoran-klasifikasi",
  appendix: "penomoran-klasifikasi",
  toc: "penomoran-klasifikasi",
  ingest: "renderer-ekspor",
  slot: "renderer-ekspor",
  // C06 (D-635 (1); research/38 §1.4): namespace kunci ronde cakupan R-67..R-80 (selain render/runningHead).
  controlSheet: "lembar-kendali",
  cover: "sampul",
  device: "kepala-kaki",
  naming: "penomoran-klasifikasi",
};

function hasOwnKey(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Kategori satu parameter; hanya membaca `group` dan `key`. */
export function categoryOf(def: Pick<ParamDef, "group" | "key">): ParamCategoryId {
  const { group, key } = def;
  if (group === "R") {
    if (hasOwnKey(R_EXACT_OVERRIDES, key)) return R_EXACT_OVERRIDES[key];
    const [ns, seg] = key.split(".");
    if (ns === "render") return seg !== undefined && hasOwnKey(R_RENDER_SEGMENT_CATEGORY, seg) ? R_RENDER_SEGMENT_CATEGORY[seg] : "lainnya";
    return hasOwnKey(R_NAMESPACE_CATEGORY, ns) ? R_NAMESPACE_CATEGORY[ns] : "lainnya";
  }
  let best: CatalogException | undefined;
  for (const e of EXCEPTIONS_BY_GROUP.get(group) ?? []) {
    const hit = e.match.endsWith(".") ? key.startsWith(e.match) : key === e.match;
    if (hit && (!best || e.match.length > best.match.length)) best = e;
  }
  if (best) return best.category;
  return (hasOwnKey(GROUP_DEFAULT_CATEGORY, group) ? GROUP_DEFAULT_CATEGORY[group] : undefined) ?? "lainnya";
}

/** S1 (D-630): dua subkelompok sangat besar dipecah per dua segmen pertama. */
const SPLIT_SUBGROUP_PREFIXES: readonly string[] = ["chart.kind", "type.scale"];

/** Kunci subkelompok: namespace (segmen pertama), atau dua segmen untuk awalan S1. */
export function subgroupKeyOf(def: Pick<ParamDef, "key">): string {
  for (const p of SPLIT_SUBGROUP_PREFIXES) if (def.key.startsWith(`${p}.`)) return p;
  return def.key.split(".")[0];
}

/**
 * Label subkelompok per kategori (research/39 "Sub-group labels"), urutan = urutan tampilan.
 * Namespace yang sama berarti lain di kategori lain (mis. `rules`, `render`, `device`).
 * D-632: istilah umum (file Word, font, grid, header, chart, bullet), tanpa jargon
 * pengembang dan tanpa mengulang nama kategorinya; nama standar (IEC, ISO, ISA) tetap.
 */
const SUBGROUP_LABELS: Readonly<Record<ParamCategoryId, ReadonlyArray<readonly [string, string]>>> = {
  warna: [
    ["color", "Palet warna"],
    ["page", "Latar halaman"],
  ],
  tipografi: [
    ["type", "Font dan ketebalan"],
    ["type.scale", "Gaya teks per elemen"],
    ["render", "Format teks dan bullet di file Word"],
  ],
  "halaman-grid": [
    ["page", "Ukuran dan orientasi kertas"],
    ["grid", "Grid dan margin"],
    ["layout", "Mode kolom catatan"],
    ["device", "Garis penanda dan kolom catatan"],
    ["chapter", "Garis penanda bab"],
    ["rules", "Tebal dan warna garis"],
    ["aside", "Catatan samping"],
    ["slot", "Pengaturan section per bagian"],
    ["render", "Section dan kolom catatan di file Word"],
  ],
  sampul: [
    ["cover", "Unsur sampul"],
    ["device", "Teks tepi sampul"],
    ["org", "Identitas organisasi"],
    ["render", "Mode sampul"],
  ],
  "lembar-kendali": [
    ["controlSheet", "Isi lembar kendali"],
    ["slot", "Penempatan tanda tangan"],
  ],
  "kepala-kaki": [
    ["runningHead", "Isi header"],
    ["wrapper", "Header halaman pembungkus"],
    ["device", "Blok register, pita segel, cap terbit"],
    ["registerBlock", "Posisi blok register"],
    ["org", "Nama pendek organisasi"],
    ["render", "Tata letak di file Word"],
  ],
  tabel: [
    ["table", "Garis, isian, dan kepala tabel"],
    ["caption", "Caption tabel"],
    ["source", "Baris sumber"],
    ["artifact", "Rujukan tabel di teks"],
    ["specTable", "Tabel spesifikasi"],
    ["render", "Tabel di file Word"],
  ],
  "gambar-chart": [
    ["chart", "Aturan umum chart"],
    ["chart.kind", "Pengaturan per jenis chart"],
    ["caption", "Caption chart"],
    ["image", "Ukuran dan resolusi gambar"],
  ],
  "diagram-simbol": [
    ["diagram", "Diagram"],
    ["symbol", "Gaya simbol"],
    ["symbolSheet", "Lembar simbol"],
    ["sheet", "Lembar gambar teknik"],
    ["designation", "Penandaan IEC 81346"],
    ["iec", "Simbol listrik IEC 60617"],
    ["isa", "Instrumentasi ISA-5.1"],
    ["mil", "Simbol militer MIL-STD-2525"],
    ["iso5807", "Diagram alir ISO 5807"],
    ["bpmn", "Diagram proses BPMN"],
    ["c4", "Diagram arsitektur C4"],
    ["archimate", "Diagram ArchiMate"],
    ["topology", "Topologi jaringan"],
    ["lineWeight", "Tebal garis ISO 128-2"],
    ["lineType", "Jenis garis ISO 128-2"],
    ["rack", "Elevasi rak EIA-310"],
    ["labels", "Label kabel TIA-606"],
    ["iso7010", "Rambu ISO 7010"],
    ["fire", "Denah kebakaran"],
  ],
  "bukti-angka": [
    ["marks", "Tanda asal data"],
    ["content", "Tanda klaim penulis"],
    ["admiralty", "Skala keandalan sumber (Admiralty)"],
    ["icd203", "Skala kemungkinan (ICD 203)"],
    ["confidence", "Label keyakinan"],
    ["numbers", "Angka penting untuk keputusan"],
    ["register", "Register kuantitas"],
    ["derivation", "Langkah perhitungan"],
    ["render", "Langkah perhitungan di file Word"],
    ["audit", "Audit angka"],
    ["serah", "Cek silang perhitungan"],
    ["assumptionRegister", "Register asumsi"],
    ["assumption", "Asumsi"],
    ["requirement", "ID persyaratan"],
    ["sourceRegister", "Daftar sumber"],
    ["numerals", "Pemisah angka"],
    ["units", "Satuan"],
    ["uncertainty", "Ketidakpastian"],
    ["conventions", "Konsistensi format"],
    ["time", "Zona waktu"],
    ["currency", "Mata uang"],
    ["vat", "PPN"],
    ["ahs", "Analisa harga satuan (AHS)"],
    ["hps", "Harga perkiraan sendiri (HPS)"],
    ["boq", "Daftar kuantitas dan harga (BoQ)"],
    ["terbilang", "Terbilang"],
    ["stampDuty", "Bea meterai"],
  ],
  "penomoran-klasifikasi": [
    ["doc", "Nomor, jenis, dan revisi dokumen"],
    ["artifact", "Tingkat dokumen"],
    ["classification", "Klasifikasi keamanan"],
    ["naming", "Pola nama file dan ID"],
    ["numbering", "Lingkup penomoran"],
    ["chapter", "Label nomor bab"],
    ["appendix", "Label nomor lampiran"],
    ["toc", "Daftar isi"],
    ["render", "Daftar isi dan nomor di file Word"],
  ],
  bahasa: [
    ["doc", "Bahasa dan susunan dokumen"],
    ["prose", "Gaya penulisan"],
    ["sentence", "Kalimat"],
    ["paragraph", "Paragraf"],
    ["list", "Daftar butir"],
    ["letter", "Surat dinas"],
    ["lexicon", "Kosakata"],
    ["glossary", "Glosarium"],
    ["normativeQuote", "Kutipan peraturan"],
    ["threshold", "Batas kerumitan kalimat"],
  ],
  "lint-pemeriksaan": [
    ["gate", "Syarat sebelum terbit"],
    ["lint", "Tingkat ketegasan cek"],
    ["artifact", "Cek yang aktif"],
    ["jury", "Penilaian juri"],
    ["checklist", "Checklist sebelum serah"],
    ["photocopy", "Uji fotokopi"],
    ["compliance", "Regulasi berlaku dan dicabut"],
    ["rules", "Daftar aturan"],
    ["governance", "Tata kelola"],
  ],
  "renderer-ekspor": [
    ["render", "File Word, HTML, dan PNG"],
    ["artifact", "Format file dan PDF"],
    ["ingest", "Format teks isi kiriman"],
    ["slot", "Teks pengisi bagian kosong"],
    ["workbook", "Workbook Excel (nonaktif)"],
    ["brief", "Slide PowerPoint (nonaktif)"],
  ],
  lainnya: [],
};

const SUBGROUP_INDEX: ReadonlyMap<ParamCategoryId, ReadonlyMap<string, { label: string; rank: number }>> = new Map(
  (Object.keys(SUBGROUP_LABELS) as ParamCategoryId[]).map((cat) => [
    cat,
    new Map(SUBGROUP_LABELS[cat].map(([key, label], rank) => [key, { label, rank }])),
  ]),
);

/** Label subkelompok dalam kategori; tanpa entri -> `namespaceLabel` (param-labels.ts). */
export function subgroupLabel(categoryId: ParamCategoryId, subgroupKey: string): string {
  return SUBGROUP_INDEX.get(categoryId)?.get(subgroupKey)?.label ?? namespaceLabel(subgroupKey);
}

export interface ParamSubgroup<T> {
  /** Open-state: `ns:<categoryId>:<subgroupKey>`. */
  id: string;
  /** Namespace, atau `chart.kind` / `type.scale` (S1). */
  key: string;
  label: string;
  /** Urutan masukan (registri) dipertahankan. */
  defs: T[];
}

export interface ParamCategoryGroup<T> {
  /** Open-state: `cat:<categoryId>`. */
  id: string;
  category: ParamCategory;
  subgroups: ParamSubgroup<T>[];
  total: number;
  /** Tampil datar tanpa tingkat subkelompok (`!showSubgroups`, D-632). */
  flat: boolean;
}

/** Batas pengaturan kategori yang ditampilkan datar tanpa subkelompok (D-632). */
export const SUBGROUP_FLAT_MAX_SETTINGS = 8;

/**
 * Tingkat subkelompok hanya tampil bila kategori punya lebih dari satu subkelompok DAN lebih
 * dari `SUBGROUP_FLAT_MAX_SETTINGS` pengaturan; selain itu pengaturan langsung tampil (D-632,
 * penyederhanaan D-627 Q10). Murni atas data terkelompok, jadi berlaku juga pada hasil saringan.
 */
export function showSubgroups(g: { subgroups: readonly unknown[]; total: number }): boolean {
  return g.subgroups.length > 1 && g.total > SUBGROUP_FLAT_MAX_SETTINGS;
}

/**
 * Kelompokkan per kategori (urutan tetap PARAM_CATEGORIES), lalu subkelompok (urutan tabel
 * label, lalu yang tak terdaftar urut alfabetis agar tidak bergantung urutan masukan).
 * Parameter di dalam subkelompok mengikuti urutan masukan (registri). Kategori tanpa
 * parameter tidak dikembalikan (R5: kategori kosong disembunyikan).
 */
export function groupByCategory<T extends Pick<ParamDef, "group" | "key">>(defs: readonly T[]): ParamCategoryGroup<T>[] {
  const buckets = new Map<ParamCategoryId, Map<string, T[]>>();
  for (const d of defs) {
    const cat = categoryOf(d);
    let subs = buckets.get(cat);
    if (!subs) buckets.set(cat, (subs = new Map()));
    const key = subgroupKeyOf(d);
    const list = subs.get(key);
    if (list) list.push(d);
    else subs.set(key, [d]);
  }
  const out: ParamCategoryGroup<T>[] = [];
  for (const category of PARAM_CATEGORIES) {
    const subs = buckets.get(category.id);
    if (!subs) continue;
    const index = SUBGROUP_INDEX.get(category.id);
    const entries = [...subs.entries()].map(([key, list]) => ({ key, list, rank: index?.get(key)?.rank ?? Number.MAX_SAFE_INTEGER }));
    entries.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
    const subgroups = entries.map(({ key, list }) => ({
      id: `ns:${category.id}:${key}`,
      key,
      label: subgroupLabel(category.id, key),
      defs: list,
    }));
    const total = subgroups.reduce((n, s) => n + s.defs.length, 0);
    out.push({ id: `cat:${category.id}`, category, subgroups, total, flat: !showSubgroups({ subgroups, total }) });
  }
  return out;
}
