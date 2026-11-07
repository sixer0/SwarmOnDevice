/**
 * UI-02 (audit UI-01 §3.2, L20/L23-L25): label tampilan parameter registri di editor.
 * Hanya teks; nilai yang disimpan tetap nilai registri. Tanpa medan kontrak baru:
 * label enum diambil dari kenop esensial (satu sumber dengan langkah Pengaturan)
 * ditambah peta kecil untuk kunci non-esensial yang sering tampil.
 */
import { ESSENTIAL_KNOBS } from "@/lib/studio/registry/essentials";

const NUM = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });

/** Akhiran satuan di label registri ("Rel bukti (mm)"). */
const UNIT_SUFFIX_RE = /\s*\((mm|pt|%|em|deg|derajat|px|tw|x)\)\s*$/i;

/** Akhiran label -> simbol satuan yang sama dengan `unitOf` (derajat/deg -> °). */
function normalizeUnit(u: string): string {
  const l = u.toLowerCase();
  return l === "deg" || l === "derajat" ? "°" : l;
}

/**
 * Satuan yang dapat diturunkan dari label registri atau kunci untuk tipe tanpa satuan
 * (UI-04 M-1: `pair`/`list`/`string`/`object`, mis. `page.customSizeMm` -> "mm").
 * Label menang atas kunci; tanpa petunjuk -> "".
 */
export function derivedUnit(key: string, registryLabel: string | null | undefined): string {
  const m = UNIT_SUFFIX_RE.exec((registryLabel ?? "").trim());
  if (m) return normalizeUnit(m[1]);
  const leaf = key.split(".").find((seg) => /(?:Mm|Deg|Pt)$/.test(seg)) ?? "";
  if (/Mm$/.test(leaf)) return "mm";
  if (/Deg$/.test(leaf)) return "°";
  if (/Pt$/.test(leaf)) return "pt";
  return "";
}

/**
 * Label tampilan satu kunci. Akhiran satuan dibuang HANYA bila satuan yang sama sudah tampil
 * di samping kontrol (`shownUnit`, dari tipe; L20). UI-04 M-1: tipe tanpa satuan (pair/list/
 * string/object) mempertahankan "(mm)" sehingga satuan tidak hilang. `shownUnit` tidak diberikan
 * = perilaku UI-02 (label buang akhiran; pemanggil lama). Tanpa label registri -> kunci itu sendiri.
 */
export function paramDisplayLabel(key: string, registryLabel: string | null | undefined, shownUnit?: string | null): string {
  const l = (registryLabel ?? "").trim();
  if (!l) return key;
  const m = UNIT_SUFFIX_RE.exec(l);
  if (!m) return l;
  if (shownUnit !== undefined && (!shownUnit || normalizeUnit(shownUnit) !== normalizeUnit(m[1]))) return l;
  const stripped = l.replace(UNIT_SUFFIX_RE, "").trim();
  return stripped || l;
}

/** Nama kelompok (namespace kunci) yang umum, dalam bahasa Indonesia (L14). */
const NAMESPACE_LABELS: Readonly<Record<string, string>> = {
  governance: "Tata kelola",
  content: "Isi",
  artifact: "Artefak",
  naming: "Penamaan",
  numbering: "Penomoran",
  doc: "Dokumen",
  prose: "Prosa",
  paragraph: "Paragraf",
  list: "Daftar",
  letter: "Surat",
  lexicon: "Kosakata",
  threshold: "Ambang",
  workbook: "Lembar kerja",
  brief: "Ringkasan",
  gate: "Gerbang",
  rules: "Aturan",
  glossary: "Glosarium",
  sourceRegister: "Daftar sumber",
  color: "Warna",
  page: "Halaman",
  type: "Huruf",
  grid: "Kisi dan margin",
  layout: "Tata letak",
  device: "Perangkat visual",
  cover: "Sampul",
  wrapper: "Pembungkus",
  org: "Organisasi",
  controlSheet: "Lembar kendali",
  runningHead: "Kepala halaman",
  chapter: "Bab",
  caption: "Keterangan",
  source: "Sumber",
  table: "Tabel",
  aside: "Catatan samping",
  marks: "Tanda",
  numbers: "Angka",
  register: "Register",
  audit: "Audit",
  derivation: "Turunan perhitungan",
  confidence: "Tingkat keyakinan",
  assumption: "Asumsi",
  assumptionRegister: "Register asumsi",
  requirement: "Persyaratan",
  classification: "Klasifikasi",
  compliance: "Kepatuhan",
  vat: "PPN",
  stampDuty: "Bea meterai",
  currency: "Mata uang",
  units: "Satuan",
  time: "Waktu",
  chart: "Grafik",
  diagram: "Diagram",
  symbol: "Simbol",
  sheet: "Lembar",
  render: "Pembuatan berkas",
  image: "Gambar",
  toc: "Daftar isi",
  slot: "Bagian",
  appendix: "Lampiran",
};

/** Nama kelompok tampilan; namespace tak dikenal tampil apa adanya (kunci asli di tooltip). */
export function namespaceLabel(ns: string): string {
  // Cek own-property: namespace bernama anggota Object.prototype tidak boleh mengembalikan fungsi.
  return Object.prototype.hasOwnProperty.call(NAMESPACE_LABELS, ns) ? NAMESPACE_LABELS[ns] : ns;
}

/** Label pilihan untuk kunci non-esensial (nilai registri -> teks). */
const EXTRA_ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "caption.position": { above: "Di atas", below: "Di bawah" },
};

/** Peta kunci -> (nilai -> label) dari kenop esensial (opsi bernilai string). */
const KNOB_ENUM_LABELS: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const m = new Map<string, Map<string, string>>();
  for (const k of ESSENTIAL_KNOBS) {
    if (!k.options || k.mapping === "anggota" || k.mapping === "medan") continue;
    for (const key of k.keys) {
      const inner = m.get(key) ?? new Map<string, string>();
      for (const o of k.options) if (typeof o.value === "string" && !inner.has(o.value)) inner.set(o.value, o.label);
      m.set(key, inner);
    }
  }
  return m;
})();

/** Label satu pilihan enum (L23): kenop esensial > peta tambahan > nilai apa adanya. */
export function enumOptionLabel(key: string, value: string): string {
  return KNOB_ENUM_LABELS.get(key)?.get(value) ?? EXTRA_ENUM_LABELS[key]?.[value] ?? value;
}

/** Label dua angka bertipe `pair` (L24): kunci ukuran kertas/slide = [lebar, tinggi]. */
export function pairLabels(key: string): [string, string] {
  if (/sizeMm$/i.test(key)) return ["Lebar", "Tinggi"];
  return ["Nilai 1", "Nilai 2"];
}

/**
 * Teks rentang (L25) tanpa simbol tak terbatas: "1-90 mm", "minimal 1", "maksimal 90";
 * null bila tidak ada batas.
 */
export function rangeText(range: { min?: number; max?: number } | undefined, unit?: string | null): string | null {
  if (!range) return null;
  const u = unit ? ` ${unit}` : "";
  const { min, max } = range;
  const hasMin = typeof min === "number" && Number.isFinite(min);
  const hasMax = typeof max === "number" && Number.isFinite(max);
  if (hasMin && hasMax) return `${NUM.format(min)}-${NUM.format(max)}${u}`;
  if (hasMin) return `minimal ${NUM.format(min)}${u}`;
  if (hasMax) return `maksimal ${NUM.format(max)}${u}`;
  return null;
}
