/**
 * Rel bukti per paragraf (S16; KT-18..KT-22, KT-29, KT-39; Garis A `rail_host`/`rail_chip`).
 *
 * Moda A, dua perender (R-12 `render.rail.renderer`):
 * - `framePr` (Garis A, datum_docx.py:584-619): paragraf inang menyempit ke
 *   kolom teks lewat `w:ind right` = gutter + rel; setiap baris rel menjadi
 *   chip paragraf ber-`w:framePr` (bentuk pasca round-trip Word
 *   RAIL_FRAMEPR_POST: w, wrap none, hAnchor margin, x) sesudah inang.
 * - `table3col` (BM.docx T013 dkk.): tabel 1x3 [prosa, penyela `<w:p/>`, rel],
 *   lebar dari R-13 `render.rail.colsTw`.
 * Moda B (tanpa kolom rel): baris rel ditulis sebagai paragraf biasa di
 *   bawah inang (format peran rel), tanpa bingkai.
 *
 * K2 rev B (RAIL-1008, FIX-R1/D-342): pada perender `framePr` ruang rel adalah
 * properti PER-PARAGRAF. Hanya inang chip yang menyempit; prosa tanpa provenans
 * memakai lebar teks penuh (166 mm pada A4, mengikuti token grid kertas lain).
 * Indentasi kanan peran yang sama dengan cadangan rel (gutter + rel) adalah sisa
 * profil `table3col` dan dibuang dari paragraf tanpa rel (`text.ts` hostFormat).
 * `assertRailK2` (G-RAIL-3 rev B) memeriksa XML unit hasil render: paragraf
 * menyempit sebesar cadangan rel tanpa chip sesudahnya, atau chip tanpa inang,
 * = BY_CONSTRUCTION_FAILED. Moda `table3col` (Manual 000) tidak tersentuh.
 *
 * Varian kolom tercadang (C20 / GF-24, R-75 `render.rail.reserveColumn`, opt-in): pada
 * moda K2 setiap paragraf badan unit interior menyempit sebesar cadangan rel, berchip
 * atau tidak, sehingga badan 128 mm dan kolom rel 32 mm kosong di setiap halaman interior
 * ("Rel yang kosong itu benar", manual ID:2711; EN:2764). Margin seksi tidak berubah
 * (GF-02/GF-03, register research/38 §6.3); tabel dan gambar tetap 128 atau 166 mm
 * (EN:2737: 166 mm untuk peta, grafik, dan tabel lebar). Absen/false = K2 rev B.
 *
 * Baris tanda: run glif (`glyphRun[mark]` peran `rail.mark`, cadangan wajah
 * symbolGlyph + warna `marks.<m>.colour`) lalu run label " <label>" (pola
 * BM.docx: spasi pemisah di awal run label). Teks label/sumber/catatan apa adanya.
 */
import { PROVENANCE_GLYPHS, type NormUnitKind, type ParaFormat, type ParamValue, type ProvenanceMark, type RailLine, type RunProps } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { provenanceMarkLabelText, wrapperLangOf } from "../../front/texts";
import { mmToTw } from "../../tokens";
import { WRAPPER_KINDS } from "../package/section";
import type { BlockEnv, RailLayout } from "./env";
import { singleRowTable } from "./table";
import { el } from "./xml";

export type HostVariant = "plain" | "framePr" | "table";

/** R-75 (C20 / GF-24): cadangkan kolom rel di setiap halaman interior. */
export const PARAM_RAIL_RESERVE_COLUMN = "render.rail.reserveColumn";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Resolver murni tata rel (sumber tunggal untuk `BlockEnv.rail()` dan assert
 * G-RAIL-3 tingkat perakit). `textColumnMm` dipanggil hanya bila
 * `render.rail.colsTw` tidak ditulis templat.
 */
