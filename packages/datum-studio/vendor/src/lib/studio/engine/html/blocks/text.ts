/**
 * Renderer HTML blok teks (padanan S16): chapter, section, paragraph, list,
 * aside (5 varian), monoBlock, assumptionInline, spacer, device, chip rel.
 * Setiap blok beralamat membawa `data-address` (konvensi S25 measure.ts, D-38).
 */
import {
  PROVENANCE_GLYPHS,
  PROVENANCE_MARKS,
  type AsideBlock,
  type AssumptionInlineBlock,
  type Chapter,
  type DeviceBlock,
  type HtmlBlockRenderer,
  type ListBlock,
  type MonoBlock,
  type NormBlock,
  type ParaFormat,
  type ParagraphBlock,
  type ParagraphRole,
  type ProvenanceMark,
  type RailLine,
  type RenderContext,
  type RoleKey,
  type RunProps,
  type Section,
  type SpacerBlock,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { railK2ReserveOf } from "../../docx/blocks/rail";
import { baselineSnapTw, snapParaToBaseline } from "../../docx/blocks/rhythm";
import { datumRulePlaced } from "../../front/apparatus";
import { appendixOpenerKickerText, chapterKickerText, kickerSuppressed, provenanceMarkLabelText } from "../../front/texts";
import { HTML_BLOCK_CLASSES as C } from "./classes";
import { contentOf, el, isObj, language, reportBad } from "./common";
import { datumRuleHtml, isDevice, renderDevice } from "./device";
import { attr, escapeHtml, finite } from "./escape";
import { DEFAULT_MD_ROLES, hasInline, inlineHtml, runHtml, type HtmlRun } from "./inline";
import { baseRun, semanticRuns, semanticTransform } from "./semantic";
import { mergePara, roleFormat, runStyle, classStyle, wrapperScope } from "./style";

// ── Paragraf ─────────────────────────────────────────────────────────────

interface RoleMap {
  tag: string;
  role: RoleKey;
}

const PARAGRAPH_ROLES: Readonly<Record<ParagraphRole, RoleMap>> = {
  body: { tag: "p", role: "body.paragraph" },
  identity: { tag: "p", role: "body.paragraph" },
  anchor: { tag: "p", role: "body.paragraph" },
  pivot: { tag: "p", role: "body.paragraph" },
  closingAction: { tag: "p", role: "body.paragraph" },
  lede: { tag: "p", role: "body.paragraph" },
  note: { tag: "p", role: "body.paragraph" },
  subheading: { tag: "h4", role: "body.subheading" },
  kicker: { tag: "p", role: "front.kicker" },
  pageTitle: { tag: "h2", role: "front.pageTitle" },
  blockHeading: { tag: "h3", role: "controlSheet.blockHeading" },
  addressLine: { tag: "p", role: "cover.addressLine" },
  title: { tag: "h1", role: "cover.titleFirst" },
  standfirst: { tag: "p", role: "cover.standfirst" },
  scopeLine: { tag: "p", role: "cover.scopeLine" },
  methodStatement: { tag: "p", role: "controlSheet.methodStatement" },
};

const RAIL_ROLE: Readonly<Record<RailLine["kind"], RoleKey>> = {
  mark: "rail.mark",
  source: "rail.source",
  note: "rail.note",
};

/**
 * Run label baris tanda (padanan DOCX `markLabelRun`, RT-01): `labelRunByMark`
 * peran `rail.mark` bila ada; selain itu, bila templat MENULIS `glyphRun`
 * tanda itu dengan warna, label berwarna sama dengan glifnya. Tanpa keduanya
 * label mewarisi gaya peran (perilaku lama).
 */
function markLabelProps(ctx: RenderContext, mark: ProvenanceMark): RunProps | undefined {
  const rf = roleFormat(ctx, "rail.mark");
  const byMark = rf.labelRunByMark?.[mark];
  if (byMark) return byMark;
  const color = rf.glyphRun?.[mark]?.color;
  return color ? { color } : undefined;
}

/** Chip rel bukti (moda A) untuk satu paragraf inang. */
export function railHtml(ctx: RenderContext, rail: readonly RailLine[]): string {
  const lines = rail.filter(isObj).map((line) => {
    const kind = RAIL_ROLE[line.kind] ? line.kind : "note";
    const mark = kind === "mark" && line.mark && (PROVENANCE_MARKS as readonly string[]).includes(line.mark) ? line.mark : undefined;
    let glyph = "";
    if (mark) {
      const gr = roleFormat(ctx, "rail.mark").glyphRun?.[mark];
      const st = runStyle(gr, 0, ctx.tpl);
      const { cls, style } = classStyle([C.railGlyph, ...st.classes], st.decl);
      glyph = `<span${attr("class", cls)}${attr("style", style)}${attr("data-mark", mark)}>${escapeHtml(PROVENANCE_GLYPHS[mark])}</span> `;
    }
    // Baris tanda konten-saja (`{kind, mark}`) tanpa label/teks: label = nama tanda (padanan DOCX).
    const labelText =
      typeof line.label === "string" && line.label ? line.label : mark && !Array.isArray(line.runs) && !line.text ? provenanceMarkLabelText(mark, language(ctx)) : "";
    let label = "";
    if (labelText) {
      const st = runStyle(mark ? markLabelProps(ctx, mark) : undefined, 0, ctx.tpl);
      const { cls, style } = classStyle(st.classes, st.decl);
      const text = escapeHtml(labelText);
      label = `${cls || style ? `<span${attr("class", cls)}${attr("style", style)}>${text}</span>` : text} `;
    }
    const lineBase = baseRun(ctx, RAIL_ROLE[kind]);
    const body = Array.isArray(line.runs)
      ? semanticRuns(ctx, line.runs as HtmlRun[], lineBase).map((r) => runHtml(r)).join("")
      : escapeHtml(line.text ?? "");
    return el(ctx, "p", { classes: [C.railLine], role: RAIL_ROLE[kind], format: line.format, attrs: [["data-kind", kind]] }, glyph + label + body);
  });
  return `<div class="${C.rail}" role="note">${lines.join("")}</div>`;
}

/**
 * K2 rev B (FIX-R1, padanan DOCX `hostFormat`): pada perender `framePr` moda A,
 * indentasi kanan PERAN yang sama dengan cadangan rel (gutter + rel) dibuang. Prosa
 * tanpa rel jadi selebar teks penuh; inang sudah menyempit lewat grid `.st-railhost`
 * (kolom teks + rel), sehingga margin peran tidak menyempitkannya dua kali. Format
 * eksplisit blok tetap menang. `table3col` (Manual 000) dan moda B tidak berubah.
 */
function k2Format(ctx: RenderContext, role: RoleKey, ...explicit: ReadonlyArray<ParaFormat | undefined>): ParaFormat | undefined {
  const merged = explicit.some((f) => f && typeof f === "object") ? mergePara(...explicit) : undefined;
  if (merged?.indRightTw !== undefined) return merged;
  const reserve = railK2ReserveOf((k) => ctx.tpl?.params?.[k]);
  if (reserve === undefined || roleFormat(ctx, role).para?.indRightTw !== reserve) return merged;
  return { ...merged, indRightTw: undefined };
}

/** Bungkus elemen inang dengan rel bila ada; alamat dipasang di pembungkus. */
function withRail(ctx: RenderContext, inner: string, rail: unknown, address: string | null, blockId?: string): string {
  if (!Array.isArray(rail) || rail.length === 0) return inner;
  return `<div class="${C.railHost}"${attr("data-address", address ?? undefined)}${attr("data-block", blockId)}><div class="${C.railHostMain}">${inner}</div>${railHtml(ctx, rail as RailLine[])}</div>`;
}

export const renderParagraph: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<ParagraphBlock>(ctx, block, "paragraph");
  if (!b) return "";
  if (!hasInline(b)) return reportBad(ctx, block, "tanpa text/runs");
  const map = PARAGRAPH_ROLES[b.role ?? "body"] ?? PARAGRAPH_ROLES.body;
  const hasRail = Array.isArray(b.rail) && b.rail.length > 0;
  const p = el(
    ctx,
    map.tag,
    {
      classes: [map.tag === "p" ? C.paragraph : C.heading, `${C.paragraph}--${b.role ?? "body"}`],
      role: map.role,
      format: k2Format(ctx, map.role, b.format),
      run: b.runDefaults,
      address: hasRail ? undefined : block.address,
      blockId: hasRail ? undefined : block.blockId,
    },
    inlineHtml(b, DEFAULT_MD_ROLES, semanticTransform(ctx, map.role, baseRun(ctx, map.role, b.runDefaults))),
  );
  return withRail(ctx, p, b.rail, block.address, block.blockId);
};

