/**
 * Perakit HTML sadar slot (SR-17; blueprint 05 §2.9 "engine/html/assemble:
 * padanan HTML", register 03 §4.6, §13.4, §15.1; D-158/D-166 KC-7, D-170).
 *
 * Padanan semantik perakit DOCX SR-16:
 * - Unit per slot: snapshot `studio.norm/v2` membawa `slotKey`/`sectionType`
 *   per unit (urutan unit = urutan dokumen, hasil compose). Perakit tidak
 *   merencanakan ulang unit; ia hanya membaca rencana compose.
 * - Nilai efektif per unit: `ctx.slots.get(unit.slotKey)` (I44
 *   `resolveSlotParams`) ditumpuk di atas `ctx.tpl` (params dan roleFormats),
 *   lalu blok unit dirender dengan `RenderContext` unit itu. Absen = nilai
 *   dokumen. Snapshot v1 (tanpa `slotKey`) = jalur lama, keluaran tidak berubah.
 * - Placeholder draf: unit `placeholder: true` (slot wajib kosong pada render
 *   draf) dirender sebagai teks `ResolvedSlot.placeholderText` (`{label}` sudah
 *   diganti); cadangan `slot.placeholderText` (R-43) dengan label kerangka.
 * - Penanda draf: `render.draft.marker` (R-39, cakupan dokumen) bila
 *   `ctx.draft` (bawaan `scope.kind !== "DOCUMENT"`). Cetak: kotak sudut
 *   `@page` (atas/bawah kanan sesuai `placement`, kotak tepi dipakai running
 *   head/register shell); layar: label per unit.
 * - Ukuran halaman per slot: `pageSizeMm` (satu sumber SR-60, tanpa fallback
 *   A4) dari parameter efektif unit, sehingga `page.orientation` slot
 *   (mis. lampiran landscape) menghasilkan `@page st-u-<i>{size:297mm 210mm}`.
 * - `slot.setup` (R-41 + D-170): `startOnNewPage: false` = unit menyambung di
 *   halaman unit sebelumnya; `runningHead` true/false menimpa mode kepala unit;
 *   `header.mode`/`footer.mode` dan `marginTw` lengkap ikut diterapkan.
 *
 * Modul murni dan deterministik (tanpa jam/acak).
 */
import type {
  AnyNormSnapshot,
  Inline,
  NormBlock,
  NormDocSnapshotV2,
  NormUnit,
  NormUnitV2,
  ParamMap,
  ParamValue,
  RenderContext,
  ResolvedSlot,
  ResolvedTemplate,
  SlotSetup,
} from "../../../contract";
import { isNormSnapshotV2 } from "../../../contract";
import { fontStack, scanUnits, tokenVars } from "../base";
import { cssString } from "../base/fonts";
import { mm, pageGeometry, record, twToMm, type PageGeometry } from "../base/params";
import { escapeHtml } from "../blocks/escape";
import { inlineHtml } from "../blocks/inline";
import { emptyOptionalUnitOmitted, expandRuleIndexMarker, isRuleIndexAutoMarker, PARAM_RULE_INDEX_FROM_MARKERS } from "../../front/rule-index";
import { HTML_ASSEMBLE_CLASSES as A } from "./classes";

/** Kunci parameter yang dibaca modul ini. */
export const SLOT_PARAM = {
  setup: "slot.setup",
  placeholderText: "slot.placeholderText",
  draftMarker: "render.draft.marker",
} as const;

/** Bawaan register R-39 / R-43 (dipakai hanya bila parameter absen atau salah tipe). */
const DRAFT_MARKER_DEFAULT = { text: "DRAF", placement: "header" as const };
const PLACEHOLDER_DEFAULT = "[{label} belum diisi]";

export type DraftPlacement = "header" | "footer";
export interface DraftMarker {
  text: string;
  placement: DraftPlacement;
}

/** Pandangan satu unit untuk perakit: konteks efektif + atribut slot. */
export interface UnitView {
  unit: NormUnit;
  slotKey?: string;
  sectionType?: string;
  /** Label slot kerangka (untuk placeholder). */
  label?: string;
  placeholder: boolean;
  placeholderText?: string;
  /** Konteks render unit (tpl efektif slot); sama dengan ctx dokumen bila tanpa slot. */
  ctx: RenderContext;
  setup?: SlotSetup;
}

