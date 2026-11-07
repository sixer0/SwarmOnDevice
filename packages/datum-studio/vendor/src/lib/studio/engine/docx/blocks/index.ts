/**
 * Modul engine/docx/blocks (I05, 01_specs.md §8.2; baris S16).
 *
 * Blok teks DOCX dengan FORMAT LANGSUNG per paragraf/run, tanpa gaya bernama
 * (semua paragraf `Normal`, sesuai BM.docx dan DatumDocx): chapter, section,
 * paragraph, list, aside, monoBlock, assumptionInline, spacer, device; rel
 * bukti moda A (`framePr` Garis A atau `table3col` BM.docx).
 *
 * Format diambil dari: format eksplisit blok/butir/run > `roleFormats` templat
 * > turunan katalog (S11 `resolveRoleFormat`) > gaya Normal templat (§5.6,
 * konvensi C12). `runs[]` ditulis apa adanya (konvensi C1-C4, C9): tidak ada
 * awalan/akhiran tambahan; `caps` = properti run `w:caps`.
 *
 * Fragmen: `xml` (paragraf/tabel badan), `media` (gambar inline; relasi lewat
 * placeholder `{{media:<nama>}}`, lihat media.ts), `facesUsed` (nama wajah
 * untuk penanaman fon S15). Galat isi -> log `error` lewat `ctx.log` (sink
 * persisten layanan render) lalu `StudioEngineError` SCHEMA_INVALID.
 */
import type { DocxBlockRenderer, DocxFragment, NormBlock, RenderContext, Run, RunProps } from "../../../contract";
import { renderAside, renderMonoBlock } from "./boxes";
import { renderContractRecord } from "./contract-record";
import { BlockEnv, faceMapFrom } from "./env";
import { renderDevice, renderSpacer } from "./primitives";
import { renderRuleIndex, renderSlotPlaceholder, renderSourceRegisterEntry } from "./source-register";
import { parseMdLite as parseMdLiteImpl, runsXmlWith, type MdLiteRoles } from "./runs";
import { renderChapter, renderSection } from "./structure";
import { renderAssumptionInline, renderList, renderParagraph } from "./text";

export { MEDIA_REL_PLACEHOLDER_RE, mediaRelPlaceholder } from "./media";
export { SECTION_NUMBER_GAP } from "./structure";
export { escapeXml } from "./xml";
export { CONTRACT_RECORD_PARTS, renderContractRecord } from "./contract-record";

export type DocxTextBlockKey =
  | "paragraph"
  | "list"
  | "aside"
  | "monoBlock"
  | "assumptionInline"
  | "spacer"
  | "device"
  | "chapter"
  | "section"
  | "sourceRegisterEntry"
  | "slotPlaceholder"
  | "contractRecord";

function renderer(fn: (env: BlockEnv) => string): DocxBlockRenderer {
  return (block: NormBlock, ctx: RenderContext): DocxFragment => {
    const env = new BlockEnv(block, ctx);
    const xml = fn(env);
    const frag: DocxFragment = { xml, facesUsed: [...env.used].sort() };
    if (env.media.length > 0) frag.media = env.media;
    return frag;
  };
}

export const docxBlocks: Partial<Record<DocxTextBlockKey, DocxBlockRenderer>> = {
  chapter: renderer(renderChapter),
  section: renderer(renderSection),
  paragraph: renderer(renderParagraph),
  list: renderer(renderList),
  aside: renderer(renderAside),
  monoBlock: renderer(renderMonoBlock),
  assumptionInline: renderer(renderAssumptionInline),
  spacer: renderer(renderSpacer),
  device: renderer(renderDevice),
  // RQ-7: blok struktural v2 slot (compose SR-08), setara perakit HTML SR-17. `ruleIndex`
  // v2 tidak didaftarkan di sini: kunci itu milik tabel v1 (`docxTables`, menang di dispatch);
  // perutean `content.mode === "auto"` ke `renderRuleIndexMarker` diajukan lewat file_requests.
  sourceRegisterEntry: renderer(renderSourceRegisterEntry),
  slotPlaceholder: renderer(renderSlotPlaceholder),
  // DC-13: slot catatan kontrak (S30, register 05 §6.1); tabel lewat keluarga tabel DATUM.
  // Butir `contractItem` adalah proyeksi alamat milik perakit (`assemble/index.ts`).
  contractRecord: renderContractRecord,
};

/** RQ-7: penanda `ruleIndex` v2 (`content.mode === "auto"`) sebagai DocxBlockRenderer siap pakai. */
export const renderRuleIndexMarker: DocxBlockRenderer = renderer(renderRuleIndex);

/**
 * Run apa adanya di atas `base`. `faceRole` dipetakan ke wajah default registri
 * (`type.face.*`); renderer blok memakai wajah parameter templat resolved.
 */
export function runsXml(runs: readonly Run[], base: RunProps): string {
  return runsXmlWith(runs, base, faceMapFrom(undefined), new Set<string>());
}

/** md-lite = semantik DatumDocx.para() (KS-03); lihat runs.ts untuk beda yang disengaja. */
export function parseMdLite(text: string, roles: MdLiteRoles): Run[] {
  return parseMdLiteImpl(text, roles);
}