// ── List ─────────────────────────────────────────────────────────────────

export const renderList: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<ListBlock>(ctx, block, "list");
  if (!b) return "";
  if (!Array.isArray(b.items)) return reportBad(ctx, block, "items bukan larik");
  const numbered = b.style === "number";
  const role: RoleKey = numbered ? "list.number" : "list.bullet";
  const markerFmt = roleFormat(ctx, role).markerRun;
  const sem = semanticTransform(ctx, role, baseRun(ctx, role, b.runDefaults));
  const items = b.items.map((item, i) => {
    if (!hasInline(item)) {
      reportBad(ctx, block, `item ${i + 1} tanpa text/runs`);
      return "";
    }
    const address = block.address ? `${block.address}/${i + 1}` : null;
    let marker: string;
    if (isObj(item.marker)) {
      marker = runHtml(item.marker as HtmlRun);
    } else {
      const st = runStyle(markerFmt, 0, ctx.tpl);
      const { cls, style } = classStyle(st.classes, st.decl);
      const text = escapeHtml(numbered ? `${i + 1}.` : "•");
      marker = cls || style ? `<span${attr("class", cls)}${attr("style", style)}>${text}</span>` : text;
    }
    const hasRail = Array.isArray(item.rail) && item.rail.length > 0;
    const content = `<span class="${C.listMarker}" aria-hidden="true">${marker}</span><span class="${C.tab}">\t</span>${inlineHtml(item, DEFAULT_MD_ROLES, sem)}`;
    const li = el(
      ctx,
      hasRail ? "div" : "li",
      { classes: [C.listItem], role, format: k2Format(ctx, role, { ...b.format, ...item.format }), run: b.runDefaults, address: hasRail ? undefined : address },
      content,
    );
    return hasRail ? `<li>${withRail(ctx, li, item.rail, address)}</li>` : li;
  });
  const tag = numbered ? "ol" : "ul";
  return `<${tag} class="${C.list} ${C.list}--${numbered ? "number" : "bullet"}"${attr("data-address", block.address ?? undefined)}${attr("data-block", block.blockId)}>${items.join("")}</${tag}>`;
};

