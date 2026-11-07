/**
 * Format langsung halaman pembungkus (S18).
 *
 * Lapisan resolusi satu paragraf/run (01_specs.md §5.6):
 *   format eksplisit blok > `roleFormats[role]` templat (sub-objek utuh)
 *   > turunan katalog (S11 `resolveRoleFormat`, per atribut)
 *   > nilai terukur benchmark di berkas ini (klaster research/07).
 * Lapisan terakhir menggantikan "gaya Normal" untuk peran pembungkus yang
 * tidak punya unsur skala katalog, sehingga templat tanpa profil tetap
 * menghasilkan sampul/lembar kendali bergaya DATUM.
 */
import type { Borders, Cell, Hex, ParaFormat, ParamMap, ParamValue, RenderContext, RoleFormat, RoleKey, RunProps, Shading } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { SEAL_BAND_TEXT_HEX } from "../../front/texts";
import { resolveRoleFormat } from "../../tokens";
import { resolveUnitSetup } from "../package/section";
import { isTocSectionRole, TOC_ROLE_PARENT, tocSectionIndentTw, tocSectionSize } from "./toc-refs";
import { mmToTw } from "./xml";

// ── Warna (research/07 RS; param color.* menimpa) ────────────────────────

export interface WrapperPalette {
  ink: Hex; // 14110F
  body: Hex; // 33302C
  meta: Hex; // 7A756E
  rule: Hex; // C4BEB4
  seal: Hex; // 6E1420
  cream: Hex; // F6E9E9
  interiorInk: Hex; // 101418
  signal: Hex; // B45309
}

