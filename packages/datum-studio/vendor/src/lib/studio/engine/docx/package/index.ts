/**
 * Modul engine/docx/package (I03, 01_specs.md §8.2), diisi S14: paket inti
 * OOXML. Basis `default.docx` (aset S13), styles.xml minimal + docDefaults dari
 * templat, settings (updateFields, embedTrueTypeFonts, saveSubsetFonts),
 * properti inti, sectPr per seksi, header/footer running head + blok register
 * (PAGE/NUMPAGES), wadah fon tertanam (S15), ZIP deterministik (fflate).
 *
 * Tanda tangan ekspor §8.2 tetap; ekspor tambahan (buildSectionPackage,
 * resolveUnitSetup, dst.) adalah antarmuka untuk perakit S20.
 */
import type { DocMeta, DocxPackageInput, HeaderFooterSpec, NormUnit, RenderContext, ResolvedTemplate, SectionSetup } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { loadBasePackage } from "./base";
import { buildFontContainer } from "./fonts";
import { headerFooterXml as hfXml } from "./header-footer";
import {
  appPropsXml,
  contentTypesXml,
  corePropsXml as corePropsXmlImpl,
  CT,
  fontTableXml,
  pageBackgroundColour,
  REL,
  relsXml,
  settingsXml as settingsXmlImpl,
  stylesXml as stylesXmlImpl,
  type Relationship,
  withPageBackground,
} from "./parts";
import { sectPrXml as sectPrXmlImpl } from "./section";
import { zipDeterministic, type ZipEntry } from "./zip";

export {
  buildSectionPackage,
  datumDate,
  defaultRunningHeadLeft,
  EMPTY_HF_FORMAT,
  REGISTER_COLS_TW,
  scaleCols,
  type SectionPackage,
  type SectionPackagePart,
} from "./header-footer";
export {
  BM_MARGIN_TW,
  mmToTw,
  resolveUnitSetup,
  sectionBreakParagraphXml,
  textWidthTw,
  WRAPPER_KINDS,
  type ResolvedSectionSetup,
} from "./section";
export { DEFAULT_FACES, escapeXml, facesInXml, resolveFace } from "./xml";
export { CT as DOCX_CONTENT_TYPES, REL as DOCX_REL_TYPES } from "./parts";
export { naturalCompare, zipMtime } from "./zip";

/** Relasi `word/_rels/document.xml.rels` milik paket (pola basis; rId4 = stylesWithEffects basis, tidak dipakai). */
export const PACKAGE_DOCUMENT_RELS: readonly Relationship[] = [
  { id: "rId1", type: REL.customXml, target: "../customXml/item1.xml" },
  { id: "rId2", type: REL.numbering, target: "numbering.xml" },
  { id: "rId3", type: REL.styles, target: "styles.xml" },
  { id: "rId5", type: REL.settings, target: "settings.xml" },
  { id: "rId6", type: REL.webSettings, target: "webSettings.xml" },
  { id: "rId7", type: REL.fontTable, target: "fontTable.xml" },
  { id: "rId8", type: REL.theme, target: "theme/theme1.xml" },
];
/** rId1..rId8 dicadangkan paket; relasi pemanggil mulai rId9 (BM: header1 = rId9). */
export const RESERVED_DOCUMENT_REL_IDS: ReadonlySet<string> = new Set(["rId1", "rId2", "rId3", "rId4", "rId5", "rId6", "rId7", "rId8"]);
export const FIRST_FREE_REL_ID = 9;

/** Bagian yang dibangkitkan paket; pemanggil tidak boleh mengirim path ini. */
const GENERATED_PARTS = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "word/settings.xml",
  "word/fontTable.xml",
  "word/_rels/fontTable.xml.rels",
]);

/** Ekstensi yang ditulis sebagai `Default` tipe isi. */
const DEFAULT_EXT_CT: Readonly<Record<string, string>> = {
  png: CT.png,
  jpeg: CT.jpeg,
  jpg: CT.jpeg,
  gif: CT.gif,
  svg: CT.svg,
  emf: CT.emf,
  odttf: CT.odttf,
};

const enc = new TextEncoder();

function toBytes(d: Uint8Array | string): Uint8Array {
  return typeof d === "string" ? enc.encode(d) : d;
}