// ── Aside ────────────────────────────────────────────────────────────────

const ASIDE_VARIANTS = new Set<AsideBlock["variant"]>(["generic", "doctrine", "story", "quickCheck", "ifInDoubt"]);

export const renderAside: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<AsideBlock>(ctx, block, "aside");
  if (!b) return "";
  const variant = ASIDE_VARIANTS.has(b.variant) ? b.variant : "generic";
  if (variant !== b.variant) reportBad(ctx, block, `varian tak dikenal ${String(b.variant)}, dipakai generic`);
  const body = Array.isArray(b.body) ? b.body : [];
  const numbered = variant === "quickCheck";
  const numberFmt = roleFormat(ctx, "aside.body").numberRun;
  const label = el(ctx, "p", { classes: [C.asideLabel], role: "aside.label" }, inlineHtml(b.label, DEFAULT_MD_ROLES, semanticTransform(ctx, undefined, baseRun(ctx, "aside.label"))));
  const bodySem = semanticTransform(ctx, "aside.body", baseRun(ctx, "aside.body", b.runDefaults));
  const paras = body.map((para, i) => {
    let prefix = "";
    if (numbered) {
      const st = runStyle(numberFmt, 0, ctx.tpl);
      const { cls, style } = classStyle([C.asideNumber, ...st.classes], st.decl);
      prefix = `<span${attr("class", cls)}${attr("style", style)}>${i + 1}.</span><span class="${C.tab}">\t</span>`;
    }
    return el(
      ctx,
      "p",
      { classes: [C.paragraph, C.asideBody], role: "aside.body", format: para?.format, run: b.runDefaults, address: block.address ? `${block.address}/${i + 1}` : null },
      prefix + inlineHtml(para, DEFAULT_MD_ROLES, bodySem),
    );
  });
  return el(
    ctx,
    "aside",
    { classes: [C.aside, `${C.aside}--${variant}`], format: b.format, address: block.address, blockId: block.blockId, attrs: [["data-variant", variant]] },
    label + paras.join(""),
  );
};

