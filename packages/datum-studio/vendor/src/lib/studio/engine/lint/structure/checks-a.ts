/**
 * Penegasan grup S (lint DATUM bermode HQ "S", module "structure"): cek yang
 * dijamin skema saat menyusun diperiksa ulang pada snapshot ternormalisasi.
 * Butir yang memang tidak dapat diungkapkan skema dilaporkan PASS dengan
 * detail "by-construction: <alasan>" (bukan dilewati diam-diam).
 *
 * Sumber aturan: research/01 §6.1 (Tabel 16.1), registry/lint.ts ROWS_A.
 */
import type {
  Cell,
  ColumnSpec,
  ParamValue,
  RegisterEntry,
  StudioChartV1,
  StudioDiagramV1,
  TableBlock,
} from "../../../contract";
import { PROVENANCE_MARKS } from "../../../contract/enums";
import { fmtFixed, numberConvention, numberPatternSources } from "../../bind/format";
import { derivedColorTokens, tintHex } from "../../tokens";
import { findings, notRun, pBool, pRaw, type CheckOutcome, type Finding, type StructCtx } from "./context";
import { hexesIn, scanProps, type PropScan } from "./props";
import { ADMIRALTY_GRADE, eighthsToMm, normHex } from "./text";
import { cellText, isFigureType, isTableType, ptr, textOf, type WalkItem } from "./walk";

// ── Bantu ─────────────────────────────────────────────────────────────────

const propCache = new WeakMap<StructCtx, PropScan>();
export function propsOf(ctx: StructCtx): PropScan {
  let p = propCache.get(ctx);
  if (!p) {
    p = scanProps(ctx.doc);
    propCache.set(ctx, p);
  }
  return p;
}

/** Pointer pemilik (blok terdekat) untuk agregasi temuan per blok. */
function ownerPointer(ctx: StructCtx, pointer: string): string {
  let p = pointer;
  while (p.length > 0) {
    if (ctx.walk.addressByPointer.has(p)) return p;
    const cut = p.lastIndexOf("/");
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return pointer.split("/").slice(0, 4).join("/");
}

function tables(ctx: StructCtx): Array<{ t: TableBlock; pointer: string; item: WalkItem }> {
  const out: Array<{ t: TableBlock; pointer: string; item: WalkItem }> = [];
  for (const item of ctx.walk.items) {
    if (!isTableType(item.block.type)) continue;
    const t = item.block as unknown as TableBlock;
    out.push({ t, pointer: item.pointer, item });
    (t.rows ?? []).forEach((r, ri) =>
      r.cells.forEach((c, ci) => {
        if (c.nested) out.push({ t: c.nested, pointer: `${item.pointer}/rows/${ri}/cells/${ci}/nested`, item });
      }),
    );
  }
  return out;
}

function figures(ctx: StructCtx): WalkItem[] {
  return ctx.walk.items.filter((i) => isFigureType(i.block.type));
}

function inlineSpec<T>(item: WalkItem, schema: string): T | undefined {
  const spec = item.block.spec as { $schema?: unknown } | undefined;
  return spec && spec.$schema === schema ? (spec as unknown as T) : undefined;
}

function label(item: WalkItem): string {
  return item.artifactLabel ?? item.address ?? item.pointer;
}

const TYPE_ROLE_DEFAULTS: Readonly<Record<string, readonly (ColumnSpec["role"] | undefined)[]>> = {
  specTable: ["text", "text", "numeral", "unit"],
};
const PRESET_ROLE_DEFAULTS: Readonly<Record<string, readonly (ColumnSpec["role"] | undefined)[]>> = {
  boq: ["id", "text", "numeral", "unit", "numeral", "numeral"],
  recap: ["id", "text", "numeral"],
  assumption: ["id", "text", "text", "text"],
};

/** Peran kolom: medan kolom, lalu default preset/jenis (sama dengan S17). */
export function columnRoles(t: TableBlock): Array<ColumnSpec["role"] | undefined> {
  const tokens = (t.preset ?? "").split(/[+\s,]+/).filter(Boolean);
  const presetDefault = tokens.map((k) => PRESET_ROLE_DEFAULTS[k]).find(Boolean);
  const dflt = presetDefault ?? TYPE_ROLE_DEFAULTS[t.type] ?? [];
  return (t.columns ?? []).map((c, i) => c.role ?? dflt[i]);
}

function hasUnitColumn(t: TableBlock): boolean {
  const roles = columnRoles(t);
  if (roles.includes("unit")) return true;
  if ((t.columns ?? []).some((c) => typeof c.unit === "string" && c.unit.trim() !== "")) return true;
  const head = (t.rows ?? []).filter((r) => r.kind === "header").map((r) => r.cells.map(cellText).join(" ")).join(" ");
  return /\b(satuan|unit)\b|\(([^)]{1,12})\)/i.test(head);
}

