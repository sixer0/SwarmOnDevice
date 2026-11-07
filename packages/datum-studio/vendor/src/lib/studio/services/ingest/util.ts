/**
 * Utilitas murni layanan ingest (S48): hash sha256, JSON kanonik, JSON
 * Pointer, dan ekstraksi teks polos. Tidak ada transformasi teks (A9): teks
 * dibaca apa adanya, hanya digabung untuk `NormBlock.textPlain`.
 */
import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * JSON kanonik: kunci objek diurutkan, `undefined` dibuang (setara
 * JSON.stringify). Dipakai untuk `contentSha256`, `snapshotSha256`,
 * `inputSha256` agar hash tidak bergantung urutan kunci masukan.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : stableStringify(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || typeof v === "function") continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Segmen JSON Pointer (RFC 6901). */
export function pointerSegment(s: string | number): string {
  return String(s).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function joinPointer(base: string, ...segs: Array<string | number>): string {
  return base + segs.map((s) => `/${pointerSegment(s)}`).join("");
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Medan yang tidak memuat teks isi (format, identitas, ekstensi). */
const NON_TEXT_KEYS: ReadonlySet<string> = new Set([
  "text",
  "runs",
  "x",
  "format",
  "runDefaults",
  "labelProps",
  "marker",
  "setup",
  "headingFormat",
  "signRowFormat",
  "paragraphFormat",
  "layout",
  "borders",
  "shading",
  "columns",
  "marginsTw",
  "blockId",
  "colsTw",
]);

function runsText(runs: readonly unknown[]): string {
  let out = "";
  for (const r of runs) {
    if (!isObject(r)) continue;
    if (typeof r.t === "string") out += r.t;
    else if (r.tab === true) out += "\t";
    else if (r.br === "line") out += "\n";
  }
  return out;
}

function collect(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.text === "string") out.push(node.text);
  if (Array.isArray(node.runs)) out.push(runsText(node.runs));
  for (const [k, v] of Object.entries(node)) {
    if (NON_TEXT_KEYS.has(k)) continue;
    if (v !== null && typeof v === "object") collect(v, out);
  }
}

/**
 * Teks polos blok untuk pencarian dan lint pindai: gabungan setiap `text`
 * (md-lite apa adanya) dan `runs[].t`, dipisah baris baru per Inline.
 */
export function plainText(content: unknown): string {
  const out: string[] = [];
  collect(content, out);
  return out.filter((s) => s !== "").join("\n");
}
