/**
 * engine/html/assemble (I13, 01_specs.md §8.2) — S24.
 *
 * Perakit HTML: artefak HTML mandiri (KT-11, §3.8) dan sumber pratinjau UI.
 * Satu berkas, fon tertanam base64 (S21 `fontFaceCss`), tanpa skrip, tanpa
 * rujukan eksternal (CSP meta + `enforceStandalone`). Bukan sumber PDF dokumen
 * (D-15: PDF dokumen = DOCX -> soffice).
 *
 * Alur:
 * 1. Blok snapshot dikelompokkan per unit (`snapshot.units`, urutan unit),
 *    di dalam unit diurutkan `ordinal`; tiap blok dirender lewat
 *    `HTML_RENDERERS` (dispatcher kontrak D01 = S22 blok/pembungkus + S23
 *    tabel/figur). Blok beralamat yang renderernya tidak memancarkan
 *    `data-address` sendiri dibungkus `<div class="st-block" data-address>` (D-38).
 * 2. Setiap unit menjadi `<section class="st-unit" data-unit data-unit-key>`;
 *    pemenggalan halaman antar unit lewat CSS paged media. Unit alir TIDAK
 *    diberi kelas `.page`: `.page` (D-38) berarti lembar tetap setinggi A4,
 *    sehingga bab multi-halaman akan terbaca luapan oleh engine/browser.
 *    Lembar tetap (bila ada) dipancarkan basis/blok S21/S22.
 * 3. Wajah fon yang dipakai dihitung dari HTML badan (`collectFaces`) ->
 *    `fontFaceCss` (S21) -> `htmlShell` (S21).
 * 4. `<meta charset>`, CSP, dan CSS struktural gabungan (S22 + perakit)
 *    disisipkan di awal `<head>`; lalu `enforceStandalone` sebagai jaring
 *    terakhir. Pelanggaran dicatat ke `ctx.log` (sink durable job S51).
 *
 * Kegagalan blok: mode pratinjau -> blok pengganti berteks polos ber-`data-address`
 * + log `warn`/`error`; mode artefak -> log `error` lalu `HtmlAssembleError`
 * (artefak rilis tidak boleh diam-diam kehilangan isi). Semua galat yang keluar
 * dari `assembleHtml` membawa kode kontrak `HTML_RENDER_FAILED` (IP-05);
 * kode penyebab (mis. `BY_CONSTRUCTION_FAILED`) ada di `details.causeCode`.
 *
 * Sadar slot (SR-17, `./slots`): snapshot `studio.norm/v2` -> blok tiap unit
 * dirender dengan nilai efektif slot unit (`ctx.slots`), unit membawa kelas dan
 * atribut slot, unit placeholder draf berisi teks pengganti, render draf membawa
 * penanda `render.draft.marker`, dan `@page` unit mengikuti ukuran kertas +
 * orientasi efektif slot (satu sumber SR-60, tanpa fallback A4). Snapshot v1 =
 * jalur lama (keluaran tidak berubah).
 *
 * Deterministik: tanpa jam/acak; keluaran hanya fungsi snapshot + templat.
 */
import type { NormBlock, NormUnit, RenderContext, StudioErrorCode } from "../../../contract";
import { HTML_RENDERERS } from "../../../contract/dispatch";
import { StudioEngineError, StudioNotImplemented } from "../../../contract/errors";
import { fontFaceCss, htmlShell } from "../base";
import { escapeHtml } from "../blocks/escape";
import { withBackCover } from "./back-cover";
import { HTML_ASSEMBLE_CLASSES as A, STUDIO_HTML_STRUCTURAL_CSS } from "./classes";
import { collectFaces } from "./faces";
import {
  draftMarker,
  draftMarkHtml,
  isDraft,
  placeholderUnitHtml,
  PROJECTION_BLOCK_TYPES,
  SLOT_BLOCK_RENDERERS,
  slotAttrs,
  slotCss,
  unitModes,
  unitViews,
  withRuleIndex,
  type DraftMarker,
  type UnitView,
} from "./slots";
import { enforceStandalone, injectHead } from "./standalone";

