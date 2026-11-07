/**
 * Primitif tak beralamat (S16, KS-05): spacer dan device.
 *
 * spacer (K-10/K-16/K-20/K-27/K-31): paragraf kosong tanpa run, `format` wajib;
 *   format kosong -> peran `spacer.generic`.
 * device:
 *   - sealBand (KT-01/02): tabel 1x2 bentang penuh, sel kiri/kanan berisi
 *     `left`/`right` (peran `wrapper.sealBand`; cadangan isian `color.wrapper.seal`,
 *     margin TCP-01/02).
 *   - logo (K-01), datumRule (K-04): paragraf gambar inline dari `asset`
 *     (datumRule tanpa aset -> aset templat `rule<lebar>`); aset tidak tersedia ->
 *     paragraf cadangan + log.
 *   - hairline (K-03): paragraf kosong bergaris bawah (garis rambut).
 *   - spineString (K-11): paragraf `text`; issueStamp: paragraf `text` peran
 *     `cover.colophonRight`.
 */
import type { DeviceBlock, Inline, ParaFormat, RoleKey, SpacerBlock } from "../../../contract";
import type { BlockEnv } from "./env";
import { imageHeightMm, inlineDrawingRun, loadImageAsset } from "./media";
import { mergePara } from "./props";
import { singleRowTable } from "./table";

function obj<T>(env: BlockEnv): T {
  const c = env.block.content;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw env.fail("content bukan objek");
  return c as T;
}

function isInline(v: unknown): v is Inline {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" || Array.isArray(o.runs);
}

export function renderSpacer(env: BlockEnv): string {
  const c = obj<SpacerBlock>(env);
  const format: ParaFormat = c.format && Object.keys(c.format).length > 0 ? c.format : (env.role("spacer.generic").para ?? {});
  return env.para(format, "");
}

function textDevice(env: BlockEnv, d: DeviceBlock, role: RoleKey): string {
  const inline = d.text ?? d.left ?? d.right;
  if (!isInline(inline)) throw env.fail(`device ${d.device} wajib memuat text`);
  const rf = env.role(role);
  return env.para(mergePara(rf.para, d.format), env.inline(inline, rf.run ?? {}, false));
}

function imageDevice(env: BlockEnv, d: DeviceBlock, role: RoleKey, defaultWidthMm: number, fallbackAsset?: string): string {
  const decorative = d.device === "logo" ? "logo" : d.device === "datumRule" ? "datumRule" : "ornament";
  const rf = env.role(role, { lineTw: 240, lineRule: "auto" });
  const para = mergePara(rf.para, d.format);
  const widthMm = d.widthMm ?? defaultWidthMm;
  const key = d.asset ?? fallbackAsset;
  const img = key ? loadImageAsset(env, key) : undefined;
  if (!key) env.warn(`device ${d.device} tanpa asset`, "FILE_NOT_FOUND");
  const docAsset = key ? env.ctx.snapshot.doc.assets?.[key] : undefined;
  let heightMm = img ? imageHeightMm(img, widthMm, d.heightMm) : undefined;
  if (heightMm === undefined && img && docAsset?.widthPx && docAsset.heightPx) heightMm = (widthMm * docAsset.heightPx) / docAsset.widthPx;
  if (img && heightMm !== undefined) return env.para(para, inlineDrawingRun(env, img, widthMm, heightMm, env.rPr(rf.run ?? {}), decorative));
  if (img) env.warn(`device ${d.device}: tinggi gambar tidak diketahui (isi heightMm)`, "ASSET_TYPE_UNSUPPORTED");
  if (d.device === "datumRule") {
    env.warn(`device datumRule memakai cadangan garis bawah paragraf (aset "${key ?? "-"}")`);
    const bottom = env.rule("device.datumRule.weightMm", "rules.primary.colour", 0.2, "ink900");
    return env.para(mergePara(para, { borders: { bottom } }), "");
  }
  env.warn(`device ${d.device}: gambar dilewati, paragraf kosong ditulis`);
  return env.para(para, "");
}

function sealBand(env: BlockEnv, d: DeviceBlock): string {
  if (!isInline(d.left) && !isInline(d.right)) throw env.fail("device sealBand wajib memuat left atau right");
  const rf = env.role("wrapper.sealBand");
  const full = env.fullSpanTw();
  const leftW = Math.floor(full / 2);
  const rightW = full - leftW;
  const fill = env.color("seal") ?? env.color("color.wrapper.seal");
  const shading = rf.cell?.shading ?? (fill ? { fill, val: "clear" as const } : undefined);
  const leftMargins = rf.cell?.marginsTw ?? { top: 85, left: 141, bottom: 85, right: 141 };
  const rightMargins = rf.cell?.marginsTw ? { ...rf.cell.marginsTw, left: 0 } : { top: 85, left: 0, bottom: 85, right: 141 };
  const cellPara = (inline: Inline | undefined, jc: "left" | "right") => {
    const para = mergePara({ jc, ...(rf.para ?? {}) }, d.format);
    return env.para(para, isInline(inline) ? env.inline(inline, rf.run ?? {}, false) : "");
  };
  return singleRowTable(env, [
    { widthTw: leftW, content: cellPara(d.left, "left"), shading, marginsTw: leftMargins, borders: rf.cell?.borders },
    { widthTw: rightW, content: cellPara(d.right, "right"), shading, marginsTw: rightMargins, borders: rf.cell?.borders },
  ]);
}

export function renderDevice(env: BlockEnv): string {
  const d = obj<DeviceBlock>(env);
  switch (d.device) {
    case "sealBand":
      return sealBand(env, d);
    case "logo":
      return imageDevice(env, d, "cover.logo", 44);
    case "datumRule": {
      const width = d.widthMm ?? env.requiredNum("grid.fullSpanMm");
      return imageDevice(env, d, "wrapper.datumRule", width, `rule${Math.round(width)}`);
    }
    case "hairline": {
      const rf = env.role("cover.hairline");
      const base: ParaFormat = rf.para?.borders
        ? (rf.para ?? {})
        : mergePara(rf.para, { borders: { bottom: { ...env.rule("rules.hairMm", "rules.hair.colour", 0.2, "ink200"), space: 1 } } });
      return env.para(mergePara(base, d.format), "");
    }
    case "spineString":
      return textDevice(env, d, "cover.identityString");
    case "issueStamp":
      return textDevice(env, d, "cover.colophonRight");
    default:
      throw env.fail(`device tidak dikenal: ${String((d as { device?: unknown }).device)}`);
  }
}
