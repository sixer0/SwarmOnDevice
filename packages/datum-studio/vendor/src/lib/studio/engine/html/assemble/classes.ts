/**
 * Nama kelas HTML Studio yang disatukan perakit (S24).
 *
 * Kontrak tidak mendefinisikan nama kelas HTML. S22 (html/blocks) menaruh
 * konstanta lokalnya di `../blocks/classes` (`HTML_BLOCK_CLASSES`, CSS
 * struktural `HTML_BLOCKS_CSS`); perakit mengekspor ulang di sini bersama kelas
 * miliknya sendiri, sehingga konsumen (pratinjau UI, lint render, uji) cukup
 * membaca satu tempat. Konvensi markup D-38 (dibaca engine/browser S25):
 * `.page`/`[data-page]` lembar tetap, `.body` area isi, `.reg` batas bawah,
 * `data-address` alamat blok, `data-figure` wadah figur.
 */
import { HTML_BLOCK_CLASSES, HTML_BLOCKS_CSS } from "../blocks/classes";

/** Kelas milik perakit dan basis (D-38). */
export const HTML_ASSEMBLE_CLASSES = {
  /** Lembar tetap (konvensi D-38); tidak dipakai untuk unit alir, lihat catatan di index.ts. */
  page: "page",
  body: "body",
  reg: "reg",
  /** Wadah satu unit (cover, controlSheet, toc, part, chapter, appendix). */
  unit: HTML_BLOCK_CLASSES.unit,
  /** Pembungkus blok yang renderernya tidak memancarkan `data-address` sendiri. */
  block: "st-block",
  /** Blok tanpa renderer atau renderer gagal (pratinjau saja). */
  missing: "st-missing",
  /** Blok yang unitnya tidak ada di `snapshot.units`. */
  orphan: "st-orphan",
  /** SR-17: unit milik slot kerangka (`st-slot st-slot-<slotKey>`). */
  slot: "st-slot",
  /** SR-17: prefiks jenis section slot (`st-sectype-<sectionType>`). */
  sectionType: "st-sectype",
  /** SR-17: unit placeholder (slot wajib kosong pada draf). */
  placeholderUnit: "st-slot-empty",
  /** SR-17: isi teks pengganti unit placeholder. */
  placeholder: "st-placeholder",
  /** SR-17: unit `slot.setup.startOnNewPage: false` (menyambung, tanpa pemenggalan). */
  flow: "st-flow",
  /** SR-17: label penanda draf per unit (layar; cetak lewat kotak sudut `@page`). */
  draftMark: "st-draft-mark",
  /** SR-17: satu entri register sumber v2 (`F:<slotKey>/<n>`). */
  sourceEntry: "st-srcreg-entry",
  /** SR-17: penanda unit indeks aturan otomatis. */
  ruleIndex: "st-ruleindex",
} as const;

/** Satu peta kelas untuk seluruh keluaran HTML Studio. */
export const HTML_CLASSES = { ...HTML_BLOCK_CLASSES, ...HTML_ASSEMBLE_CLASSES } as const;

const A = HTML_ASSEMBLE_CLASSES;

/**
 * CSS struktural perakit: pemenggalan halaman antar unit (paged media) dan
 * penanda blok gagal. Warna/ukuran tetap dari token S21.
 */
export const HTML_ASSEMBLE_CSS = [
  `.${A.unit}{break-before:page;page-break-before:always}`,
  `.${A.unit}:first-of-type{break-before:auto;page-break-before:auto}`,
  `.${A.block}{display:block}`,
  `.${A.missing}{border:0.5pt dashed #B45309;padding:1mm;margin:1mm 0}`,
  `.${A.missing}::before{content:attr(data-block-type);display:block;font-size:6pt;color:#B45309}`,
  // SR-17: placeholder draf dan penanda draf (layar). Cetak: kotak sudut @page (slots.ts).
  `.${A.placeholder}{border:0.5pt dashed #B45309;padding:4mm;margin:2mm 0;color:#B45309;font-style:italic}`,
  `.${A.draftMark}{display:none}`,
  `.${A.sourceEntry}{margin:0 0 1.6mm 0;padding-left:8mm;text-indent:-8mm}`,
  `.${A.sourceEntry}-n{font-family:var(--ff-mono,monospace)}`,
  // Row 123 (C40 FIX CP-51, ID p.80 cek 33, p.52 Tabel 8.3): no stranded heading. A heading, caption or derivation
  // label is kept with what follows, and a table keeps its caption and header with its first body row (row 98:
  // heading 4.2 at the foot of a page, its caption and table on the next).
  `.st-chapter-head,.st-section-heading,.st-appendix-head,.st-caption,.st-derivation-label{break-after:avoid;page-break-after:avoid}`,
  `.st-table-grid > tbody:first-of-type > tr:first-child,.st-table-grid > thead + tbody > tr:first-child{break-before:avoid;page-break-before:avoid}`,
  `@media screen{.${A.unit} > .${A.draftMark}{display:block;position:absolute;left:0;right:0;text-align:center;font-size:7pt;font-weight:600;letter-spacing:.16em;color:#B45309}` +
    `.${A.unit} > .${A.draftMark}-header{top:2mm}.${A.unit} > .${A.draftMark}-footer{bottom:2mm}}`,
].join("\n");

/** CSS struktural gabungan (S22 blok + perakit), disisipkan sebelum token S21 agar token menang. */
export const STUDIO_HTML_STRUCTURAL_CSS = `${HTML_BLOCKS_CSS}\n${HTML_ASSEMBLE_CSS}`;

export { HTML_BLOCK_CLASSES, HTML_BLOCKS_CSS };
