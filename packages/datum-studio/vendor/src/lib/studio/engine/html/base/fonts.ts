/**
 * `@font-face` tertanam base64 untuk HTML mandiri (S21, KT-11: tanpa URL eksternal).
 *
 * Sumber berkas: aset templat ber-kind "font" (`ResolvedTemplate.assets`), atau
 * bila templat tidak membawa aset fon, manifest S13
 * `src/lib/studio/assets/manifest.json` relatif cwd repo. sha256 terkunci
 * (aset templat/manifest) diverifikasi sebelum dipakai.
 *
 * Kunci wajah (`faces`): nama keluarga ("IBM Plex Serif" = semua slot tersedia),
 * `Keluarga|slot` (slot `regular` | `bold` | `italic` | `boldItalic`; satu
 * wajah saja), atau alias peran `serif` | `condensed` | `mono` | `workbookUi` |
 * `symbolGlyph` (nama keluarga dari `type.face.*`). Nama keluarga renderer R-08
 * (mis. "IBM Plex Sans Cond") dikenali sebagai alias keluarga peran yang sama;
 * `@font-face` selalu didaftarkan dengan nama keluarga peran (`type.face.*`)
 * agar cocok dengan tumpukan fon `tokenCss`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ResolvedTemplate } from "../../../contract";
import { studioAssetsRoot } from "../../../contract/env";
import { StudioEngineError } from "../../../contract/errors";
import { list, P, record, str } from "./params";

export const FONT_SLOTS = ["regular", "bold", "italic", "boldItalic"] as const;
export type FontSlot = (typeof FONT_SLOTS)[number];

export const FACE_ROLES = ["serif", "condensed", "mono", "workbookUi", "symbolGlyph"] as const;
export type FaceRole = (typeof FACE_ROLES)[number];

const ROLE_PARAM: Readonly<Record<FaceRole, string>> = {
  serif: P.faceSerif,
  condensed: P.faceCondensed,
  mono: P.faceMono,
  workbookUi: P.faceWorkbook,
  symbolGlyph: P.faceSymbol,
};

/** Cadangan nama keluarga peran (katalog P4T-01..05) bila parameter absen. */
const ROLE_FALLBACK: Readonly<Record<FaceRole, string>> = {
  serif: "IBM Plex Serif",
  condensed: "IBM Plex Sans Condensed",
  mono: "IBM Plex Mono",
  workbookUi: "IBM Plex Sans",
  symbolGlyph: "DejaVu Sans",
};

/**
 * Rentang Unicode wajah glif simbol: sama dengan `DatumSym` acuan RL (Sumber
 * Lembar Bukti.html) — Greek, panah, operator matematika, bentuk geometris —
 * ditambah titik kode glif tanda provenans `marks.*.glyph` (P5-30..36).
 */
const SYMBOL_RANGES: readonly (readonly [number, number])[] = [
  [0x0370, 0x03ff],
  [0x2190, 0x21ff],
  [0x2200, 0x22ff],
  [0x25a0, 0x25ff],
];

const MARK_GLYPH_KEYS = ["marks.terukur.glyph", "marks.diturunkan.glyph", "marks.pemasok.glyph", "marks.asumsi.glyph"];

/** Akar aset Studio relatif cwd repo (S13). */
export const STUDIO_ASSETS_DIR = path.join("src", "lib", "studio", "assets");

export function normalizeFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Bentuk pendek keluarga yang setara ("…Condensed" = "…Cond", nama berkas IBM Plex). */
function familyAliases(name: string): string[] {
  const n = normalizeFamily(name);
  const out = [n];
  if (n.endsWith("condensed")) out.push(`${n.slice(0, -"condensed".length)}cond`);
  else if (n.endsWith("cond")) out.push(`${n}ensed`);
  return out;
}

export function roleFamily(tpl: ResolvedTemplate, role: FaceRole): string {
  const v = str(tpl.params, ROLE_PARAM[role]);
  return v && v.trim() ? v.trim() : ROLE_FALLBACK[role];
}

