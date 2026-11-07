/**
 * Parameter warna dan tipografi Bab 4 (01_specs.md §5.1, T02, baris S05).
 * 134 ParamDef, `origin: "catalog"`: P4C 35 + P4T dasar 18 + skala huruf 67 + unsur prosa 14.
 * Sumber: research/01_manual_parameter_catalog.md §3.3.1-3.3.4. Nilai [REK] diganti nilai
 * tabel .docx asli (research/04: Tabel 4.2 = T031, Tabel 4.3 = T032, Tabel 4.4 = T033; D-09).
 *
 * Konvensi: hex tanpa "#" huruf besar (kontrak `Hex`); angka desimal manual (koma) ditulis
 * sebagai number; tokenRef = nama token palet interior ("ink900", "signal", ...).
 * Putusan konflik: K-05 kepala halaman Cond 400, K-07 token zebra `zebra15`, K-08 caption ink700,
 * K-31 weights dipisah dari styles, nama wajah condensed kanonik "IBM Plex Sans Condensed".
 * SR-05 (research/09 §5.3, SR-01 PC-06): `type.baselinePt` = T (`baselineFromBodyLeading`);
 * ukuran skala selain `type.scale.body.size` (kenop "Ukuran huruf dasar"), 8 spasi baris,
 * dan X01/X05/X08 = turunan beracuan `typeScaleFromBase` (kelas B, acuan disematkan preset).
 */
import type { ParamDef } from "../contract/types/params";

type Extra = Partial<ParamDef>;

const CH = "Bab 4";

function mk(
  group: "P4C" | "P4T",
  id: string,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
  ruleRef: string,
  source: string,
  extra: Extra = {},
): ParamDef {
  return {
    id,
    key,
    label,
    type,
    default: def,
    class: "B",
    ruleRef,
    source,
    origin: "catalog",
    group,
    chapter: CH,
    namespace: key.split(".")[0],
    ...extra,
  };
}

const c = (n: number, key: string, label: string, type: ParamDef["type"], def: ParamDef["default"], rule: string, src: string, extra?: Extra) =>
  mk("P4C", `P4C-${String(n).padStart(2, "0")}`, key, label, type, def, rule, src, extra);

const t = (n: number, key: string, label: string, type: ParamDef["type"], def: ParamDef["default"], rule: string, src: string, extra?: Extra) =>
  mk("P4T", `P4T-${String(n).padStart(2, "0")}`, key, label, type, def, rule, src, extra);

const WRAP: Extra = { tiers: ["TERBIT", "SERAH"] };
const REK: Extra = { rek: true };

