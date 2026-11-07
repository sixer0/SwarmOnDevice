/**
 * Resolusi format keluarga tabel (S17): parameter efektif, format peran per
 * sel (klaster KT-xx, 01_specs.md §13.2), border/margin/shading per sel
 * (registri TCP research/07 §5.3), dan md-lite sel.
 *
 * Urutan resolusi per sel: format eksplisit blok/sel > `roleFormats[peran]`
 * templat > turunan katalog (S11 `resolveRoleFormat`) > penyempurnaan Tabel
 * 5.1 (research/04 T038) dan nilai terukur BM (research/07 TCP-15..19, KT-23..28)
 * yang dipakai hanya bila templat tidak membawa format terukur untuk peran itu.
 */
import type {
  BorderSpec,
  Borders,
  Cell,
  ParaFormat,
  ParamMap,
  ParamValue,
  ProvenanceMark,
  ResolvedTemplate,
  RoleFormat,
  RoleKey,
  Run,
  RunProps,
  Shading,
} from "../../../contract";
import { PROVENANCE_GLYPHS } from "../../../contract/enums";
import { StudioNotImplemented } from "../../../contract/errors";
import { ALL_PARAMS } from "../../../params";
import { resolveRoleFormat, resolveTokenColor } from "../../tokens";
import { parseMdLite } from "../blocks";

// ── Parameter efektif ────────────────────────────────────────────────────

let defaultParams: Readonly<Record<string, ParamValue>> | undefined;

function catalogDefaults(): Readonly<Record<string, ParamValue>> {
  if (!defaultParams) {
    const out: Record<string, ParamValue> = {};
    for (const d of ALL_PARAMS) if (d.default !== null && d.default !== undefined) out[d.key] = d.default;
    defaultParams = Object.freeze(out);
  }
  return defaultParams;
}

const effCache = new WeakMap<ResolvedTemplate, ResolvedTemplate>();

/**
 * Templat dengan parameter = default registri <- `tpl.params`, agar renderer
 * tetap berbentuk benar bila templat hanya membawa sebagian parameter.
 */
export function effectiveTemplate(tpl: ResolvedTemplate): ResolvedTemplate {
  const hit = effCache.get(tpl);
  if (hit) return hit;
  const eff: ResolvedTemplate = { ...tpl, params: Object.freeze({ ...catalogDefaults(), ...tpl.params }) };
  effCache.set(tpl, eff);
  return eff;
}