// ── monoBlock ────────────────────────────────────────────────────────────

export const renderMonoBlock: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<MonoBlock>(ctx, block, "monoBlock");
  if (!b) return "";
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const label = el(ctx, "p", { classes: [C.monoLabel], role: "monoBlock.label" }, inlineHtml(b.label, DEFAULT_MD_ROLES, semanticTransform(ctx, undefined, baseRun(ctx, "monoBlock.label"))));
  const lineSem = semanticTransform(ctx, "derivation.expr", baseRun(ctx, "derivation.expr", b.runDefaults));
  const body = lines
    .map((line, i) =>
      el(
        ctx,
        "span",
        { classes: [C.monoLine], role: "derivation.expr", format: line?.format, run: b.runDefaults, address: block.address ? `${block.address}/${i + 1}` : null },
        inlineHtml(line, DEFAULT_MD_ROLES, lineSem),
      ),
    )
    .join("");
  return el(
    ctx,
    "div",
    { classes: [C.monoBlock], format: b.format, address: block.address, blockId: block.blockId },
    `${label}<pre class="${C.monoBody}"><code>${body}</code></pre>`,
  );
};

// ── assumptionInline ─────────────────────────────────────────────────────

export const renderAssumptionInline: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<AssumptionInlineBlock>(ctx, block, "assumptionInline");
  if (!b) return "";
  if (typeof b.asmId !== "string" || !b.asmId) return reportBad(ctx, block, "tanpa asmId");
  const impactLabel = language(ctx) === "EN" ? "Impact" : "Dampak";
  const id = `<span class="${C.assumptionId}">[${escapeHtml(b.asmId)}]</span> `;
  const impact = typeof b.impact === "string" && b.impact ? ` <span class="${C.assumptionImpact}">${impactLabel}: ${escapeHtml(b.impact)}</span>` : "";
  return el(
    ctx,
    "p",
    {
      classes: [C.paragraph, C.assumption],
      role: "body.paragraph",
      format: k2Format(ctx, "body.paragraph", b.format),
      run: b.runDefaults,
      address: block.address,
      blockId: block.blockId,
      attrs: [["data-asm", b.asmId]],
    },
    id + inlineHtml(b, DEFAULT_MD_ROLES, semanticTransform(ctx, "body.paragraph", baseRun(ctx, "body.paragraph", b.runDefaults))) + impact,
  );
};

// ── spacer, device ───────────────────────────────────────────────────────

export const renderSpacer: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<SpacerBlock>(ctx, block, "spacer");
  if (!b) return "";
  return el(ctx, "p", { classes: [C.spacer], role: "spacer.generic", format: b.format, attrs: [["aria-hidden", "true"]] }, "&nbsp;");
};

export const renderDeviceBlock: HtmlBlockRenderer = (block, ctx) => {
  const b = contentOf<DeviceBlock>(ctx, block, "device");
  if (!b) return "";
  if (!isDevice(b)) return reportBad(ctx, block, "bukan device");
  return renderDevice(block, ctx, b);
};

// ── chapter / appendix / section ─────────────────────────────────────────

/** Kunci bab efektif (FIX-2: sama dengan DOCX `blocks/structure.ts` chapterKey). */
function chapterKey(block: NormBlock, c: Chapter): string {
  if (typeof c.key === "string" && c.key) return c.key;
  if (block.address && /^[0-9A-Z]+$/.test(block.address)) return block.address;
  return block.unitKey ?? "";
}