/** P4C: warna (35). Tabel 4.2 = research/04 T031. */
const P4C: readonly ParamDef[] = [
  c(1, "color.wrapper.paper", "Kertas pembungkus", "hex", "FBFAF7", "DT-05", "L615, TK16; research/04 T031", WRAP),
  c(2, "color.wrapper.ink", "Tinta pembungkus (judul, nilai blok kendali)", "hex", "14110F", "-", "L616, TK17; research/04 T031", WRAP),
  c(3, "color.wrapper.body", "Prosa pembungkus", "hex", "33302C", "-", "L617, TK18; research/04 T031", WRAP),
  c(4, "color.wrapper.meta", "Label, alamat, teks tepi sampul", "hex", "7A756E", "-", "L618, TK19; research/04 T031", WRAP),
  c(5, "color.wrapper.rule", "Garis rambut pembungkus", "hex", "C4BEB4", "-", "L619, TK20; research/04 T031", WRAP),
  c(6, "color.wrapper.seal", "Pita segel dan klasifikasi", "hex", "6E1420", "-", "L620, L595, TK21; research/04 T031", WRAP),
  c(7, "color.wrapper.cream", "Krem pembungkus (tanpa peran)", "hex", "F6E9E9", "-", "TK22 saja", {
    conflictRef: "K-03",
    classNote: "B (konflik K-03): disimpan tanpa peran sampai admin menetapkan",
  }),
  c(8, "color.interior.paper", "Kertas badan", "hex", "FCFCFB", "DT-05", "L623, TK25; research/04 T031"),
  c(9, "color.interior.ink900", "Judul, garis utama, setiap numeral", "hex", "101418", "-", "L624, TK26; research/04 T031"),
  c(10, "color.interior.ink700", "Prosa badan (tidak pernah hitam murni)", "hex", "2B3640", "-", "L631-632, TK27; research/04 T031", REK),
  c(11, "color.interior.ink400", "Label, caption, baris sumber, rel", "hex", "6B7783", "-", "L632-633, TK28; research/04 T031", REK),
  c(12, "color.interior.ink200", "Garis rambut dan pemisah baris", "hex", "C3CBD1", "-", "L633-634, TK29; research/04 T031", REK),
  c(13, "color.interior.ink100", "Pita ink100 (pita workbook)", "hex", "EFF2F4", "-", "L634-635, TK30; research/04 T031", {
    ...REK,
    conflictRef: "K-07",
    classNote: "B (konflik K-07, E-07): rona 5,3 % di bawah lantai fotokopi 15 %; zebra memakai token zebra15 (P4C-30)",
  }),
  c(14, "color.interior.signal", "Warna aksen", "hex", "B45309", "-", "L635-636, TK31; research/04 T031", REK),
  c(15, "color.interior.alert", "Rahasia, ASUMSI, batas terlampaui", "hex", "9B1C1C", "-", "L636-637, TK32; research/04 T031", REK),
  c(16, "color.interior.verd", "Jalur verifikasi, tautan sheet, arah membaik", "hex", "2F6F6B", "R-02", "L637-638, L646, TK33; research/04 T031", REK),
  c(17, "color.interior.link", "Biru hyperlink dokumen", "hex", "0563C1", "-", "TK34 saja", {
    conflictRef: "K-04",
    classNote: "B (konflik K-04): hanya hyperlink dokumen; dilarang di chart dan diagram (R-02)",
  }),
  c(18, "color.brief.ground", "Warna latar ringkasan komando (gelap)", "hex", "0E1216", "DT-05", "L642, TK37; research/04 T031"),
  c(19, "color.brief.accent", "Aksen pada latar gelap", "hex", "D98324", "-", "L644, TK38; research/04 T031"),
  c(20, "color.retired", "Warna pensiun (dilarang dipakai)", "list", ["1A2B4A", "C9A84C"], "DT-07", "L648-651, TK41-42", { class: "K" }),
  c(21, "color.maxValuesPerPage", "Maksimum nilai warna per halaman", "int", 5, "DT-06, lint 14", "L648-649, L3966", {
    class: "K",
    range: { min: 1, max: 5, step: 1 },
  }),
  c(22, "color.decorative.allowed", "Warna dekoratif diizinkan", "bool", false, "DT-06, lint 12", "L649, L3962", { class: "K" }),
  c(23, "page.background", "Latar halaman", "enum", "light", "DT-05", "L600-607", {
    enum: ["light", "dark"],
    classNote: "B (dark wajib mengisi P4C-24)",
  }),
  c(24, "page.darkRequestReason", "Alasan latar gelap", "string", "", "DT-05", "L604-607", {
    classNote: "wajib bila dark: pusat komando, HUD, mode gelap, layar 24 jam, register klien",
  }),
  c(25, "color.role.heading", "Peran warna judul", "tokenRef", "ink900", "4.3", "L624"),
  c(26, "color.role.numeral", "Peran warna numeral", "tokenRef", "ink900", "4.3", "L624"),
  c(27, "color.role.body", "Peran warna prosa badan", "tokenRef", "ink700", "4.3", "L632; research/04 T031", REK),
  c(28, "color.role.label", "Peran warna label", "tokenRef", "ink400", "4.3", "L633; research/04 T031", {
    ...REK,
    conflictRef: "K-08",
    classNote: "B (konflik K-08): caption memakai skala Tabel 4.4 = ink700 (type.scale.caption.colour), bukan peran label",
  }),
  c(29, "color.role.hairline", "Peran warna garis rambut", "tokenRef", "ink200", "4.3", "L634; research/04 T031", REK),
  c(30, "color.role.zebra", "Peran warna zebra tabel", "tokenRef", "zebra15", "DT-18", "L635, L877; research/04 T031", {
    conflictRef: "K-07",
    classNote:
      "K-07/KT-09: token baru color.interior.zebra15 menggantikan ink100 (rona 15 % memenuhi lantai fotokopi). Nilai hex zebra15 diturunkan mesin token (S11); hipotesis D9D9D9 = rona 15 % ink900 di atas kertas FCFCFB",
  }),
  c(31, "color.role.accent", "Peran warna aksen", "tokenRef", "signal", "CH-03", "L636, L1388; research/04 T031", {
    classNote: "B (jumlah aksen per halaman/gambar: K)",
  }),
  c(32, "color.role.alert", "Peran warna alert", "tokenRef", "alert", "CH-11", "L637, L1411-1412; research/04 T031"),
  c(33, "color.role.verify", "Peran warna verifikasi", "tokenRef", "verd", "CH-11", "L638, L1413; research/04 T031"),
  c(34, "color.body.pureBlack.allowed", "Hitam murni untuk prosa badan diizinkan", "bool", false, "4.3", "L632", { class: "K" }),
  // Swarm patch (row 49a, C104 H1): Manual Rev A DT-28d (WAJIB, manual_id.txt:667-669, :5093) sets classification text in
  // seal #6E1420 bold at every level, "bukan alert" (alert #9B1C1C named as forbidden at :3947). Was SR/R alert, T/B ink900.
  c(35, "color.classificationInk", "Warna tinta per klasifikasi", "map", { SR: "seal", R: "seal", T: "seal", B: "seal" }, "DT-28", "L1089-1091, L817; Rev A DT-28d", {
    class: "K",
  }),
];