interface FontFile {
  key: string;
  absPath: string;
  sha256?: string;
  /** Stem keluarga ternormalisasi dari nama berkas (awalan sebelum "-"). */
  familyKey: string;
  slot: FontSlot;
  weight: number;
  /** Urutan preferensi dalam slot (kecil = dipilih): SemiBold sebelum Bold (R-08: slot Bold = wajah SemiBold). */
  rank: number;
}

const STYLE_SUFFIX: ReadonlyArray<{ re: RegExp; slot: FontSlot; weight: number; rank: number }> = [
  { re: /^semibolditalic$/, slot: "boldItalic", weight: 600, rank: 0 },
  { re: /^bolditalic$/, slot: "boldItalic", weight: 700, rank: 1 },
  { re: /^semibold$/, slot: "bold", weight: 600, rank: 0 },
  { re: /^bold$/, slot: "bold", weight: 700, rank: 1 },
  { re: /^italic$/, slot: "italic", weight: 400, rank: 0 },
  { re: /^(regular|book|)$/, slot: "regular", weight: 400, rank: 0 },
];

function classifyFile(key: string, absPath: string, sha256?: string): FontFile | undefined {
  const base = path.basename(key).replace(/\.(ttf|otf)$/i, "");
  if (base === path.basename(key)) return undefined;
  const dash = base.indexOf("-");
  const fam = dash >= 0 ? base.slice(0, dash) : base;
  const style = (dash >= 0 ? base.slice(dash + 1) : "").toLowerCase();
  const hit = STYLE_SUFFIX.find((s) => s.re.test(style));
  if (!hit) return undefined;
  return { key, absPath, sha256, familyKey: normalizeFamily(fam), slot: hit.slot, weight: hit.weight, rank: hit.rank };
}

interface ManifestEntry {
  path?: string;
  sha256?: string;
  kind?: string;
}

function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Daftar berkas fon: aset templat, cadangan manifest S13. Urut kunci (deterministik). */
export function fontFiles(tpl: ResolvedTemplate, assetsRoot?: string): FontFile[] {
  const fromTpl = Object.entries(tpl.assets ?? {})
    .filter(([, a]) => a.kind === "font")
    .map(([key, a]) => classifyFile(key, a.absPath, a.sha256))
    .filter((f): f is FontFile => f !== undefined);
  if (fromTpl.length > 0) return fromTpl.sort(byKey);
  // Swarm patch (row 107, row 11 M4): default font root is the explicit Studio asset root, not cwd.
  const root = assetsRoot ?? studioAssetsRoot();
  const mp = path.join(root, "manifest.json");
  if (!existsSync(mp)) return [];
  let entries: ManifestEntry[];
  try {
    const m = JSON.parse(readFileSync(mp, "utf8")) as { entries?: ManifestEntry[] };
    entries = Array.isArray(m.entries) ? m.entries : [];
  } catch (e) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `manifest aset Studio tidak terbaca: ${mp}`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  return entries
    .filter((e): e is ManifestEntry & { path: string } => e.kind === "font" && typeof e.path === "string")
    .map((e) => classifyFile(e.path, path.join(root, ...e.path.split("/")), e.sha256))
    .filter((f): f is FontFile => f !== undefined)
    .sort(byKey);
}

const base64Cache = new Map<string, string>();

/** Isi berkas sebagai base64; sha256 terkunci diverifikasi. Di-cache per path + sha256. */
function fontBase64(f: FontFile): string {
  const cacheKey = `${f.absPath}\u0000${f.sha256 ?? ""}`;
  const hit = base64Cache.get(cacheKey);
  if (hit !== undefined) return hit;
  if (!existsSync(f.absPath)) {
    throw new StudioEngineError("FILE_MISSING_ON_DISK", `Berkas fon tidak ada: ${f.absPath}`, { key: f.key });
  }
  const data = readFileSync(f.absPath);
  if (f.sha256) {
    // sha256 aktual sengaja tidak masuk `details` (dikirim ke API, S87 L-06).
    if (createHash("sha256").update(data).digest("hex") !== f.sha256.toLowerCase()) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `sha256 fon tidak cocok: ${f.key}`, {
        expected: f.sha256,
      });
    }
  }
  const b64 = data.toString("base64");
  base64Cache.set(cacheKey, b64);
  return b64;
}