function hexParam(p: ParamMap, key: string, fallback: Hex): Hex {
  const v = p[key];
  return typeof v === "string" && /^[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : fallback;
}

export function palette(p: ParamMap): WrapperPalette {
  return {
    ink: hexParam(p, "color.wrapper.ink", "14110F"),
    body: hexParam(p, "color.wrapper.body", "33302C"),
    meta: hexParam(p, "color.wrapper.meta", "7A756E"),
    rule: hexParam(p, "color.wrapper.rule", "C4BEB4"),
    seal: hexParam(p, "color.wrapper.seal", "6E1420"),
    cream: hexParam(p, "color.wrapper.cream", "F6E9E9"),
    interiorInk: hexParam(p, "color.interior.ink900", "101418"),
    signal: hexParam(p, "color.interior.signal", "B45309"),
  };
}

// ── Akses parameter ──────────────────────────────────────────────────────

export function pStr(p: ParamMap, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

export function pNum(p: ParamMap, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function pBool(p: ParamMap, key: string, fallback: boolean): boolean {
  const v = p[key];
  return typeof v === "boolean" ? v : fallback;
}

export function pList(p: ParamMap, key: string): ParamValue[] | undefined {
  const v = p[key];
  return Array.isArray(v) ? v : undefined;
}

export function pStrList(p: ParamMap, key: string, fallback: readonly string[]): string[] {
  const v = pList(p, key);
  return v ? v.filter((x): x is string => typeof x === "string") : [...fallback];
}

// ── Nilai terukur benchmark per peran pembungkus ─────────────────────────

/** Format tingkat sel (registri TCP research/07 §5.3). */
export interface CellFormat {
  borders?: Omit<Borders, "insideH" | "insideV">;
  marginsTw?: Cell["marginsTw"];
  shading?: Shading;
}

const ex = (before: number, after: number, line: number, more: ParaFormat = {}): ParaFormat => ({
  spacingBeforeTw: before,
  spacingAfterTw: after,
  lineTw: line,
  lineRule: "exact",
  ...more,
});
const auto = (before: number, after: number, more: ParaFormat = {}): ParaFormat => ({
  spacingBeforeTw: before,
  spacingAfterTw: after,
  lineTw: 240,
  lineRule: "auto",
  ...more,
});

const cond = (szHalfPt: number, color: Hex, more: RunProps = {}): RunProps => ({ faceRole: "condensed", szHalfPt, color, b: false, i: false, ...more });
const serif = (szHalfPt: number, color: Hex, more: RunProps = {}): RunProps => ({ faceRole: "serif", szHalfPt, color, b: false, i: false, ...more });
const mono = (szHalfPt: number, color: Hex, more: RunProps = {}): RunProps => ({ faceRole: "mono", szHalfPt, color, b: false, i: false, ...more });

/** Peran pembungkus yang dikenali modul ini (subset RoleKey §5.6). */
export type WrapperRole =
  | "cover.logo"
  | "cover.addressLine"
  | "cover.hairline"
  | "wrapper.datumRule"
  | "wrapper.kicker"
  | "cover.titleFirst"
  | "cover.titleLast"
  | "cover.standfirst"
  | "cover.scopeLine"
  | "cover.identityString"
  | "front.kicker"
  | "front.pageTitle"
  | "controlSheet.blockHeading"
  | "controlSheet.methodStatement"
  | "toc.title"
  | "toc.note"
  | "part.title"
  | "part.lede"
  | "chapter.kicker"
  | "chapter.datumRule"
  | "chapter.title"
  | "wrapper.sealBand"
  | "cover.controlLabel"
  | "cover.controlValue"
  | "cover.colophonLeft"
  | "cover.colophonRight"
  | "controlTable.header"
  | "controlTable.cell"
  | "signature.space"
  | "toc.partLabel"
  | "toc.partTitle"
  | "toc.partPage"
  | "toc.chapterLabel"
  | "toc.chapterTitle"
  | "toc.chapterPage"
  | "toc.sectionLabel"
  | "toc.sectionTitle"
  | "toc.sectionPage"
  | "toc.appendixLabel"
  | "toc.appendixTitle"
  | "toc.appendixPage"
  | "part.chapterNo"
  | "part.chapterTitle"
  | "spacer.generic"
  | "body.paragraph"
  | "caption"
  | "figure.source";

export interface WrapperRoleFormat extends RoleFormat {
  cell?: CellFormat;
}

/**
 * Nilai klaster benchmark (research/07 §3-§5: K-01..K-25, KT-01..KT-17,
 * TCP-01..TCP-13, RS02..RS38). Warna diambil dari palet agar template yang
 * mengganti token warna tetap konsisten.
 */
export function benchmarkRole(role: WrapperRole, p: ParamMap): WrapperRoleFormat {
  const c = palette(p);
  const ruleBottom = { val: "single" as const, sz: 5, color: c.rule, space: 0 };
  const titleSz = Math.round((pNum(p, "cover.title.sizePt") ?? 25) * 2);
  switch (role) {
    case "cover.logo": // K-01
      return { para: auto(360, 0) };
    case "cover.addressLine": // K-02, RS02
      return { para: ex(100, 80, 210), run: cond(14, c.meta) };
    case "cover.hairline": // K-03
      return { para: ex(0, 800, 120, { borders: { bottom: { val: "single", sz: 5, color: c.rule, space: 1 } } }) };
    case "wrapper.datumRule": // K-04
      return { para: auto(0, 140) };
    case "wrapper.kicker": // K-05, RS03
      return { para: ex(0, 160, 220), run: cond(14, c.seal, { b: true, caps: true, spacingTw: 30 }) };
    case "cover.titleFirst": // K-06, RS04
      return { para: ex(0, 0, 580), run: cond(titleSz, c.ink, { b: true }) };
    case "cover.titleLast": // K-07
      return { para: ex(0, 180, 580), run: cond(titleSz, c.ink, { b: true }) };
    case "cover.standfirst": // K-08, RS05
      return {
        para: ex(0, 120, 300, { indRightTw: 1701 }),
        run: serif(21, c.body, { i: pBool(p, "cover.standfirst.italic", true) }),
      };
    case "cover.scopeLine": // K-09, RS06
      return { para: ex(0, 520, 240, { indRightTw: 1134 }), run: cond(15, c.meta) };
    case "cover.identityString": // K-11, RS07
      return {
        para: ex(200, 0, 180),
        run: mono(Math.round((pNum(p, "device.spine.sizePt") ?? 6) * 2), c.meta, { spacingTw: 24 }),
      };
    case "front.kicker": // K-13, RS03
      return { para: ex(360, 120, 220), run: cond(14, c.seal, { b: true, caps: true, spacingTw: 30 }) };
    case "front.pageTitle": // K-14, RS08
      return { para: ex(0, 200, 400), run: cond(32, c.ink, { b: true }) };
    case "controlSheet.blockHeading": // K-15, RS09
      return { para: ex(0, 60, 240), run: cond(18, c.ink, { b: true }) };
    case "controlSheet.methodStatement": // K-17, RS10 (+ RS11 glif DejaVu)
      return {
        para: ex(0, 160, 250, { jc: "both", indRightTw: 1701 }),
        run: serif(17, c.body),
        glyphRun: {
          TERUKUR: { faceRole: "symbolGlyph", szHalfPt: 15, color: c.body },
          DITURUNKAN: { faceRole: "symbolGlyph", szHalfPt: 15, color: c.body },
          PEMASOK: { faceRole: "symbolGlyph", szHalfPt: 15, color: c.body },
          ASUMSI: { faceRole: "symbolGlyph", szHalfPt: 15, color: c.body },
        },
      };
    case "toc.title": // K-18, RS08
      return { para: ex(0, 160, 400), run: cond(32, c.ink, { b: true }) };
    case "toc.note": // K-19, RS02
      return { para: ex(160, 0, 200, { indRightTw: 1701 }), run: cond(14, c.meta) };
    case "part.title": // K-21, RS12
      return { para: ex(0, 180, 560, { outlineLvl: 0 }), run: cond(48, c.ink, { b: true }) };
    case "part.lede": // K-22, RS05
      return { para: ex(0, 360, 300, { indRightTw: 2154 }), run: serif(21, c.body, { i: true }) };
    case "chapter.kicker": // K-23, RS13
      return { para: ex(0, 80, 180, { keepNext: true }), run: cond(13, c.signal, { b: true, caps: true, spacingTw: 28 }) };
    case "chapter.datumRule": // K-24
      return { para: auto(0, 80, { keepNext: true }) };
    case "chapter.title": // K-25, RS14
      return { para: ex(0, 140, 400, { keepNext: true, outlineLvl: 0 }), run: cond(32, c.interiorInk, { b: true }) };
    case "wrapper.sealBand": // KT-01/02, RS27, TCP-01
      return {
        para: ex(0, 0, 180, { jc: "left" }),
        // Swarm patch (I-2, C69 FIX CP-07; ID p.49 Tabel 8.1, p.89): band text #F4F5F6 as the HTML engine (row 123), not cream.
        // Swarm patch (row 49a, C104 M1): 6,5 pt (w:sz 13), the nearest Word half point to Rev A Tab A.2 "pita segel 6,4"
        // (manual_id.txt:4920), as the C54 kicker ruling; was 6,0 pt (cond(12)). The HTML band follows this role.
        run: cond(13, SEAL_BAND_TEXT_HEX, { b: true, caps: true, spacingTw: 26 }),
        cell: { marginsTw: { top: 85, left: 141, bottom: 85, right: 141 }, shading: { fill: c.seal, val: "clear" } },
      };
    case "cover.controlLabel": // KT-03, RS28, TCP-04 (baris pertama TCP-03)
      return {
        para: ex(0, 0, 220),
        run: cond(12, c.meta, { b: true, caps: true, spacingTw: 14 }),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 85, left: 0, bottom: 85, right: 170 } },
      };
    case "cover.controlValue": // KT-04, RS29
      return {
        para: ex(0, 0, 220),
        run: mono(14, c.ink),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 85, left: 0, bottom: 85, right: 170 } },
      };
    case "cover.colophonLeft": // KT-05, RS30, TCP-05
      return {
        para: ex(0, 0, 180, { jc: "left" }),
        run: mono(12, c.meta),
        cell: { borders: { top: ruleBottom }, marginsTw: { top: 102, left: 0, bottom: 0, right: 0 } },
      };
    case "cover.colophonRight": // KT-06, RS31
      return {
        para: ex(0, 0, 180, { jc: "right" }),
        run: mono(12, c.seal, { b: true }),
        cell: { borders: { top: ruleBottom }, marginsTw: { top: 102, left: 0, bottom: 0, right: 0 } },
      };
    case "controlTable.header": // KT-07, RS32, TCP-06
      return {
        para: ex(0, 0, 180),
        run: cond(13, c.meta, { b: true, caps: true, spacingTw: 12 }),
        cell: {
          borders: { top: { val: "single", sz: 10, color: c.ink, space: 0 }, bottom: { val: "single", sz: 6, color: c.meta, space: 0 } },
          marginsTw: { top: 85, left: 0, bottom: 85, right: 141 },
        },
      };
    case "controlTable.cell": // KT-08, RS33, TCP-07
      return {
        para: ex(0, 0, 220),
        run: serif(16, c.body),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 79, left: 0, bottom: 79, right: 141 } },
      };
    case "signature.space": // KT-09, TCP-09
      return { para: ex(0, 0, 680), cell: { marginsTw: { top: 0, left: 0, bottom: 0, right: 226 } } };
    case "toc.partLabel": // KT-10, RS34, TCP-11
      return {
        para: ex(0, 0, 200),
        run: cond(13, c.seal, { b: true, caps: true, spacingTw: 18 }),
        cell: { borders: { bottom: { val: "single", sz: 8, color: c.ink, space: 0 } }, marginsTw: { top: 124, left: 0, bottom: 62, right: 113 } },
      };
    case "toc.partTitle": // KT-11, RS35
      return {
        para: ex(0, 0, 200),
        run: cond(17, c.ink, { b: true }),
        cell: { borders: { bottom: { val: "single", sz: 8, color: c.ink, space: 0 } }, marginsTw: { top: 124, left: 0, bottom: 62, right: 113 } },
      };
    case "toc.partPage": // KT-12, RS36
      return {
        para: ex(0, 0, 200, { jc: "right" }),
        run: mono(14, c.ink, { b: true }),
        cell: { borders: { bottom: { val: "single", sz: 8, color: c.ink, space: 0 } }, marginsTw: { top: 124, left: 0, bottom: 62, right: 113 } },
      };
    case "toc.chapterLabel": // KT-13, RS37, TCP-12
      return {
        para: ex(0, 0, 200),
        run: mono(14, c.meta),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 62, left: 0, bottom: 62, right: 113 } },
      };
    case "toc.chapterTitle": // KT-14, RS33
      return {
        para: ex(0, 0, 200),
        run: serif(16, c.body),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 62, left: 0, bottom: 62, right: 113 } },
      };
    case "toc.chapterPage": // KT-15, RS29
      return {
        para: ex(0, 0, 200, { jc: "right" }),
        run: mono(14, c.ink),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 62, left: 0, bottom: 62, right: 113 } },
      };
    case "toc.sectionLabel":
    case "toc.sectionTitle":
    case "toc.sectionPage":
    case "toc.appendixLabel":
    case "toc.appendixTitle":
    case "toc.appendixPage": {
      // FIX-TL: tanpa nilai terukur benchmark; turunan dari peran bab (lihat `tocDerivedFormat`).
      const parent = TOC_ROLE_PARENT[role] as WrapperRole;
      return tocDerivedFormat(role, benchmarkRole(parent, p), p);
    }
    case "part.chapterNo": // KT-16, RS37, TCP-13
      return {
        para: ex(0, 0, 220),
        run: mono(14, c.meta),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 79, left: 0, bottom: 79, right: 113 } },
      };
    case "part.chapterTitle": // KT-17, RS38
      return {
        para: ex(0, 0, 220),
        run: cond(18, c.ink),
        cell: { borders: { bottom: ruleBottom }, marginsTw: { top: 79, left: 0, bottom: 79, right: 113 } },
      };
    case "spacer.generic": // K-10/K-16/K-20 (nilai per tempat ditulis pemanggil)
      return { para: ex(0, 0, 160) };
    case "body.paragraph": // K-28, RS17
      return { para: ex(0, 135, 270, { jc: "both" }), run: serif(19, "2B3640") };
    case "caption": // K-29, RS19/RS20
      return {
        para: ex(120, 48, 220, { keepNext: true }),
        run: cond(15, "2B3640"),
        labelRun: cond(14, c.interiorInk, { b: true, caps: true, spacingTw: 16 }),
      };
    case "figure.source": // K-34, RS23/RS24
      return {
        para: ex(0, 0, 180, { borders: { top: { val: "single", sz: 5, color: "C3CBD1", space: 1 } } }),
        run: cond(13, "6B7783"),
        labelRun: cond(13, "6B7783", { b: true, spacingTw: 12 }),
      };
  }
}

