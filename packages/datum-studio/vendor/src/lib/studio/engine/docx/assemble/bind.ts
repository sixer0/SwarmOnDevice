/**
 * Pengikatan run konten-saja ke templat untuk blok yang dirender modul
 * figur/turunan (RT-01, D-119).
 *
 * Run dokumen konten-saja hanya membawa peran wajah semantik (`faceRole`:
 * `symbolGlyph` untuk glif provenans/simbol, `mono` untuk kode). Glif simbol
 * sebaris (paragraf yang juga memuat teks lain) mendapat
 * `render.run.symbolGlyphByRole[peran inang]` templat (R-37) SEBELUM render.
 *
 * Wajah tidak diikat di sini: serializer paket (`package/xml.ts`
 * `mergeRunProps`) menegakkan face XOR faceRole, sehingga run ber-`faceRole`
 * tanpa `face` tidak mewarisi wajah dasar (RQ-1 menggantikan pengikatan wajah
 * sementara RT-01).
 *
 * Tabel TIDAK melewati modul ini: modul tabel menerapkan
 * `symbolGlyphByRole[peran sel]` secara asli (RQ-2 `symbolRuns`, termasuk
 * caption dan `table.source`; cermin `hostCellRole` dihapus SR-16, D-152).
 * Run ber-`face` eksplisit (dokumen lama) tidak disentuh; blok lain tidak
 * melewati modul ini.
 */
import type { NormBlock, ParamMap, RoleKey, Run, RunProps } from "../../../contract";
import { FIGURE_BLOCK_TYPES } from "../../../contract/enums";
import { hasPlainText, symbolGlyphProps } from "../blocks/semantic";

const FIGURE_TYPES: ReadonlySet<string> = new Set(FIGURE_BLOCK_TYPES);

/** Jenis blok yang diikat (dirender modul figur S19 dan turunan). */
export const BOUND_RUN_TYPES: ReadonlySet<string> = new Set([...FIGURE_TYPES, "derivation"]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function bindRun(r: Run, symbol: RunProps | undefined): Run {
  if (!("t" in r) || r.face) return r;
  return symbol && r.faceRole === "symbolGlyph" ? ({ ...symbol, ...r } as Run) : r;
}

function bindRuns(runs: readonly Run[], params: ParamMap, role: RoleKey | undefined): Run[] {
  const symbol = hasPlainText(runs) ? symbolGlyphProps(params, role) : undefined;
  return symbol ? runs.map((r) => bindRun(r, symbol)) : [...runs];
}

/** Inline/CellParagraph/RailLine: ikat `runs` bila ada. */
function bindInline<T>(v: T, params: ParamMap, role: RoleKey | undefined): T {
  if (!isObj(v) || !Array.isArray(v.runs)) return v;
  return { ...v, runs: bindRuns(v.runs as Run[], params, role) } as T;
}

/** Ikat setiap objek ber-`runs` di dalam `v` tanpa peran inang (wajah saja). */
function bindDeep(v: unknown, params: ParamMap): unknown {
  if (Array.isArray(v)) return v.map((x) => bindDeep(x, params));
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = k === "runs" && Array.isArray(x) ? bindRuns(x as Run[], params, undefined) : bindDeep(x, params);
  }
  return out;
}

function bindFigure(f: Obj, params: ParamMap): Obj {
  const out: Obj = { ...f };
  if (isObj(f.caption)) out.caption = { ...f.caption, inline: bindInline(f.caption.inline, params, "caption") };
  if (isObj(f.source)) out.source = { ...f.source, inline: bindInline(f.source.inline, params, "figure.source") };
  if (isObj(f.keyRow)) out.keyRow = bindInline(f.keyRow, params, "figure.keyRow");
  return out;
}

/** Isi blok terikat; objek baru (isi masukan tidak diubah). Blok jenis lain dikembalikan apa adanya. */
export function bindBlockRuns(block: NormBlock, params: ParamMap): NormBlock {
  if (!BOUND_RUN_TYPES.has(block.type) || !isObj(block.content)) return block;
  const c = block.content as Obj;
  const content = FIGURE_TYPES.has(block.type) ? bindFigure(c, params) : (bindDeep(c, params) as Obj);
  return { ...block, content: content as NormBlock["content"] };
}
