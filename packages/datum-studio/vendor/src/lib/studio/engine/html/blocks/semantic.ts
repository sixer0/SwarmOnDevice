/**
 * Paritas HTML aturan dokumen konten-saja RT-01 (D-119, D-138; RQ-5).
 *
 * Aturan run semantik SATU sumber dengan DOCX (`engine/docx/blocks/semantic`,
 * modul murni tanpa ketergantungan DOCX): `render.run.strong` (R-36),
 * `glyphRun[tanda]` peran yang DITULIS templat, `render.run.symbolGlyphByRole`
 * (R-37). Di HTML gaya dasar peran diwarisi lewat CSS elemen, sehingga run
 * hasil aturan hanya membawa properti tambahannya sendiri.
 *
 * Spacer otomatis (`render.spacer.autoMode` = `template`): padanan
 * `autoSpacerRole` perakit DOCX. Perakit HTML (SR-17) tidak diubah; renderer
 * dibungkus di peta dispatcher (`withAutoSpacer`) sehingga paragraf spacer
 * peran `spacer.afterBlock`/`spacer.afterList` ditulis sesudah blok yang
 * memenuhi syarat. Semua aturan opt-in: profil tanpa parameter/peran eksplisit
 * dirender sama seperti sebelumnya.
 */
import type { HtmlBlockRenderer, NormBlock, ParamMap, RenderContext, RoleKey, Run, RunProps } from "../../../contract";
import { FIGURE_BLOCK_TYPES, TABLE_BLOCK_TYPES } from "../../../contract/enums";
import { applySemanticRuns, hasPlainText, symbolGlyphProps } from "../../docx/blocks/semantic";
import { HTML_BLOCK_CLASSES as C } from "./classes";
import { el } from "./common";
import type { HtmlRun, RunTransform } from "./inline";
import { mergeRun, roleFormat } from "./style";

export { GLYPH_MARK, hasPlainText, strongProps, symbolGlyphProps } from "../../docx/blocks/semantic";

/**
 * Terapkan aturan run semantik templat ke `runs` (run inang peran `role`).
 * `base` = run dasar efektif elemen (run peran + runDefaults); hanya dipakai
 * untuk memeriksa tebal dasar (`strong` tidak berlaku di atas dasar tebal).
 */
export function semanticRuns<T extends Run>(ctx: RenderContext, runs: readonly T[], base: RunProps | undefined, role?: RoleKey): T[] {
  const params = ctx.tpl?.params;
  if (!params) return [...runs];
  const glyph = role ? ctx.tpl.roleFormats?.[role]?.glyphRun : undefined;
  return applySemanticRuns(runs, base ?? {}, params, role, glyph) as T[];
}

/** Run dasar efektif elemen berperan: run peran (atau sub-run) <- runDefaults blok. */
export function baseRun(ctx: RenderContext, role: RoleKey | undefined, run?: RunProps, roleRun: "run" | "labelRun" | "numberRun" | "markerRun" = "run"): RunProps {
  return mergeRun(role ? roleFormat(ctx, role)[roleRun] : undefined, run);
}

/**
 * Transformasi run semantik untuk `inlineHtml`. `role` = peran inang run
 * (glif/simbol); tanpa `role` hanya `render.run.strong` (padanan DOCX
 * `env.inline` tanpa peran).
 */
export function semanticTransform(ctx: RenderContext, role: RoleKey | undefined, base: RunProps | undefined): RunTransform {
  return (runs: readonly HtmlRun[]) => semanticRuns(ctx, runs, base, role);
}

/**
 * Glif simbol sebaris sel/apparatus tabel-figur (padanan `assemble/bind.ts`
 * DOCX): run `faceRole: "symbolGlyph"` di paragraf yang juga memuat teks lain
 * mendapat `render.run.symbolGlyphByRole[role]`; properti run sendiri menang.
 */
export function symbolBoundRuns<T extends Run>(runs: readonly T[], params: ParamMap | undefined, role: RoleKey | undefined): T[] {
  if (!params || !role) return [...runs];
  const symbol = hasPlainText(runs) ? symbolGlyphProps(params, role) : undefined;
  if (!symbol) return [...runs];
  return runs.map((r) => ("t" in r && !r.face && r.faceRole === "symbolGlyph" ? ({ ...symbol, ...r } as T) : r));
}

// ── Spacer otomatis ──────────────────────────────────────────────────────

/** R-18: `template` = spacer sesudah blok diambil dari peran templat. */
export const PARAM_SPACER_AUTO_MODE = "render.spacer.autoMode";

export type AutoSpacerRole = "spacer.afterBlock" | "spacer.afterList";

