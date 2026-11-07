/**
 * Tabel spec templat jenis dokumen DATUM Rev A, ID dan EN (baris S26; register `research/31` §1-§3; D-590,
 * D-594, D-595, D-598 F-3/F-6, D-602). Data murni: tidak membuka DB dan tidak memeriksa izin DB; diiterasi
 * `prisma/seed-studio.ts --doc-type-templates` (S27) lewat helper bersama `seed-studio-templates.ts`.
 *
 * Satu baris spec = lapis bersama x lapis jenis x lapis bahasa, disusun oleh `composeSpec`; tidak ada salinan
 * per templat dan tidak ada cabang slug/jenis (U4). Semua kunci adalah parameter templat yang sudah ada
 * (`doc.defaultTypeCode`, `doc.defaultTier`, `doc.typeCode`, `doc.language`, `org.entityName`, `layout.railMode`,
 * `table.zebra.minRows`, kenop slot `cover.kicker.text`, `render.toc.mode`) dan label slot; tidak ada medan muatan
 * atau skema slot baru (U3, D-594).
 *
 * Tidak ditimpa (research/31 §3.4): `wrapper.header` dan `device.issueStamp.format` (mesin memilih teks EN
 * lewat tabel teks bila bahasa EN dan nilai = bawaan registri), `render.toc.title` (kosong, F-6: kicker
 * daftar isi sudah dicetak per bahasa), `chapter.kicker.pattern`, `device.registerBlock.cells`.
 *
 * Ronde cakupan C23 (register `research/38` §4; D-627, D-635, D-639, D-640): nilai opt-in parameter R-67..R-80
 * dan enum baru (C06) dipasang sebagai data di lapis bersama, lapis jenis (`DocTypeLayer.layer`) dan lapis bahasa
 * (`LanguageLayer.layer`); tidak ada kunci yang muncul di dua lapis, jadi urutan gabung tidak berpengaruh. Basis
 * preset = `datum-gsp-rev-a-preset` (GF-08, M2; dibuat C21 di transaksi yang sama, `seed-derived-presets.ts`).
 */
import { WRAPPER_TEXT } from "../src/lib/studio/engine/front/texts";
import type { ParamRecord } from "../src/lib/studio/services/templates";
import { DATUM_SKELETON_SLOTS, type DerivedTemplateSpec, type GuardedTemplateTxOptions, type SlotOverrides, type SlotShape } from "./seed-studio-templates";

export type DocLanguage = "ID" | "EN";
export type DocTier = "NOTA" | "TERBIT" | "SERAH";

/**
 * Preset basis semua templat jenis dokumen (AC-2: basis = versi terbaru preset ini). C23 (GF-08, M2; research/38
 * §4.4): preset GSP DATUM Rev A = baris tabel preset turunan `DERIVED_PRESET_SPECS` (`seed-derived-presets.ts`,
 * C21: `datum-gsp-preset` + sematan Tabel 8.2), dibuat `--doc-type-templates` sebelum templat di transaksi yang sama.
 */
export const DOC_TYPE_PRESET_SLUG = "datum-gsp-rev-a-preset";

/** research/31 §3.1: daftar tertutup kode jenis Rev A (Tabel 3.1 kolom kiri lalu kanan; tanpa DS, dengan NDA). */
export const REV_A_TYPE_CODES: readonly string[] = ["PT", "KT", "RAB", "SPH", "SP", "BA", "NDA", "DEK", "LAP", "MAT", "STD", "NOT", "MOD", "VER"];