/** Snapshot v2 bila `ctx.snapshot` berbentuk `studio.norm/v2` (cast satu tempat; kontrak mengetik v1). */
export function snapshotV2(ctx: RenderContext): NormDocSnapshotV2 | undefined {
  const s = ctx.snapshot as unknown as AnyNormSnapshot;
  return s && isNormSnapshotV2(s) ? s : undefined;
}

/** Render draf: `ctx.draft`, bawaan `scope.kind !== "DOCUMENT"` (kontrak engine.ts). */
export function isDraft(ctx: RenderContext): boolean {
  if (typeof ctx.draft === "boolean") return ctx.draft;
  return ctx.scope !== undefined && ctx.scope.kind !== "DOCUMENT";
}

/** `render.draft.marker` (R-39) dari parameter dokumen. */
export function draftMarker(tpl: ResolvedTemplate): DraftMarker {
  const m = record(tpl.params[SLOT_PARAM.draftMarker]);
  const text = typeof m?.text === "string" && m.text.trim() !== "" ? m.text : DRAFT_MARKER_DEFAULT.text;
  const placement: DraftPlacement = m?.placement === "footer" ? "footer" : m?.placement === "header" ? "header" : DRAFT_MARKER_DEFAULT.placement;
  return { text, placement };
}

/** Token kelas CSS aman dari kunci slot/jenis section (C18 sudah aman; jaga-jaga untuk masukan lain). */
export function classToken(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-");
}

function slotTemplate(base: ResolvedTemplate, slot: ResolvedSlot): ResolvedTemplate {
  // `ResolvedSlot.params` = nilai efektif slot (I44). Ditumpuk di atas params
  // dokumen agar peta parsial (hanya kunci slot) tetap lengkap.
  const params: Record<string, ParamValue> = { ...base.params, ...slot.params };
  const roleFormats = { ...base.roleFormats, ...(slot.roleFormats ?? {}) };
  return { ...base, params, roleFormats };
}

function slotSetupOf(p: ParamMap): SlotSetup | undefined {
  const s = record(p[SLOT_PARAM.setup]);
  return s && Object.keys(s).length > 0 ? (s as unknown as SlotSetup) : undefined;
}

function fallbackPlaceholder(tpl: ResolvedTemplate, label: string): string {
  const raw = tpl.params[SLOT_PARAM.placeholderText];
  const pattern = typeof raw === "string" && raw.trim() !== "" ? raw : PLACEHOLDER_DEFAULT;
  return pattern.split("{label}").join(label);
}

/**
 * Pandangan unit berurutan. Jalur v1 (snapshot v1 atau unit tanpa `slotKey`):
 * konteks dokumen apa adanya. Konteks slot dibuat sekali per `slotKey`.
 */
export function unitViews(ctx: RenderContext): UnitView[] {
  const v2 = snapshotV2(ctx);
  if (!v2) return ctx.snapshot.units.map((unit) => ({ unit, placeholder: false, ctx }));
  const labels = new Map<string, string>();
  for (const s of v2.skeleton?.slots ?? []) labels.set(s.slotKey, s.label);
  const perSlot = new Map<string, { ctx: RenderContext; resolved?: ResolvedSlot }>();
  return (v2.units as NormUnitV2[]).map((u) => {
    const slotKey = typeof u.slotKey === "string" && u.slotKey !== "" ? u.slotKey : undefined;
    if (!slotKey) return { unit: u, placeholder: false, ctx };
    let entry = perSlot.get(slotKey);
    if (!entry) {
      const resolved = ctx.slots?.get(slotKey);
      entry = resolved ? { ctx: { ...ctx, tpl: slotTemplate(ctx.tpl, resolved) }, resolved } : { ctx };
      perSlot.set(slotKey, entry);
    }
    const label = entry.resolved?.label ?? labels.get(slotKey) ?? slotKey;
    const placeholder = u.placeholder === true;
    return {
      unit: u,
      slotKey,
      sectionType: entry.resolved?.sectionType ?? u.sectionType,
      label,
      placeholder,
      placeholderText: placeholder ? entry.resolved?.placeholderText ?? fallbackPlaceholder(entry.ctx.tpl, label) : undefined,
      ctx: entry.ctx,
      setup: slotSetupOf(entry.ctx.tpl.params),
    };
  });
}

