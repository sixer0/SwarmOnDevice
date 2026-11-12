/**
 * SEC-FIX3 N-5 (D-508): teks blok figur v2 yang compose salin ke spec mesin dinilai dengan batas render yang SAMA
 * (`FIGURE_BOUNDS`, satu sumber dengan cek kapasitas `services/render/figure-limits.ts`) saat kiriman, bukan baru
 * saat render. Tanpa ini caption diagram 301..20000 karakter (skema `CaptionV2` bersama tabel: 20000) lolos kiriman
 * lalu figurnya dilewati diam-diam saat render.
 *
 * Pemetaan compose (`services/compose/blocks.ts` `chart`/`diagram`/`diagramSpec`, teks polos = `inlineV2Plain`):
 *  - diagram (spec sebaris): caption -> `title` (<= `diagramText.title`), source -> `source` (<= `diagramText.source`),
 *    `sources` = `spec.sources` bila tidak kosong, selain itu `[source]` (total <= `diagramText.sourcesTotal`);
 *  - chart (spec sebaris): caption -> `title`, source -> `source`, keduanya string spec (<= `stringChars`); data
 *    `steps` (juga di panel komposit) menyusun spec diagram dengan caption/source yang sama -> batas diagram juga.
 * Figur rujukan `artifactId` dilewati (judul/sumber dari artefak v1 yang berbatas skema v1).
 *
 * Dipanggil validator v2 bersama (`services/ingest/validate.ts` `studioValidator`/`validateV2Against`) SESUDAH ajv,
 * sehingga R04, R08, R12/R13, dan R16/R06/R14 menolaknya 400 `SCHEMA_INVALID` `checkId: "FIGURE_TEXT"`.
 */
import { CAPTION_GUIDE_MAX_CHARS, FIGURE_BOUNDS } from "../figure-bounds";
import type { AjvErrorLike } from "./forbidden";

/** Keyword galat semu yang dipetakan `classifySchemaV2Errors` ke `checkId: "FIGURE_TEXT"`. */
export const FIGURE_TEXT_KEYWORD = "figureTextLength";
export const FIGURE_TEXT_CHECK_ID = "FIGURE_TEXT";

/**
 * Swarm patch (1.2.6 row 27, T-01, register N-011..N-013): Studio mencetak label "GAMBAR n.m" sendiri, jadi caption
 * yang diawali token label figur tercetak ganda ("GAMBAR 1.1 Gambar 1.1 ..."). Caption blok figur v2 (diagram,
 * chart, image, symbolSheet; sebaris maupun rujukan `artifactId`) yang teks polosnya cocok `CAPTION_TOKEN_RE`
 * ditolak saat kiriman (bab/slot/dokumen) dan saat tambal blok R16 (`studio_figure_revise`) lewat validator v2
 * bersama, `checkId: "CAPTION_TOKEN_DUPLICATE"`. Render halaman tidak memeriksanya (dokumen tersimpan tetap terbit).
 */
export const CAPTION_TOKEN_KEYWORD = "figureCaptionToken";
export const CAPTION_TOKEN_DUPLICATE = "CAPTION_TOKEN_DUPLICATE";
// 1.2.6 row 27b (C12): pemisah kata kunci-nomor nol atau lebih spasi ("Gambar1.1" juga ditolak); "Gambaran ..." lolos
// karena sesudah kata kunci (dan spasi opsional) wajib ada angka.
// 1.2.6 FX-7 (C19d): nomor figur 1-3 digit (opsional .n / -n berulang); tahun 4 digit ("Grafik 2024 ...", "Diagram 2025
// rencana") bukan token. `\b` sesudah nomor menolak digit ke-4 (tanpa backtrack ke 1-3 digit pertama).
export const CAPTION_TOKEN_RE = /^\s*(gambar|figure|fig\.|grafik|bagan|diagram)\s*[A-Z]?\d{1,3}(?:[.\-]\d+)*\b/i;
const CAPTION_TOKEN_BLOCKS: ReadonlySet<unknown> = new Set(["diagram", "chart", "image", "symbolSheet"]);

/** Pesan penolakan: menyebut token yang ditemukan, aturannya, dan batas panjang caption (N-014). */
export function captionTokenMessage(token: string): string {
  return `caption diawali token label "${token}": Studio mencetak label GAMBAR n.m sendiri; hapus token dari caption dan tulis isinya saja, maks ${CAPTION_GUIDE_MAX_CHARS} karakter agar muat satu baris (CAPTION_GUIDE_MAX_CHARS = ${CAPTION_GUIDE_MAX_CHARS})`;
}