export { HTML_ASSEMBLE_CLASSES, HTML_ASSEMBLE_CSS, HTML_CLASSES, STUDIO_HTML_STRUCTURAL_CSS } from "./classes";
export { BASE_FACE_ROLES, DEFAULT_FACE_BY_ROLE, collectFaces, faceForRole } from "./faces";
export {
  STUDIO_HTML_CSP,
  STUDIO_HTML_CSP_META,
  enforceStandalone,
  injectHead,
  isAllowedUrl,
  type StandaloneViolation,
  type StandaloneViolationKind,
} from "./standalone";
export {
  PROJECTION_BLOCK_TYPES,
  SLOT_BLOCK_RENDERERS,
  SLOT_PARAM,
  classToken,
  draftMarker,
  isDraft,
  slotCss,
  snapshotV2,
  unitModes,
  unitViews,
  type DraftMarker,
  type DraftPlacement,
  type SlotCssResult,
  type UnitView,
} from "./slots";

const MODULE = "engine/html/assemble";

export type HtmlAssembleFailure = "RENDERER_MISSING" | "RENDERER_FAILED" | "SHELL_FAILED" | "ASSEMBLY_FAILED";

/**
 * Galat perakit HTML. Di batas modul membawa kode kontrak `HTML_RENDER_FAILED`
 * (delta S03-d1, IP-05): turunan `StudioEngineError`, sehingga `errorCodeOf`,
 * `studioErrorFrom`, dan pembaca `.code` lain memetakannya tanpa kasus khusus.
 * `reason` (lokal) membedakan penyebab; `details` hanya data polos yang aman
 * dikirim ke klien (alasan, alamat, jenis blok, kode galat penyebab), tanpa
 * stack. Galat asli tetap di `cause` untuk log server.
 */
export class HtmlAssembleError extends StudioEngineError {
  readonly reason: HtmlAssembleFailure;
  readonly address?: string;
  readonly blockType?: string;
  /** Kode `StudioEngineError` penyebab (mis. `BY_CONSTRUCTION_FAILED`), bila ada. */
  readonly causeCode?: StudioErrorCode;

  constructor(reason: HtmlAssembleFailure, message: string, info: { address?: string; blockType?: string; cause?: unknown } = {}) {
    const causeCode = info.cause instanceof StudioEngineError ? info.cause.code : undefined;
    super("HTML_RENDER_FAILED", message, {
      reason,
      ...(info.address !== undefined ? { address: info.address } : {}),
      ...(info.blockType !== undefined ? { blockType: info.blockType } : {}),
      ...(causeCode !== undefined ? { causeCode } : {}),
    });
    this.name = "HtmlAssembleError";
    this.reason = reason;
    this.address = info.address;
    this.blockType = info.blockType;
    this.causeCode = causeCode;
    if (info.cause !== undefined) Object.defineProperty(this, "cause", { value: info.cause, enumerable: false, configurable: true, writable: true });
  }
}

/** Kunci unit untuk blok yang unitnya tidak terdaftar di `snapshot.units`. */
const ORPHAN_UNIT_KEY = "__orphan__";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function blockLabel(b: NormBlock): string {
  return b.address ?? `${b.type}#${b.ordinal}`;
}

/** Pengganti blok gagal/tanpa renderer (pratinjau): teks polos ter-escape, tetap beralamat. */
function placeholderHtml(b: NormBlock): string {
  const addr = b.address ? ` data-address="${escapeHtml(b.address)}"` : "";
  const text = b.textPlain ? `<p>${escapeHtml(b.textPlain)}</p>` : "";
  return `<div class="${A.missing}" data-block-type="${escapeHtml(b.type)}"${addr}>${text}</div>`;
}

/** Pastikan blok beralamat membawa `data-address` (D-38) tanpa mengubah markup renderer yang sudah benar. */
function withAddress(html: string, b: NormBlock): string {
  if (!b.address) return html;
  const attr = `data-address="${escapeHtml(b.address)}"`;
  if (html.includes(attr)) return html;
  return `<div class="${A.block}" ${attr} data-block-type="${escapeHtml(b.type)}">${html}</div>`;
}

