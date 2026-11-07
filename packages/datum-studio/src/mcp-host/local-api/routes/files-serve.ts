/**
 * Header sajian berkas R10 `/api/studio/files/[id]` (01_specs.md §6.2; S57).
 *
 * Berbeda dari route IL lama (`research/02_codebase_map.md` temuan 6: semua
 * selain teks -> octet-stream): Content-Type ditetapkan per ekstensi nama
 * berkas DB, `X-Content-Type-Options: nosniff` selalu, HTML/SVG (konten
 * aktif) disajikan dengan CSP ketat + `attachment` kecuali `?inline=1`.
 *
 * DC-18 (register 05 §9.5, §10 FN-06/FN-07; D-363 U-2): header C50
 * `X-Studio-Final-Filename` pada setiap respons berkas; nama di
 * `Content-Disposition` = nama final untuk dokumen ber-contractKind, nama
 * DATUM untuk lainnya; `?name=final|datum` (E57) menimpa bawaan.
 */
import { FINAL_FILENAME_PATTERN, FINAL_NAME_MODES, STUDIO_FINAL_FILENAME_HEADER, type FinalNameMode } from "@/lib/studio/contract";

const FINAL_RE = new RegExp(FINAL_FILENAME_PATTERN);

export type ServeKind = "docx" | "pdf" | "html" | "svg" | "png" | "jpg" | "other";

const EXT_KIND: Readonly<Record<string, ServeKind>> = {
  docx: "docx",
  pdf: "pdf",
  html: "html",
  htm: "html",
  svg: "svg",
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
};

export const KIND_CONTENT_TYPE: Readonly<Record<ServeKind, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  other: "application/octet-stream",
};

/**
 * CSP konten aktif. Inti sesuai brief (`default-src 'none'; img-src data:;
 * style-src 'unsafe-inline'; font-src data:`) ditambah direktif yang tidak
 * tercakup `default-src` (base-uri, form-action, frame-ancestors) dan
 * `sandbox` (tanpa skrip, origin buram) — lebih ketat, tidak melonggarkan.
 */
export const ACTIVE_CONTENT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

export function serveKindOf(fileName: string): ServeKind {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return (m && EXT_KIND[m[1].toLowerCase()]) || "other";
}

export function isActiveContent(kind: ServeKind): boolean {
  return kind === "html" || kind === "svg";
}

/**
 * `inline`/`attachment` (selaras UI S60, D-65):
 * - tanpa parameter atau `download=1`: attachment;
 * - `inline=1` (pratinjau sesi): inline untuk HTML/SVG (dengan CSP ketat),
 *   PDF (tanpa CSP agar viewer PDF Chromium berjalan), PNG/JPG;
 * - DOCX dan jenis tak dikenal: selalu attachment.
 */
export function dispositionType(kind: ServeKind, q: { inline: boolean; download: boolean }): "inline" | "attachment" {
  if (q.download) return "attachment";
  if (kind === "docx" || kind === "other") return "attachment";
  return q.inline ? "inline" : "attachment";
}

/** Cadangan ASCII untuk `filename=` (RFC 6266): diakritik dilepas, sisanya `_`. */
function asciiFallback(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\%]/g, "_")
    .trim();
  return s || "file";
}

/** RFC 5987 `ext-value` (UTF-8, percent-encoding atas karakter di luar attr-char). */
function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** `Content-Disposition` dengan nama berkas DATUM (filename + filename*). */
export function contentDisposition(type: "inline" | "attachment", fileName: string): string {
  const clean = fileName.replace(/[\u0000-\u001f\u007f]/g, "");
  return `${type}; filename="${asciiFallback(clean)}"; filename*=UTF-8''${rfc5987(clean)}`;
}

/**
 * `?name=` (E57). Absen -> `null` (pakai bawaan); satu nilai E57 -> mode;
 * nilai lain atau parameter ganda -> `"invalid"` (400 `/query/name`).
 */
export function parseNameMode(q: URLSearchParams): FinalNameMode | null | "invalid" {
  const all = q.getAll("name");
  if (all.length === 0) return null;
  if (all.length > 1) return "invalid";
  return (FINAL_NAME_MODES as readonly string[]).includes(all[0]) ? (all[0] as FinalNameMode) : "invalid";
}

/** Bawaan U-2 (D-363): dokumen ber-contractKind -> nama final; lainnya -> DATUM. */
export function defaultNameMode(contractKind: string | null | undefined): FinalNameMode {
  return typeof contractKind === "string" && contractKind !== "" ? "final" : "datum";
}

/** Nama final hanya dipakai bila cocok C51 (ASCII aman; mencegah injeksi header). */
function safeFinalName(name: string | undefined): string | undefined {
  return typeof name === "string" && FINAL_RE.test(name) ? name : undefined;
}

/** Header lengkap sajian berkas. */
export function fileHeaders(i: {
  /** Nama DATUM (kolom `fileName`). */
  fileName: string;
  /** Nama final C51 (FN-01); dipasang di header C50 bila sah. */
  finalFileName?: string;
  /** Nama di Content-Disposition; bawaan `datum`. `final` tanpa nama final sah -> DATUM. */
  nameMode?: FinalNameMode;
  bytes: number;
  sha256: string;
  inline: boolean;
  download: boolean;
  shaVerified?: boolean;
}): Headers {
  const kind = serveKindOf(i.fileName);
  const finalName = safeFinalName(i.finalFileName);
  const shownName = i.nameMode === "final" && finalName ? finalName : i.fileName;
  const h = new Headers();
  h.set("Content-Type", KIND_CONTENT_TYPE[kind]);
  h.set("Content-Length", String(i.bytes));
  h.set("Content-Disposition", contentDisposition(dispositionType(kind, i), shownName));
  if (finalName) h.set(STUDIO_FINAL_FILENAME_HEADER, finalName);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("X-Studio-Sha256", i.sha256);
  if (i.shaVerified !== undefined) h.set("X-Studio-Sha256-Verified", i.shaVerified ? "true" : "false");
  if (isActiveContent(kind)) h.set("Content-Security-Policy", ACTIVE_CONTENT_CSP);
  return h;
}