/** Keluarga yang dikenal templat: peran `type.face.*` + keluarga R-08 `render.docx.embedFonts`. */
function knownFamilies(tpl: ResolvedTemplate): Map<string, { cssFamily: string; role?: FaceRole }> {
  const out = new Map<string, { cssFamily: string; role?: FaceRole }>();
  for (const role of FACE_ROLES) {
    const fam = roleFamily(tpl, role);
    for (const a of familyAliases(fam)) if (!out.has(a)) out.set(a, { cssFamily: fam, role });
    out.set(normalizeFamily(role), { cssFamily: fam, role });
  }
  for (const e of list(tpl.params, P.embedFonts)) {
    const fam = record(e)?.family;
    if (typeof fam !== "string" || !fam.trim()) continue;
    for (const a of familyAliases(fam)) if (!out.has(a)) out.set(a, { cssFamily: fam.trim() });
  }
  return out;
}

export interface FaceRequest {
  /** Nama keluarga CSS yang didaftarkan. */
  cssFamily: string;
  role?: FaceRole;
  /** Kunci keluarga ternormalisasi untuk dicocokkan dengan nama berkas. */
  matchKeys: string[];
  /** `undefined` = semua slot tersedia. */
  slots?: Set<FontSlot>;
}

/** Urai kunci wajah (`Keluarga`, `Keluarga|slot`, alias peran) menjadi permintaan per keluarga. */
export function parseFaces(tpl: ResolvedTemplate, faces: ReadonlySet<string>): FaceRequest[] {
  const known = knownFamilies(tpl);
  const byFamily = new Map<string, FaceRequest>();
  for (const raw of [...faces].sort()) {
    const [famRaw, slotRaw] = raw.split("|").map((s) => s.trim());
    if (!famRaw) continue;
    const k = known.get(normalizeFamily(famRaw)) ?? familyAliases(famRaw).map((a) => known.get(a)).find(Boolean);
    const cssFamily = k?.cssFamily ?? famRaw;
    const req = byFamily.get(cssFamily) ?? {
      cssFamily,
      role: k?.role,
      matchKeys: [...new Set([...familyAliases(cssFamily), ...familyAliases(famRaw)])],
      slots: new Set<FontSlot>(),
    };
    for (const a of familyAliases(famRaw)) if (!req.matchKeys.includes(a)) req.matchKeys.push(a);
    if (slotRaw === undefined || slotRaw === "") req.slots = undefined;
    else if ((FONT_SLOTS as readonly string[]).includes(slotRaw)) req.slots?.add(slotRaw as FontSlot);
    else {
      throw new StudioEngineError("SCHEMA_INVALID", `Slot wajah tidak dikenal: ${raw}`, { allowed: FONT_SLOTS });
    }
    byFamily.set(cssFamily, req);
  }
  return [...byFamily.values()].sort((a, b) => (a.cssFamily < b.cssFamily ? -1 : a.cssFamily > b.cssFamily ? 1 : 0));
}

function unicodeRange(tpl: ResolvedTemplate): string {
  const cps = new Set<number>();
  for (const k of MARK_GLYPH_KEYS) {
    const g = str(tpl.params, k);
    const cp = g ? g.codePointAt(0) : undefined;
    if (cp !== undefined && !SYMBOL_RANGES.some(([a, b]) => cp >= a && cp <= b)) cps.add(cp);
  }
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  return [
    ...SYMBOL_RANGES.map(([a, b]) => `U+${hex(a)}-${hex(b)}`),
    ...[...cps].sort((a, b) => a - b).map((c) => `U+${hex(c)}`),
  ].join(",");
}

/** C35 M-01: kontrol C0 dan DEL yang tersisa sesudah LF/CRLF (CR dan FF juga baris baru CSS). */
const CSS_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

/**
 * String CSS aman: kutip ganda, `\` dan `"` di-escape, `<` dan baris baru sebagai escape heksa.
 * C35 M-01 (CWE-116): CR tunggal, FF, kontrol C0 lain dan DEL juga jadi escape heksa (`\d `, `\c `),
 * sehingga tidak ada karakter yang bisa mengakhiri string; string biasa tetap byte-identik.
 */
