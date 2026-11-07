/**
 * Wajah fon yang dipakai badan HTML (S24) -> masukan `fontFaceCss` (S21).
 *
 * Deterministik: dihitung dari teks HTML badan dan parameter templat saja.
 * Sumber: (1) kelas peran wajah S22 (`st-face-<peran>`) dipetakan lewat
 * parameter `type.face.<peran>`; (2) deklarasi `font-family` eksplisit di
 * gaya inline dan atribut SVG (figur S23/S30/S32); (3) peran dasar yang selalu
 * dipakai basis (serif badan, condensed kepala berjalan).
 */
import type { FaceRole, ResolvedTemplate } from "../../../contract";
import { HTML_BLOCK_CLASSES as C } from "../blocks/classes";

/** Nilai cadangan bila templat tidak membawa `type.face.<peran>` (params/color-type.ts P4T 1-5). */
export const DEFAULT_FACE_BY_ROLE: Readonly<Record<FaceRole, string>> = {
  serif: "IBM Plex Serif",
  condensed: "IBM Plex Sans Condensed",
  mono: "IBM Plex Mono",
  workbookUi: "IBM Plex Sans",
  symbolGlyph: "DejaVu Sans",
};

const ROLE_CLASS: ReadonlyArray<readonly [FaceRole, string]> = [
  ["serif", C.faceSerif],
  ["condensed", C.faceCondensed],
  ["mono", C.faceMono],
  ["workbookUi", C.faceWorkbookUi],
  ["symbolGlyph", C.faceSymbolGlyph],
];

/** Peran yang selalu ditanam karena dipakai CSS basis (badan, kepala berjalan, register). */
export const BASE_FACE_ROLES: readonly FaceRole[] = ["serif", "condensed"];

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "math",
  "emoji",
  "inherit",
  "initial",
  "unset",
  "revert",
]);

const FACE_NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

/** Nama keluarga untuk peran wajah menurut templat (cadangan: DEFAULT_FACE_BY_ROLE). */
export function faceForRole(tpl: ResolvedTemplate, role: FaceRole): string {
  const v = tpl.params?.[`type.face.${role}`];
  if (typeof v === "string" && FACE_NAME_RE.test(v.trim())) return v.trim();
  return DEFAULT_FACE_BY_ROLE[role];
}

/**
 * Entitas kutip `escapeHtml` S22 -> kutip tunggal (hanya untuk pemindaian nama).
 * Sengaja kutip tunggal: kutip ganda literal tetap menandai batas nilai atribut,
 * dan titik koma entitas (`&#39;`) tidak lagi memotong deklarasi CSS.
 */
function unquoteEntities(s: string): string {
  return s.replace(/&quot;|&#39;|&#x27;/gi, "'");
}

/** Keluarga dari daftar `font-family` (dipisah koma, kutip dibuang, generik diabaikan). */
function familiesFromList(list: string): string[] {
  const out: string[] = [];
  for (const raw of list.split(",")) {
    const name = raw.replace(/["']/g, "").trim();
    if (!name || GENERIC_FAMILIES.has(name.toLowerCase()) || name.toLowerCase().startsWith("var(")) continue;
    if (FACE_NAME_RE.test(name)) out.push(name);
  }
  return out;
}

/**
 * Himpunan wajah (nama keluarga) yang dipakai `bodyHtml`, terurut agar
 * keluaran `fontFaceCss` deterministik.
 */
export function collectFaces(bodyHtml: string, tpl: ResolvedTemplate): Set<string> {
  const found = new Set<string>();
  for (const role of BASE_FACE_ROLES) found.add(faceForRole(tpl, role));
  for (const [role, cls] of ROLE_CLASS) {
    if (bodyHtml.includes(cls)) found.add(faceForRole(tpl, role));
  }
  // CSS `font-family: ...` (gaya inline ber-entitas, atau elemen <style> berkutip) dan
  // atribut SVG `font-family="..."`. Kutip di dalam nilai atribut sudah di-escape S22,
  // jadi tangkapan berhenti di kutip penutup atribut.
  const scan = unquoteEntities(bodyHtml);
  const cssRe = /font-family\s*:\s*((?:"[^"<>]*"|[^;"<>{}])+)/gi;
  const attrRe = /font-family\s*=\s*(["'])([^"'<>]*)\1/gi;
  for (const m of scan.matchAll(cssRe)) for (const f of familiesFromList(m[1])) found.add(f);
  for (const m of scan.matchAll(attrRe)) for (const f of familiesFromList(m[2])) found.add(f);
  return new Set([...found].sort());
}
