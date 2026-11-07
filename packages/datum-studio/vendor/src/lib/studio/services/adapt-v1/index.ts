/**
 * services/adapt-v1 (I46, SR-09): adaptor MURNI `studio.doc/v1` → `studio.doc/v2`
 * (register 03_structural_sections_specs.md §14; blueprint 05 §2.8 butir 1).
 *
 * Tanpa DB, tanpa berkas, tanpa jam: masukan sama → keluaran sama. Galat
 * kebijakan dilempar sebagai `StudioEngineError` (route memetakan ke HTTP);
 * pencatatan galat persisten milik pemanggil (ingest SR-12).
 *
 * Tingkat atas (AD-01..AD-16):
 * - `agentId`, `template`, `mission`, `meta`, `register`, `x` apa adanya
 *   (`x` tetap melewati gerbang kepercayaan D-98/D-134 di ingest).
 * - `$schema` → `studio.doc/v2`. D-247 (FIX-S, mengganti AD-03/AD-15): kiriman v1 tidak
 *   lagi memicu build; `render` permintaan dan `outputs` v1 DIBUANG dan dicatat di
 *   laporan (`stripped.render`, `stripped.outputs`). Build lewat
 *   `POST /api/studio/documents/{id}/render`.
 * - `overrides` = format inline R-38 (AD-09): `strip` dibuang + REPORT,
 *   `reject` 422, `allow` tepercaya dipertahankan di `internal` (KD-26).
 * - `front.*` → slot `cover`, `controlSheet`, `toc`, `signature`; `parts`/
 *   `chapters` → `sections.content`; `appendices` → `sections.appendices`.
 * - `assets`: `dataBase64` → `{ mime, dataBase64 }`; selain itu
 *   `{ assetRef: "sha256:<hex>" }`. Aset ber-`path` juga dilaporkan di
 *   `assetPaths` agar ingest membaca berkas di bawah akar aset dan menyimpan M13
 *   (adaptor murni tidak membaca berkas).
 *
 * Kebijakan `ingest.inlineFormat` (R-38, D-138): `allow` hanya berlaku bila
 * `trusted` (ADMIN/harness); `allow` dari pemanggil tak tepercaya diperlakukan
 * `strip` dan `report.policy` memuat kebijakan efektif.
 */
import { StudioEngineError } from "@/lib/studio/contract";
import type {
  AdaptReportV1,
  AppendixSlotPayloadV2,
  AssetInputV2,
  AssetRef,
  ContentSlotPayloadV2,
  InlineFormatPolicy,
  PartV2,
  SignaturePayloadV2,
  StudioDocV1,
  StudioDocV2,
  StudioIngestRequest,
} from "@/lib/studio/contract";
import { adaptChapter, type AdaptCtx } from "./blocks";
import { adaptControlSheet, adaptCover, adaptSignature, adaptToc, dropFrontBody, type FrontCarry } from "./front";
import { buildAssetKeyMap, PidMapper } from "./ids";
import { adaptInline, adaptInlineOpt, ptr } from "./inline";
import { AdaptRecorder, countInlineFormat } from "./report";

export { countInlineFormat, INLINE_FORMAT_FIELDS } from "./report";

/** Kunci slot hasil adaptasi (kerangka bawaan SL-01..SL-07 / kerangka implisit §6.3). */
export const ADAPT_V1_SLOT_KEYS = {
  cover: "cover",
  controlSheet: "controlSheet",
  signature: "signature",
  toc: "toc",
  content: "content",
  appendices: "appendices",
} as const;

export interface AdaptV1Options {
  /**
   * Slot `toc` versi templat bermode MIXED: `entries` statis v1 dipertahankan.
   * Bawaan false (AUTO): entri dibuang + `dropped.tocEntries` (§14.2).
   */
  tocMixed?: boolean;
}

/** Aset v1 ber-`path` yang wajib dibaca ingest dan disimpan ke M13 (kunci = kunci aset v2). */
export interface AdaptAssetPath {
  path: string;
  sha256: string;
  mime: "image/png" | "image/jpeg";
}

