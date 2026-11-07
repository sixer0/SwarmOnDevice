/**
 * Blok prosa (S16): paragraph, list, assumptionInline.
 *
 * - paragraph: `text` md-lite ATAU `runs[]` apa adanya; peran paragraf
 *   dipetakan ke RoleKey (§5.6) menurut jenis unit; `rail[]` -> rel bukti.
 * - list: penanda (`marker` atau templat) + `w:tab` dalam run yang sama +
 *   isi (pola BM.docx K-30/K-35); indentasi gantung dari peran.
 * - assumptionInline: paragraf badan + rel [tanda ASUMSI, ID asumsi, dampak]
 *   (pola BM.docx T017: "△ ASUMSI" / "ASM-MAN-01" / "Dampak bila salah: ...").
 */
import type {
  AssumptionInlineBlock,
  Inline,
  ListBlock,
  ListItem,
  ParaFormat,
  ParagraphBlock,
  ParagraphRole,
  RailLine,
  Run,
  RoleKey,
  RunProps,
} from "../../../contract";
import type { BlockEnv } from "./env";
import { mergePara } from "./props";
import { railHostIndentTw, railK2ReserveOf, withRail, type HostVariant } from "./rail";
import { el } from "./xml";

/** Bawaan struktural per peran (di bawah turunan katalog; lihat env.ts). */
const STRUCTURAL: Partial<Record<RoleKey, ParaFormat>> = {
  "body.subheading": { keepNext: true },
  "chapter.kicker": { keepNext: true },
  "chapter.title": { keepNext: true, outlineLvl: 0 },
  "part.title": { outlineLvl: 0 },
  "section.heading": { keepNext: true, outlineLvl: 1 },
  // research/07 K-30/K-35: gantung 5 mm / 7 mm dengan tab di posisi yang sama.
  "list.bullet": { jc: "left", indLeftTw: 283, indHangingTw: 283, tabs: [{ posTw: 283, val: "left" }] },
  "list.number": { indLeftTw: 397, indHangingTw: 397, tabs: [{ posTw: 397, val: "left" }] },
};

export function structuralFor(key: RoleKey): ParaFormat | undefined {
  return STRUCTURAL[key];
}

function asObject(content: unknown, env: BlockEnv): Record<string, unknown> {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw env.fail("content bukan objek");
  return content as Record<string, unknown>;
}

function hasInline(o: Record<string, unknown>): boolean {
  return typeof o.text === "string" || Array.isArray(o.runs);
}

/** Indeks judul sampul ke-n dari jumlahnya di unit (K-06 baris pertama, K-07 baris terakhir). */
function coverTitleRole(env: BlockEnv): RoleKey {
  const titles = env.ctx.snapshot.blocks.filter((b) => {
    if (b.unitKey !== env.block.unitKey || b.type !== "paragraph") return false;
    const c = b.content as { role?: unknown } | null;
    return !!c && typeof c === "object" && c.role === "title";
  });
  const idx = titles.findIndex((b) => b.blockId === env.block.blockId);
  return idx >= 0 && idx === titles.length - 1 ? "cover.titleLast" : "cover.titleFirst";
}

/** ParagraphRole -> RoleKey menurut jenis unit (§13.1). */
export function paragraphRoleKey(role: ParagraphRole | undefined, env: BlockEnv): RoleKey {
  const unit = env.unitKind();
  switch (role) {
    case undefined:
    case "body":
    case "identity":
    case "anchor":
    case "pivot":
    case "closingAction":
    case "note":
      return "body.paragraph";
    case "lede":
      return unit === "cover" ? "cover.standfirst" : "part.lede";
    case "subheading":
      return "body.subheading";
    case "kicker":
      if (unit === "cover" || unit === "part") return "wrapper.kicker";
      if (unit === "controlSheet" || unit === "toc") return "front.kicker";
      return "chapter.kicker";
    case "pageTitle":
      return "front.pageTitle";
    case "blockHeading":
      return "controlSheet.blockHeading";
    case "addressLine":
      return "cover.addressLine";
    case "title":
      return unit === "part" ? "part.title" : coverTitleRole(env);
    case "standfirst":
      return "cover.standfirst";
    case "scopeLine":
      return "cover.scopeLine";
    case "methodStatement":
      return "controlSheet.methodStatement";
    default:
      return "body.paragraph";
  }
}

/**
 * Format paragraf inang dan run dasar untuk satu varian rel.
 * `table`: isi sel prosa memakai peran `rail.prose` bila templat menulisnya,
 * selain itu format peran tanpa indentasi kanan (sel sudah selebar kolom teks).
 * `plain` pada moda K2 (A + `framePr`, FIX-R1): indentasi kanan PERAN yang sama
 * dengan cadangan rel dibuang, sehingga prosa tanpa provenans selebar teks penuh
 * (K2 rev B); format eksplisit blok tetap menang dan diperiksa G-RAIL-3.
 */
