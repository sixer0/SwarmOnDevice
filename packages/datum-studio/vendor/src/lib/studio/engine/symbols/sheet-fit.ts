/**
 * engine/symbols — lembar simbol isi-pas `fit` (IP-42a, D-137 opsi B).
 *
 * Port tata letak RL Garis B `datum_symbols.py sheet()` (:593-626): kepala
 * "ID STANDAR · JUDUL" huruf besar, petak 24 x 24 mm berjarak 4 mm (6 kolom
 * pada lebar 166 mm), langkah baris 33 mm, label id (IBM Plex Mono 2,1, ink400)
 * dan nama Indonesia (IBM Plex Sans Condensed 2,2, ink900) di bawah petak,
 * amplifier eselon "battalion" pada mil:friend. Tinggi mengikuti isi.
 *
 * RL menggambar keempat dialek dalam satu lembar; BM (Gambar 10.1-10.5, via
 * Panduan Simbol Engineering GSP v1.0 Gambar 5.x) memakai satu PITA per dialek
 * dari lembar itu. Pita diukur dari aset BM (1500 px = 178 mm, pitch 236 px =
 * 28 mm): bantalan 6 mm kiri/kanan dan di atas garis dasar kepala; pita
 * dipotong 6 mm di atas kepala dialek berikutnya, pita dialek terakhir (mil)
 * berakhir di ujung lembar RL. Lembar ditampilkan selebar lebar turunan (A4 166 mm):
 * tata letak (kolom bawaan, lebar viewBox) dihitung pada lebar nyata itu (D-245 H1).
 *
 * Geometri simbol tetap HS (paritas SY; petak RL juga berpusat di x + 12).
 * Warna token interior = literal RL (#101418, #6B7783, #FCFCFB). Deterministik.
 */
import type { SymbolDialect } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { DIALECT_LIBS } from "./dialects";
import { INK400, INK900, num, PAPER, xmlEscape } from "./primitives";

/** Urutan keluarga lembar RL (:597). Keluarga terakhir memakai ekor penuh. */
const RL_FAMILIES: readonly SymbolDialect[] = ["iec", "isa", "sec", "mil"];

/** `STANDARDS[fam].id/title` RL (:41-80). */
const RL_STANDARDS: Readonly<Record<SymbolDialect, { id: string; title: string }>> = {
  iec: { id: "IEC 60617 DB", title: "Graphical symbols for diagrams" },
  isa: { id: "ANSI/ISA-5.1-2024", title: "Instrumentation and Control - Symbols and Identification" },
  sec: { id: "GSP project legend", title: "Security and surveillance site-plan marks" },
  mil: { id: "MIL-STD-2525E (31 December 2022)", title: "Joint Military Symbology" },
};

/** Id dan nama Indonesia per dialek dalam urutan registri RL `SYMBOLS` (:494-547). */
const RL_NAMES: Readonly<Record<SymbolDialect, ReadonlyArray<readonly [string, string]>>> = {
  iec: [
    ["iec:breaker", "Pemutus daya"],
    ["iec:disconnector", "Pemisah"],
    ["iec:contactor", "Kontaktor"],
    ["iec:switch", "Sakelar"],
    ["iec:changeover", "Kontak pindah (ATS)"],
    ["iec:fuse", "Sekring"],
    ["iec:generator", "Generator"],
    ["iec:motor", "Motor"],
    ["iec:transformer", "Transformator"],
    ["iec:ct", "Trafo arus"],
    ["iec:arrester", "Penangkap surja"],
    ["iec:earth", "Pembumian"],
    ["iec:battery", "Baterai"],
    ["iec:lamp", "Lampu"],
    ["iec:busbar", "Rel daya"],
    ["iec:enclosure", "Blok fungsi (UPS, penyearah)"],
  ],
  isa: [
    ["isa:field", "Instrumen lapangan"],
    ["isa:primary", "Instrumen ruang kendali"],
    ["isa:auxiliary", "Instrumen lokasi bantu"],
    ["isa:inaccessible", "Instrumen tak terjangkau"],
    ["isa:shared", "Tampilan bersama"],
    ["isa:shared-field", "Tampilan bersama lapangan"],
    ["isa:computer", "Fungsi komputer"],
    ["isa:plc", "PLC"],
    ["isa:valve", "Katup kendali"],
    ["isa:valve-diaphragm", "Katup aktuator diafragma"],
    ["isa:valve-motor", "Katup aktuator motor"],
    ["isa:valve-solenoid", "Katup aktuator solenoid"],
  ],
  sec: [
    ["sec:camera", "Kamera tetap + kerucut pandang"],
    ["sec:ptz", "Kamera PTZ"],
    ["sec:pir", "Detektor gerak inframerah"],
    ["sec:fence", "Sensor pagar"],
    ["sec:reader", "Pembaca akses"],
    ["sec:barrier", "Palang kendaraan"],
    ["sec:mast", "Tiang lampu / kamera"],
  ],
  mil: [
    ["mil:friend", "Kawan (darat)"],
    ["mil:hostile", "Lawan (darat)"],
    ["mil:neutral", "Netral (darat)"],
    ["mil:unknown", "Tak dikenal (darat)"],
    ["mil:friend-air", "Kawan (udara)"],
    ["mil:hostile-air", "Lawan (udara)"],
  ],
};