function renderBlock(b: NormBlock, ctx: RenderContext, preview: boolean): string {
  // Dispatch kontrak dulu; blok struktural v2 (slotPlaceholder, sourceRegisterEntry, ruleIndex) milik perakit (SR-17).
  const render = HTML_RENDERERS[b.type] ?? SLOT_BLOCK_RENDERERS[b.type];
  if (typeof render !== "function") {
    const message = `HTML renderer missing for block type "${b.type}"`;
    ctx.log({ level: preview ? "warn" : "error", message: `${MODULE}: ${message}`, address: b.address ?? undefined, ...(preview ? {} : { code: "HTML_RENDER_FAILED" }) });
    if (preview) return placeholderHtml(b);
    throw new HtmlAssembleError("RENDERER_MISSING", message, { address: b.address ?? undefined, blockType: b.type });
  }
  try {
    const html = render(b, ctx);
    // Blok proyeksi (contractItem, DC-12): alamatnya sudah ada di markup blok induk.
    if (html === "" && PROJECTION_BLOCK_TYPES.has(b.type)) return "";
    return withAddress(html, b);
  } catch (e) {
    const notImpl = e instanceof StudioNotImplemented;
    const message = `HTML renderer ${notImpl ? "not implemented" : "failed"} for ${blockLabel(b)} (${b.type}): ${errMessage(e)}`;
    ctx.log({ level: preview && notImpl ? "warn" : "error", message: `${MODULE}: ${message}`, address: b.address ?? undefined, ...(preview ? {} : { code: "HTML_RENDER_FAILED" }) });
    if (preview) return placeholderHtml(b);
    throw new HtmlAssembleError(notImpl ? "RENDERER_MISSING" : "RENDERER_FAILED", message, {
      address: b.address ?? undefined,
      blockType: b.type,
      cause: e,
    });
  }
}

function unitAttrs(v: UnitView, draft: boolean): string {
  const u: NormUnit = v.unit;
  const { header: head, footer: foot } = unitModes(v);
  const slot = slotAttrs(v, draft);
  return [
    ` class="${A.unit} ${A.unit}-${escapeHtml(u.kind)}${slot.classes}"`,
    ` data-unit="${escapeHtml(u.kind)}"`,
    ` data-unit-key="${escapeHtml(u.key)}"`,
    head ? ` data-header="${escapeHtml(head)}"` : "",
    foot ? ` data-footer="${escapeHtml(foot)}"` : "",
    slot.attrs,
  ].join("");
}

/** Badan HTML: semua unit berurutan, blok per unit berurutan `ordinal`. */
export function assembleBody(ctx: RenderContext, opts: { preview: boolean; views?: readonly UnitView[]; draft?: DraftMarker }): string {
  const { blocks } = ctx.snapshot;
  const views = opts.views ?? unitViews(ctx);
  const units = views.map((v) => v.unit);
  const unitKeys = new Set(units.map((u) => u.key));
  const byUnit = new Map<string, NormBlock[]>();
  for (const b of blocks) {
    const key = unitKeys.has(b.unitKey) ? b.unitKey : ORPHAN_UNIT_KEY;
    const list = byUnit.get(key);
    if (list) list.push(b);
    else byUnit.set(key, [b]);
  }
  // Urutan stabil: ordinal, lalu blockId (pemutus seri deterministik).
  for (const list of byUnit.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
  }

  const parts: string[] = [];
  const mark = opts.draft ? draftMarkHtml(opts.draft) : "";
  for (const v of views) {
    const u = v.unit;
    const list = byUnit.get(u.key) ?? [];
    let inner: string;
    if (v.placeholder && list.length === 0) {
      inner = placeholderUnitHtml(v);
    } else {
      if (v.placeholder && list.some((b) => b.type !== "slotPlaceholder")) {
        ctx.log({ level: "warn", message: `${MODULE}: placeholder unit "${u.key}" (slot ${v.slotKey}) carries content block(s); rendering blocks` });
      } else if (list.length === 0) ctx.log({ level: "warn", message: `${MODULE}: unit "${u.key}" (${u.kind}) has no blocks` });
      // Nilai efektif per unit: konteks slot unit (SR-17); jalur v1 = ctx dokumen.
      inner = list.map((b) => renderBlock(b, v.ctx, opts.preview)).join("");
    }
    parts.push(`<section${unitAttrs(v, opts.draft !== undefined)}>${mark}${inner}</section>`);
  }
  const orphans = byUnit.get(ORPHAN_UNIT_KEY);
  if (orphans && orphans.length > 0) {
    const keys = Array.from(new Set(orphans.map((b) => b.unitKey))).sort();
    ctx.log({
      level: "warn",
      message: `${MODULE}: ${orphans.length} block(s) reference unknown unit(s) ${keys.join(", ")}; rendered at document end`,
    });
    parts.push(
      `<section class="${A.unit} ${A.orphan}" data-unit="orphan">${orphans.map((b) => renderBlock(b, ctx, opts.preview)).join("")}</section>`,
    );
  }
  return parts.join("\n");
}