/** P4T dasar: tipografi (18). Tabel 4.3 = research/04 T032. */
const P4T_BASE: readonly ParamDef[] = [
  t(1, "type.face.serif", "Jenis huruf baca (serif)", "string", "IBM Plex Serif", "DT-08", "L661, TK48; research/04 T032"),
  t(2, "type.face.condensed", "Jenis huruf struktural (condensed)", "string", "IBM Plex Sans Condensed", "DT-08", "L659, TK49; research/04 T032", {
    classNote: "nama kanonik; profil Manual 000 (S95) memakai 'IBM Plex Sans Cond'",
  }),
  t(3, "type.face.mono", "Jenis huruf data (mono)", "string", "IBM Plex Mono", "DT-08", "L663, TK50; research/04 T032"),
  t(4, "type.face.workbookUi", "Jenis huruf UI workbook", "string", "IBM Plex Sans", "DT-08", "L665, TK51; research/04 T032"),
  t(5, "type.face.symbolGlyph", "Jenis huruf simbol dan glif provenans", "string", "DejaVu Sans", "R-14", "L667-670, L4291-4292; research/04 T032", {
    conflictRef: "K-18",
    classNote: "B (tidak ada di tokens, konflik K-18): ikut R-14 dan kode, ditanam ke berkas",
  }),
  t(6, "type.role.structural.weights", "Bobot peran Struktural", "list", [400, 600], "Tabel 4.3", "L659, TK54; research/04 T032", {
    classNote: "bobot yang diizinkan: 400, 600",
  }),
  t(7, "type.role.reading.weights", "Bobot dan gaya peran Baca", "map", { weights: [400, 600], styles: ["italic"] }, "Tabel 4.3", "L661, TK55; research/04 T032", {
    conflictRef: "K-31",
    classNote: "K-31: bobot (int) dipisah dari gaya (string); weights 400, 600; styles italic",
  }),
  t(8, "type.role.data.weights", "Bobot peran Data", "list", [400, 600], "Tabel 4.3", "L663, TK56; research/04 T032", {
    classNote: "bobot yang diizinkan: 400, 600",
  }),
  t(9, "type.role.workbookUi.weights", "Bobot peran UI workbook", "list", [400, 600], "Tabel 4.3", "L665, TK57; research/04 T032", {
    classNote: "bobot yang diizinkan: 400, 600",
  }),
  t(10, "type.role.structural.fallback", "Cadangan peran Struktural", "string", "Segoe UI Semibold", "Tabel 4.3", "L659, TK54; research/04 T032"),
  t(11, "type.role.reading.fallback", "Cadangan peran Baca", "string", "Georgia", "Tabel 4.3", "L661, TK55; research/04 T032"),
  t(12, "type.role.data.fallback", "Cadangan peran Data", "string", "Consolas", "Tabel 4.3", "L663, TK56; research/04 T032"),
  t(13, "type.role.workbookUi.fallback", "Cadangan peran UI workbook", "string", "Arial Narrow", "Tabel 4.3", "L665, TK57; research/04 T032"),
  t(14, "type.forbiddenBodyFaces", "Wajah dilarang untuk badan", "list", ["Calibri", "Times New Roman", "Aptos", "Arial"], "DT-08, lint 05", "L670, TK43; research/04 T032", {
    class: "K",
  }),
  t(15, "type.tracking.displayTighter", "Jarak antarhuruf judul tampilan (rapat) (em)", "em", -0.012, "-", "TK59 saja"),
  t(16, "type.tracking.microLabelWider", "Jarak antarhuruf label kecil (renggang)", "em", 0.09, "-", "TK59, L703"),
  t(17, "type.baselinePt", "Garis dasar (pt)", "pt", 13.5, "DT-10", "L682, L722, TK60", {
    class: "T",
    derive: "baselineFromBodyLeading",
    classNote: "T (research/09 U8): = type.scale.body.leading efektif; menggerakkan P4G-10",
  }),
  t(
    18,
    "type.fontEmbedding",
    "Kebijakan penanaman fon per format",
    "map",
    {
      docx: "tanam (embed_fonts.py)",
      xlsx: "kirim assets/fonts + PASANG-DULU.txt",
      pptx: "kirim assets/fonts + PASANG-DULU.txt",
      pdf: "tanam dan subset",
    },
    "DT-09",
    "L674-678",
    { class: "K", classNote: "tetap per format; xlsx/pptx di luar rilis v2.1 (D-05)" },
  ),
];

