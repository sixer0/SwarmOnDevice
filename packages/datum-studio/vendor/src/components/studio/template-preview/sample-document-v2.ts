/**
 * Dokumen contoh `studio.doc/v2` pratinjau templat (FIX-V, FIX-U M5; D-139 konten-saja).
 *
 * Isi dibentuk dari KERANGKA draf: setiap slot aktif untuk tingkat terbitan yang jenisnya
 * dikenal (sampul, lembar kendali, daftar isi, pengesahan, bab, lampiran) mendapat isi
 * contoh; slot lain dibiarkan kosong (mesin memakai isi otomatis atau tanda kosong).
 * Hanya konten: tanpa medan tampilan (rupa sepenuhnya milik templat draf), tanpa `render`
 * (D-247). Kunci `sections` = `slotKey` kerangka sehingga kiriman selalu cocok dengan
 * susunan draf.
 *
 * Bahasa (addendum USER 2026-11-05): `language` dari data templat (`doc.language`, lihat `preview-language.ts`).
 * ID = contoh di bawah apa adanya (byte-identik dengan sebelum addendum). EN = terjemahan setia berstruktur sama
 * (bahasa Inggris UK sederhana, angka format EN). Pada contoh EN, label depan yang punya bawaan mesin berbahasa
 * dokumen tidak dikirim: judul lembar kendali (bawaan = label slot templat) dan kepala kolom riwayat revisi
 * (bentuk daftar, kepala dari tabel teks mesin `controlSheetColumnHeads`). Peran tanda tangan wajib dikirim
 * (tanpa bawaan mesin); nilainya = tabel teks mesin `FRONT_PAYLOAD_LABELS` EN (D-590), dijaga uji (tabel teks
 * tidak diimpor di sini karena menarik registri parameter ke bundel klien).
 *
 * Murni data: aman diimpor komponen klien.
 */
import type { StudioTier } from "@/lib/studio/contract/enums";
import type { TemplateSlotDef } from "@/lib/studio/contract/types/v2/template";
import type { PreviewLanguage } from "./preview-language";

const t = (text: string) => ({ text });

const COVER = {
  type: "cover",
  tagline: t("STANDAR KERJA"),
  titleLines: [t("Contoh Pratinjau"), t("Templat Dokumen")],
  standfirst: t("Dokumen contoh untuk melihat pengaruh pengaturan templat sebelum versi baru disimpan."),
  scopeLine: t("Lingkup: pratinjau editor templat."),
  addressLine: t("Kepada tim penyusun templat"),
  colophon: { left: t("Divisi Engineering"), right: t("Oktober 2026") },
};

const CONTROL_SHEET = {
  type: "controlSheet",
  title: t("Kendali dokumen"),
  revisionHistory: {
    type: "registerTable",
    columns: [{ role: "id" }, { role: "text" }, { role: "text" }, { role: "text" }],
    rows: [
      { kind: "header", cells: [t("Rev"), t("Tanggal"), t("Uraian"), t("Oleh")] },
      { cells: [t("A"), t("2026-10-01"), t("Terbit pertama"), t("Divisi Engineering")] },
    ],
    preset: "revisionHistory",
  },
  methodStatement: t("Angka diikat dari sumber terukur; setiap klaim membawa tanda provenans."),
};

const SIGNATURE = {
  type: "signatureBlock",
  roles: [
    { role: t("Disusun"), holder: t("Penyusun dokumen"), date: t("2026-10-01") },
    { role: t("Diperiksa"), holder: t("Pemeriksa teknis"), date: t("2026-10-01") },
    { role: t("Disetujui"), holder: t("Kepala divisi"), date: t("2026-10-01") },
  ],
};

const TOC = { type: "toc" };