/**
 * Lapis bersama semua templat: daftar kode jenis Rev A, dan nilai manual untuk kunci yang dikendalikan
 * parameter templat (D-602): entitas kolofon kapital (`ID:20`, CV-16; preset GSP DATUM menyimpan huruf campur).
 * G-FIX1 (D-606), parameter yang sudah ada, bawaan registri tidak diubah. Nilainya sama dengan profil preset GSP
 * DATUM (`benchmark/manual000/template.json`), jadi keluaran tidak berubah; di lapis ini agar tuntutan manual menjadi
 * data templat sendiri, tidak bergantung pada versi preset:
 *  - `layout.railMode` A: rel bukti 32 mm selalu tampil di halaman interior (GF-24, `EN:2764`; "Rel yang kosong
 *    itu benar", `ID:2711`); bawaan registri `auto` menjatuhkan rel bila tidak ada sitasi rel.
 *  - `table.zebra.minRows` 1000: zebra tidak menyala ("tanpa zebra", DT-11b `ID:2749-2754`, GF-17); konvensi
 *    profil Manual 000 ("1000 menonaktifkan zebra", registri tanpa saklar zebra; kelas K, ditulis seed ADMIN).
 */
/**
 * Saklar controller untuk dua opt-in tata letak mesin E (C19 GF-21 ritme garis dasar, C20 GF-24 kolom rel 32 mm).
 * `true` = kedua kunci dipasang di lapis bersama ke-10 templat; `false` = keduanya absen (bawaan registri `false`
 * = keluaran sebelum ronde cakupan). Matikan di sini saja bila laporan baris mesin E menunjukkan masalah tata letak.
 */
export const ENGINE_E_LAYOUT_OPT_INS = true;

/**
 * C23 opt-in bersama ke-10 templat (research/38 §4.1). Kunci sampul dan lembar kendali inert di dua templat NOTA
 * (tanpa unit sampul/lembar kendali; sampul belakang hanya dirender bila dokumen merender unit sampul, C12):
 *  - `runningHead.ruleColour`, `device.registerBlock.topRuleColour` 6E1420: Tabel 8.1 `ID:2576-2577`, `EN:2646-2647`;
 *    DT-13d (RGB 110, 20, 32). R-72 yang berbeda dari bawaan didahulukan atas border preset (D-640 (1)).
 *  - `render.docx.pageBackground`: DT-05 `ID:2528-2533`, `EN:2591-2597` (warna = `color.interior.paper`, D-631).
 *  - `controlSheet.subtitle.enabled` (`ID:25`, `EN:25`), `controlSheet.signatures.fillRoles` (tiga kolom, `ID:2501`,
 *    `EN:2570`), `controlSheet.columns.form` manual (`ID:29, 39, 58`; `EN:29, 38, 62`; D-635 (5)).
 *  - `cover.title.maxWidthMm` 150: `ID:2480`, `EN:2552`.
 *  - `cover.controlBlock.fields`: 8 medan, KLASIFIKASI ketiga (baris 2 di bawah nomor, DT-28c `ID:611`, `EN:647`),
 *    tanpa DASAR agar tetap 4 x 2 (`ID:2483`, `EN:2555`; D-635 (3)).
 *  - `device.spine.placements` + sampul belakang (DT-13f `ID:2718-2723`, `EN:2766`, `EN:2778-2783`); dua penempatan
 *    yang ada dipertahankan (menimpa sematan preset `["margin luar sampul"]`).
 *  - `render.rhythm.snapToBaseline` (DT-10b) dan `render.rail.reserveColumn` (`EN:2764`, `ID:2705-2711`) lewat
 *    `ENGINE_E_LAYOUT_OPT_INS`.
 */
const SHARED_OPT_INS: ParamRecord = {
  "runningHead.ruleColour": "6E1420",
  "device.registerBlock.topRuleColour": "6E1420",
  "render.docx.pageBackground": true,
  "controlSheet.subtitle.enabled": true,
  "controlSheet.signatures.fillRoles": true,
  "controlSheet.columns.form": "manual",
  "cover.title.maxWidthMm": 150,
  "cover.controlBlock.fields": ["NOMOR DOKUMEN", "REVISI", "KLASIFIKASI", "PENYUSUN", "KUSTODIAN", "DITUJUKAN KEPADA", "TIER", "BAHASA"],
  "device.spine.placements": ["margin luar sampul", "pembatas", "sampul belakang"],
  ...(ENGINE_E_LAYOUT_OPT_INS ? { "render.rhythm.snapToBaseline": true, "render.rail.reserveColumn": true } : {}),
};