/** Mode kepala/kaki efektif unit: `slot.setup.runningHead` (D-170) > `slot.setup.header|footer.mode` > unit. */
export function unitModes(v: UnitView): { header?: string; footer?: string } {
  const s = v.setup;
  let header: string | undefined = v.unit.setup?.header?.mode;
  let footer: string | undefined = v.unit.setup?.footer?.mode;
  if (s?.header?.mode) header = s.header.mode;
  if (s?.footer?.mode) footer = s.footer.mode;
  if (s?.runningHead === true) header = "runningHead";
  else if (s?.runningHead === false) header = "none";
  return { header, footer };
}

/** Atribut slot untuk tag pembuka unit (v2 saja; "" untuk jalur v1). */
export function slotAttrs(v: UnitView, draft: boolean): { classes: string; attrs: string } {
  if (!v.slotKey) return { classes: "", attrs: "" };
  const classes = [A.slot, `${A.slot}-${classToken(v.slotKey)}`];
  if (v.sectionType) classes.push(`${A.sectionType}-${classToken(v.sectionType)}`);
  if (v.placeholder) classes.push(A.placeholderUnit);
  if (v.setup?.startOnNewPage === false) classes.push(A.flow);
  const g = pageGeometry(v.ctx.tpl);
  const attrs = [
    ` data-slot-key="${escapeHtml(v.slotKey)}"`,
    v.sectionType ? ` data-section-type="${escapeHtml(v.sectionType)}"` : "",
    v.placeholder ? ` data-placeholder="true"` : "",
    draft ? ` data-draft="true"` : "",
    ` data-page-mm="${escapeHtml(`${r2(g.pageW)} ${r2(g.pageH)}`)}"`,
  ].join("");
  return { classes: ` ${classes.join(" ")}`, attrs };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Isi unit placeholder (draf): teks pengganti ter-escape. */
export function placeholderUnitHtml(v: UnitView): string {
  return `<div class="${A.placeholder}" role="note" data-slot-key="${escapeHtml(v.slotKey ?? "")}"><p>${escapeHtml(v.placeholderText ?? "")}</p></div>`;
}

function contentRecord(b: NormBlock): Record<string, unknown> {
  return b.content && typeof b.content === "object" && !Array.isArray(b.content) ? (b.content as Record<string, unknown>) : {};
}

function addrAttr(b: NormBlock): string {
  return b.address ? ` data-address="${escapeHtml(b.address)}"` : "";
}

/**
 * Renderer blok struktural v2 milik perakit (compose SR-08 memancarkannya; tidak
 * ada di dispatch kontrak `HTML_RENDERERS`, blueprint §2.9 "renderer lain tidak
 * berubah"): `slotPlaceholder` (unit placeholder draf), `sourceRegisterEntry`
 * (satu entri register sumber per alamat `F:<slotKey>/<n>`), `ruleIndex`
 * (penanda unit indeks aturan otomatis), `contractItem` (DC-12: proyeksi butir,
 * dirender sebagai baris tabel butir blok `contractRecord`). URL entri ditulis
 * sebagai teks, bukan tautan (artefak mandiri KT-11).
 */
export const SLOT_BLOCK_RENDERERS: Readonly<Record<string, (b: NormBlock, ctx: RenderContext) => string>> = {
  slotPlaceholder: (b) => {
    const text = contentRecord(b).text;
    return `<div class="${A.placeholder}" role="note" data-block-type="slotPlaceholder"><p>${escapeHtml(typeof text === "string" ? text : "")}</p></div>`;
  },
  sourceRegisterEntry: (b) => {
    const c = contentRecord(b);
    const n = b.address ? /\/(\d+)$/.exec(b.address)?.[1] : undefined;
    const parts = [inlineHtml(c.citation as Partial<Inline> | undefined)];
    for (const k of ["kind", "url", "accessed"] as const) if (typeof c[k] === "string" && c[k] !== "") parts.push(escapeHtml(c[k] as string));
    const id = typeof c.id === "string" ? ` data-entry-id="${escapeHtml(c.id)}"` : "";
    return `<p class="${A.sourceEntry}" data-block-type="sourceRegisterEntry"${addrAttr(b)}${id}>${n ? `<span class="${A.sourceEntry}-n">[${n}]</span> ` : ""}${parts.filter(Boolean).join(" · ")}</p>`;
  },
  ruleIndex: (b, ctx) => {
    ctx.log({ level: "warn", message: `engine/html/assemble: ruleIndex (${b.address ?? b.blockId}) rendered as marker only; automatic rule index not built in HTML` });
    return `<div class="${A.ruleIndex}" data-block-type="ruleIndex"${addrAttr(b)}></div>`;
  },
  // DC-12 (register 05 §5.7): butir `F:<slotKey>/<n>` = proyeksi alamat/pid. Baris ke-n
  // tabel butir blok `contractRecord` sudah membawa alamat + pid, jadi tidak ada markup di sini.
  contractItem: () => "",
};

/**
 * C17 / ST-01 (research/37 R5/R7, D-631; opt-in `render.ruleIndex.fromMarkers`, R-77): konteks dengan
 * penanda `ruleIndex` AUTO diganti judul + tabel indeks dari pembangun bersama DOCX (`front/rule-index`),
 * sehingga dispatch tabel kontrak merendernya. 0 entri pada slot opsional = unit dan bloknya tidak
 * dipancarkan (padanan D-299 DOCX `units.ts` (c2)); baris kosong hanya bila unit dipaksa (slot wajib,
 * render lingkup slot itu, unit berisi blok lain). Flag absen/false atau tanpa penanda = `ctx` apa adanya.
 */
export function withRuleIndex(ctx: RenderContext): RenderContext {
  const v2 = snapshotV2(ctx);
  if (!v2 || !v2.blocks.some(isRuleIndexAutoMarker)) return ctx;
  const slotByKey = new Map((v2.skeleton?.slots ?? []).map((s) => [s.slotKey, s] as const));
  let blocks: NormBlock[] = [...v2.blocks];
  let units: NormUnitV2[] = [...v2.units];
  let changed = false;
  for (const marker of v2.blocks.filter(isRuleIndexAutoMarker)) {
    const unit = units.find((u) => u.key === marker.unitKey);
    const slot = unit ? slotByKey.get(unit.slotKey) : undefined;
    if (!unit || !slot || unit.placeholder) continue;
    const flag = ctx.slots?.get(slot.slotKey)?.params[PARAM_RULE_INDEX_FROM_MARKERS];
    if ((flag !== undefined ? flag : ctx.tpl.params[PARAM_RULE_INDEX_FROM_MARKERS]) !== true) continue;
    const scoped = ctx.scope?.kind === "SLOT" && ctx.scope.key === slot.slotKey;
    const omitted = emptyOptionalUnitOmitted(slot, blocks.filter((b) => b.unitKey === unit.key), { scoped });
    const x = expandRuleIndexMarker(marker, v2, { forced: !omitted });
    for (const e of x.log) ctx.log(e);
    changed = true;
    if (x.blocks) {
      const at = blocks.indexOf(marker);
      blocks = [...blocks.slice(0, at), ...x.blocks, ...blocks.slice(at + 1)];
      continue;
    }
    blocks = blocks.filter((b) => b.unitKey !== unit.key);
    units = units.filter((u) => u !== unit);
    ctx.log({
      level: "info",
      code: "OPTIONAL_SLOT_EMPTY_OMITTED",
      address: `F:${slot.slotKey}`,
      message: `Slot opsional ${slot.slotKey} (${slot.sectionType}) tanpa isi tidak dirender sebagai seksi (D-299)`,
    });
  }
  if (!changed) return ctx;
  const snapshot = { ...v2, units, blocks: blocks as NormDocSnapshotV2["blocks"] };
  return { ...ctx, snapshot: snapshot as unknown as RenderContext["snapshot"] };
}

/** Blok proyeksi: dirender oleh blok induknya; keluaran kosong tidak dibungkus `data-address`. */
export const PROJECTION_BLOCK_TYPES: ReadonlySet<string> = new Set(["contractItem"]);

/** Label draf per unit (layar). */
export function draftMarkHtml(m: DraftMarker): string {
  return `<div class="${A.draftMark} ${A.draftMark}-${m.placement}" role="note">${escapeHtml(m.text)}</div>`;
}

/** Margin unit dari `slot.setup.marginTw` lengkap (twip -> mm), selain itu geometri parameter. */
function unitGeometry(v: UnitView): PageGeometry {
  const g = pageGeometry(v.ctx.tpl);
  const m = record(v.setup?.marginTw as unknown as ParamValue);
  if (!m) return g;
  const keys = ["top", "bottom", "left", "right"] as const;
  if (!keys.every((k) => typeof m[k] === "number" && Number.isFinite(m[k] as number))) return g;
  return { ...g, top: twToMm(m.top as number), bottom: twToMm(m.bottom as number), inner: twToMm(m.left as number), outer: twToMm(m.right as number) };
}

function sameBox(a: PageGeometry, b: PageGeometry): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  return eq(a.pageW, b.pageW) && eq(a.pageH, b.pageH) && eq(a.top, b.top) && eq(a.bottom, b.bottom) && eq(a.inner, b.inner) && eq(a.outer, b.outer);
}