export function cssString(s: string): string {
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\3C ")
    .replace(/\r?\n/g, "\\A ")
    .replace(CSS_CONTROL_RE, (c) => `\\${c.charCodeAt(0).toString(16)} `);
  return `"${body}"`;
}

export interface FontFaceResult {
  css: string;
  /** `Keluarga|slot` yang tertanam, urut. */
  embedded: string[];
  /** Permintaan yang tidak punya berkas (keluarga bukan milik templat, mis. fallback sistem). */
  missing: string[];
}

/**
 * Versi rinci `fontFaceCss`. Keluarga milik templat (peran `type.face.*` atau
 * R-08) yang tidak punya satu pun berkas -> `FILE_MISSING_ON_DISK`; keluarga
 * lain tanpa berkas dilaporkan di `missing` (fallback sistem tidak ditanam).
 */
export function fontFaceCssDetailed(
  tpl: ResolvedTemplate,
  faces: ReadonlySet<string>,
  opts: { assetsRoot?: string } = {},
): FontFaceResult {
  const files = fontFiles(tpl, opts.assetsRoot);
  const known = knownFamilies(tpl);
  const symbolFamily = roleFamily(tpl, "symbolGlyph");
  const rules: string[] = [];
  const embedded: string[] = [];
  const missing: string[] = [];
  for (const req of parseFaces(tpl, faces)) {
    const candidates = files.filter((f) => req.matchKeys.includes(f.familyKey));
    const chosen: FontFile[] = [];
    for (const slot of FONT_SLOTS) {
      if (req.slots && !req.slots.has(slot)) continue;
      const best = candidates.filter((f) => f.slot === slot).sort((a, b) => a.rank - b.rank || byKey(a, b))[0];
      if (best) chosen.push(best);
      else if (req.slots) missing.push(`${req.cssFamily}|${slot}`);
    }
    if (chosen.length === 0) {
      const owned = req.role !== undefined || req.matchKeys.some((k) => known.has(k));
      if (owned && candidates.length === 0) {
        throw new StudioEngineError("FILE_MISSING_ON_DISK", `Berkas fon untuk keluarga templat tidak ditemukan: ${req.cssFamily}`, {
          family: req.cssFamily,
          matchKeys: req.matchKeys,
        });
      }
      if (!req.slots) missing.push(req.cssFamily);
      continue;
    }
    const range = req.role === "symbolGlyph" || normalizeFamily(req.cssFamily) === normalizeFamily(symbolFamily) ? unicodeRange(tpl) : undefined;
    for (const f of chosen) {
      const italic = f.slot === "italic" || f.slot === "boldItalic";
      const fmt = /\.otf$/i.test(f.key) ? "opentype" : "truetype";
      // D-45: hanya `font/ttf` dan `application/font-sfnt` diterima penjaga S24.
      const mime = fmt === "opentype" ? "application/font-sfnt" : "font/ttf";
      rules.push(
        `@font-face{font-family:${cssString(req.cssFamily)};` +
          `src:url(data:${mime};base64,${fontBase64(f)}) format("${fmt}");` +
          `font-weight:${f.weight};font-style:${italic ? "italic" : "normal"};font-display:block` +
          (range ? `;unicode-range:${range}` : "") +
          `}`,
      );
      embedded.push(`${req.cssFamily}|${f.slot}`);
    }
  }
  return { css: rules.join("\n"), embedded, missing };
}

/**
 * Keluarga yang dirujuk CSS dasar (`tokenCss`/`htmlShell`): serif, condensed,
 * mono, dan glif simbol (tanda provenans rel). Perakit (S24) menyatukannya
 * dengan wajah yang dipakai blok sebelum memanggil `fontFaceCss`.
 */
export function shellFaces(tpl: ResolvedTemplate): Set<string> {
  // Glif simbol cukup slot regular (tanda provenans, unicode-range); keluarga lain semua slot.
  return new Set<string>([...(["serif", "condensed", "mono"] as const).map((r) => roleFamily(tpl, r)), `${roleFamily(tpl, "symbolGlyph")}|regular`]);
}