const SHARED_LAYER: ParamRecord = {
  "doc.typeCode": [...REV_A_TYPE_CODES],
  "org.entityName": "PT GEMILANG SATRIA PERKASA",
  "layout.railMode": "A",
  "table.zebra.minRows": 1000,
  ...SHARED_OPT_INS,
};

/**
 * Override kenop slot bersama semua templat (D-602 adendum 2, kalibrasi S25 `verification/21` TR-03/TR-08):
 * daftar isi = medan TOC Word. Kenop berlingkup slot `toc` (`params/render.ts` P-22, permukaan esensial); preset
 * GSP DATUM menyalin `static` ke kenop slot toc, jadi nilainya wajib di slot, bukan di lapis dokumen.
 */
const SHARED_SLOT_OVERRIDES: SlotOverrides = {
  toc: { "render.toc.mode": "field" },
};

/** Slot tambahan satu jenis dokumen, disisipkan sebelum slot `insertBefore` (posisi dihitung ulang). */
interface ExtraSlot {
  insertBefore: string;
  slot: Omit<SlotShape, "position">;
}

/** research/31 §3.5 (F-3, D-598): indeks aturan STD = AUTO dari isi, opsional (belum memancarkan seksi DOCX). */
const RULE_INDEX_SLOT: ExtraSlot = {
  insertBefore: "appendices",
  slot: { slotKey: "ruleIndex", sectionType: "ruleIndex", label: "Indeks Aturan", required: false, positionLocked: false, repeatable: false, contentMode: "AUTO", tiers: [], admits: [] },
};

/** Lapis jenis dokumen (research/31 §1-§2). */
export interface DocTypeLayer {
  slugBase: string;
  typeCode: string;
  tier: DocTier;
  /** Nama jenis untuk nama templat, per bahasa. */
  title: Readonly<Record<DocLanguage, string>>;
  /** `cover.kicker.text` (kenop slot cover), per bahasa. */
  kicker: Readonly<Record<DocLanguage, string>>;
  extraSlots?: readonly ExtraSlot[];
  /** C23: nilai parameter khusus jenis ini (research/38 §4.2), digabung di atas lapis bersama. */
  layer?: ParamRecord;
}

export const DOC_TYPE_LAYERS: readonly DocTypeLayer[] = [
  { slugBase: "datum-proposal-teknis", typeCode: "PT", tier: "SERAH", title: { ID: "Proposal Teknis", EN: "Technical Proposal" }, kicker: { ID: "PROPOSAL TEKNIS", EN: "TECHNICAL PROPOSAL" } },
  { slugBase: "datum-laporan", typeCode: "LAP", tier: "TERBIT", title: { ID: "Laporan", EN: "Report" }, kicker: { ID: "LAPORAN", EN: "REPORT" } },
  { slugBase: "datum-laporan-verifikasi", typeCode: "VER", tier: "TERBIT", title: { ID: "Laporan Verifikasi dan Uji", EN: "Verification and Test Report" }, kicker: { ID: "LAPORAN VERIFIKASI", EN: "VERIFICATION REPORT" } },
  // C23: indeks aturan dari penanda kode di isi (`ID:235`, `ID:4515-4522`; `EN:240`, `EN:4439-4445`; research/37).
  {
    slugBase: "datum-standar",
    typeCode: "STD",
    tier: "TERBIT",
    title: { ID: "Standar", EN: "Standard" },
    kicker: { ID: "STANDAR", EN: "STANDARD" },
    extraSlots: [RULE_INDEX_SLOT],
    layer: { "render.ruleIndex.fromMarkers": true },
  },
  // C23: baris klasifikasi di bawah nomor (DT-28c `ID:609-617`, `EN:645-652`; D-639 (4)) dan nama berkas
  // `<judul> <YYYY-MM-DD>.<ext>` (Tabel 2.3 `ID:487-493`, `EN:518-523`).
  {
    slugBase: "datum-nota",
    typeCode: "NOT",
    tier: "NOTA",
    title: { ID: "Nota Internal", EN: "Internal Note" },
    kicker: { ID: "NOTA INTERNAL", EN: "INTERNAL NOTE" },
    layer: { "render.nota.classificationLine": true, "naming.file.form": "judulTanggalIso" },
  },
];