const WHITE: ReadonlySet<string> = new Set(["FFFFFF"]);

function isColoredFill(c: Cell | undefined): boolean {
  const hex = normHex(c?.shading?.fill);
  return hex !== undefined && !WHITE.has(hex);
}

// ── Cek ───────────────────────────────────────────────────────────────────

/** DATUM-01 Deret KPI tile/strip statistik. */
function a01(ctx: StructCtx): CheckOutcome {
  const tilesAllowed = pBool(ctx, "chart.dashboardTiles.allowedInDocument", false);
  const f: Finding[] = [];
  for (const it of figures(ctx)) {
    const spec = inlineSpec<StudioChartV1>(it, "studio.chart/v1");
    const p = spec?.params ?? {};
    if (!tilesAllowed && (p.kpiTiles === true || p.statStrip === true || p.gauge === true)) {
      f.push({ pointer: it.pointer, detail: `${label(it)}: chart meminta tile KPI/strip statistik/gauge (CH-13)` });
    }
  }
  return findings(f, "by-construction: skema studio.doc/v1 tidak memiliki jenis blok KPI tile atau strip statistik");
}

/** DATUM-02 Kotak callout berisi warna. */
function a02(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const it of ctx.walk.items) {
    const fmt = it.block.format as { shading?: { fill?: string } } | undefined;
    const hex = normHex(fmt?.shading?.fill);
    if (hex && !WHITE.has(hex)) f.push({ pointer: `${it.pointer}/format/shading`, detail: `blok ${it.block.type} berisi warna isian ${hex} (DT-20)` });
    if (it.block.type === "aside" || it.block.type === "monoBlock") {
      const body = ((it.block.body ?? it.block.lines) as Array<{ format?: { shading?: { fill?: string } } }>) ?? [];
      body.forEach((p, i) => {
        const h = normHex(p.format?.shading?.fill);
        if (h && !WHITE.has(h)) f.push({ pointer: `${it.pointer}/${it.block.type === "aside" ? "body" : "lines"}/${i}/format/shading`, detail: `isi ${it.block.type} berisi warna isian ${h} (DT-20)` });
      });
    }
  }
  return findings(f, "tidak ada callout/paragraf berisi warna isian");
}

const OFFICE_FACES: ReadonlySet<string> = new Set(
  [
    "calibri",
    "calibri light",
    "cambria",
    "cambria math",
    "arial",
    "arial narrow",
    "times new roman",
    "aptos",
    "aptos display",
    "aptos narrow",
    "courier new",
    "segoe ui",
    "tahoma",
    "verdana",
    "consolas",
    "candara",
    "constantia",
    "corbel",
  ],
);

/** DATUM-05 Fon bawaan Office. */
function a05(ctx: StructCtx): CheckOutcome {
  const seen = new Map<string, { pointer: string; n: number }>();
  for (const u of propsOf(ctx).faces) {
    if (!OFFICE_FACES.has(u.face.toLowerCase())) continue;
    const s = seen.get(u.face);
    if (s) s.n++;
    else seen.set(u.face, { pointer: u.pointer, n: 1 });
  }
  const f: Finding[] = [...seen.entries()].map(([face, s]) => ({ pointer: s.pointer, detail: `fon bawaan Office "${face}" dipakai ${s.n} kali (DT-08)` }));
  for (const [k, v] of Object.entries(ctx.params)) {
    if (!k.startsWith("type.face") || typeof v !== "string") continue;
    if (OFFICE_FACES.has(v.trim().toLowerCase())) f.push({ detail: `parameter templat ${k} = "${v}" adalah fon bawaan Office (DT-08)` });
  }
  return findings(f, `${propsOf(ctx).faces.length} penyebutan wajah fon, tidak ada fon bawaan Office`);
}