export interface AdaptV1Result {
  doc: StudioDocV2;
  /** Hanya `allow` tepercaya: dokumen v1 asli (salinan) untuk snapshot internal (KD-26). */
  internal?: StudioDocV1;
  report: AdaptReportV1;
  /** (+) Aset `path` v1 yang harus dibaca dan disimpan pemanggil sebelum compose. */
  assetPaths?: Record<string, AdaptAssetPath>;
}

const REQUEST_KEYS = ["agentId", "document", "render"] as const;
const DOCUMENT_KEYS = [
  "$schema",
  "template",
  "mission",
  "meta",
  "register",
  "front",
  "parts",
  "chapters",
  "appendices",
  "assets",
  "outputs",
  "x",
] as const;

/** Kebijakan efektif: `allow` hanya untuk pemanggil tepercaya. */
export function effectiveInlinePolicy(policy: InlineFormatPolicy, trusted: boolean): InlineFormatPolicy {
  return policy === "allow" && !trusted ? "strip" : policy;
}

function letterKey(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `A${i}`;
}

function adaptAssets(
  assets: Record<string, AssetRef>,
  keyMap: ReadonlyMap<string, string>,
  rec: AdaptRecorder,
): { assets: Record<string, AssetInputV2>; paths: Record<string, AdaptAssetPath> } {
  const out: Record<string, AssetInputV2> = {};
  const paths: Record<string, AdaptAssetPath> = {};
  for (const [k, a] of Object.entries(assets)) {
    const key = keyMap.get(k) ?? k;
    const p = ptr("/document/assets", k);
    if (typeof a.dataBase64 === "string" && a.dataBase64 !== "") {
      out[key] = { mime: a.mime, dataBase64: a.dataBase64 };
      rec.rest(a, ["kind", "mime", "dataBase64", "sha256", "path"], p);
    } else {
      out[key] = { assetRef: `sha256:${String(a.sha256).toLowerCase()}` };
      rec.rename("assets.sha256->assetRef");
      rec.rest(a, ["kind", "mime", "sha256", "path"], p);
      if (typeof a.path === "string" && a.path !== "") paths[key] = { path: a.path, sha256: String(a.sha256).toLowerCase(), mime: a.mime };
    }
  }
  return { assets: out, paths };
}

/**
 * Adaptasi permintaan ingest v1 ke dokumen v2 konten murni + REPORT
 * `SCHEMA_V1_ADAPTED`. Melempar 422 `INLINE_FORMAT_REJECTED` bila kebijakan
 * efektif `reject` dan kiriman memuat format inline (R-38).
 */