/** Lapis bahasa (research/31 §3.3): akhiran slug, akhiran nama, label slot, deskripsi. */
export interface LanguageLayer {
  language: DocLanguage;
  slugSuffix: string;
  nameSuffix: string;
  /** Label slot per `slotKey`; slot tanpa entri memakai label kerangka (ID, = datum-gsp). */
  slotLabels: Readonly<Record<string, string>>;
  description: (t: { title: string; typeCode: string; tier: DocTier }) => string;
  /** C23: nilai parameter khusus bahasa ini (research/38 §4.3), digabung di atas lapis bersama dan jenis. */
  layer?: ParamRecord;
}

export const LANGUAGE_LAYERS: readonly LanguageLayer[] = [
  {
    language: "ID",
    slugSuffix: "",
    nameSuffix: " (DATUM Rev A)",
    slotLabels: {},
    description: (t) => `Dokumen ${t.title} GSP mengikuti Manual DATUM Rev A (kode ${t.typeCode}, tier bawaan ${t.tier}).`,
    // C23: unit penyusun tetap (`ID:16`, `ID:2487`; D-627 Q2, D-639 (2)). Penomoran lembar mulai Bab 1
    // tidak diaktifkan (D-650: total "DARI N" ikut menghitung halaman pembungkus + 1 LibreOffice).
    layer: { "cover.controlBlock.preparerUnit": "Divisi Engineering PT GSP" },
  },
  {
    language: "EN",
    slugSuffix: "-en",
    nameSuffix: " (DATUM Rev A, EN)",
    slotLabels: {
      cover: "Cover",
      // Label lembar kendali tercetak sebagai kicker (`compose/front.ts`): satu sumber dengan tabel teks pembungkus.
      controlSheet: WRAPPER_TEXT.controlKicker.EN,
      signature: "Signatures",
      toc: WRAPPER_TEXT.tocKicker.EN,
      content: "Content",
      references: "References",
      appendices: "Appendices",
      ruleIndex: "Rule Index",
    },
    description: (t) => `GSP ${t.title} following the DATUM Manual Rev A (type code ${t.typeCode}, default tier ${t.tier}).`,
    // C23: unit penyusun tetap (`EN:16`, `EN:2558`; D-627 Q2). Penomoran lembar tetap bawaan `dokumen`
    // ("Sheets count from the cover", `EN:2582`; D-590).
    layer: { "cover.controlBlock.preparerUnit": "Engineering Division, PT GSP" },
  },
];

/** Kerangka datum-gsp + slot tambahan jenis, label per bahasa, posisi 1..n. */
function skeletonFor(type: DocTypeLayer, lang: LanguageLayer): SlotShape[] {
  const slots: Array<Omit<SlotShape, "position">> = DATUM_SKELETON_SLOTS.map((s) => ({ ...s, admits: [...s.admits], tiers: [...s.tiers] }));
  for (const extra of type.extraSlots ?? []) {
    const at = slots.findIndex((s) => s.slotKey === extra.insertBefore);
    if (at < 0) throw new Error(`Slot tambahan ${extra.slot.slotKey}: slot ${extra.insertBefore} tidak ada di kerangka`);
    slots.splice(at, 0, { ...extra.slot, admits: [...extra.slot.admits], tiers: [...extra.slot.tiers] });
  }
  return slots.map((s, i) => ({ ...s, label: lang.slotLabels[s.slotKey] ?? s.label, position: i + 1 }));
}

