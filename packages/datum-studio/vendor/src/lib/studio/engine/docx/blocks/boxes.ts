/**
 * Kotak bergaris (S16): aside (5 varian, KT-30/KT-31, TCP-18) dan monoBlock
 * (KT-40/KT-35, TCP-21), masing-masing tabel 1x1 selebar kolom teks.
 *
 * Format sel: `RoleFormat.cell` peran (label lalu badan) bila templat
 * menulisnya; selain itu turunan parameter (aside: garis atas
 * `rules.asideTopMm` warna garis utama + garis rambut bawah `aside.ruleBottom`,
 * P4R-12/P5-28; monoBlock: garis kiri tebal utama warna ink400) dengan margin
 * sel terukur BM.docx (TCP-18: atas 124, bawah 136; TCP-21: atas/bawah 136,
 * kiri 255). Varian aside tidak mengubah format (label varian ditulis penulis
 * di `label`, research/01:851).
 *
 * Teks label dan baris monoBlock verbatim (baris kode tidak diurai md-lite);
 * badan aside = prosa md-lite bila `text`.
 */
import type { AsideBlock, Cell, Inline, MonoBlock, RoleFormat } from "../../../contract";
import type { BlockEnv } from "./env";
import { mergePara } from "./props";
import { singleRowTable } from "./table";

const ASIDE_VARIANTS = new Set(["generic", "doctrine", "story", "quickCheck", "ifInDoubt"]);

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

function cellOf(...roles: RoleFormat[]): RoleFormat["cell"] | undefined {
  for (const r of roles) if (r.cell) return r.cell;
  return undefined;
}

function frame(env: BlockEnv, cell: RoleFormat["cell"], content: string): string {
  return singleRowTable(env, [
    {
      widthTw: env.textColumnTw(),
      content,
      borders: cell?.borders as Cell["borders"],
      marginsTw: cell?.marginsTw,
      shading: cell?.shading,
    },
  ]);
}

export function renderAside(env: BlockEnv): string {
  const c = obj<AsideBlock>(env);
  if (!ASIDE_VARIANTS.has(c.variant)) throw env.fail(`aside.variant tidak dikenal: ${String(c.variant)}`);
  if (!isInline(c.label)) throw env.fail("aside.label wajib Inline");
  if (!Array.isArray(c.body)) throw env.fail("aside.body bukan larik");
  const labelRole = env.role("aside.label");
  const bodyRole = env.role("aside.body");
  const cell = cellOf(labelRole, bodyRole) ?? {
    borders: {
      top: env.rule("rules.asideTopMm", "rules.primary.colour", 0.35, "ink900"),
      bottom: env.rule("rules.hairMm", "rules.hair.colour", 0.2, "ink200"),
    },
    marginsTw: { top: 124, bottom: 136, left: 0, right: 0 },
  };
  let content = env.para(labelRole.para ?? {}, env.inline(c.label, labelRole.run ?? {}, false));
  const bodyRun = env.mergeRun(bodyRole.run, c.runDefaults);
  c.body.forEach((p, i) => {
    if (!isInline(p)) throw env.fail(`aside.body[${i}] wajib memuat text atau runs`);
    const para = mergePara(mergePara(bodyRole.para, c.format), p.format);
    content += env.para(para, env.inline(p, bodyRun, true, "aside.body"));
  });
  return frame(env, cell, content);
}

export function renderMonoBlock(env: BlockEnv): string {
  const c = obj<MonoBlock>(env);
  if (!isInline(c.label)) throw env.fail("monoBlock.label wajib Inline");
  if (!Array.isArray(c.lines)) throw env.fail("monoBlock.lines bukan larik");
  const labelRole = env.role("monoBlock.label");
  const lineRole = env.role("derivation.expr");
  const cell = cellOf(labelRole, lineRole) ?? {
    borders: { left: env.rule("rules.primaryMm", undefined, 0.45, "ink400") },
    marginsTw: { top: 136, left: 255, bottom: 136, right: 0 },
  };
  let content = env.para(labelRole.para ?? {}, env.inline(c.label, labelRole.run ?? {}, false));
  const lineRun = env.mergeRun(lineRole.run, c.runDefaults);
  c.lines.forEach((l, i) => {
    if (!isInline(l)) throw env.fail(`monoBlock.lines[${i}] wajib memuat text atau runs`);
    const para = mergePara(mergePara(lineRole.para, c.format), l.format);
    content += env.para(para, env.inline(l, lineRun, false, "derivation.expr"));
  });
  return frame(env, cell, content);
}
