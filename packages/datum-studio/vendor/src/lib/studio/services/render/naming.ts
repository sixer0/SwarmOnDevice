/**
 * Nama berkas, MIME, dan direktori relatif keluaran render (S51, §7.2).
 * Penulisan dan guard traversal tetap milik services/storage (S52); di sini
 * hanya nama yang deterministik dari masukan.
 */
import type { Inline, StudioOutputFormat } from "../../contract";

export const FORMAT_ORDER: readonly StudioOutputFormat[] = ["DOCX", "PDF", "HTML", "SVG", "PNG"];

export const FORMAT_EXT: Readonly<Record<StudioOutputFormat, string>> = {
  DOCX: "docx",
  PDF: "pdf",
  HTML: "html",
  SVG: "svg",
  PNG: "png",
};

export const FORMAT_MIME: Readonly<Record<StudioOutputFormat, string>> = {
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PDF: "application/pdf",
  HTML: "text/html; charset=utf-8",
  SVG: "image/svg+xml",
  PNG: "image/png",
};

/** Dedupe + urut kanonik (determinisme urutan tulis). */
export function normalizeFormats(formats: readonly string[]): StudioOutputFormat[] {
  const want = new Set(formats.map((f) => String(f).toUpperCase()));
  return FORMAT_ORDER.filter((f) => want.has(f));
}

const MISSION_FOLDER_RE = /^\d{4}-\d{2}-\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$/;

/** `<YYYY-MM-DD>_<misi>`; absen/tidak sah -> `<tanggal>_studio` (§7.2). */
export function missionFolderOr(folder: string | null | undefined, date: string): string {
  if (folder && MISSION_FOLDER_RE.test(folder)) return folder;
  return `${date.slice(0, 10)}_studio`;
}

/** Direktori artefak mandiri: `docs/<misi>/studio/artefak/<artifactId>`. */
export function artifactRelDir(missionFolder: string | null | undefined, createdAt: Date, artifactId: string): string {
  const safeId = artifactId.replace(/[^A-Za-z0-9_-]/g, "");
  return `docs/${missionFolderOr(missionFolder, createdAt.toISOString())}/studio/artefak/${safeId}`;
}

/**
 * Aturan nama DATUM (§7.2, DATUM-38): `_` -> spasi, `<>:"/\|?*` dan kendali
 * dibuang, spasi dirapatkan, maks 120 karakter sebelum ekstensi, titik/spasi
 * akhir dibuang.
 */
export function datumSafeName(base: string, ext: string, fallback = "Berkas"): string {
  let s = base
    .replace(/_/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 120) s = s.slice(0, 120);
  s = s.replace(/[. ]+$/g, "");
  if (!s) s = fallback;
  return `${s}.${ext}`;
}

/** Teks polos dari Inline (`text` md-lite atau `runs[]`). */
export function inlineText(inl: Inline | undefined | null): string {
  if (!inl || typeof inl !== "object") return "";
  if ("text" in inl && typeof inl.text === "string") return inl.text.replace(/[*`_]/g, "");
  if ("runs" in inl && Array.isArray(inl.runs)) {
    return inl.runs.map((r) => ("t" in r && typeof r.t === "string" ? r.t : " ")).join("");
  }
  return "";
}

/** Nama berkas figur: `<Gambar C.n> <Judul>[ lembar n].<ext>`. */
export function figureFileName(label: string, title: string, sheet: number, ext: string): string {
  const base = [label, title].filter((s) => s && s.trim()).join(" ") + (sheet > 1 ? ` lembar ${sheet}` : "");
  return datumSafeName(base, ext, "Gambar");
}

// ── Lingkup render draf (SR-15, register 03 §12 "Berkas draf") ───────────

/** Lingkup draf yang sudah diselesaikan terhadap snapshot (bab di slot lampiran = `appendix`). */
export type DraftScopeLayout =
  | { kind: "CHAPTER"; key: string; appendix: boolean }
  | { kind: "SLOT"; key: string; label: string };

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9-]/g, "");
}

/** Subdirektori di bawah `rev-<n>/`: `bab-<k>`, `lamp-<k>` (bab slot lampiran), `slot-<slotKey>`. */
export function draftScopeDir(s: DraftScopeLayout): string {
  if (s.kind === "SLOT") return `slot-${safeKey(s.key)}`;
  return `${s.appendix ? "lamp" : "bab"}-${safeKey(s.key)}`;
}

/** Akhiran nama berkas DATUM: ` Bab <k>` / ` Lampiran <k>` / ` <label slot>`. */
export function draftScopeSuffix(s: DraftScopeLayout): string {
  if (s.kind === "SLOT") return s.label.trim() || s.key;
  return `${s.appendix ? "Lampiran" : "Bab"} ${s.key}`;
}

/**
 * Sisipkan akhiran lingkup sebelum ekstensi nama DATUM dokumen
 * (`<Judul> <nomor> RevA.docx` -> `<Judul> <nomor> RevA Bab 3.docx`). Batang
 * dipotong lebih dulu agar akhiran tidak pernah terpotong oleh batas 120.
 */
export function draftFileName(baseFileName: string, suffix: string): string {
  const dot = baseFileName.lastIndexOf(".");
  const ext = dot > 0 ? baseFileName.slice(dot + 1) : "bin";
  const stem = dot > 0 ? baseFileName.slice(0, dot) : baseFileName;
  const tail = datumSafeName(suffix, "x").replace(/\.x$/, "");
  const room = Math.max(1, 120 - tail.length - 1);
  return datumSafeName(`${stem.slice(0, room).trimEnd()} ${tail}`, ext);
}