export function hostFormat(
  env: BlockEnv,
  roleKey: RoleKey,
  explicit: readonly (ParaFormat | undefined)[],
  runDefaults: RunProps | undefined,
  variant: HostVariant,
): { para: ParaFormat; run: RunProps; markerRun?: RunProps } {
  const rf = env.role(roleKey, structuralFor(roleKey));
  let para: ParaFormat = { ...(rf.para ?? {}) };
  let run: RunProps = rf.run ?? {};
  if (variant === "table") {
    if (env.templateHas("rail.prose", "para")) para = { ...(env.role("rail.prose").para ?? {}) };
    else delete para.indRightTw;
    if (env.templateHas("rail.prose", "run")) run = env.role("rail.prose").run ?? run;
  }
  if (variant === "plain" && para.indRightTw !== undefined && para.indRightTw === railK2ReserveOf((k) => env.param(k))) delete para.indRightTw;
  for (const f of explicit) para = mergePara(para, f);
  if (variant === "framePr" && !explicit.some((f) => f?.indRightTw !== undefined)) para.indRightTw = railHostIndentTw(env);
  return { para, run: env.mergeRun(run, runDefaults), markerRun: rf.markerRun };
}

// ── paragraph ────────────────────────────────────────────────────────────

export function renderParagraph(env: BlockEnv): string {
  const c = asObject(env.block.content, env) as unknown as ParagraphBlock;
  if (!hasInline(c as unknown as Record<string, unknown>)) throw env.fail("paragraph wajib memuat text atau runs");
  const roleKey = paragraphRoleKey(c.role, env);
  return withRail(env, c.rail, (variant) => {
    const f = hostFormat(env, roleKey, [c.format], c.runDefaults, variant);
    return env.para(f.para, env.inline(c as Inline, f.run, true, roleKey));
  });
}

// ── list ─────────────────────────────────────────────────────────────────

function defaultMarker(env: BlockEnv, style: ListBlock["style"], index: number): Run {
  if (style === "number") return { t: String(index + 1) };
  const v = env.param("render.list.bulletMarker");
  const t = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>).t : undefined;
  return { t: typeof t === "string" ? t : "–" };
}

export function renderList(env: BlockEnv): string {
  const c = asObject(env.block.content, env) as unknown as ListBlock;
  if (c.style !== "bullet" && c.style !== "number") throw env.fail(`list.style tidak dikenal: ${String(c.style)}`);
  if (!Array.isArray(c.items)) throw env.fail("list.items bukan larik");
  const roleKey: RoleKey = c.style === "number" ? "list.number" : "list.bullet";
  return c.items
    .map((item: ListItem, i) => {
      if (!item || typeof item !== "object" || !hasInline(item as unknown as Record<string, unknown>)) {
        throw env.fail(`list.items[${i}] wajib memuat text atau runs`);
      }
      return withRail(env, item.rail, (variant) => {
        const f = hostFormat(env, roleKey, [c.format, item.format], c.runDefaults, variant);
        const marker = item.marker ?? defaultMarker(env, c.style, i);
        const markerBase = env.mergeRun(f.run, f.markerRun);
        const markerXml = env.run(marker, markerBase, el("w:tab"));
        return env.para(f.para, markerXml + env.inline(item as Inline, f.run, true, roleKey));
      });
    })
    .join("");
}

// ── assumptionInline ─────────────────────────────────────────────────────

const IMPACT_PREFIX: Record<"ID" | "EN", string> = { ID: "Dampak bila salah: ", EN: "Impact if wrong: " };

export function renderAssumptionInline(env: BlockEnv): string {
  const c = asObject(env.block.content, env) as unknown as AssumptionInlineBlock;
  if (!hasInline(c as unknown as Record<string, unknown>)) throw env.fail("assumptionInline wajib memuat text atau runs");
  if (typeof c.asmId !== "string" || !c.asmId) throw env.fail("assumptionInline.asmId kosong");
  if (typeof c.impact !== "string" || !c.impact) throw env.fail("assumptionInline.impact kosong");
  const lang = env.ctx.snapshot.doc.meta.language === "EN" ? "EN" : "ID";
  // Awalan label dampak hanya ditambahkan bila teks dampak belum memuatnya.
  const impact = /^(dampak|impact)\b/i.test(c.impact) ? c.impact : IMPACT_PREFIX[lang] + c.impact;
  const rail: RailLine[] = [
    { kind: "mark", mark: "ASUMSI" },
    { kind: "source", text: c.asmId },
    { kind: "note", text: impact },
  ];
  return withRail(env, rail, (variant) => {
    const f = hostFormat(env, "body.paragraph", [c.format], c.runDefaults, variant);
    return env.para(f.para, env.inline(c as Inline, f.run, true, "body.paragraph"));
  });
}