export function resolveRailLayout(param: (key: string) => ParamValue | undefined, textColumnMm: () => number): RailLayout {
  const renderer = param("render.rail.renderer") === "table3col" ? "table3col" : "framePr";
  const raw = param("render.rail.colsTw");
  let colsTw = Array.isArray(raw) && raw.every(isNum) && raw.length > 0 ? (raw as number[]).map(Math.round) : undefined;
  if (!colsTw) {
    const text = textColumnMm();
    const g = param("grid.gutterMm");
    const r = param("grid.evidenceRailMm");
    const gutter = isNum(g) ? g : 6;
    const rail = isNum(r) ? r : 32;
    colsTw = param("layout.railMode") === "B" ? [mmToTw(text + gutter + rail)] : [mmToTw(text), mmToTw(gutter), mmToTw(rail)];
  }
  // P4S-07 (FIX-H4): templat mematikan rel = moda B dengan bentang penuh, sama dengan HTML
  // (`buildHtmlShell`: railEnabled false -> B); baris rel tetap tertulis di bawah inang.
  if (param("device.evidenceRail.enabled") === false) {
    return { mode: "B", renderer, colsTw: [colsTw.reduce((x, y) => x + y, 0)] };
  }
  // `auto` tanpa konteks sitasi = susunan moda A (D-37); B bila diminta atau kolom rel tunggal.
  const mode = param("layout.railMode") === "B" || colsTw.length < 3 ? "B" : "A";
  // C20: varian kolom tercadang hanya di samping perender framePr (moda K2); medan ditulis hanya bila aktif.
  if (mode === "A" && renderer === "framePr" && param(PARAM_RAIL_RESERVE_COLUMN) === true) return { mode, renderer, colsTw, reserveColumn: true };
  return { mode, renderer, colsTw };
}

/** Cadangan rel (gutter + rel, twip) bila tata rel berada di moda K2 (A + `framePr`); selain itu undefined. */
export function railK2ReserveTw(lay: RailLayout): number | undefined {
  return lay.mode === "A" && lay.renderer === "framePr" && lay.colsTw.length >= 3 ? lay.colsTw[1] + lay.colsTw[2] : undefined;
}

/**
 * Cadangan rel K2 dari parameter saja (tanpa menuntut `grid.textColumnMm`: kolom teks
 * tidak ikut cadangan), untuk perakit dan varian `plain` yang tidak boleh gagal karena
 * parameter kolom teks absen.
 */
export function railK2ReserveOf(param: (key: string) => ParamValue | undefined): number | undefined {
  return railK2ReserveTw(resolveRailLayout(param, () => 0));
}

/**
 * Cadangan rel (twip) yang berlaku untuk paragraf badan blok ini pada varian kolom
 * tercadang (C20): K2 + R-75 true + unit interior (bukan sampul, lembar kendali, daftar
 * isi, pembatas bagian). Selain itu undefined (perilaku K2 rev B per paragraf).
 */
export function reservedColumnTw(env: BlockEnv): number | undefined {
  return reservedColumnTwOf((k) => env.param(k), env.unitKind());
}

/** Bentuk parameter-saja `reservedColumnTw` untuk penyaji tanpa BlockEnv (figur, tabel); kolom teks tidak dituntut. */
export function reservedColumnTwOf(param: (key: string) => ParamValue | undefined, unitKind: NormUnitKind | undefined): number | undefined {
  if (param(PARAM_RAIL_RESERVE_COLUMN) !== true || unitKind === undefined || WRAPPER_KINDS.has(unitKind)) return undefined;
  const lay = resolveRailLayout(param, () => 0);
  return lay.reserveColumn ? railK2ReserveTw(lay) : undefined;
}

/**
 * Apparatus (caption, kunci, SUMBER) artefak selebar kolom teks atau lebih sempit ikut badan
 * 128 mm pada kolom tercadang; artefak bentang penuh (166 mm, EN:2737) membawa apparatusnya
 * selebar artefak. `widthTw` = lebar artefak; tanpa `grid.textColumnMm` = tidak diubah.
 */
export function apparatusReserveTw(param: (key: string) => ParamValue | undefined, unitKind: NormUnitKind | undefined, widthTw: number): number | undefined {
  const reserve = reservedColumnTwOf(param, unitKind);
  const text = param("grid.textColumnMm");
  if (reserve === undefined || !isNum(text)) return undefined;
  // Toleransi sisa pembulatan per kolom (BM: tblW 9412 untuk 166 mm = 9411 tw).
  return widthTw <= mmToTw(text) + 4 ? reserve : undefined;
}

/** `para` dengan indentasi kanan paling sedikit `reserve` (indentasi lebih besar tetap); `reserve` undefined = apa adanya. */
export function reserveRight(para: ParaFormat, reserve: number | undefined): ParaFormat {
  if (reserve === undefined || (para.indRightTw ?? 0) >= reserve) return para;
  return { ...para, indRightTw: reserve };
}

/** Varian inang untuk paragraf tanpa rel: `framePr` (menyempit tanpa chip) pada kolom tercadang, selain itu `plain`. */
export function plainHostVariant(env: BlockEnv): HostVariant {
  return reservedColumnTw(env) !== undefined ? "framePr" : "plain";
}

