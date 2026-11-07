/**
 * Pembantu bersama renderer HTML blok (S22): pembangun elemen ber-escape,
 * pembaca parameter templat, dan validasi `NormBlock.content` (unknown).
 */
import type { NormBlock, ParaFormat, ParamValue, RenderContext, RoleKey, RunProps } from "../../../contract";
import { attr } from "./escape";
import { classStyle, mergePara, mergeRun, paraDecl, roleFormat, runStyle } from "./style";

export interface ElOptions {
  classes?: ReadonlyArray<string | undefined | false>;
  /** Kunci roleFormats templat (§5.6); `para`/`run`-nya menjadi dasar. */
  role?: RoleKey;
  /** Format eksplisit (menimpa format peran). */
  format?: ParaFormat;
  /** RunProps eksplisit dasar (menimpa run peran), mis. `runDefaults` blok. */
  run?: RunProps;
  /** Pilih sub-run peran selain `run` (mis. `labelRun`). */
  roleRun?: "run" | "labelRun" | "numberRun" | "markerRun";
  address?: string | null;
  blockId?: string;
  attrs?: ReadonlyArray<readonly [string, string | number | undefined | null]>;
}

/** Bangun elemen dengan class/style dari format peran + eksplisit dan atribut alamat. */
export function el(ctx: RenderContext, tag: string, o: ElOptions, inner: string): string {
  const rf = o.role ? roleFormat(ctx, o.role) : {};
  const para = mergePara(rf.para, o.format);
  const run = mergeRun(rf[o.roleRun ?? "run"], o.run);
  const rs = runStyle(run, 0, ctx.tpl);
  const decl = [...paraDecl(para), ...rs.decl];
  if (rf.cell?.shading?.fill && !para.shading) {
    // Peran tingkat sel membawa shading; elemen non-sel memakainya sebagai latar.
    const fill = /^[0-9A-Fa-f]{6}$/.test(rf.cell.shading.fill) ? `#${rf.cell.shading.fill.toUpperCase()}` : undefined;
    if (fill) decl.push(`background-color:${fill}`);
  }
  const { cls, style } = classStyle([...(o.classes ?? []), ...rs.classes], decl);
  const extra = (o.attrs ?? []).map(([k, v]) => attr(k, v)).join("");
  const inside = rs.vert ? `<${rs.vert}>${inner}</${rs.vert}>` : inner;
  return `<${tag}${attr("class", cls)}${attr("style", style)}${attr("data-address", o.address ?? undefined)}${attr("data-block", o.blockId)}${attr("data-role", o.role)}${extra}>${inside}</${tag}>`;
}

// ── Parameter templat ────────────────────────────────────────────────────

function param(ctx: RenderContext, key: string): ParamValue | undefined {
  const p = ctx.tpl?.params;
  return p && Object.prototype.hasOwnProperty.call(p, key) ? p[key] : undefined;
}

export function paramNum(ctx: RenderContext, key: string, def: number): number {
  const v = param(ctx, key);
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

export function paramBool(ctx: RenderContext, key: string, def: boolean): boolean {
  const v = param(ctx, key);
  return typeof v === "boolean" ? v : def;
}

export function paramStr(ctx: RenderContext, key: string, def: string): string {
  const v = param(ctx, key);
  return typeof v === "string" ? v : def;
}

export function paramList(ctx: RenderContext, key: string, def: readonly string[]): readonly string[] {
  const v = param(ctx, key);
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : def;
}

export function language(ctx: RenderContext): "ID" | "EN" {
  return ctx.snapshot?.doc?.meta?.language === "EN" ? "EN" : "ID";
}

// ── Validasi isi blok ────────────────────────────────────────────────────

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Catat isi blok tak sah lewat log render (sink tahan lama milik layanan render S51). */
export function reportBad(ctx: RenderContext, block: NormBlock, detail: string): string {
  ctx.log({
    level: "error",
    message: `engine/html/blocks: ${block.type} ${detail}`,
    code: "RENDER_BLOCK_INVALID",
    address: block.address ?? block.blockId,
  });
  return "";
}

/** Ambil `content` sebagai objek ber-`type` yang diharapkan (bila diberikan). */
export function contentOf<T>(ctx: RenderContext, block: NormBlock, expectType?: string): T | undefined {
  const c = block?.content;
  if (!isObj(c)) {
    reportBad(ctx, block, "content bukan objek");
    return undefined;
  }
  if (expectType && typeof c.type === "string" && c.type !== expectType) {
    reportBad(ctx, block, `content.type ${String(c.type)} tidak sama dengan ${expectType}`);
    return undefined;
  }
  return c as T;
}

/** NormBlock sintetis untuk unsur bersarang (badan halaman depan/bagian). */
export function childBlock(parent: NormBlock, type: string, content: unknown, index: number, address: string | null): NormBlock {
  return {
    blockId: `${parent.blockId}/${index + 1}`,
    address,
    ordinal: parent.ordinal,
    unitKey: parent.unitKey,
    type,
    content,
    textPlain: "",
    contentSha256: "",
  };
}