export function pNum(p: ParamMap, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function pBool(p: ParamMap, key: string, fallback: boolean): boolean {
  const v = p[key];
  return typeof v === "boolean" ? v : fallback;
}

export function pStr(p: ParamMap, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

export function pObj(p: ParamMap, key: string): Record<string, ParamValue> | undefined {
  const v = p[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, ParamValue>) : undefined;
}

export function pList(p: ParamMap, key: string): ParamValue[] | undefined {
  const v = p[key];
  return Array.isArray(v) ? v : undefined;
}

// ── Garis ────────────────────────────────────────────────────────────────

const DEFAULT_LADDER = [5, 6, 8, 10, 11];

/** mm -> `w:sz` (1/8 pt) dikuantisasi ke tangga Word `rules.wordLadderSz` (0,45 -> 10, 0,25 -> 6, 0,20 -> 5). */
export function ruleSz(p: ParamMap, mm: number): number {
  const raw = (mm / 25.4) * 72 * 8;
  const list = pList(p, "rules.wordLadderSz");
  const ladder = list && list.every((x) => typeof x === "number") ? (list as number[]) : DEFAULT_LADDER;
  let best = ladder[0];
  for (const s of ladder) if (Math.abs(s - raw) < Math.abs(best - raw)) best = s;
  return best;
}

export type RuleKind = "primary" | "belowHeader" | "hair";

const RULE_KEYS: Readonly<Record<RuleKind, { mm: string; mmDefault: number; colour: string; colourDefault: string }>> = {
  primary: { mm: "rules.primaryMm", mmDefault: 0.45, colour: "rules.primary.colour", colourDefault: "101418" },
  belowHeader: { mm: "rules.belowHeaderMm", mmDefault: 0.25, colour: "rules.belowHeader.colour", colourDefault: "6B7783" },
  hair: { mm: "rules.hairMm", mmDefault: 0.2, colour: "rules.hair.colour", colourDefault: "C3CBD1" },
};

export function ruleBorder(tpl: ResolvedTemplate, kind: RuleKind, space?: number): BorderSpec {
  const k = RULE_KEYS[kind];
  const p = tpl.params;
  const color = resolveTokenColor(tpl, pStr(p, k.colour) ?? "") ?? k.colourDefault;
  return { val: "single", sz: ruleSz(p, pNum(p, k.mm, k.mmDefault)), color, ...(space !== undefined ? { space } : {}) };
}

/** Garis dari tokenRef garis (mis. `rules.primary` dari P5-10 / P4A-08). */
export function ruleFromRef(tpl: ResolvedTemplate, ref: ParamValue | undefined): BorderSpec {
  if (ref === "rules.belowHeader") return ruleBorder(tpl, "belowHeader");
  if (ref === "rules.hair") return ruleBorder(tpl, "hair");
  return ruleBorder(tpl, "primary");
}

// ── Peran sel ────────────────────────────────────────────────────────────

export type RowKind = "header" | "body" | "group" | "total" | "source";

type Margins = NonNullable<Cell["marginsTw"]>;
type SideBorders = Omit<Borders, "insideH" | "insideV">;

/** tcMar terukur BM (research/07 §5.3): TCP-15 kepala, TCP-16 badan, TCP-17 sumber, TCP-19 pita kelompok. */
const DEFAULT_MARGINS: Readonly<Record<RowKind, Margins>> = {
  header: { top: 102, left: 0, bottom: 102, right: 141 },
  body: { top: 85, left: 0, bottom: 85, right: 141 },
  total: { top: 85, left: 0, bottom: 85, right: 141 },
  group: { top: 192, left: 0, bottom: 68, right: 0 },
  source: { top: 102, left: 0, bottom: 0, right: 0 },
};

/** Spasi baris tepat cadangan per peran bila format peran tidak membawa `lineTw` (KT-23..28, KT-32, KT-38, KT-26). */
const FALLBACK_LINE_TW: Readonly<Partial<Record<RoleKey, number>>> = {
  "table.headerLeft": 180,
  "table.headerRight": 180,
  "table.cellMono": 210,
  "table.cellText": 220,
  "table.cellNumeralRight": 220,
  "table.cellGlyph": 210,
  "table.groupBand": 200,
  "table.source": 180,
  "cell.empty": 220,
};

export interface CellStyle {
  role: RoleKey;
  para: ParaFormat;
  run: RunProps;
  labelRun?: RunProps;
  glyphRun?: RoleFormat["glyphRun"];
  borders: SideBorders;
  margins: Margins;
  shading?: Shading;
  /** Templat membawa format terukur untuk peran ini. */
  measured: boolean;
}

const roleCache = new WeakMap<ResolvedTemplate, Map<RoleKey, RoleFormat>>();

export function roleFormat(tpl: ResolvedTemplate, role: RoleKey): RoleFormat {
  let m = roleCache.get(tpl);
  if (!m) {
    m = new Map();
    roleCache.set(tpl, m);
  }
  let rf = m.get(role);
  if (!rf) {
    rf = resolveRoleFormat(tpl, role);
    m.set(role, rf);
  }
  return rf;
}

function color(tpl: ResolvedTemplate, ref: string, fallback: string): string {
  return resolveTokenColor(tpl, ref) ?? fallback;
}

/** Penyempurnaan Tabel 5.1 (research/04 T038) untuk peran tanpa format terukur. */
function catalogRunTweaks(tpl: ResolvedTemplate, role: RoleKey): RunProps {
  switch (role) {
    case "table.groupBand":
      // Pita kelompok: Cond 600, 7,4 pt, kapital, ink900, tanpa isian.
      return { faceRole: "condensed", b: true, caps: true, szHalfPt: 15, color: color(tpl, "ink900", "101418") };
    case "table.cellGlyph":
      return { faceRole: "symbolGlyph" };
    default:
      return {};
  }
}

/** Format dasar sel untuk peran dan jenis baris (tanpa override sel). */
export function cellStyle(tpl: ResolvedTemplate, role: RoleKey, kind: RowKind): CellStyle {
  const rf = roleFormat(tpl, role);
  const measured = tpl.roleFormats[role] !== undefined;
  const line = FALLBACK_LINE_TW[role];
  const para: ParaFormat = {
    spacingBeforeTw: 0,
    spacingAfterTw: 0,
    ...(line !== undefined ? { lineTw: line, lineRule: "exact" as const } : {}),
    ...(rf.para ?? {}),
  };
  let run: RunProps = { ...(rf.run ?? {}) };
  if (!measured) run = { ...run, ...catalogRunTweaks(tpl, role) };
  let labelRun = rf.labelRun;
  if (!measured && role === "table.source") labelRun = { ...(labelRun ?? rf.run ?? {}), b: true };

  let borders: SideBorders;
  if (rf.cell?.borders) {
    borders = { ...rf.cell.borders };
  } else if (kind === "header") {
    borders = { top: ruleBorder(tpl, "primary"), bottom: ruleBorder(tpl, "belowHeader") };
  } else if (kind === "source") {
    borders = { top: ruleBorder(tpl, "hair") };
  } else if (kind === "total") {
    const ref = pObj(tpl.params, "table.totalRow.style")?.ruleAbove ?? tpl.params["table.totalRow.ruleAbove"];
    borders = { top: ruleFromRef(tpl, ref), bottom: ruleBorder(tpl, "hair") };
  } else {
    borders = { bottom: ruleBorder(tpl, "hair") };
  }
  const margins: Margins = rf.cell?.marginsTw ? { ...rf.cell.marginsTw } : { ...DEFAULT_MARGINS[kind] };
  return { role, para, run, labelRun, glyphRun: rf.glyphRun, borders, margins, shading: rf.cell?.shading, measured };
}

/** Run gaya satuan Tabel 5.1 (Cond 7,2 pt ink400) untuk kolom `role:"unit"` tanpa format terukur. */
export function unitRunTweak(tpl: ResolvedTemplate): RunProps {
  return { faceRole: "condensed", szHalfPt: 14, color: color(tpl, "ink400", "6B7783") };
}

/** Gaya baris total P4A-08: condensed 600 tanpa isian (numeral tetap mono, ditebalkan). */
export function totalRunTweak(tpl: ResolvedTemplate, numeric: boolean): RunProps {
  const st = pObj(tpl.params, "table.totalRow.style");
  const weight = typeof st?.weight === "number" ? st.weight : 600;
  const out: RunProps = { b: weight >= 600 };
  if (!numeric && (st?.face === undefined || st.face === "condensed")) out.faceRole = "condensed";
  return out;
}

// ── Glif provenans ───────────────────────────────────────────────────────

const MARK_KEY: Readonly<Record<ProvenanceMark, string>> = {
  TERUKUR: "terukur",
  DITURUNKAN: "diturunkan",
  PEMASOK: "pemasok",
  ASUMSI: "asumsi",
};

export function markGlyph(tpl: ResolvedTemplate, mark: ProvenanceMark): string {
  const g = pStr(tpl.params, `marks.${MARK_KEY[mark]}.glyph`);
  return g && g.length > 0 ? g : PROVENANCE_GLYPHS[mark];
}

/** Run glif: `glyphRun[mark]` peran > DejaVu (symbolGlyph) berwarna `marks.<m>.colour` (Tabel 5.3). */
export function markGlyphRun(tpl: ResolvedTemplate, mark: ProvenanceMark, glyphRun: RoleFormat["glyphRun"]): RunProps {
  const explicit = glyphRun?.[mark];
  if (explicit) return explicit;
  const c = resolveTokenColor(tpl, pStr(tpl.params, `marks.${MARK_KEY[mark]}.colour`) ?? "");
  return { faceRole: "symbolGlyph", ...(c ? { color: c } : {}) };
}

/** Teks sel hanya glif bentuk geometris / kotak centang (KT-38, RS56): U+25A0-25FF, U+2610-2612, U+2713-2717. */
export function isGlyphText(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  for (const ch of Array.from(t)) {
    const cp = ch.codePointAt(0) ?? 0;
    const ok = (cp >= 0x25a0 && cp <= 0x25ff) || (cp >= 0x2610 && cp <= 0x2612) || (cp >= 0x2713 && cp <= 0x2717) || ch === " ";
    if (!ok) return false;
  }
  return true;
}

// ── md-lite ──────────────────────────────────────────────────────────────

const MD_ROLES: { mono: RunProps; bold: RunProps; italic: RunProps } = {
  mono: { faceRole: "mono" },
  bold: { b: true },
  italic: { i: true },
};

/** Cadangan md-lite selama S16 belum mendarat: **tebal**, `mono`, *miring* (INLINE_RE datum_docx.py). */
function mdLiteFallback(text: string): Run[] {
  const re = /(\*\*.+?\*\*|`[^`]+`|\*[^*\n]+\*(?!\*))/g;
  const out: Run[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**") && tok.length > 4) out.push({ t: tok.slice(2, -2), ...MD_ROLES.bold });
    else if (tok.startsWith("`")) out.push({ t: tok.slice(1, -1), ...MD_ROLES.mono });
    else out.push({ t: tok.slice(1, -1), ...MD_ROLES.italic });
    last = m.index + tok.length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

/** md-lite lewat S16 `parseMdLite` (KS-03); cadangan lokal bila modul S16 masih stub. */
export function mdLite(text: string): Run[] {
  try {
    return parseMdLite(text, MD_ROLES);
  } catch (e) {
    if (e instanceof StudioNotImplemented) return mdLiteFallback(text);
    throw e;
  }
}