/** Gabungan per atribut; `over` menang. */
function mergeRun(base: RunProps | undefined, over: RunProps | undefined): RunProps | undefined {
  if (!base) return over;
  if (!over) return base;
  const out: RunProps = { ...base, ...over };
  if (over.face) delete out.faceRole;
  if (over.faceRole) delete out.face;
  return out;
}

function mergePara(base: ParaFormat | undefined, over: ParaFormat | undefined): ParaFormat | undefined {
  if (!base) return over;
  if (!over) return base;
  return { ...base, ...over };
}

/**
 * Gaya bawaan peran entri TOC turunan (FIX-TL, D-351/D-352) dari format peran bab:
 * section = indentasi tingkat 2 (`tocSectionIndentTw`, label dan judul; halaman tidak)
 * + run 1 pt lebih kecil (`tocSectionSize`); lampiran = format bab apa adanya.
 */
function tocDerivedFormat(role: WrapperRole, parent: WrapperRoleFormat, p: ParamMap): WrapperRoleFormat {
  if (!isTocSectionRole(role as RoleKey)) return parent;
  const out: WrapperRoleFormat = { ...parent };
  if (role !== "toc.sectionPage") {
    const indent = tocSectionIndentTw(p) + (parent.para?.indLeftTw ?? 0);
    out.para = { ...(parent.para ?? {}), indLeftTw: indent };
  }
  const sz = tocSectionSize(parent.run?.szHalfPt);
  if (parent.run && sz !== undefined) out.run = { ...parent.run, szHalfPt: sz };
  return out;
}