function assertPartPath(p: string): void {
  if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Path bagian paket tidak sah: "${p}"`);
  }
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function inferContentType(p: string): string | undefined {
  if (/^word\/header\d*\.xml$/.test(p)) return CT.header;
  if (/^word\/footer\d*\.xml$/.test(p)) return CT.footer;
  if (p.endsWith(".rels")) return CT.rels;
  return DEFAULT_EXT_CT[extOf(p)];
}

/** ZIP deterministik, mtime = fixedDate. */
export function buildDocxPackage(i: DocxPackageInput): Uint8Array {
  if (!i.documentXml || !i.documentXml.includes("<w:document")) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "documentXml kosong atau tanpa akar <w:document>");
  }
  const base = loadBasePackage(i.tpl);

  // Bagian pemanggil (header/footer/media/odttf siap pakai).
  const provided = new Map<string, Uint8Array>();
  const providedCt = new Map<string, string | undefined>();
  for (const part of i.parts) {
    assertPartPath(part.path);
    if (GENERATED_PARTS.has(part.path)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Bagian ${part.path} dibangkitkan paket; jangan dikirim pemanggil`);
    }
    if (provided.has(part.path)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Bagian ganda: ${part.path}`);
    }
    provided.set(part.path, toBytes(part.data));
    providedCt.set(part.path, part.contentType);
  }

  const fonts = buildFontContainer(i.fonts, provided);
  for (const fp of fonts.parts) {
    provided.delete(fp.path);
    providedCt.delete(fp.path);
  }

  // Relasi dokumen.
  const docRels: Relationship[] = [...PACKAGE_DOCUMENT_RELS];
  const relIds = new Set<string>(RESERVED_DOCUMENT_REL_IDS);
  for (const r of i.relationships) {
    if (relIds.has(r.id)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Id relasi dokumen bentrok/cadangan: ${r.id} (mulai rId${FIRST_FREE_REL_ID})`);
    }
    relIds.add(r.id);
    docRels.push({ id: r.id, type: r.type, target: r.target, targetMode: r.targetMode });
  }

  // Tipe isi.
  const defaults = new Map<string, string>([
    ["rels", CT.rels],
    ["xml", CT.xml],
  ]);
  const overrides = new Map<string, string>([
    ["/word/document.xml", CT.document],
    ["/word/styles.xml", CT.styles],
    ["/word/settings.xml", CT.settings],
    ["/word/fontTable.xml", CT.fontTable],
    ["/docProps/core.xml", CT.core],
    ["/docProps/app.xml", CT.app],
  ]);
  const baseCt: Record<string, string> = {
    "word/theme/theme1.xml": CT.theme,
    "word/webSettings.xml": CT.webSettings,
    "word/numbering.xml": CT.numbering,
    "customXml/itemProps1.xml": CT.customXmlProps,
  };
  for (const p of base.parts.keys()) {
    if (baseCt[p]) overrides.set(`/${p}`, baseCt[p]);
  }
  const addDefault = (ext: string, ct: string, p: string) => {
    const prev = defaults.get(ext);
    if (prev && prev !== ct) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Tipe isi bentrok untuk .${ext} (${prev} vs ${ct}) di ${p}`);
    }
    defaults.set(ext, ct);
  };
  if (fonts.parts.length > 0) addDefault("odttf", CT.odttf, "word/fonts");
  for (const [p, givenCt] of providedCt) {
    const ext = extOf(p);
    const ct = givenCt ?? baseCt[p] ?? inferContentType(p);
    if (!ct) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Tipe isi tidak diketahui untuk bagian ${p}`);
    }
    if (DEFAULT_EXT_CT[ext] !== undefined || ext === "rels") addDefault(ext, ct, p);
    else if (!(ext === "xml" && ct === CT.xml)) overrides.set(`/${p}`, ct);
  }

  const rootRels: Relationship[] = [
    { id: "rId1", type: REL.officeDocument, target: "word/document.xml" },
    { id: "rId3", type: REL.coreProps, target: "docProps/core.xml" },
    { id: "rId4", type: REL.extendedProps, target: "docProps/app.xml" },
  ];

  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: enc.encode(contentTypesXml(defaults, overrides)) },
    { path: "_rels/.rels", data: enc.encode(relsXml(rootRels)) },
    { path: "docProps/core.xml", data: enc.encode(corePropsXmlImpl(i.meta)) },
    { path: "docProps/app.xml", data: enc.encode(appPropsXml(i.tpl)) },
    { path: "word/document.xml", data: enc.encode(withPageBackground(i.documentXml, pageBackgroundColour(i.tpl))) },
    { path: "word/_rels/document.xml.rels", data: enc.encode(relsXml(docRels)) },
    { path: "word/styles.xml", data: enc.encode(stylesXmlImpl(i.tpl)) },
    { path: "word/settings.xml", data: enc.encode(settingsXmlImpl(i.tpl)) },
    { path: "word/fontTable.xml", data: enc.encode(fontTableXml(base.fontEntriesXml, fonts.embeds)) },
  ];
  if (fonts.relationships.length > 0) {
    entries.push({ path: "word/_rels/fontTable.xml.rels", data: enc.encode(relsXml(fonts.relationships)) });
  }
  for (const [p, data] of base.parts) {
    if (!provided.has(p)) entries.push({ path: p, data });
  }
  for (const fp of fonts.parts) entries.push(fp);
  for (const [p, data] of provided) entries.push({ path: p, data });

  return zipDeterministic(entries, i.fixedDate);
}

export function sectPrXml(s: SectionSetup, rel: { headerRId: string; footerRId: string }): string {
  return sectPrXmlImpl(s, rel);
}

export function headerFooterXml(spec: HeaderFooterSpec, ctx: RenderContext, unit: NormUnit, kind: "hdr" | "ftr"): string {
  return hfXml(spec, ctx, unit, kind);
}

export function stylesXml(tpl: ResolvedTemplate): string {
  return stylesXmlImpl(tpl);
}

export function settingsXml(tpl: ResolvedTemplate): string {
  return settingsXmlImpl(tpl);
}

export function corePropsXml(meta: DocMeta): string {
  return corePropsXmlImpl(meta);
}