/** Indentasi kanan paragraf badan pada kolom tercadang: paling sedikit sebesar cadangan rel (indentasi peran yang lebih besar tetap). */
export function withReservedColumn(env: BlockEnv, para: ParaFormat): ParaFormat {
  return reserveRight(para, reservedColumnTw(env));
}

function markGlyph(env: BlockEnv, mark: ProvenanceMark): string {
  const v = env.param(`marks.${mark.toLowerCase()}.glyph`);
  return typeof v === "string" && v.length > 0 ? v : PROVENANCE_GLYPHS[mark];
}

function glyphRunProps(env: BlockEnv, mark: ProvenanceMark, labelRun: RunProps | undefined): RunProps {
  const explicit = env.role("rail.mark").glyphRun?.[mark];
  if (explicit) return explicit;
  const colourRef = env.param(`marks.${mark.toLowerCase()}.colour`);
  const color = env.color(typeof colourRef === "string" ? colourRef : undefined);
  return env.mergeRun(labelRun, { faceRole: "symbolGlyph", ...(color ? { color } : {}) });
}

/**
 * Run label baris tanda (S95-C04, RT-01): `labelRunByMark[tanda]` peran bila
 * ada; selain itu, bila templat MENULIS `glyphRun` peran `rail.mark`, label
 * berwarna sama dengan glifnya (BM: TERUKUR 101418, DITURUNKAN B45309, ASUMSI
 * 9B1C1C). Tanpa keduanya = run dasar peran (perilaku lama, profil kanonik).
 */
export function markLabelRun(env: BlockEnv, mark: ProvenanceMark, base: RunProps): RunProps {
  const byMark = env.role("rail.mark").labelRunByMark?.[mark];
  if (byMark) return env.mergeRun(base, byMark);
  const glyph = env.ctx.tpl.roleFormats["rail.mark"]?.glyphRun?.[mark];
  return glyph?.color ? env.mergeRun(base, { color: glyph.color }) : base;
}

/** Paragraf-paragraf baris rel; `framePr` diisi untuk chip moda A Garis A. */
export function railLinesXml(env: BlockEnv, lines: readonly RailLine[], framePr?: string): string {
  return lines
    .map((line, i) => {
      const roleKey = line.kind === "mark" ? "rail.mark" : line.kind === "source" ? "rail.source" : "rail.note";
      const rf = env.role(roleKey);
      const para: ParaFormat = { ...(rf.para ?? {}), ...(line.format ?? {}) };
      const base = rf.run ?? {};
      let content: string;
      if (line.runs) {
        content = env.runs(line.runs, base);
      } else if (line.kind === "mark") {
        if (!line.mark) throw env.fail(`rail[${i}] kind "mark" tanpa medan mark`);
        const glyph = env.run({ t: markGlyph(env, line.mark) }, glyphRunProps(env, line.mark, base));
        const label = markLabelRun(env, line.mark, base);
        content = glyph + env.run({ t: ` ${line.label ?? provenanceMarkLabelText(line.mark, wrapperLangOf(env.ctx.snapshot.doc.meta))}` }, label);
      } else {
        const text = line.text ?? line.label;
        if (text === undefined) throw env.fail(`rail[${i}] kind "${line.kind}" tanpa text/label/runs`);
        content = env.run({ t: text }, base);
      }
      return env.para(para, content, framePr);
    })
    .join("");
}

/**
 * Bungkus inang dengan rel. `host(variant)` menulis paragraf inang sesuai varian:
 * `framePr` = inang menyempit (ind kanan), `table` = isi sel prosa 1x3, `plain` = biasa.
 */
export function withRail(env: BlockEnv, rail: readonly RailLine[] | undefined, host: (v: HostVariant) => string): string {
  if (!rail || rail.length === 0) return host(plainHostVariant(env));
  const lay = env.rail();
  if (lay.mode === "B") {
    // FIX-H4: rel dimatikan templat (P4S-07) = perilaku jelas, bukan diam-diam: baris tetap
    // ditulis (konten kekal) di bawah inang dan tercatat di log render.
    if (env.param("device.evidenceRail.enabled") === false) {
      env.warn(`rel bukti dimatikan templat (device.evidenceRail.enabled = false): ${rail.length} baris rel ditulis moda B di bawah paragraf`);
    }
    return host("plain") + railLinesXml(env, rail);
  }
  const [textTw, gutterTw, railTw] = lay.colsTw;
  if (lay.renderer === "framePr") {
    const framePr = el("w:framePr", { "w:w": railTw, "w:wrap": "none", "w:hAnchor": "margin", "w:x": textTw + gutterTw });
    return host("framePr") + railLinesXml(env, rail, framePr);
  }
  return singleRowTable(env, [
    { widthTw: textTw, content: host("table") },
    { widthTw: gutterTw, content: "<w:p/>" },
    { widthTw: railTw, content: railLinesXml(env, rail) },
  ]);
}