/** DATUM-06 Sampul di tengah. */
function a06(ctx: StructCtx): CheckOutcome {
  const cover = ctx.doc.front?.cover;
  if (!cover) return findings([], "tidak ada sampul");
  const f: Finding[] = [];
  for (const it of ctx.walk.items) {
    if (!it.pointer.startsWith("/front/cover/")) continue;
    const jc = (it.block.format as { jc?: string } | undefined)?.jc;
    if (jc === "center") f.push({ pointer: `${it.pointer}/format/jc`, detail: `unsur sampul ${it.block.type} rata tengah (DT-14: sampul rata kiri pada grid)` });
  }
  return findings(f, cover.mode === "auto" ? "by-construction: sampul mode auto disusun rata kiri (cover.elementOrder)" : "tidak ada unsur sampul rata tengah");
}

/** DATUM-07 Garis tegak di tabel. */
function a07(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  const vertical = (b: { val?: string } | undefined) => b !== undefined && b.val !== undefined && b.val !== "none";
  for (const { t, pointer } of tables(ctx)) {
    const where: string[] = [];
    const lb = t.layout?.borders;
    if (vertical(lb?.insideV)) where.push("insideV");
    if (vertical(lb?.left)) where.push("tepi kiri");
    if (vertical(lb?.right)) where.push("tepi kanan");
    let cells = 0;
    let firstCell: string | undefined;
    (t.rows ?? []).forEach((r, ri) =>
      r.cells.forEach((c, ci) => {
        if (vertical(c.borders?.left) || vertical(c.borders?.right)) {
          cells++;
          firstCell ??= `${pointer}/rows/${ri}/cells/${ci}/borders`;
        }
      }),
    );
    if (cells > 0) where.push(`${cells} sel bergaris kiri/kanan`);
    if (where.length) f.push({ pointer: firstCell ?? `${pointer}/layout/borders`, detail: `tabel ${t.type} memuat garis tegak: ${where.join(", ")} (DT-16)` });
  }
  return findings(f, `${tables(ctx).length} tabel tanpa garis tegak`);
}

/** DATUM-08 Baris kepala tabel berisi warna. */
function a08(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { t, pointer } of tables(ctx)) {
    (t.rows ?? []).forEach((r, ri) => {
      if (r.kind !== "header") return;
      const ci = r.cells.findIndex(isColoredFill);
      if (ci >= 0) f.push({ pointer: `${pointer}/rows/${ri}/cells/${ci}/shading`, detail: `baris kepala tabel ${t.type} berisi warna ${normHex(r.cells[ci].shading?.fill)} (DT-16)` });
    });
  }
  for (const [role, rf] of Object.entries(ctx.tpl.roleFormats ?? {})) {
    if (!/head/i.test(role)) continue;
    const hex = normHex(rf?.cell?.shading?.fill);
    if (hex && !WHITE.has(hex)) f.push({ detail: `roleFormats templat "${role}" memberi isian kepala ${hex} (DT-16)` });
  }
  return findings(f, "tidak ada baris kepala berwarna");
}

/**
 * HS datum_lint.py `is_pure_number`: sel berisi satu angka (boleh disusul
 * penanda pendek). Pemisah dari entri ID tabel konvensi (engine/bind/format.ts).
 */
const ID_NUMBER_PATTERN = numberPatternSources(numberConvention("ID"));
const PURE_NUMBER = new RegExp(
  `^-?\\d{1,3}(?:${ID_NUMBER_PATTERN.thousands}\\d{3})*(?:${ID_NUMBER_PATTERN.decimal}\\d+)?\\s*\\S{0,8}$`,
  "u",
);

export function isPureNumberCell(text: string): boolean {
  const s = text.trim();
  return PURE_NUMBER.test(s) && /\d/u.test(s);
}

/**
 * Tabel data numerik (FIX-L, F-062): definisi HS datum_lint.py
 * `numeric_data_tables` (cek 09): >= 2 baris dan >= 50 % sel badan (baris
 * selain kepala) berupa angka murni; HS mensyaratkan >= 3 kolom, di sini tabel
 * 2 kolom tetap dinilai bila agen menyatakan kolom `numeral`. Kolom nomor urut
 * atau cacah di tabel teks (mis. "No", "Jumlah" aturan) tidak lagi menjadikan
 * tabel itu tabel data hanya karena peran kolomnya `numeral`. Kolom nomor urut
 * (isi badan tepat 1, 2, ..., n dengan n >= 2) adalah penanda baris, bukan
 * besaran, sehingga tidak ikut porsi (D-267).
 */