/** Kunci lampiran efektif (FIX-2: sama dengan DOCX `wrapper/pages.ts` renderAppendixOpener): key, posisi A..Z, unitKey. */
function appendixKey(block: NormBlock, ctx: RenderContext, c: Chapter): string {
  if (typeof c.key === "string") return c.key;
  const apps = Array.isArray(ctx.snapshot?.doc?.appendices) ? ctx.snapshot.doc.appendices : [];
  const idx = apps.findIndex((a) => a === c || (!!c.blockId && a.blockId === c.blockId));
  return idx >= 0 ? String.fromCharCode(65 + idx) : (block.unitKey ?? "");
}

function anchorId(prefix: string, key: string): string | undefined {
  const k = key.replace(/[^A-Za-z0-9_-]/g, "");
  return k ? `${prefix}-${k}` : undefined;
}

/**
 * Kicker bawaan pembuka bab/lampiran (FIX-2, F-055): teks dari sumber bersama DOCX
 * `engine/front/texts.ts`. Lampiran = pembuka DOCX `renderAppendixOpener`
 * (`appendix.kicker.pattern` bila diset, selain itu "Lampiran A" / "Appendix A");
 * bab = pola P4A-04 seperti DOCX `structure.ts` (EN + pola bawaan = "CHAPTER {n}";
 * bab di unit lampiran atau berkunci huruf memakai pola lampiran).
 */
export function defaultKicker(ctx: RenderContext, kind: "chapter" | "appendix", key: string, unitKey?: string): string {
  const p = ctx.tpl?.params ?? {};
  const lang = language(ctx);
  if (kind === "appendix") return appendixOpenerKickerText(key, lang, p["appendix.kicker.pattern"]);
  const inAppendixUnit = unitKey !== undefined && ctx.snapshot?.units?.find((u) => u.key === unitKey)?.kind === "appendix";
  return chapterKickerText(p["chapter.kicker.pattern"], p["appendix.kicker.pattern"], key, inAppendixUnit || /^[A-Z]{1,2}$/.test(key), lang);
}

/**
 * Ukuran mm turunan wajib (D-245 H1, D-271 FIX-X): nilai sah pertama dari `keys` di
 * parameter templat; absen = log error + BY_CONSTRUCTION_FAILED (tanpa cadangan literal A4).
 */
export function requiredParamMm(ctx: RenderContext, block: NormBlock, keys: readonly string[], what: string): number {
  const p = ctx.tpl?.params ?? {};
  for (const key of keys) {
    const v = finite(p[key], 1, 1000);
    if (v !== undefined) return v;
  }
  const message = `engine/html/blocks: ${what} tidak terbaca: ${keys.join(" / ")} wajib ada di parameter templat`;
  ctx.log({ level: "error", message, code: "BY_CONSTRUCTION_FAILED", address: block.address ?? block.blockId });
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, { blockId: block.blockId, keys: [...keys] });
}

/**
 * C22b / GF-21 (R-74 `render.rhythm.snapToBaseline`, opt-in): format paragraf `para` dengan jarak dan tinggi baris
 * dikunci ke garis dasar, aturan bersama DOCX (`docx/blocks/rhythm.ts`: jarak ke kelipatan terdekat dengan minimum
 * satu garis dasar, jadi jarak bukan nol tidak pernah 0 (review C34 #5); tinggi baris exact/atLeast ke atas; medan
 * absen tetap absen). Opt-in mati = undefined (format pemanggil apa adanya).
 */
function onBaseline(ctx: RenderContext, para: ParaFormat | undefined): ParaFormat | undefined {
  const base = baselineSnapTw((k) => ctx.tpl?.params?.[k]);
  return base === undefined ? undefined : snapParaToBaseline(para ?? {}, base);
}

