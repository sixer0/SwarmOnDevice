/**
 * Nama kelas CSS yang dipancarkan engine/html/blocks (S22).
 *
 * Kontrak (`src/lib/studio/contract/**`) belum mendefinisikan nama kelas HTML,
 * sehingga konstanta ini LOKAL. S24 (perakit) menyatukannya dengan nama milik
 * S21 (html/base). Konvensi markup S25 (`measure.ts`, D-38) dihormati:
 * `data-address` pada setiap blok beralamat; `.page`/`.body`/`.reg` milik
 * perakit/basis, TIDAK dipancarkan modul ini.
 */

export const HTML_BLOCK_CLASSES = {
  // teks
  paragraph: "st-p",
  heading: "st-h",
  run: "st-r",
  caps: "st-caps",
  smallCaps: "st-smallcaps",
  bold: "st-b",
  italic: "st-i",
  underline: "st-u",
  tab: "st-tab",
  field: "st-field",
  url: "st-url",
  faceSerif: "st-face-serif",
  faceCondensed: "st-face-condensed",
  faceMono: "st-face-mono",
  faceWorkbookUi: "st-face-workbookui",
  faceSymbolGlyph: "st-face-symbolglyph",
  // struktur
  chapterHead: "st-chapter-head",
  appendixHead: "st-appendix-head",
  chapterKicker: "st-chapter-kicker",
  chapterTitle: "st-chapter-title",
  sectionHeading: "st-section-heading",
  sectionNumber: "st-section-no",
  sectionTitle: "st-section-title",
  // blok
  list: "st-list",
  listItem: "st-li",
  listMarker: "st-li-marker",
  aside: "st-aside",
  asideLabel: "st-aside-label",
  asideBody: "st-aside-body",
  asideNumber: "st-aside-no",
  monoBlock: "st-monoblock",
  monoLabel: "st-monoblock-label",
  monoBody: "st-monoblock-body",
  monoLine: "st-monoline",
  assumption: "st-asm",
  assumptionId: "st-asm-id",
  assumptionImpact: "st-asm-impact",
  spacer: "st-spacer",
  // rel bukti (moda A)
  railHost: "st-railhost",
  railHostMain: "st-railhost-main",
  rail: "st-rail",
  railLine: "st-rail-line",
  railGlyph: "st-rail-glyph",
  // perangkat
  device: "st-device",
  sealBand: "st-seal-band",
  sealLeft: "st-seal-left",
  sealRight: "st-seal-right",
  logo: "st-logo",
  hairline: "st-hairline",
  datumRule: "st-datum-rule",
  spine: "st-spine",
  issueStamp: "st-issue-stamp",
  // pembungkus
  unit: "st-unit",
  cover: "st-cover",
  coverKicker: "st-cover-kicker",
  coverTitle: "st-cover-title",
  coverStandfirst: "st-cover-standfirst",
  coverScope: "st-cover-scope",
  coverAddress: "st-cover-address",
  coverIdentity: "st-cover-identity",
  controlBlock: "st-control",
  controlLabel: "st-control-label",
  controlValue: "st-control-value",
  /** Row 165O (C204 item 3): one line of a multi-line control-block cell (number, then the classification line). */
  controlLine: "st-control-line",
  /** Swarm row 165P (C205, CP-05): the 0.45 mm rule above the cover control block. */
  controlRule: "st-control-rule",
  colophon: "st-colophon",
  colophonLeft: "st-colophon-left",
  colophonRight: "st-colophon-right",
  controlSheet: "st-control-sheet",
  frontKicker: "st-front-kicker",
  frontTitle: "st-front-title",
  blockHeading: "st-block-heading",
  methodStatement: "st-method",
  toc: "st-toc",
  tocTitle: "st-toc-title",
  tocNote: "st-toc-note",
  tocTable: "st-toc-table",
  tocRow: "st-toc-row",
  tocLabel: "st-toc-label",
  tocEntryTitle: "st-toc-entry-title",
  tocPage: "st-toc-page",
  tocLink: "st-toc-link",
  part: "st-part",
  partKicker: "st-part-kicker",
  partTitle: "st-part-title",
  partLede: "st-part-lede",
  partChapters: "st-part-chapters",
  partChapterNo: "st-part-chapter-no",
  partChapterTitle: "st-part-chapter-title",
  signature: "st-signature",
  signatureRole: "st-signature-role",
  signatureSpace: "st-signature-space",
  signatureHolder: "st-signature-holder",
  signatureDate: "st-signature-date",
  fallbackTable: "st-fallback-table",
} as const;

export type HtmlBlockClass = (typeof HTML_BLOCK_CLASSES)[keyof typeof HTML_BLOCK_CLASSES];

const C = HTML_BLOCK_CLASSES;

/**
 * CSS struktural minimum agar markup blok terbaca benar tanpa bergantung isi
 * token S21 (spasi apa adanya, caps tanpa mengubah teks sumber, tab, rel).
 * Warna/ukuran/wajah tetap dari token S21 dan gaya inline per peran.
 * Perakit S24 menyisipkan konstanta ini ke `<style>` (tanpa rujukan eksternal).
 */