function composeSpec(type: DocTypeLayer, lang: LanguageLayer): DerivedTemplateSpec {
  const title = type.title[lang.language];
  const kicker = type.kicker[lang.language];
  return {
    slug: `${type.slugBase}${lang.slugSuffix}`,
    name: `${title}${lang.nameSuffix}`,
    description: lang.description({ title, typeCode: type.typeCode, tier: type.tier }),
    presetSlug: DOC_TYPE_PRESET_SLUG,
    slots: skeletonFor(type, lang),
    layer: { ...SHARED_LAYER, ...type.layer, ...lang.layer, "doc.defaultTypeCode": type.typeCode, "doc.defaultTier": type.tier, "doc.language": lang.language },
    slotOverrides: { ...SHARED_SLOT_OVERRIDES, cover: { "cover.kicker.text": kicker } },
    contractKind: null,
    changeNote: (c) =>
      `S27: templat jenis dokumen DATUM Rev A ${type.typeCode}/${lang.language} = preset ${DOC_TYPE_PRESET_SLUG} v${c.presetVersionNo} + esensial global + lapis jenis/bahasa (tier ${type.tier}, kicker ${kicker}) + kerangka ${c.slotCount} slot`,
  };
}

/** 10 baris tabel spec: setiap jenis x setiap bahasa (urutan register research/31 §1). */
export const DOC_TYPE_TEMPLATE_SPECS: readonly DerivedTemplateSpec[] = DOC_TYPE_LAYERS.flatMap((type) => LANGUAGE_LAYERS.map((lang) => composeSpec(type, lang)));

/** Kunci parameter yang dibuktikan aturan NU-03 skor konformitas. */
const NU03_PARAM_KEYS = ["doc.typeCode", "doc.defaultTypeCode", "doc.defaultTier", "doc.language"] as const;

export interface DocTypeSpecJson {
  schema: "datum-template-spec/v1";
  templates: Array<{ slug: string; params: Record<string, unknown> }>;
}

/**
 * JSON `--spec` skor konformitas DATUM (bukti NU-03; bentuk `benchmark/datum_conformance/rules/language.ts`
 * docblock "Bentuk JSON --spec"): nilai parameter templat + kicker slot cover per slug.
 */
export function docTypeTemplateSpecJson(specs: readonly DerivedTemplateSpec[] = DOC_TYPE_TEMPLATE_SPECS): DocTypeSpecJson {
  return {
    schema: "datum-template-spec/v1",
    templates: specs.map((s) => ({
      slug: s.slug,
      params: {
        ...Object.fromEntries(NU03_PARAM_KEYS.map((k) => [k, JSON.parse(JSON.stringify(s.layer[k] ?? null)) as unknown])),
        "cover.kicker.text": s.slotOverrides?.cover?.["cover.kicker.text"] ?? "",
      },
    })),
  };
}

// ── Opsi runner `--doc-type-templates` (S27) ─────────────────────────────

/**
 * Opsi `runGuardedTemplateTx` untuk tabel ini: satu transaksi, section type dibekukan (tidak boleh ada
 * create/update; penjaga gagal bila registri dan DB berbeda), templat lain tidak berubah (penjaga runner),
 * setiap templat sasaran `storedOk` (restricted=false, contractKind null, archived=false, basis = versi
 * terbaru preset). Tidak membuka koneksi: `counts` dijalankan runner di dalam transaksinya.
 */
export function docTypeTemplateTxOptions(database: string, dryRun: boolean): GuardedTemplateTxOptions {
  return {
    label: "Templat jenis dokumen DATUM Rev A",
    guardFailMessage:
      "Penjaga templat jenis dokumen gagal (templat lain/section type berubah atau isi tersimpan tidak sesuai); transaksi di-rollback (tidak ada yang ditulis)",
    dryRunDoneMessage: "Dry-run templat jenis dokumen selesai; transaksi di-rollback (0 tulis)",
    database,
    dryRun,
    specs: DOC_TYPE_TEMPLATE_SPECS,
    freezeSectionTypes: true,
    counts: async (tx) => ({
      sectionTypes: await tx.studioSectionType.count(),
      docTypeTemplates: await tx.studioTemplate.count({ where: { slug: { in: DOC_TYPE_TEMPLATE_SPECS.map((s) => s.slug) } } }),
      templates: await tx.studioTemplate.count(),
    }),
  };
}