/**
 * C11 / CV-20 (R-70, opt-in): jorokan kanan peran judul sampul agar baris judul paling lebar
 * `cover.title.maxWidthMm` (manual ID:2480, EN:2552: <= 150 mm) = bentang penuh `grid.fullSpanMm` - nilai
 * (166 - 150 = 16 mm = 907 tw). `null`/absen, atau nilai >= bentang = tanpa jorokan (keluaran sekarang).
 */
export function coverTitleIndentTw(p: ParamMap): number | undefined {
  const max = pNum(p, "cover.title.maxWidthMm");
  const span = pNum(p, "grid.fullSpanMm");
  if (max === undefined || span === undefined || max >= span) return undefined;
  return mmToTw(span - max);
}

/**
 * Row 122c (Swarm 1.2.0, C96 O1): cover title leading, one rule for DOCX and HTML = title size + 4 pt, exact.
 * Manual Rev A ID p.47 butir 7 and p.90 Tabel A.2 set the title at 24-26 pt Cond 600 without a leading; the
 * manual's own cover (ID p.1) sets its two 24 pt title lines 28 pt apart (baselines 287.1 and 315.1 pt in the
 * PDF), as does the DATUM sample report (w:line 560 for w:sz 48). 25 pt -> 29 pt keeps the benchmark K-06.
 */
