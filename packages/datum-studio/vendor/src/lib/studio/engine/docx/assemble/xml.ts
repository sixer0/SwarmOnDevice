/**
 * Serialisasi tingkat dokumen untuk perakit DOCX (S20): akar `w:document`
 * (himpunan namespace BM.docx persis), pemeriksaan prefiks namespace fragmen,
 * dan paragraf pemegang sectPr peran U11 `unit.sectionHolder` (K-12).
 */
import type { ParaFormat, ParamMap, RunProps } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { escapeXml, resolveFace } from "../package";

export const XML_DECL = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n";

/** Namespace akar BM.docx (python-docx default.docx), urutan apa adanya. */
const BM_ROOT_NS: ReadonlyArray<readonly [string, string]> = [
  ["wpc", "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"],
  ["mo", "http://schemas.microsoft.com/office/mac/office/2008/main"],
  ["mc", "http://schemas.openxmlformats.org/markup-compatibility/2006"],
  ["mv", "urn:schemas-microsoft-com:mac:vml"],
  ["o", "urn:schemas-microsoft-com:office:office"],
  ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
  ["m", "http://schemas.openxmlformats.org/officeDocument/2006/math"],
  ["v", "urn:schemas-microsoft-com:vml"],
  ["wp14", "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"],
  ["wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"],
  ["w10", "urn:schemas-microsoft-com:office:word"],
  ["w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"],
  ["w14", "http://schemas.microsoft.com/office/word/2010/wordml"],
  ["wpg", "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"],
  ["wpi", "http://schemas.microsoft.com/office/word/2010/wordprocessingInk"],
  ["wne", "http://schemas.microsoft.com/office/word/2006/wordml"],
  ["wps", "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"],
];

/**
 * Prefiks umum yang ditambahkan ke akar HANYA bila dipakai fragmen tanpa
 * deklarasi lokal (python-docx mendeklarasikan `a`/`pic` lokal di drawing; BM
 * tidak memuatnya di akar). Prefiks tak dikenal tanpa deklarasi = galat.
 */
const KNOWN_EXTRA_NS: Readonly<Record<string, string>> = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  a14: "http://schemas.microsoft.com/office/drawing/2010/main",
  asvg: "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  wp15: "http://schemas.microsoft.com/office/word/2012/wordprocessingDrawing",
};

const BM_PREFIXES: ReadonlySet<string> = new Set(BM_ROOT_NS.map(([p]) => p));

/**
 * Prefiks elemen dan atribut yang dipakai (selain xml/xmlns). Hanya isi tag
 * yang diperiksa (teks ber-escape tidak memuat `<`/`>`), nilai atribut dibuang
 * dulu agar teks seperti `x:y=` di dalam nilai tidak terhitung.
 */
function usedPrefixes(body: string): Set<string> {
  const out = new Set<string>();
  const tag = /<([^<>]+)>/g;
  let t: RegExpExecArray | null;
  while ((t = tag.exec(body)) !== null) {
    const inner = t[1];
    if (inner.startsWith("?") || inner.startsWith("!")) continue;
    const bare = inner.replace(/"[^"]*"|'[^']*'/g, '""');
    const name = /^\/?([A-Za-z_][\w.-]*):/.exec(bare);
    if (name) out.add(name[1]);
    const at = /\s([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = at.exec(bare)) !== null) out.add(m[1]);
  }
  out.delete("xml");
  out.delete("xmlns");
  return out;
}

/** `word/document.xml` lengkap. Melempar bila ada prefiks tanpa deklarasi. */
export function documentXml(body: string): string {
  const extra: Array<[string, string]> = [];
  for (const p of [...usedPrefixes(body)].sort()) {
    if (BM_PREFIXES.has(p)) continue;
    if (body.includes(`xmlns:${p}=`)) continue; // dideklarasikan lokal oleh fragmen
    const uri = KNOWN_EXTRA_NS[p];
    if (!uri) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Prefiks namespace "${p}" dipakai fragmen tanpa deklarasi`);
    }
    extra.push([p, uri]);
  }
  const ns = [...BM_ROOT_NS, ...extra].map(([p, uri]) => `xmlns:${p}="${uri}"`).join(" ");
  const ignorable = ["w14", "wp14", ...extra.map(([p]) => p).filter((p) => p === "w15" || p === "wp15")].join(" ");
  return `${XML_DECL}<w:document ${ns} mc:Ignorable="${ignorable}"><w:body>${body}</w:body></w:document>`;
}

// ── Paragraf pemegang sectPr (U11) ───────────────────────────────────────

function onOff(tag: string, v: boolean | undefined): string {
  if (v === undefined) return "";
  return v ? `<w:${tag}/>` : `<w:${tag} w:val="0"/>`;
}

function a(k: string, v: string | number | undefined): string {
  return v === undefined ? "" : ` ${k}="${escapeXml(String(v))}"`;
}

/** rPr tanda paragraf (urutan CT_ParaRPr). */
function paraMarkRPr(r: RunProps | undefined, params: ParamMap): string {
  if (!r) return "";
  const face = resolveFace(r, params);
  let inner = "";
  if (face) inner += `<w:rFonts${a("w:ascii", face)}${a("w:hAnsi", face)}${a("w:cs", face)}${a("w:eastAsia", face)}/>`;
  inner += onOff("b", r.b) + onOff("i", r.i);
  if (r.caps) inner += "<w:caps/>";
  if (r.color) inner += `<w:color${a("w:val", r.color)}/>`;
  if (r.spacingTw !== undefined) inner += `<w:spacing${a("w:val", Math.round(r.spacingTw))}/>`;
  if (r.szHalfPt !== undefined) {
    const sz = Math.round(r.szHalfPt);
    inner += `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
  }
  return inner ? `<w:rPr>${inner}</w:rPr>` : "";
}

/**
 * Isi `w:pPr` paragraf pemegang (tanpa sectPr; sectPr ditambahkan
 * `sectionBreakParagraphXml` sebagai anak terakhir). Urutan CT_PPr; hanya
 * medan yang lazim untuk paragraf kosong pemegang seksi. BM: pPr kosong.
 */
export function sectionHolderPPrInner(f: ParaFormat | undefined, run: RunProps | undefined, params: ParamMap): string {
  let inner = "";
  if (f) {
    inner += onOff("keepNext", f.keepNext) + onOff("keepLines", f.keepLines) + onOff("widowControl", f.widowControl);
    const sp =
      a("w:before", f.spacingBeforeTw) +
      a("w:after", f.spacingAfterTw) +
      a("w:line", f.lineTw) +
      a("w:lineRule", f.lineTw !== undefined ? (f.lineRule ?? "auto") : undefined);
    if (sp) inner += `<w:spacing${sp}/>`;
    if (f.jc) inner += `<w:jc w:val="${f.jc}"/>`;
  }
  return inner + paraMarkRPr(run, params);
}