/**
 * Rakit dokumen HTML lengkap. `preview: true` = sumber pratinjau UI (label
 * pratinjau, blok gagal diganti pengganti); `false` = artefak HTML rilis.
 */
export async function assembleHtml(ctx: RenderContext, opts: { preview: boolean }): Promise<string> {
  try {
    return assembleDocument(ctx, opts?.preview === true);
  } catch (e) {
    if (e instanceof HtmlAssembleError) throw e;
    // Batas modul (IP-05): galat tak terduga di luar renderer/shell tetap
    // keluar sebagai HTML_RENDER_FAILED, bukan galat lokal tanpa kode.
    const message = `HTML assembly failed: ${errMessage(e)}`;
    ctx.log({ level: "error", message: `${MODULE}: ${message}`, code: "HTML_RENDER_FAILED" });
    throw new HtmlAssembleError("ASSEMBLY_FAILED", message, { cause: e });
  }
}

function assembleDocument(docCtx: RenderContext, preview: boolean): string {
  // C17 / ST-01: indeks aturan dari penanda (opt-in R-77); tanpa flag = konteks apa adanya.
  // C22 / CV-19: unit sampul belakang terakhir (opt-in "sampul belakang"); tanpa opt-in = konteks apa adanya.
  const ctx = withBackCover(withRuleIndex(docCtx));
  const views = unitViews(ctx);
  const draft = isDraft(ctx) ? draftMarker(ctx.tpl) : undefined;
  const bodyHtml = assembleBody(ctx, { preview, views, draft });
  const faces = collectFaces(bodyHtml, ctx.tpl);
  for (const v of views) {
    // Wajah fon yang hanya dipakai slot dengan `type.face.*` berbeda ikut ditanam.
    if (v.ctx !== ctx) for (const f of collectFaces(bodyHtml, v.ctx.tpl)) faces.add(f);
  }

  let shell: string;
  try {
    const fontsCss = fontFaceCss(ctx.tpl, faces);
    shell = htmlShell({ tpl: ctx.tpl, meta: ctx.snapshot.doc.meta, bodyHtml, fontsCss, previewLabel: preview });
  } catch (e) {
    const message = `HTML shell failed: ${errMessage(e)}`;
    ctx.log({ level: "error", message: `${MODULE}: ${message}`, code: "HTML_RENDER_FAILED" });
    throw new HtmlAssembleError("SHELL_FAILED", message, { cause: e });
  }

  const slots = slotCss(ctx, views, bodyHtml, draft);
  if (slots.unmatched.length > 0) {
    ctx.log({ level: "warn", message: `${MODULE}: ${slots.unmatched.length} slot unit(s) not found by shell scan; per-slot @page not applied: ${slots.unmatched.join(", ")}` });
  }
  for (const o of slots.pageOverrides) {
    ctx.log({ level: "info", message: `${MODULE}: unit "${o.unitKey}" page ${o.page} size ${o.size} (slot effective paper size/orientation)` });
  }
  const extraHead = [
    `<style data-studio="structural">${STUDIO_HTML_STRUCTURAL_CSS}</style>`,
    draft ? `<meta name="studio:draft" content="true">` : "",
    slots.css ? `<style data-studio="slots">${slots.css}</style>` : "",
  ].join("");
  const withHead = injectHead(shell, extraHead);
  const { html, violations } = enforceStandalone(withHead);
  if (violations.length > 0) {
    const counts = new Map<string, number>();
    for (const v of violations) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    const summary = Array.from(counts.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    ctx.log({
      level: "error",
      message: `${MODULE}: standalone guard neutralised ${violations.length} construct(s) (${summary}); first: ${violations[0].detail}`,
    });
  }
  return html.startsWith("<!DOCTYPE") || /^<!doctype/i.test(html) ? html : `<!DOCTYPE html>\n${html}`;
}