export const HTML_BLOCKS_CSS = [
  `.${C.paragraph},.${C.heading},.${C.listItem},.${C.monoLine},.${C.railLine}{white-space:pre-wrap;margin:0}`,
  // caps (w:caps) = text-transform:uppercase, presentasi saja; teks sumber di DOM tidak diubah (D-46).
  `.${C.caps}{text-transform:uppercase}`,
  // smallCaps (w:smallCaps) = font-variant-caps:small-caps (D-46).
  `.${C.smallCaps}{font-variant-caps:small-caps}`,
  `.${C.bold}{font-weight:600}`,
  `.${C.italic}{font-style:italic}`,
  `.${C.underline}{text-decoration:underline}`,
  `.${C.tab}{display:inline-block;min-width:1.25em;white-space:pre}`,
  `.${C.list}{list-style:none;margin:0;padding:0}`,
  `.${C.listMarker}{display:inline-block;min-width:1.25em}`,
  `.${C.monoBody}{margin:0;white-space:pre-wrap}`,
  `.${C.monoLine}{display:block}`,
  `.${C.railHost}{display:grid;grid-template-columns:minmax(0,1fr) var(--st-rail-width,32mm);column-gap:var(--st-rail-gap,6mm);align-items:start}`,
  `.${C.rail}{font-size:5.9pt;line-height:1.3}`,
  `.${C.datumRule}{display:block;overflow:visible}`,
  `.${C.hairline}{border:0;border-top:0.25pt solid currentColor;margin:0}`,
  `.${C.sealBand}{display:flex;justify-content:space-between;align-items:center}`,
  `.${C.spine}[data-rotate="90"]{writing-mode:vertical-rl}`,
  `.${C.controlBlock},.${C.tocTable},.${C.signature},.${C.partChapters},.${C.fallbackTable}{border-collapse:collapse;table-layout:fixed}`,
  `.${C.colophon}{display:flex;justify-content:space-between}`,
  // FIX-H4: entri daftar isi turunan = tautan jangkar internal; tampilan tetap milik peran sel.
  `.${C.tocLink}{color:inherit;text-decoration:none}`,
  `.${C.field}:empty::before{content:"\\2007"}`,
  // Wave 165 row 165A (C188 F113-3/F113-4): the control block and the signature block span the 166 mm text column
  // (shares from wrapper.ts `shareColgroup`, DOCX grids); 3 mm between a value and the next label so no pair abuts;
  // three signature columns 4 mm apart, each with its own signature line (DOCX holder top border, colour
  // `--st-sign-rule` = `color.wrapper.rule`); HALAMAN = the printed page count set by the PDF print.
  `.${C.controlBlock},.${C.signature}{width:100%}`,
  `.${C.controlValue}{padding-right:3mm}`,
  `.${C.signature} th,.${C.signature} td{padding-right:4mm;text-align:left;vertical-align:top}`,
  // Row 165J (F165H-3, CP-47): the signature line is a CSS border on a block before the holder text, not a gradient
  // background (Chromium printed the gradient into the PDF as a 145 x 2 px raster image). The td keeps its 4 mm right
  // padding, so the line is the column width minus 4 mm (51 mm at the 55 mm pitch), drawn as a vector rule.
  `.${C.signatureHolder}::before{content:"";display:block;border-top:0.22mm solid var(--st-sign-rule,#C4BEB4);margin-bottom:1.4mm}`,
  // Row 165J (F165H-1, DATUM-15): the control-sheet method statement is a body paragraph (st-p) and is set at the
  // body text measure `--col` (128 mm on the canonical grid), as chapter prose, not across the 166 mm span. The
  // second selector outranks the K2 rail rule (html/base/shell.ts RAIL_K2_CSS, max-width:none, specificity 0,4,1),
  // which the reserve rule re-narrows for interior units only (case 05 measured 136 mm without it).
  `.${C.methodStatement},body.st-doc .st-unit.st-unit-controlSheet .${C.paragraph}.${C.methodStatement}{max-width:var(--col)}`,
  `.${C.controlBlock} .${C.field}[data-field="NUMPAGES"]:empty::before{content:var(--st-pages-total,"\\2007")}`,
  // Swarm row 165P (C205, CP-01, ID p.47 DT-14 "Tumpukan di tengah adalah tanda templat", UJI "Semua unsur sampul rata
  // kiri pada 24 mm"; Gambar 8.2 and the specimen cover p.1 range the labels left): a label is a `th`, which a browser
  // centres by default; it is set flush left, as the DOCX label paragraph. CP-05 (ID p.47 butir 10 "Blok kendali 4 × 2
  // di bawah garis 0,45 mm"): the rule above the block is an inline SVG right before the table (wrapper.ts
  // `controlBlockHtml`; = DOCX `controlBlockXml` first-row top border, w:sz 10 = 0.44 mm).
  `.${C.controlLabel}{text-align:left}`,
  `.${C.controlRule}{display:block;width:100%;margin:0}`,
].join("\n");