function captionToken(out: AjvErrorLike[], block: Rec, at: string): void {
  const m = CAPTION_TOKEN_RE.exec(figureInlinePlain(block.caption));
  if (!m) return;
  const token = m[0].trim();
  out.push({ instancePath: `${at}/caption`, keyword: CAPTION_TOKEN_KEYWORD, params: { token, limit: CAPTION_GUIDE_MAX_CHARS }, message: captionTokenMessage(token) });
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_DEPTH = 64;
const T = FIGURE_BOUNDS.diagramText;

/** Teks polos inline v2, sama dengan compose `inlineV2Plain` (run `t`, tab = "\t", selain itu baris baru). */
export function figureInlinePlain(i: unknown): string {
  if (!isRec(i)) return "";
  if (typeof i.text === "string") return i.text;
  if (!Array.isArray(i.runs)) return "";
  return i.runs.map((r) => (isRec(r) && typeof r.t === "string" ? r.t : isRec(r) && "tab" in r ? "\t" : "\n")).join("");
}

const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

function err(instancePath: string, limit: number, actual: number, message: string): AjvErrorLike {
  return { instancePath, keyword: FIGURE_TEXT_KEYWORD, params: { limit, actual }, message };
}

/** Batas diagram atas caption/source blok + `sources` spec terkomposisi. */
function diagramText(out: AjvErrorLike[], block: Rec, spec: unknown, at: string, specAt: string, what: string): void {
  const title = figureInlinePlain(block.caption).length;
  if (title > T.title) {
    out.push(err(`${at}/caption`, T.title, title, `caption ${what} menjadi judul gambar: ${title} karakter > batas ${T.title}; persingkat caption ${what} maks ${T.title} karakter`));
  }
  const source = figureInlinePlain(block.source);
  if (source.length > T.source) {
    out.push(err(`${at}/source`, T.source, source.length, `sumber ${what} ${source.length} karakter > batas ${T.source}; persingkat sumber ${what} maks ${T.source} karakter`));
    return;
  }
  const own = isRec(spec) && Array.isArray(spec.sources) && spec.sources.length > 0 ? spec.sources : null;
  const total = (own ?? [source]).reduce((n: number, s) => n + (typeof s === "string" ? s.length : 0), 0);
  if (total > T.sourcesTotal) {
    const ptr = own ? `${specAt}/sources` : `${at}/source`;
    out.push(err(ptr, T.sourcesTotal, total, `total teks sumber ${what} ${total} karakter > batas ${T.sourcesTotal}; persingkat atau gabungkan sumber (total maks ${T.sourcesTotal} karakter)`));
  }
}

function chartText(out: AjvErrorLike[], block: Rec, at: string): void {
  const max = FIGURE_BOUNDS.stringChars;
  for (const field of ["caption", "source"] as const) {
    const n = figureInlinePlain(block[field]).length;
    if (n > max) out.push(err(`${at}/${field}`, max, n, `${field} chart menjadi teks gambar: ${n} karakter > batas ${max}; persingkat ${field} chart maks ${max} karakter`));
  }
  const steps: Array<[unknown, string]> = [];
  if (isRec(block.data) && block.data.shape === "steps") steps.push([block.data.spec, `${at}/data/spec`]);
  if (Array.isArray(block.panels)) {
    block.panels.forEach((p, i) => {
      if (isRec(p) && isRec(p.data) && p.data.shape === "steps") steps.push([p.data.spec, `${at}/panels/${i}/data/spec`]);
    });
  }
  // Panel steps berbagi caption/source blok: satu temuan per medan cukup.
  const seen = new Set<string>();
  for (const [spec, specAt] of steps) {
    const local: AjvErrorLike[] = [];
    diagramText(local, block, spec, at, specAt, "diagram");
    for (const e of local) {
      if (seen.has(e.instancePath)) continue;
      seen.add(e.instancePath);
      out.push(e);
    }
  }
}

/**
 * Galat semu (bentuk ajv, `instancePath` relatif `data`) untuk setiap blok figur v2 sebaris di `data` (dokumen,
 * kiriman bab/slot, bab, bagian, atau blok tunggal). Iteratif; masukan sudah dibatasi transport dan skema.
 */
export function figureTextErrorsV2(data: unknown): AjvErrorLike[] {
  const out: AjvErrorLike[] = [];
  const stack: Array<{ v: unknown; p: string; d: number }> = [{ v: data, p: "", d: 0 }];
  while (stack.length > 0) {
    const { v, p, d } = stack.pop()!;
    if (d > MAX_DEPTH) continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], p: `${p}/${i}`, d: d + 1 });
      continue;
    }
    if (!isRec(v)) continue;
    if (CAPTION_TOKEN_BLOCKS.has(v.type) && v.caption !== undefined) captionToken(out, v, p);
    const inline = v.artifactId === undefined;
    if (v.type === "diagram" && inline && isRec(v.spec)) {
      diagramText(out, v, v.spec, p, `${p}/spec`, "diagram");
      continue;
    }
    if (v.type === "chart" && inline && typeof v.code === "string") {
      chartText(out, v, p);
      continue;
    }
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i >= 0; i--) stack.push({ v: v[keys[i]], p: `${p}/${esc(keys[i])}`, d: d + 1 });
  }
  return out;
}