/**
 * Swarm patch (row 124, CP-45, manual Rev A SM-01/SM-03, ID p.63 and 66): name and standard of one
 * symbol for the key row of a diagram that draws it on a node. `house` = GSP project legend
 * (`sec:`), which the key must mark "bukan simbol standar". Null for an id not in the registry.
 */
export function symbolLegendName(id: string): { name: string; standard: string; house: boolean } | null {
  const d = String(id).split(":", 1)[0] as SymbolDialect;
  const row = RL_NAMES[d]?.find(([sid]) => sid === id);
  if (!row) return null;
  return { name: row[1], standard: RL_STANDARDS[d].id, house: d === "sec" };
}

/** Konstanta RL `sheet()` (:594-623), mm. Lebar RL 166 mm = bentang A4, kini argumen turunan `widthMm`. */
const CELL_W = 24.0;
const CELL_H = 24.0;
const GAP = 4.0;
const HEAD_STEP = 4.0;
const ROW_STEP = CELL_H + 9.0;
const FAMILY_TAIL = CELL_H + 14.0;
const ID_DY = 3.2;
const NAME_DY = 6.2;
/** RL MM_PT (:37) dan amplifier eselon 7 pt di v = -0,06 kotak 18 x 24 (:476-483). */
const MM_PT = 0.3527777778;
const ECHELON_SIZE = 7.0 * MM_PT;
const ECHELON_DY = -0.06 * CELL_H + ECHELON_SIZE * 0.35;
/** Pita BM terukur (lihat kepala modul), mm. */
const BAND_PAD = 6.0;

const FACE_HEAD = "'IBM Plex Sans Condensed',sans-serif";
const FACE_MONO = "'IBM Plex Mono',monospace";
const FACE_ECHELON = "'IBM Plex Sans Condensed','IBM Plex Sans',sans-serif";

/** Kolom bawaan RL pada lebar `widthMm`: `int((width + gap) // (cell_w + gap))` (166 mm = 6). */
export function fitSheetMaxCols(widthMm: number): number {
  return Math.floor((widthMm + GAP) / (CELL_W + GAP));
}

function t(
  body: string,
  x: number,
  y: number,
  face: string,
  size: number,
  fill: string,
  opts: { anchor?: "middle"; weight?: number; spacing?: number } = {},
): string {
  const w = opts.weight ? ` font-weight="${opts.weight}"` : "";
  const ls = opts.spacing ? ` letter-spacing="${num(opts.spacing)}"` : "";
  const a = opts.anchor ? ` text-anchor="${opts.anchor}"` : "";
  return `<text x="${num(x)}" y="${num(y)}" font-family="${face}" font-size="${num(size)}"${w}${ls} fill="${fill}"${a}>${xmlEscape(body)}</text>`;
}

/**
 * Satu SVG lembar isi-pas untuk dialek `d` dengan `cols` kolom (1..`fitSheetMaxCols`,
 * sudah divalidasi pemanggil). Lebar tampil = `widthMm` turunan, tinggi = pita isi.
 */
export function symbolSheetFitSvg(d: SymbolDialect, cols: number, widthMm: number): string {
  const lib = DIALECT_LIBS[d];
  const entries = RL_NAMES[d];
  for (const [sid] of entries) {
    if (!Object.prototype.hasOwnProperty.call(lib, sid)) {
      throw new StudioEngineError("SCHEMA_INVALID", `engine/symbols: simbol lembar RL ${sid} tidak ada di pustaka`, { id: sid });
    }
  }
  const rows = Math.max(1, Math.ceil(entries.length / cols));
  const last = RL_FAMILIES[RL_FAMILIES.length - 1] === d;
  const tail = last ? FAMILY_TAIL : FAMILY_TAIL - BAND_PAD;
  const vbW = widthMm + 2 * BAND_PAD;
  const vbH = BAND_PAD + HEAD_STEP + (rows - 1) * ROW_STEP + tail;
  const outW = widthMm;
  const outH = (vbH * outW) / vbW;
  const std = RL_STANDARDS[d];

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(outW)}mm" height="${num(outH)}mm" ` +
      `viewBox="0 0 ${num(vbW)} ${num(vbH)}" data-dialect="${d}" data-sheet="fit">`,
    `<rect x="0" y="0" width="${num(vbW)}" height="${num(vbH)}" fill="${PAPER}"/>`,
    t(`${std.id.toUpperCase()} · ${std.title.toUpperCase()}`, BAND_PAD, BAND_PAD, FACE_HEAD, 2.7, INK900, {
      weight: 600,
      spacing: 0.24,
    }),
  ];
  const y0 = BAND_PAD + HEAD_STEP;
  entries.forEach(([sid, name], i) => {
    const x = BAND_PAD + (i % cols) * (CELL_W + GAP);
    const y = y0 + Math.floor(i / cols) * ROW_STEP;
    const cx = x + CELL_W / 2;
    parts.push(`<g transform="translate(${num(x)},${num(y)})" data-mark="node" data-symbol="${xmlEscape(sid)}">${lib[sid]()}</g>`);
    if (sid === "mil:friend") {
      parts.push(t("||", cx, y + ECHELON_DY, FACE_ECHELON, ECHELON_SIZE, INK900, { anchor: "middle", weight: 600 }));
    }
    parts.push(t(sid, cx, y + CELL_H + ID_DY, FACE_MONO, 2.1, INK400, { anchor: "middle" }));
    parts.push(t(name, cx, y + CELL_H + NAME_DY, FACE_HEAD, 2.2, INK900, { anchor: "middle" }));
  });
  parts.push("</svg>");
  return parts.join("");
}