export interface SlotCssResult {
  css: string;
  /** Unit yang `@page`-nya berbeda dari halaman dokumen: kunci unit -> "W H" mm. */
  pageOverrides: Array<{ unitKey: string; page: string; size: string }>;
  /** Kunci unit yang tidak ditemukan pada pindaian shell (nama halaman tidak dapat dipasang). */
  unmatched: string[];
}

/**
 * CSS sadar slot, disisipkan di `<head>` setelah shell:
 * 1. properti khusus per slot yang berbeda dari dokumen (`tokenVars` unit vs
 *    dokumen) pada `.st-unit[data-slot-key]`;
 * 2. `size`/`margin` halaman bernama shell `st-u-<i>` bila geometri unit beda
 *    (ukuran kertas + orientasi per slot, `slot.setup.marginTw`);
 * 3. unit `startOnNewPage: false` memakai halaman unit sebelumnya tanpa pemenggalan;
 * 4. penanda draf cetak di kotak sudut `@page`.
 * Nama halaman `st-u-<i>` = urutan `scanUnits` (S21 `pageFurnitureCss`).
 */
export function slotCss(ctx: RenderContext, views: readonly UnitView[], bodyHtml: string, draft: DraftMarker | undefined): SlotCssResult {
  const out: string[] = [];
  const pageOverrides: SlotCssResult["pageOverrides"] = [];
  const unmatched: string[] = [];
  const hasSlots = views.some((v) => v.slotKey !== undefined);

  if (hasSlots) {
    const docVars = new Map(tokenVars(ctx.tpl));
    const done = new Set<string>();
    for (const v of views) {
      if (!v.slotKey || done.has(v.slotKey) || v.ctx === ctx) continue;
      done.add(v.slotKey);
      const decl = tokenVars(v.ctx.tpl)
        .filter(([n, val]) => docVars.get(n) !== val)
        .map(([n, val]) => `${n}:${val}`)
        .join(";");
      if (decl) out.push(`.${A.unit}[data-slot-key=${cssString(v.slotKey)}]{${decl}}`);
    }

    const docG = pageGeometry(ctx.tpl);
    const scanned = scanUnits(ctx.tpl, bodyHtml);
    const indexByKey = new Map<string, number>();
    for (const s of scanned) if (s.key !== undefined) indexByKey.set(s.key, s.index);
    let prevPage: string | undefined;
    for (const v of views) {
      const idx = indexByKey.get(v.unit.key);
      if (idx === undefined) {
        if (v.slotKey) unmatched.push(v.unit.key);
        continue;
      }
      const own = `st-u-${idx}`;
      if (v.slotKey && v.setup?.startOnNewPage === false && prevPage) {
        // Menyambung: halaman bernama sama dengan unit sebelumnya (beda nama = pemenggalan paksa).
        out.push(`section.${A.unit}.${A.flow}[data-unit-key=${cssString(v.unit.key)}]{page:${prevPage}}`);
        continue;
      }
      prevPage = own;
      if (!v.slotKey) continue;
      const g = unitGeometry(v);
      if (sameBox(g, docG)) continue;
      const size = `${mm(g.pageW)} ${mm(g.pageH)}`;
      out.push(`@page ${own}{size:${size};margin:${mm(g.top)} ${mm(g.outer)} ${mm(g.bottom)} ${mm(g.inner)}}`);
      pageOverrides.push({ unitKey: v.unit.key, page: own, size });
    }
    out.push(`section.${A.unit}.${A.flow}{break-before:auto;page-break-before:auto}`);
  }

  if (draft) {
    const box = draft.placement === "footer" ? "bottom-right-corner" : "top-right-corner";
    out.push(
      `@page{@${box}{content:${cssString(draft.text)};font-family:${fontStack(ctx.tpl, "condensed")};font-size:7pt;font-weight:600;letter-spacing:.16em;color:#B45309;text-align:center;vertical-align:middle}}`,
    );
  }
  return { css: out.join("\n"), pageOverrides, unmatched };
}