type ScaleAttr = "size" | "leading" | "upper" | "trackEm" | "face" | "weight" | "colour" | "tabular";

interface ScaleEl {
  n: number;
  el: string;
  label: string;
  src: string;
  attrs: Partial<Record<ScaleAttr, ParamDef["default"]>>;
  extra?: Partial<Record<ScaleAttr, Extra>>;
}

const FACE_ROLES = ["condensed", "serif", "mono", "workbookUi"] as const;

const SCALE_ATTR: Record<ScaleAttr, { type: ParamDef["type"]; label: string }> = {
  size: { type: "pt", label: "ukuran (pt)" },
  leading: { type: "pt", label: "spasi baris (pt)" },
  upper: { type: "bool", label: "kapital" },
  trackEm: { type: "em", label: "pelacakan (em)" },
  face: { type: "enum", label: "rupa huruf" },
  weight: { type: "int", label: "bobot" },
  colour: { type: "tokenRef", label: "warna" },
  tabular: { type: "bool", label: "angka tabular" },
};

/** Unsur yang spasi barisnya turunan beracuan (research/09 §5.2). */
const LEADING_DERIVED = new Set(["chapterTitle", "sectionHeading", "body", "tableBody", "caption", "sourceLine", "evidenceRail", "derivation"]);

/** Ukuran/spasi baris skala yang mengikuti kenop ukuran huruf dasar (`type.scale.body.size` sendiri = kenop). */
function scaleDerive(el: string, a: ScaleAttr): Extra {
  const derived = (a === "size" && el !== "body") || (a === "leading" && LEADING_DERIVED.has(el));
  return derived ? { derive: "typeScaleFromBase" } : {};
}

