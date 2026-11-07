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
].join("\n");