export function adaptV1(
  req: StudioIngestRequest,
  policy: InlineFormatPolicy,
  trusted: boolean,
  opts: AdaptV1Options = {},
): AdaptV1Result {
  const eff = effectiveInlinePolicy(policy, trusted);
  const rec = new AdaptRecorder(eff);
  const d = req.document;
  rec.rest(req, REQUEST_KEYS, "");
  rec.rest(d, DOCUMENT_KEYS, "/document");

  const assetKeys = buildAssetKeyMap(Object.keys(d.assets ?? {}), rec);
  const ctx: AdaptCtx = { rec, pids: new PidMapper(rec), assetKeys };
  const carry: FrontCarry = {};
  const sections: NonNullable<StudioDocV2["sections"]> = {};

  // Halaman depan (AD-10). Urutan objek = urutan kerangka bawaan.
  const front = d.front;
  if (front) {
    const pf = "/document/front";
    rec.rest(front, ["cover", "controlSheet", "toc", "signature"], pf);
    const cover = front.cover ? adaptCover(front.cover, `${pf}/cover`, ctx, carry) : undefined;
    const controlSheet = front.controlSheet ? adaptControlSheet(front.controlSheet, `${pf}/controlSheet`, ctx, carry) : undefined;
    const toc = front.toc ? adaptToc(front.toc, `${pf}/toc`, ctx, opts.tocMixed === true) : undefined;
    let signature: SignaturePayloadV2 | undefined;
    if (front.signature) {
      signature = adaptSignature(front.signature, `${pf}/signature`, rec);
      if (carry.signature) rec.drop("frontItems");
    } else if (carry.signature) {
      signature = adaptSignature(carry.signature.block, carry.signature.pointer, rec);
      rec.rename("front.body.signatureBlock->signature");
    }
    if (cover) sections[ADAPT_V1_SLOT_KEYS.cover] = cover;
    if (controlSheet) sections[ADAPT_V1_SLOT_KEYS.controlSheet] = controlSheet;
    if (signature) sections[ADAPT_V1_SLOT_KEYS.signature] = signature;
    if (toc) sections[ADAPT_V1_SLOT_KEYS.toc] = toc;
  }

  // Bagian (AD-11): keanggotaan bab lewat `ChapterV2.partId`.
  const partOf = new Map<string, string>();
  const parts: PartV2[] = (d.parts ?? []).map((part, i) => {
    const pp = ptr("/document/parts", i);
    rec.rest(part, ["id", "title", "lede", "chapterKeys", "body"], pp);
    for (const k of part.chapterKeys ?? []) if (!partOf.has(k)) partOf.set(k, part.id);
    dropFrontBody(part.body, rec);
    const v: PartV2 = { id: part.id, title: adaptInline(part.title, `${pp}/title`, rec) };
    const lede = adaptInlineOpt(part.lede, `${pp}/lede`, rec);
    if (lede) v.lede = lede;
    return v;
  });

  // Bab (AD-12) dan lampiran (AD-13).
  const chapters = (d.chapters ?? []).map((c, i) => adaptChapter(c, String(i + 1), partOf, ptr("/document/chapters", i), ctx));
  const content: ContentSlotPayloadV2 = { type: "chapter" };
  if (parts.length > 0) content.parts = parts;
  content.chapters = chapters;
  sections[ADAPT_V1_SLOT_KEYS.content] = content;
  if (d.appendices && d.appendices.length > 0) {
    const app: AppendixSlotPayloadV2 = {
      type: "appendix",
      chapters: d.appendices.map((c, i) => adaptChapter(c, letterKey(i), new Map(), ptr("/document/appendices", i), ctx)),
    };
    sections[ADAPT_V1_SLOT_KEYS.appendices] = app;
  }

  // Dokumen v2 (AD-01..AD-08, AD-14..AD-16).
  const doc: StudioDocV2 = { $schema: "studio.doc/v2", template: { ...d.template }, meta: { ...d.meta } };
  if (req.agentId !== undefined) doc.agentId = req.agentId;
  if (d.mission !== undefined) doc.mission = { ...d.mission };
  doc.sections = sections;
  if (d.register !== undefined) doc.register = d.register;
  let assetPaths: Record<string, AdaptAssetPath> | undefined;
  if (d.assets && Object.keys(d.assets).length > 0) {
    const a = adaptAssets(d.assets, assetKeys, rec);
    doc.assets = a.assets;
    if (Object.keys(a.paths).length > 0) assetPaths = a.paths;
  }
  if (d.x !== undefined) doc.x = d.x;
  // D-247: tanpa build otomatis; permintaan render/outputs v1 dibuang dengan laporan.
  if (d.outputs !== undefined) rec.strip("outputs", "/document");
  if (req.render !== undefined) rec.strip("render", "");

  const report = rec.finish();
  if (eff === "reject" && countInlineFormat(report) > 0) {
    throw new StudioEngineError(
      "INLINE_FORMAT_REJECTED",
      "Kiriman studio.doc/v1 memuat format tampilan inline, sedangkan templat menolaknya (ingest.inlineFormat = reject). " +
        "Hapus medan tampilan (format, runDefaults, fieldFormats, properti fon run, overrides); tampilan diatur templat.",
      { issues: rec.inlineIssues(), report },
    );
  }

  const result: AdaptV1Result = { doc, report };
  if (eff === "allow") result.internal = structuredClone(d);
  if (assetPaths) result.assetPaths = assetPaths;
  return result;
}