export function isNumericDataTable(t: TableBlock): boolean {
  const rows = t.rows ?? [];
  if (rows.length < 2) return false;
  const width = Math.max(
    (t.columns ?? []).length,
    ...rows.map((r) => r.cells.reduce((a, c) => a + Math.max(1, c.gridSpan ?? 1), 0)),
  );
  if (width < 3 && !columnRoles(t).includes("numeral")) return false;
  const grid = rows
    .filter((r) => r.kind !== "header")
    .map((r) => {
      let col = 0;
      return r.cells.map((c) => {
        const at = col;
        col += Math.max(1, c.gridSpan ?? 1);
        return { col: at, text: cellText(c).trim() };
      });
    });
  const ordinal = new Set<number>();
  for (let col = 0; col < width; col++) {
    const vals = grid.map((r) => r.find((c) => c.col === col)?.text ?? "");
    if (vals.length >= 2 && vals.every((v, i) => /^\d{1,4}$/u.test(v) && Number(v) === i + 1)) ordinal.add(col);
  }
  const cells = grid.flatMap((r) => r.filter((c) => !ordinal.has(c.col)).map((c) => c.text));
  if (cells.length === 0) return false;
  return cells.filter(isPureNumberCell).length / cells.length >= 0.5;
}

/** DATUM-09 Tabel data tanpa kolom satuan. */
function a09(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let data = 0;
  for (const { t, pointer, item } of tables(ctx)) {
    if (!t.caption) continue;
    if (!isNumericDataTable(t)) continue;
    data++;
    if (!hasUnitColumn(t)) f.push({ pointer, detail: `${item.artifactLabel ?? "tabel"}: tabel data berkolom numeral tanpa kolom/penanda satuan (DT-17)` });
  }
  return findings(f, `${data} tabel data numerik (>= 50 % sel badan angka; HS numeric_data_tables) memuat satuan`);
}

function emptyInline(x: unknown): boolean {
  if (!x || typeof x !== "object") return true;
  return textOf(x as { text: string }).trim() === "";
}

/** DATUM-10 Tabel atau gambar tanpa SUMBER. */
function a10(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let n = 0;
  for (const it of ctx.walk.items) {
    const t = it.block.type;
    if (isTableType(t) && it.block.caption) {
      n++;
      const src = it.block.source as { inline?: unknown } | undefined;
      if (!src || emptyInline(src.inline)) f.push({ pointer: it.pointer, detail: `${label(it)}: tabel bercaption tanpa baris SUMBER (DT-15)` });
    } else if (isFigureType(t)) {
      n++;
      const src = it.block.source as { inline?: unknown } | undefined;
      if (!src || emptyInline(src.inline)) f.push({ pointer: it.pointer, detail: `${label(it)}: gambar tanpa baris SUMBER (DT-15)` });
    }
  }
  return findings(f, `${n} tabel bercaption/gambar memuat SUMBER`);
}

/** DATUM-11 Angka beban keputusan tanpa tanda (provenans). */
function a11(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  const marks = new Set<string>(PROVENANCE_MARKS);
  for (const [k, e] of Object.entries(ctx.register as Record<string, RegisterEntry>)) {
    if (!marks.has(String(e?.mark))) f.push({ pointer: ptr("register", k), detail: `besaran register "${k}" tanpa tanda provenans sah (DT-21)` });
  }
  for (const it of ctx.walk.items) {
    if (it.block.type !== "derivation") continue;
    const lines = (it.block.lines as Array<{ value?: unknown; mark?: string }>) ?? [];
    lines.forEach((ln, i) => {
      const v = ln.value;
      if (!v || typeof v !== "object" || "registerKey" in v) return;
      if (/\d/.test(textOf(v as { text: string })) && !ln.mark) {
        f.push({ pointer: `${it.pointer}/lines/${i}`, detail: `${label(it)}: baris turunan bernilai angka literal tanpa tanda provenans (DT-21)` });
      }
    });
  }
  return findings(f, "register bertanda; baris turunan beranka bertanda (pemindaian angka prosa: D01)");
}

function paletteOf(ctx: StructCtx): Set<string> {
  const pal = new Set<string>();
  for (const [k, v] of Object.entries(ctx.params)) if (k.startsWith("color.") && k !== "color.retired") hexesIn(v, pal);
  try {
    for (const h of Object.values(derivedColorTokens(ctx.params))) pal.add(h);
    const paper = normHex(ctx.params["color.interior.paper"]);
    const ink = normHex(ctx.params["color.interior.ink900"]);
    const tints = (ctx.params["rules.tintsPercent"] as ParamValue[] | undefined) ?? [15, 30];
    if (paper && ink && Array.isArray(tints)) for (const t of tints) if (typeof t === "number") pal.add(tintHex(paper, ink, t));
  } catch {
    // token turunan opsional: palet tetap dari parameter literal.
  }
  hexesIn(ctx.tpl.roleFormats as unknown, pal);
  pal.add("FFFFFF");
  return pal;
}