const AFTER_BLOCK_TYPES: ReadonlySet<string> = new Set<string>([
  ...TABLE_BLOCK_TYPES,
  ...FIGURE_BLOCK_TYPES,
  "aside",
  "derivation",
  "monoBlock",
]);

/** Blok sesudahnya di unit yang sama (urutan perakit: ordinal, lalu blockId); null = terakhir. */
const NEXT_CACHE = new WeakMap<readonly NormBlock[], Map<string, NormBlock | null>>();

function nextMap(blocks: readonly NormBlock[]): Map<string, NormBlock | null> {
  const hit = NEXT_CACHE.get(blocks);
  if (hit) return hit;
  const byUnit = new Map<string, NormBlock[]>();
  for (const b of blocks) {
    const list = byUnit.get(b.unitKey);
    if (list) list.push(b);
    else byUnit.set(b.unitKey, [b]);
  }
  const out = new Map<string, NormBlock | null>();
  for (const list of byUnit.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
    list.forEach((b, i) => out.set(b.blockId, list[i + 1] ?? null));
  }
  NEXT_CACHE.set(blocks, out);
  return out;
}

/** Paragraf ber-rel yang DOCX tulis sebagai tabel 1x3 (moda A, perender `table3col`). */
function railRendersAsTable(params: ParamMap): boolean {
  if (params["render.rail.renderer"] !== "table3col") return false;
  if (params["layout.railMode"] === "B") return false;
  const cols = params["render.rail.colsTw"];
  return !Array.isArray(cols) || cols.length === 0 || cols.length >= 3;
}

function hasRail(content: unknown): boolean {
  const r = content && typeof content === "object" ? (content as { rail?: unknown }).rail : undefined;
  return Array.isArray(r) && r.length > 0;
}

/**
 * Peran spacer otomatis sesudah `block` (padanan `autoSpacerRole` DOCX):
 * hanya bila `render.spacer.autoMode` = `template`, templat MENULIS `para`
 * peran itu, blok adalah blok snapshot di unit bab/lampiran, dan blok
 * berikutnya bukan spacer eksplisit.
 */
export function autoSpacerRole(ctx: RenderContext, block: NormBlock): AutoSpacerRole | undefined {
  const params = ctx.tpl?.params;
  const snap = ctx.snapshot;
  if (!params || !snap || params[PARAM_SPACER_AUTO_MODE] !== "template") return undefined;
  const unit = snap.units.find((u) => u.key === block.unitKey);
  if (!unit || (unit.kind !== "chapter" && unit.kind !== "appendix")) return undefined;
  const nexts = nextMap(snap.blocks);
  // Blok sintetis (anak pembungkus) bukan anggota snapshot: tanpa spacer.
  if (!nexts.has(block.blockId)) return undefined;
  if (nexts.get(block.blockId)?.type === "spacer") return undefined;
  let role: AutoSpacerRole | undefined;
  if (block.type === "list") role = "spacer.afterList";
  else if (AFTER_BLOCK_TYPES.has(block.type)) role = "spacer.afterBlock";
  else if (block.type === "assumptionInline" && railRendersAsTable(params)) role = "spacer.afterBlock";
  else if (block.type === "paragraph" && hasRail(block.content) && railRendersAsTable(params)) role = "spacer.afterBlock";
  if (!role || !ctx.tpl.roleFormats?.[role]?.para) return undefined;
  return role;
}

/** Paragraf spacer peran (bentuk sama dengan blok `spacer` eksplisit). */
export function spacerHtml(ctx: RenderContext, role: AutoSpacerRole): string {
  return el(ctx, "p", { classes: [C.spacer], role, attrs: [["aria-hidden", "true"], ["data-spacer", "auto"]] }, "&nbsp;");
}

/** Bungkus renderer: tambahkan spacer otomatis peran sesudah keluaran blok. */
export function withAutoSpacer(render: HtmlBlockRenderer): HtmlBlockRenderer {
  return (block, ctx) => {
    const html = render(block, ctx);
    if (!html) return html;
    const role = autoSpacerRole(ctx, block);
    return role ? html + spacerHtml(ctx, role) : html;
  };
}

/** Bungkus semua renderer peta (dipakai indeks blocks dan tables). */
export function withAutoSpacers<K extends string>(map: Partial<Record<K, HtmlBlockRenderer>>): Partial<Record<K, HtmlBlockRenderer>> {
  const out: Partial<Record<K, HtmlBlockRenderer>> = {};
  for (const k of Object.keys(map) as K[]) {
    const r = map[k];
    if (r) out[k] = withAutoSpacer(r);
  }
  return out;
}