const CHAPTER_1 = {
  key: "1",
  title: t("Ruang lingkup pekerjaan"),
  intro: [{ type: "paragraph", text: "Bab ini merangkum lingkup dan angka kunci pemasangan saluran.", role: "lede" }],
  sections: [
    {
      title: t("Lingkup dan angka kunci"),
      blocks: [
        {
          type: "paragraph",
          text: "Pekerjaan mencakup pemasangan saluran sepanjang 6.546,2 m beserta uji tekan dan serah terima.",
          rail: [
            { kind: "mark", mark: "TERUKUR" },
            { kind: "source", text: "Survei lapangan 2026" },
          ],
        },
        {
          type: "list",
          ordered: false,
          items: [t("Penggalian dan pemasangan pipa."), t("Uji tekan per segmen 500 m."), t("Serah terima dengan berita acara.")],
        },
        {
          type: "table",
          columns: [{ role: "id" }, { role: "text" }, { role: "numeral" }],
          rows: [
            { kind: "header", cells: [t("No"), t("Segmen"), t("Panjang (m)")] },
            { cells: [t("1"), t("Utara"), t("3.120,0")] },
            { cells: [t("2"), t("Selatan"), t("3.426,2")] },
          ],
          caption: t("Panjang saluran per segmen."),
          source: t("Survei lapangan 2026."),
        },
      ],
    },
  ],
};

const CHAPTER_2 = {
  key: "2",
  title: t("Metode dan jadwal"),
  sections: [
    {
      title: t("Urutan kerja"),
      blocks: [
        { type: "paragraph", text: "Pemasangan dimulai dari segmen utara karena akses jalan lebih lebar." },
        { type: "list", ordered: true, items: [t("Mobilisasi alat."), t("Penggalian segmen utara."), t("Uji tekan dan penimbunan.")] },
      ],
    },
  ],
};

const APPENDIX_A = {
  key: "A",
  title: t("Glosarium"),
  sections: [
    {
      title: t("Istilah"),
      blocks: [
        {
          type: "glossary",
          columns: [{ role: "text" }, { role: "text" }],
          rows: [
            { kind: "header", cells: [t("Istilah"), t("Arti")] },
            { cells: [t("Uji tekan"), t("Pengujian kebocoran saluran dengan tekanan air.")] },
          ],
          caption: t("Istilah dokumen contoh."),
          source: t("Dokumen contoh pratinjau templat."),
        },
      ],
    },
  ],
};

// ── Contoh EN (terjemahan setia, struktur yang sama) ────────────────────

const COVER_EN = {
  type: "cover",
  tagline: t("WORK STANDARD"),
  titleLines: [t("Preview Sample"), t("Document Template")],
  standfirst: t("A sample document for checking the effect of template settings before a new version is saved."),
  scopeLine: t("Scope: template editor preview."),
  addressLine: t("To the template authors"),
  colophon: { left: t("Engineering Division"), right: t("October 2026") },
};

const CONTROL_SHEET_EN = {
  type: "controlSheet",
  revisionHistory: [{ rev: "A", date: "2026-10-01", what: "First issue", by: "Engineering Division" }],
  methodStatement: t("Figures are bound to measured sources; every claim carries a provenance mark."),
};

const SIGNATURE_EN = {
  type: "signatureBlock",
  roles: [
    { role: t("Prepared by"), holder: t("Document author"), date: t("2026-10-01") },
    { role: t("Reviewed by"), holder: t("Technical reviewer"), date: t("2026-10-01") },
    { role: t("Approved by"), holder: t("Head of division"), date: t("2026-10-01") },
  ],
};

const CHAPTER_1_EN = {
  key: "1",
  title: t("Scope of work"),
  intro: [{ type: "paragraph", text: "This chapter summarises the scope and key figures for the pipeline installation.", role: "lede" }],
  sections: [
    {
      title: t("Scope and key figures"),
      blocks: [
        {
          type: "paragraph",
          text: "The work covers laying 6,546.2 m of pipeline, with pressure testing and handover.",
          rail: [
            { kind: "mark", mark: "TERUKUR" },
            { kind: "source", text: "Field survey 2026" },
          ],
        },
        {
          type: "list",
          ordered: false,
          items: [t("Excavation and pipe laying."), t("Pressure test per 500 m segment."), t("Handover with a signed record.")],
        },
        {
          type: "table",
          columns: [{ role: "id" }, { role: "text" }, { role: "numeral" }],
          rows: [
            { kind: "header", cells: [t("No"), t("Segment"), t("Length (m)")] },
            { cells: [t("1"), t("North"), t("3,120.0")] },
            { cells: [t("2"), t("South"), t("3,426.2")] },
          ],
          caption: t("Pipeline length per segment."),
          source: t("Field survey 2026."),
        },
      ],
    },
  ],
};