/** DATUM-12 Warna dekoratif (sebagian: warna di luar palet templat, warna pensiun). */
function a12(ctx: StructCtx): CheckOutcome {
  const pal = paletteOf(ctx);
  const retired = new Set<string>();
  hexesIn(ctx.params["color.retired"], retired);
  const off = new Map<string, { pointer: string; n: number }>();
  const ret = new Map<string, { pointer: string; n: number }>();
  for (const c of propsOf(ctx).colors) {
    const bucket = retired.has(c.hex) ? ret : pal.has(c.hex) ? undefined : off;
    if (!bucket) continue;
    const s = bucket.get(c.hex);
    if (s) s.n++;
    else bucket.set(c.hex, { pointer: c.pointer, n: 1 });
  }
  const f: Finding[] = [
    ...[...ret.entries()].map(([h, s]) => ({ pointer: s.pointer, detail: `warna pensiun ${h} dipakai ${s.n} kali (DT-07)` })),
    ...[...off.entries()].map(([h, s]) => ({ pointer: s.pointer, detail: `warna ${h} di luar palet templat, ${s.n} kali (DT-06; makna warna dinilai manusia H10)` })),
  ];
  return findings(f, `${propsOf(ctx).colors.length} pemakaian warna di dalam palet templat (${pal.size} nilai); makna warna dinilai manusia (H10)`);
}

/** DATUM-13 Chart dirasterisasi. */
function a13(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let images = 0;
  for (const it of figures(ctx)) {
    if (it.block.type === "image") {
      images++;
      const x = it.block.x as { chart?: unknown } | undefined;
      if (x && x.chart !== undefined) f.push({ pointer: it.pointer, detail: `${label(it)}: blok image ditandai sebagai chart (x.chart); chart wajib vektor (DT-36)` });
    }
  }
  return findings(
    f,
    `by-construction: blok chart dirender SVG vektor; ${images} blok image tidak dapat dipastikan bukan chart (pemeriksaan mata)`,
  );
}

const DEFAULT_SCHEME_LEVELS: Readonly<Record<string, readonly string[]>> = {
  kemhanTni: ["Biasa", "Rahasia", "Sangat Rahasia"],
  polri: ["Biasa", "Terbatas", "Rahasia", "Sangat Rahasia"],
  anri: ["Biasa", "Terbatas", "Rahasia", "Sangat Rahasia"],
};

/** DATUM-18 Klasifikasi salah untuk penerima. */
function a18(ctx: StructCtx): CheckOutcome {
  const scheme = typeof ctx.params["classification.recipientScheme"] === "string" ? (ctx.params["classification.recipientScheme"] as string) : "anri";
  let levels: readonly string[] | undefined = DEFAULT_SCHEME_LEVELS[scheme];
  const map = pRaw(ctx, "classification.schemeLevels");
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const ent = (map as Record<string, ParamValue>)[scheme];
    const lv = ent && typeof ent === "object" && !Array.isArray(ent) ? (ent as Record<string, ParamValue>).levels : undefined;
    if (Array.isArray(lv)) levels = lv.filter((x): x is string => typeof x === "string");
  }
  if (!levels) return notRun(`skema klasifikasi "${scheme}" tidak dikenal; tingkat sah tidak dapat ditentukan`);
  const cls = (ctx.doc.meta.classification ?? "").trim();
  const ok = levels.some((l) => l.toLowerCase() === cls.toLowerCase());
  return findings(
    ok ? [] : [{ pointer: "/meta/classification", detail: `klasifikasi "${cls}" bukan tingkat sah skema ${scheme} (${levels.join(", ")}) (DT-28)` }],
    `klasifikasi "${cls}" sah untuk skema ${scheme}`,
  );
}