/** 13 unsur Tabel 4.4 (research/04 T033), urutan atribut mengikuti katalog §3.3.3. */
const SCALE: readonly ScaleEl[] = [
  { n: 1, el: "chapterTitle", label: "Judul bab", src: "L686, TK62", attrs: { size: 16, leading: 20, face: "condensed", weight: 600, colour: "ink900" } },
  { n: 2, el: "chapterKicker", label: "Kicker bab", src: "L693, TK63", attrs: { size: 6.8, upper: true, trackEm: 0.16, face: "condensed", weight: 600, colour: "signal" } },
  { n: 3, el: "sectionHeading", label: "Judul seksi", src: "L695, TK64", attrs: { size: 11, leading: 13.5, face: "condensed", weight: 600, colour: "ink900" } },
  { n: 4, el: "body", label: "Badan", src: "L697, L832, TK65", attrs: { size: 9.5, leading: 13.5, face: "serif", weight: 400, colour: "ink700" } },
  { n: 5, el: "tableBody", label: "Badan tabel", src: "L699, TK66", attrs: { size: 8.2, leading: 11.5, face: "serif", weight: 400, colour: "ink700" } },
  { n: 6, el: "tableNumerals", label: "Numeral tabel", src: "L701, TK67", attrs: { size: 7.8, face: "mono", weight: 400, colour: "ink900", tabular: true } },
  { n: 7, el: "tableHeader", label: "Kepala tabel", src: "L703, L869, TK68", attrs: { size: 6.8, upper: true, trackEm: 0.09, face: "condensed", weight: 600, colour: "ink400" } },
  {
    n: 8,
    el: "caption",
    label: "Caption",
    src: "L705, TK69",
    attrs: { size: 7.6, leading: 11, face: "condensed", weight: 400, colour: "ink700" },
    extra: { colour: { conflictRef: "K-08", classNote: "K-08: skala (Tabel 4.4) menang atas peran palet; caption = ink700" } },
  },
  { n: 9, el: "sourceLine", label: "Baris sumber", src: "L707, TK70", attrs: { size: 6.6, leading: 9, face: "condensed", weight: 400, colour: "ink400" } },
  { n: 10, el: "evidenceRail", label: "Rel bukti", src: "L709, TK71", attrs: { size: 5.9, leading: 8.4, upper: true, face: "mono", weight: 400, colour: "ink400" } },
  {
    n: 11,
    el: "runningHead",
    label: "Kepala halaman",
    src: "L711, L717, TK72",
    attrs: { size: 6.8, upper: true, face: "condensed", weight: 400, colour: "ink400" },
    extra: {
      weight: {
        conflictRef: "K-05",
        classNote: "K-05: Cond 400 karena bobot 500 (TK72) tidak dikirim (E-25); pakai 400 sampai fon 500 dikirim",
      },
    },
  },
  { n: 12, el: "registerBlock", label: "Blok register", src: "L713, TK73", attrs: { size: 6.2, face: "mono", weight: 400, colour: "ink400" } },
  { n: 13, el: "derivation", label: "Turunan", src: "L715, TK74", attrs: { size: 7.4, leading: 11.5, face: "mono", weight: 400, colour: "ink900" } },
];

const SCALE_ORDER: readonly ScaleAttr[] = ["size", "leading", "upper", "trackEm", "face", "weight", "colour", "tabular"];

const P4T_SCALE: readonly ParamDef[] = SCALE.flatMap((s) =>
  SCALE_ORDER.filter((a) => a in s.attrs).map((a) => {
    const meta = SCALE_ATTR[a];
    const base: Extra = {
      ...(a === "size" ? { range: { min: 1, step: 0.1 } } : {}),
      ...(a === "leading" ? { range: { min: 1, step: 0.1 } } : {}),
      ...(a === "trackEm" ? { range: { min: -0.1, max: 1, step: 0.001 } } : {}),
      ...(a === "weight" ? { range: { min: 100, max: 900, step: 100 } } : {}),
      ...(a === "face" ? { enum: FACE_ROLES } : {}),
      ...(a === "colour" ? REK : {}),
      ...scaleDerive(s.el, a),
      ...(s.extra?.[a] ?? {}),
    };
    return mk(
      "P4T",
      `P4T-S${String(s.n).padStart(2, "0")}-${a}`,
      `type.scale.${s.el}.${a}`,
      `${s.label}: ${meta.label}`,
      meta.type,
      s.attrs[a] as ParamDef["default"],
      "Tabel 4.4",
      `${s.src}; research/04 T033`,
      base,
    );
  }),
);