const CHAPTER_2_EN = {
  key: "2",
  title: t("Method and schedule"),
  sections: [
    {
      title: t("Work sequence"),
      blocks: [
        { type: "paragraph", text: "Installation starts at the north segment because the road access is wider." },
        { type: "list", ordered: true, items: [t("Mobilise equipment."), t("Excavate the north segment."), t("Pressure test and backfill.")] },
      ],
    },
  ],
};

const APPENDIX_A_EN = {
  key: "A",
  title: t("Glossary"),
  sections: [
    {
      title: t("Terms"),
      blocks: [
        {
          type: "glossary",
          columns: [{ role: "text" }, { role: "text" }],
          rows: [
            { kind: "header", cells: [t("Term"), t("Meaning")] },
            { cells: [t("Pressure test"), t("Leak test of the pipeline using water pressure.")] },
          ],
          caption: t("Terms used in the sample document."),
          source: t("Template preview sample document."),
        },
      ],
    },
  ],
};

interface SampleSet {
  cover: Record<string, unknown>;
  controlSheet: Record<string, unknown>;
  signature: Record<string, unknown>;
  chapters: readonly Record<string, unknown>[];
  appendices: readonly Record<string, unknown>[];
  meta: { title: string; author: string; audience: string };
}

/** Isi contoh per bahasa; ID = nilai sebelum addendum apa adanya. */
const SAMPLES: Readonly<Record<PreviewLanguage, SampleSet>> = {
  ID: {
    cover: COVER,
    controlSheet: CONTROL_SHEET,
    signature: SIGNATURE,
    chapters: [CHAPTER_1, CHAPTER_2],
    appendices: [APPENDIX_A],
    meta: { title: "Contoh Pratinjau Templat", author: "Divisi Engineering PT GSP", audience: "Tim penyusun templat" },
  },
  EN: {
    cover: COVER_EN,
    controlSheet: CONTROL_SHEET_EN,
    signature: SIGNATURE_EN,
    chapters: [CHAPTER_1_EN, CHAPTER_2_EN],
    appendices: [APPENDIX_A_EN],
    meta: { title: "Template Preview Sample", author: "Engineering Division, PT GSP", audience: "Template authors" },
  },
};

/** Isi contoh per jenis slot (konten saja). `undefined` = slot dibiarkan kosong. */
function samplePayload(sectionType: string, set: SampleSet): Record<string, unknown> | undefined {
  switch (sectionType) {
    case "cover":
      return set.cover;
    case "controlSheet":
      return set.controlSheet;
    case "signatureBlock":
      return set.signature;
    case "toc":
      return TOC;
    case "chapter":
      return { type: "chapter", chapters: set.chapters };
    case "appendix":
      return { type: "appendix", chapters: set.appendices };
    default:
      return undefined;
  }
}

export interface SampleDocumentV2Input {
  /** Slug templat yang disunting (draf diresolusi server dari `draftTemplate`). */
  slug: string;
  tier: StudioTier;
  slots: ReadonlyArray<Pick<TemplateSlotDef, "slotKey" | "sectionType" | "tiers">>;
  /** Bahasa dokumen templat (`doc.language`, `previewLanguageOf`); bawaan ID. */
  language?: PreviewLanguage;
}

/** Kiriman `studio.doc/v2` contoh yang mengikuti kerangka draf (slot tidak aktif untuk tier dilewati). */
export function sampleDocumentV2(input: SampleDocumentV2Input): Record<string, unknown> {
  const set = SAMPLES[input.language ?? "ID"];
  const sections: Record<string, unknown> = {};
  for (const s of input.slots) {
    if (Array.isArray(s.tiers) && s.tiers.length > 0 && !s.tiers.includes(input.tier)) continue;
    const payload = samplePayload(s.sectionType, set);
    if (payload) sections[s.slotKey] = payload;
  }
  return {
    $schema: "studio.doc/v2",
    template: { slug: input.slug },
    meta: {
      title: set.meta.title,
      docNumber: "001/GSP/KT/X/2026",
      rev: "A",
      tier: input.tier,
      author: set.meta.author,
      issueDate: "2026-10-01",
      custodian: "ENG-01",
      audience: set.meta.audience,
    },
    sections,
  };
}