/** DATUM-20 Sel gabungan di zona komputasi (kolom numeral). */
function a20(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { t, pointer, item } of tables(ctx)) {
    const roles = columnRoles(t);
    if (!roles.includes("numeral")) continue;
    (t.rows ?? []).forEach((r, ri) => {
      if (r.kind === "header") return;
      let col = 0;
      r.cells.forEach((c, ci) => {
        const span = Math.max(1, c.gridSpan ?? 1);
        const merged = span > 1 || c.vMerge !== undefined;
        const covers = roles.slice(col, col + span);
        if (merged && covers.includes("numeral")) {
          f.push({ pointer: `${pointer}/rows/${ri}/cells/${ci}`, detail: `${item.artifactLabel ?? "tabel"}: sel gabungan (${span > 1 ? `gridSpan ${span}` : `vMerge ${c.vMerge}`}) menutup kolom numeral (DT-40)` });
        }
        col += span;
      });
    });
  }
  return findings(f, "tidak ada sel gabungan pada kolom numeral");
}

/** DATUM-21 Garis < 0,18 mm atau rona < 15 %. */
function a21(ctx: StructCtx): CheckOutcome {
  const minMm = 0.18;
  const props = propsOf(ctx);
  const byOwner = new Map<string, { thin: number; minSz: number; pointer: string }>();
  for (const b of props.borders) {
    if (b.val === "none" || b.sz <= 0) continue;
    if (eighthsToMm(b.sz) + 1e-9 >= minMm) continue;
    const owner = ownerPointer(ctx, b.pointer);
    const s = byOwner.get(owner);
    if (s) {
      s.thin++;
      s.minSz = Math.min(s.minSz, b.sz);
    } else byOwner.set(owner, { thin: 1, minSz: b.sz, pointer: b.pointer });
  }
  const f: Finding[] = [...byOwner.values()].map((s) => ({
    pointer: s.pointer,
    detail: `${s.thin} garis lebih tipis dari 0,18 mm (terkecil sz ${s.minSz} = ${fmtFixed(eighthsToMm(s.minSz), 3)} mm) (DT-11)`,
  }));
  const paper = normHex(ctx.params["color.interior.paper"]) ?? "FFFFFF";
  const ink = normHex(ctx.params["color.interior.ink900"]) ?? "000000";
  const pc = [0, 2, 4].map((i) => parseInt(paper.slice(i, i + 2), 16));
  const kc = [0, 2, 4].map((i) => parseInt(ink.slice(i, i + 2), 16));
  const tintOf = (hex: string): number => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const parts = c.map((v, i) => (pc[i] === kc[i] ? 0 : (pc[i] - v) / (pc[i] - kc[i])));
    return (100 * parts.reduce((a, b) => a + b, 0)) / 3;
  };
  const tintOwners = new Map<string, { hex: string; pct: number; pointer: string; n: number }>();
  for (const fill of props.fills) {
    const pct = tintOf(fill.hex);
    if (!(pct > 0.5 && pct < 14.5)) continue;
    const key = `${ownerPointer(ctx, fill.pointer)}|${fill.hex}`;
    const s = tintOwners.get(key);
    if (s) s.n++;
    else tintOwners.set(key, { hex: fill.hex, pct, pointer: fill.pointer, n: 1 });
  }
  for (const s of tintOwners.values()) {
    f.push({ pointer: s.pointer, detail: `isian ${s.hex} = rona ${fmtFixed(s.pct, 1)} % (< 15 %), ${s.n} kali (DT-11, lantai fotokopi)` });
  }
  return findings(f, `${props.borders.length} garis dan ${props.fills.length} isian memenuhi lantai 0,18 mm / rona 15 %`);
}

/** DATUM-22 Klaim eksternal tanpa Admiralty. */
function a22(ctx: StructCtx): CheckOutcome {
  if (!pBool(ctx, "admiralty.requiredOnExternalClaims", true)) return notRun("admiralty.requiredOnExternalClaims = false pada templat");
  const f: Finding[] = [];
  let n = 0;
  for (const [k, e] of Object.entries(ctx.register as Record<string, RegisterEntry>)) {
    if (e?.mark !== "PEMASOK") continue;
    n++;
    if (!ADMIRALTY_GRADE.test(e.src ?? "")) f.push({ pointer: ptr("register", k, "src"), detail: `besaran pemasok "${k}" tanpa nilai Admiralty di sumbernya (DT-25)` });
  }
  for (const { t, pointer, item } of tables(ctx)) {
    if (t.type !== "sourceRegister") continue;
    (t.rows ?? []).forEach((r, ri) => {
      if (r.kind === "header" || r.kind === "group") return;
      n++;
      if (!ADMIRALTY_GRADE.test(r.cells.map(cellText).join(" "))) {
        f.push({ pointer: `${pointer}/rows/${ri}`, detail: `${item.artifactLabel ?? "register sumber"}: baris sumber eksternal tanpa nilai Admiralty (A-F, 1-6) (DT-25)` });
      }
    });
  }
  return findings(f, n === 0 ? "tidak ada klaim eksternal (register PEMASOK / register sumber)" : `${n} klaim eksternal bernilai Admiralty`);
}