function chapterHead(block: NormBlock, ctx: RenderContext, kind: "chapter" | "appendix"): string {
  const c = contentOf<Chapter>(ctx, block);
  if (!c) return "";
  if (!hasInline(c.title)) return reportBad(ctx, block, "tanpa title");
  const key = kind === "appendix" ? appendixKey(block, ctx, c) : chapterKey(block, c);
  // IMPL-W4: kicker kosong eksplisit (penomoran sumber) = tanpa paragraf kicker, sama dengan DOCX structure.ts.
  const kicker = kickerSuppressed(c.kicker) ? "" : el(
    ctx,
    "p",
    // R-74: kicker/judul bab dikunci (DOCX structure.ts); pembuka lampiran tidak (DOCX wrapper/pages.ts, engine E).
    { classes: [C.chapterKicker], role: "chapter.kicker", format: kind === "chapter" ? onBaseline(ctx, roleFormat(ctx, "chapter.kicker").para) : undefined },
    hasInline(c.kicker) ? inlineHtml(c.kicker, DEFAULT_MD_ROLES, semanticTransform(ctx, undefined, baseRun(ctx, "chapter.kicker"))) : escapeHtml(defaultKicker(ctx, kind, key, block.unitKey)),
  );
  // Datum Rule bab = kolom teks turunan (sama dengan DOCX `structure.ts` requiredNum("grid.textColumnMm")).
  // FIX-F C2: hanya bila penempatan `atas judul bab` (DOCX `datumRuleEnabled` / `rulePlaced`, engine/front/apparatus).
  const rule = datumRulePlaced(ctx.tpl?.params ?? {}, "atas judul bab")
    ? datumRuleHtml(ctx, "chapter.datumRule", requiredParamMm(ctx, block, ["grid.textColumnMm"], "lebar Datum Rule bab"))
    : "";
  const titleFormat = kind === "chapter" ? onBaseline(ctx, roleFormat(ctx, "chapter.title").para) : undefined;
  const title = el(ctx, "h2", { classes: [C.heading, C.chapterTitle], role: "chapter.title", format: titleFormat }, inlineHtml(c.title, DEFAULT_MD_ROLES, semanticTransform(ctx, undefined, baseRun(ctx, "chapter.title"))));
  return `<header class="${kind === "appendix" ? C.appendixHead : C.chapterHead}"${attr("id", anchorId(kind === "appendix" ? "st-app" : "st-ch", key))}${attr("data-address", block.address ?? undefined)}${attr("data-block", block.blockId)}${attr("data-head", kind)}>${kicker}${rule}${title}</header>`;
}

/** Kepala bab: kicker (BAB n), Datum Rule selebar kolom teks turunan, judul. Seksi dan blok dirender sebagai NormBlock terpisah. */
export const renderChapter: HtmlBlockRenderer = (block, ctx) => chapterHead(block, ctx, "chapter");

/** Pembuka lampiran: kicker LAMPIRAN X, Datum Rule, judul (rantai format pembungkus = DOCX `renderAppendixOpener`, ENG-01). */
export const renderAppendix: HtmlBlockRenderer = (block, ctx) => chapterHead(block, wrapperScope(ctx), "appendix");

export const renderSection: HtmlBlockRenderer = (block, ctx) => {
  const s = contentOf<Section>(ctx, block);
  if (!s) return "";
  if (!hasInline(s.title)) return reportBad(ctx, block, "tanpa title");
  // IMPL-W4: nomor kosong eksplisit (penomoran sumber; nomor ada di judul) = tanpa nomor, sama dengan DOCX.
  const number = typeof s.number === "string" ? s.number : (block.address ?? "");
  const rf = roleFormat(ctx, "section.heading");
  const ns = runStyle(rf.numberRun, 0, ctx.tpl);
  const n = classStyle([C.sectionNumber, ...ns.classes], ns.decl);
  const numberHtml = number ? `<span${attr("class", n.cls)}${attr("style", n.style)}>${escapeHtml(number)}</span><span class="${C.tab}">\t</span>` : "";
  return el(
    ctx,
    "h3",
    {
      classes: [C.heading, C.sectionHeading],
      role: "section.heading",
      format: onBaseline(ctx, mergePara(rf.para, s.headingFormat)) ?? s.headingFormat,
      address: block.address,
      blockId: block.blockId,
      attrs: [["id", anchorId("st-sec", (number || (block.address ?? "")).replace(/\./g, "-"))]],
    },
    `${numberHtml}<span class="${C.sectionTitle}">${inlineHtml(s.title, DEFAULT_MD_ROLES, semanticTransform(ctx, undefined, baseRun(ctx, "section.heading")))}</span>`,
  );
};
