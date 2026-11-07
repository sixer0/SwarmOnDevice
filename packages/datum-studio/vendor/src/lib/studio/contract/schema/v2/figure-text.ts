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
import { FIGURE_BOUNDS } from "../figure-bounds";
import type { AjvErrorLike } from "./forbidden";

/** Keyword galat semu yang dipetakan `classifySchemaV2Errors` ke `checkId: "FIGURE_TEXT"`. */
export const FIGURE_TEXT_KEYWORD = "figureTextLength";
export const FIGURE_TEXT_CHECK_ID = "FIGURE_TEXT";

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