function diagrams(ctx: StructCtx): Array<{ it: WalkItem; d: StudioDiagramV1 }> {
  const out: Array<{ it: WalkItem; d: StudioDiagramV1 }> = [];
  for (const it of figures(ctx)) {
    const d = inlineSpec<StudioDiagramV1>(it, "studio.diagram/v1");
    if (d) out.push({ it, d });
  }
  return out;
}

/** DATUM-23 Sudut membulat di luar terminator. */
function a23(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { it, d } of diagrams(ctx)) {
    const inc = new Map<string, number>();
    const outg = new Map<string, number>();
    for (const e of d.edges ?? []) {
      outg.set(e.from, (outg.get(e.from) ?? 0) + 1);
      inc.set(e.to, (inc.get(e.to) ?? 0) + 1);
    }
    d.nodes.forEach((n, ni) => {
      if (n.shape !== "stadium") return;
      if ((inc.get(n.id) ?? 0) > 0 && (outg.get(n.id) ?? 0) > 0) {
        f.push({ pointer: `${it.pointer}/spec/nodes/${ni}`, detail: `${label(it)}: simpul "${n.id}" bersudut membulat (stadium) tetapi bukan terminator (DT-37)` });
      }
    });
  }
  return findings(f, "by-construction: hanya bentuk stadium yang membulat, dipakai di terminator");
}

/** DATUM-24 Penghubung tanpa label. */
function a24(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let n = 0;
  for (const { it, d } of diagrams(ctx)) {
    (d.edges ?? []).forEach((e, ei) => {
      n++;
      if (!e.label || e.label.trim() === "") f.push({ pointer: `${it.pointer}/spec/edges/${ei}`, detail: `${label(it)}: penghubung ${e.from} -> ${e.to} tanpa label (DT-37)` });
    });
  }
  return findings(f, `${n} penghubung berlabel`);
}

/** DATUM-26 Subjek beraksen pada satu gambar (maks. 1). */
function a26(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { it, d } of diagrams(ctx)) {
    const acc = d.nodes.filter((n) => n.class?.accent === true).length;
    if (acc > 1) f.push({ pointer: `${it.pointer}/spec/nodes`, detail: `${label(it)}: ${acc} simpul beraksen (maks. 1) (DT-37)` });
  }
  for (const it of figures(ctx)) {
    const c = inlineSpec<StudioChartV1>(it, "studio.chart/v1");
    const data = c?.data as { points?: Array<{ accent?: boolean }>; series?: Array<{ accent?: boolean }> } | undefined;
    if (!data) continue;
    const acc = (data.points ?? []).filter((p) => p.accent === true).length + (data.series ?? []).filter((s) => s.accent === true).length;
    if (acc > 1) f.push({ pointer: `${it.pointer}/spec/data`, detail: `${label(it)}: ${acc} tanda data beraksen (maks. 1) (DT-37)` });
  }
  return findings(f, "setiap gambar beraksen paling banyak satu subjek");
}

/** DATUM-27 Garis diagram < 0,18 mm. */
function a27(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { it, d } of diagrams(ctx)) {
    const x = d as unknown as { strokeMm?: unknown; lineMm?: unknown };
    for (const v of [x.strokeMm, x.lineMm]) {
      if (typeof v === "number" && v < 0.18) f.push({ pointer: `${it.pointer}/spec`, detail: `${label(it)}: tebal garis ${v} mm < 0,18 mm (DT-11)` });
    }
  }
  return findings(f, "by-construction: tebal garis diagram ditetapkan mesin dari tangga garis (>= 0,18 mm)");
}

/** DATUM-29 Gambar tanpa SUMBER. */
function a29(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  const figs = figures(ctx);
  for (const it of figs) {
    const src = it.block.source as { inline?: unknown } | undefined;
    if (!src || emptyInline(src.inline)) f.push({ pointer: it.pointer, detail: `${label(it)}: gambar tanpa SUMBER (DT-15)` });
    const d = inlineSpec<StudioDiagramV1>(it, "studio.diagram/v1");
    if (d && (!Array.isArray(d.sources) || d.sources.filter((s) => s.trim() !== "").length === 0)) {
      f.push({ pointer: `${it.pointer}/spec/sources`, detail: `${label(it)}: spesifikasi diagram tanpa sources (DT-15)` });
    }
  }
  return findings(f, `${figs.length} gambar memuat SUMBER`);
}