/** Indentasi kanan inang moda A framePr = gutter + rel (datum_docx.py RAIL_HOST_MM). */
export function railHostIndentTw(env: BlockEnv): number {
  const cols = env.rail().colsTw;
  return cols.length >= 3 ? cols[1] + cols[2] : 0;
}

// ── G-RAIL-3 rev B (K2): assert byte jadi per unit ─────────────────────────

interface ParaInfo {
  chip: boolean;
  rightTw: number | undefined;
  text: string;
}

/** Paragraf `w:p` (urut kemunculan, termasuk bersarang) dengan sifat pPr langsungnya. */
function scanParagraphs(xml: string): ParaInfo[] {
  const out: ParaInfo[] = [];
  const re = /<w:p(?=[\s>\/])[^>]*?(\/?)>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] === "/") {
      out.push({ chip: false, rightTw: undefined, text: "" });
      continue;
    }
    const start = re.lastIndex;
    const pPr = xml.startsWith("<w:pPr>", start) ? xml.slice(start, xml.indexOf("</w:pPr>", start)) : "";
    const ind = /<w:ind\b[^>]*?\bw:right="(-?\d+)"/.exec(pPr);
    const end = xml.indexOf("</w:p>", start);
    const text = (end < 0 ? "" : xml.slice(start, end)).replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, "").replace(/<[^>]+>/g, "");
    out.push({ chip: pPr.includes("<w:framePr"), rightTw: ind ? Number(ind[1]) : undefined, text: text.slice(0, 60) });
  }
  return out;
}

export interface RailK2Report {
  /** Paragraf inang (menyempit sebesar cadangan, diikuti chip). */
  hosts: number;
  /** Chip `w:framePr`. */
  chips: number;
}

/**
 * G-RAIL-3 rev B (K2, setara konsistensi dua arah HS pada tingkat paragraf):
 * pada moda K2 (A + `framePr`) setiap paragraf dengan `w:ind w:right` sama dengan
 * cadangan rel WAJIB diikuti chip `w:framePr`, dan setiap chip WAJIB didahului
 * inang atau chip lain. Pelanggaran = BY_CONSTRUCTION_FAILED (render gagal keras).
 * Di luar moda K2 (moda B, `table3col`) mengembalikan undefined tanpa memeriksa.
 */
export function assertRailK2(xml: string, lay: RailLayout, where: string): RailK2Report | undefined {
  const reserve = railK2ReserveTw(lay);
  if (reserve === undefined) return undefined;
  const paras = scanParagraphs(xml);
  const narrowed: string[] = [];
  const orphans: string[] = [];
  let hosts = 0;
  let chips = 0;
  paras.forEach((p, i) => {
    if (p.chip) {
      chips += 1;
      const prev = paras[i - 1];
      if (!prev || (!prev.chip && prev.rightTw === undefined)) orphans.push(p.text);
      return;
    }
    if (p.rightTw !== reserve) return;
    if (paras[i + 1]?.chip) hosts += 1;
    // C20: pada kolom tercadang paragraf badan menyempit tanpa chip memang benar.
    else if (!lay.reserveColumn) narrowed.push(p.text);
  });
  if (narrowed.length > 0 || orphans.length > 0) {
    const parts = [
      narrowed.length > 0 ? `${narrowed.length} paragraf tanpa chip menyempit w:right=${reserve} (prosa tanpa provenans wajib selebar teks penuh)` : "",
      orphans.length > 0 ? `${orphans.length} chip w:framePr tanpa paragraf inang` : "",
    ].filter(Boolean);
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `G-RAIL-3 rev B (K2) gagal pada ${where}: ${parts.join("; ")}`, {
      gate: "G-RAIL-3",
      unit: where,
      reserveTw: reserve,
      narrowed: narrowed.slice(0, 5),
      orphans: orphans.slice(0, 5),
    });
  }
  return { hosts, chips };
}