/** P4T X: unsur huruf yang hanya ada di prosa manual (14). */
const P4T_PROSE: readonly ParamDef[] = [
  mk("P4T", "P4T-X01", "type.scale.groupBand.size", "Pita kelompok: ukuran (pt)", "pt", 7.4, "5.1", "L871", { range: { min: 1, step: 0.1 }, derive: "typeScaleFromBase", }),
  mk("P4T", "P4T-X02", "type.scale.groupBand.upper", "Pita kelompok: kapital", "bool", true, "5.1", "L871"),
  mk("P4T", "P4T-X03", "type.scale.groupBand.faceWeight", "Pita kelompok: rupa dan bobot", "string", "condensed 600", "5.1", "L838, L871"),
  mk("P4T", "P4T-X04", "type.scale.groupBand.colour", "Pita kelompok: warna", "tokenRef", "ink900", "5.1", "L871"),
  mk("P4T", "P4T-X05", "type.scale.unitColumn.size", "Kolom satuan: ukuran (pt)", "pt", 7.2, "DT-17", "L875", { range: { min: 1, step: 0.1 }, derive: "typeScaleFromBase", }),
  mk("P4T", "P4T-X06", "type.scale.unitColumn.face", "Kolom satuan: rupa dan bobot", "string", "condensed 400", "DT-17", "L875", {
    gapRef: "G-01",
    classNote: "G-01: bobot tidak dinyatakan manual; 400 diputus en bloc (KT-10)",
  }),
  mk("P4T", "P4T-X07", "type.scale.unitColumn.colour", "Kolom satuan: warna", "tokenRef", "ink400", "DT-17", "L875"),
  mk("P4T", "P4T-X08", "type.scale.asideBody.size", "Badan aside: ukuran (pt)", "pt", 8.6, "DT-20", "L930", {
    range: { min: 1, step: 0.1 },
    derive: "typeScaleFromBase",
    gapRef: "G-01",
    classNote: "G-01: wajah prosa aside tidak dinyatakan; serif badan (KT-10)",
  }),
  mk("P4T", "P4T-X09", "type.scale.asideLabel.style", "Label aside: gaya", "string", "condensed kapital", "DT-20", "L929-930"),
  mk("P4T", "P4T-X10", "type.scale.sectionNumber.face", "Nomor seksi: rupa huruf", "string", "mono", "Tabel 4.7 no. 6", "L830"),
  mk("P4T", "P4T-X11", "type.scale.sectionNumber.colour", "Nomor seksi: warna", "tokenRef", "ink400", "Tabel 4.7 no. 6", "L830"),
  mk("P4T", "P4T-X12", "type.body.align", "Perataan badan", "enum", "justify", "Tabel 4.7 no. 7", "L832", { enum: ["left", "justify"] }),
  mk("P4T", "P4T-X13", "type.body.measureChars", "Lebar baris badan (karakter)", "range", [66, 80], "DT-10, lint 15", "L724-725, L3968", {
    class: "K",
    range: { min: 66, max: 80, step: 1 },
  }),
  mk("P4T", "P4T-X14", "type.heading.form", "Bentuk judul", "enum", "label", "DT-38, lint 04, R-19", "L823, L3946, L4309-4311", {
    class: "K",
    enum: ["label"],
    classNote: "judul berbentuk label, bukan pertanyaan",
  }),
];

export const PARAMS_COLOR_TYPE: readonly ParamDef[] = [...P4C, ...P4T_BASE, ...P4T_SCALE, ...P4T_PROSE];

/** Hitungan target katalog; isi larik wajib sama dengan angka ini setelah S05. */
export const PARAMS_COLOR_TYPE_COUNT = 134;