export function coverTitleLineTw(szHalfPt: number): number {
  return Math.round((szHalfPt / 2 + 4) * 20);
}

/**
 * Format efektif satu peran: benchmark <- katalog (per atribut) <- templat
 * `roleFormats` (sub-objek utuh, semantik S11 D-37a).
 * Peran entri TOC turunan (`toc.section*`, `toc.appendix*`; FIX-TL) mewarisi format
 * EFEKTIF peran bab (termasuk `roleFormats` bab templat), diturunkan, lalu sub-objek
 * yang disetel templat untuk peran itu sendiri menang utuh.
 */
export function roleFormat(ctx: RenderContext, role: WrapperRole): WrapperRoleFormat {
  const parent = TOC_ROLE_PARENT[role as RoleKey] as WrapperRole | undefined;
  if (parent) {
    const derived = tocDerivedFormat(role, roleFormat(ctx, parent), ctx.tpl.params);
    const own = ctx.tpl.roleFormats[role as RoleKey];
    if (!own) return derived;
    const out: WrapperRoleFormat = { ...derived };
    for (const k of Object.keys(own) as Array<keyof RoleFormat>) {
      if (own[k] !== undefined) (out as Record<string, unknown>)[k] = own[k];
    }
    return out;
  }
  const base = benchmarkRole(role, ctx.tpl.params);
  const resolved = resolveRoleFormat(ctx.tpl, role as RoleKey);
  const tplOwn = ctx.tpl.roleFormats[role as RoleKey];
  const pick = <K extends keyof RoleFormat>(k: K, merge: (a: RoleFormat[K], b: RoleFormat[K]) => RoleFormat[K]): RoleFormat[K] => {
    if (tplOwn && tplOwn[k] !== undefined) return tplOwn[k];
    return merge(base[k], resolved[k]);
  };
  const titleRole = role === "cover.titleFirst" || role === "cover.titleLast";
  const run = pick("run", mergeRun);
  const titleSz = run?.szHalfPt;
  // Row 122c: the manual's cover title leading unless the template sets its own line height for the role.
  const leadPara = pick("para", mergePara);
  const para = titleRole && typeof titleSz === "number" && tplOwn?.para?.lineTw === undefined
    ? { ...leadPara, lineTw: coverTitleLineTw(titleSz), lineRule: "exact" as const }
    : leadPara;
  const titleIndent = titleRole ? coverTitleIndentTw(ctx.tpl.params) : undefined;
  return {
    para: titleIndent === undefined ? para : { ...para, indRightTw: titleIndent },
    run,
    labelRun: pick("labelRun", mergeRun),
    numberRun: pick("numberRun", mergeRun),
    markerRun: pick("markerRun", mergeRun),
    glyphRun: pick("glyphRun", (a, b) => b ?? a),
    cell: tplOwn?.cell ?? resolved.cell ?? base.cell,
  };
}