/** DATUM-30 Gambar tanpa nomor atau caption. */
function a30(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  const figs = figures(ctx);
  for (const it of figs) {
    const cap = it.block.caption as { label?: string; inline?: unknown } | undefined;
    if (!cap || emptyInline(cap.inline)) {
      f.push({ pointer: it.pointer, detail: `gambar ${it.block.type} tanpa caption (DT-15)` });
      continue;
    }
    if (!it.artifactLabel && it.zone !== "chapter" && it.zone !== "appendix") {
      f.push({ pointer: it.pointer, detail: `gambar di halaman depan/bagian tidak bernomor (DT-15)` });
    }
    if (cap.label && it.artifactLabel && cap.label.trim() !== it.artifactLabel) {
      f.push({ pointer: `${it.pointer}/caption/label`, status: "REPORT", detail: `label caption "${cap.label}" berbeda dari penomoran "${it.artifactLabel}" (§3.4 Caption.label)` });
    }
  }
  for (const it of ctx.walk.items) {
    if (!isTableType(it.block.type)) continue;
    const cap = it.block.caption as { label?: string } | undefined;
    if (cap?.label && it.artifactLabel && cap.label.trim() !== it.artifactLabel) {
      f.push({ pointer: `${it.pointer}/caption/label`, status: "REPORT", detail: `label caption "${cap.label}" berbeda dari penomoran "${it.artifactLabel}" (§3.4 Caption.label)` });
    }
  }
  return findings(f, `${figs.length} gambar bercaption dan bernomor`);
}

/** DATUM-34 Tanda rumah (provenans) tanpa legenda. */
function a34(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { it, d } of diagrams(ctx)) {
    const marked = d.nodes.filter((n) => n.mark !== undefined).length;
    if (marked > 0 && (!d.legend || d.legend.filter((l) => l.trim() !== "").length === 0)) {
      f.push({ pointer: `${it.pointer}/spec/legend`, detail: `${label(it)}: ${marked} simpul bertanda rumah tanpa legenda (SM-03)` });
    }
  }
  return findings(f, "setiap diagram bertanda rumah memuat legenda");
}

/** DATUM-35 Lebih dari satu dialek per gambar. */
function a35(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { it, d } of diagrams(ctx)) {
    const dialects = new Set<string>();
    for (const n of d.nodes) {
      const m = /^(iec|isa|sec|mil)[:_]/i.exec(n.tag ?? "");
      if (m) dialects.add(m[1].toLowerCase());
    }
    if (dialects.size > 1) f.push({ pointer: `${it.pointer}/spec/nodes`, detail: `${label(it)}: ${dialects.size} dialek simbol (${[...dialects].sort().join(", ")}) dalam satu gambar (SM-04)` });
  }
  return findings(f, "by-construction: symbolSheet satu dialek; diagram tanpa campuran dialek");
}

/** DATUM-36 Aparatus didelegasikan ke halaman (lapor). */
function a36(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const it of figures(ctx)) {
    const spec = it.block.spec as { apparatus?: string } | undefined;
    if (spec?.apparatus === "page") f.push({ pointer: `${it.pointer}/spec/apparatus`, status: "REPORT", detail: `${label(it)}: aparatus (caption, kunci, sumber) didelegasikan ke halaman (9.4)` });
  }
  return findings(f, "tidak ada aparatus yang didelegasikan ke halaman");
}

export const STRUCTURE_A_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  "DATUM-01": a01,
  "DATUM-02": a02,
  "DATUM-05": a05,
  "DATUM-06": a06,
  "DATUM-07": a07,
  "DATUM-08": a08,
  "DATUM-09": a09,
  "DATUM-10": a10,
  "DATUM-11": a11,
  "DATUM-12": a12,
  "DATUM-13": a13,
  "DATUM-18": a18,
  "DATUM-20": a20,
  "DATUM-21": a21,
  "DATUM-22": a22,
  "DATUM-23": a23,
  "DATUM-24": a24,
  "DATUM-26": a26,
  "DATUM-27": a27,
  "DATUM-29": a29,
  "DATUM-30": a30,
  "DATUM-34": a34,
  "DATUM-35": a35,
  "DATUM-36": a36,
};