/** Format paragraf peran ditimpa format eksplisit blok. */
export function paraOf(ctx: RenderContext, role: WrapperRole, explicit?: ParaFormat): ParaFormat | undefined {
  return mergePara(roleFormat(ctx, role).para, explicit);
}

export function runOf(ctx: RenderContext, role: WrapperRole, explicit?: RunProps): RunProps {
  return mergeRun(roleFormat(ctx, role).run, explicit) ?? {};
}

export { mergePara, mergeRun };

// ── Geometri halaman ─────────────────────────────────────────────────────

/**
 * Lebar teks seksi unit (twip) = pgSz - kiri - kanan - gutter dari
 * `resolveUnitSetup` (SR-16 / IP-50): setup unit v1, `slot.setup` + orientasi
 * slot untuk unit sadar slot, setup templat jenis unit
 * (`render.section.wrapper|interior`, RT-01) dan ukuran halaman dari kenop.
 * Unit tak dikenal (atau lebar tidak positif) memakai `grid.fullSpanMm`
 * turunan; tanpa literal cadangan: bila param itu absen = BY_CONSTRUCTION_FAILED.
 */
export function textWidthTw(ctx: RenderContext, unitKey: string): number {
  const unit = ctx.snapshot.units.find((u) => u.key === unitKey);
  if (unit) {
    const s = resolveUnitSetup(unit, ctx.tpl);
    const w = s.pageSizeTw[0] - s.marginTw.left - s.marginTw.right - s.marginTw.gutter;
    if (w > 0) return w;
  }
  const span = pNum(ctx.tpl.params, "grid.fullSpanMm");
  if (span === undefined || span <= 0) {
    throw new StudioEngineError(
      "BY_CONSTRUCTION_FAILED",
      `Lebar teks unit ${unitKey} tidak terbaca: unit tanpa setup sah dan grid.fullSpanMm absen`,
    );
  }
  return mmToTw(span);
}

/** Bulan Romawi untuk string punggung dan nomor dokumen (BM: "X" = Oktober). */
export const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] as const;

const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

export function dateParts(iso: string): DateParts | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  const out = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return out.m >= 1 && out.m <= 12 ? out : undefined;
}

/** "8 Oktober 2026" / "8 October 2026"; tanggal tak terurai dikembalikan apa adanya. */
export function longDate(iso: string, lang: "ID" | "EN"): string {
  const d = dateParts(iso);
  if (!d) return iso;
  return `${d.d} ${(lang === "EN" ? MONTHS_EN : MONTHS_ID)[d.m - 1]} ${d.y}`;
}

/** Angka Romawi 1..39 untuk label Bagian otomatis. */
export function roman(n: number): string {
  const table: Array<[number, string]> = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  let v = Math.max(1, Math.floor(n));
  for (const [k, s] of table) {
    while (v >= k) {
      out += s;
      v -= k;
    }
  }
  return out;
}
