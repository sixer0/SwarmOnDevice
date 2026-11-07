/**
 * engine/symbols — geometri 41 simbol empat dialek (S31, I21).
 *
 * Port 1:1 HS `datumsimbol.py:98-284` (iec 16, isa 12, sec 7, mil 6). Setiap
 * fungsi menggambar ke petak CELL x CELL mm (24 x 24) dengan origin kiri-atas,
 * urutan elemen dan atribut sama dengan sumber (paritas kelas SY,
 * research/06:259). Data path `d` disalin literal dari sumber.
 */
import type { SymbolDialect } from "../../contract";
import { ALERT, c, g, HAIR, INK700, INK900, lead, p, PAPER, path, r, SIGNAL, STROKE_W, text } from "./primitives";

type Draw = () => string;

const MONO = "IBM Plex Mono";
const COND = "IBM Plex Sans Condensed";

// ---- dialek iec ---------------------------------------------------------------

/** Keluarga sakelar: bilah terbuka; pembeda hanya tanda pada kontak. HS :98-112 */
function iecSwitch(cx: number, cy: number, o: { cross?: boolean; coil?: boolean; tick?: boolean } = {}): string {
  const parts = [g(cx - 5, cy + 4, cx + 5, cy - 4, INK900, STROKE_W)];
  parts.push(c(cx - 5, cy + 4, 0.9, INK900, HAIR, PAPER));
  parts.push(c(cx + 5, cy - 4, 0.9, INK900, HAIR, PAPER));
  if (o.cross) {
    parts.push(g(cx - 2.2, cy - 2.2, cx + 2.2, cy + 2.2, INK900, HAIR * 1.5));
    parts.push(g(cx - 2.2, cy + 2.2, cx + 2.2, cy - 2.2, INK900, HAIR * 1.5));
  }
  if (o.tick) parts.push(g(cx + 5, cy - 6.2, cx + 5, cy - 2.2, INK900, HAIR * 1.5));
  if (o.coil) parts.push(r(cx + 3, cy + 2, 4, 4, INK900, HAIR * 1.5));
  return parts.join("");
}

const IEC: Readonly<Record<string, Draw>> = {
  "iec:breaker": () => lead("t") + lead("b") + iecSwitch(12, 12, { cross: true }),
  "iec:disconnector": () => lead("t") + lead("b") + iecSwitch(12, 12, { tick: true }),
  "iec:contactor": () => lead("t") + lead("b") + iecSwitch(12, 12, { coil: true }),
  "iec:switch": () => lead("t") + lead("b") + iecSwitch(12, 12),
  "iec:changeover": () =>
    lead("t") +
    g(12, 4, 12, 12, INK900, STROKE_W) +
    g(12, 12, 7, 17, INK900, STROKE_W) +
    c(7, 17, 0.9, INK900, HAIR, PAPER) +
    c(17, 17, 0.9, INK900, HAIR, PAPER) +
    g(17, 17, 17, 20, INK900, HAIR * 2),
  "iec:fuse": () => lead("t") + lead("b") + r(9, 7, 6, 10, INK900, STROKE_W) + g(12, 7, 12, 17, INK900, STROKE_W),
  "iec:generator": () =>
    lead("l") +
    lead("r") +
    c(12, 12, 6, INK900, STROKE_W) +
    path("M9.5 14.5 A3.5 3.5 0 0 1 9.5 9.5 M14.5 9.5 A3.5 3.5 0 0 1 14.5 14.5", INK900, HAIR * 1.5),
  "iec:motor": () => lead("l") + lead("r") + c(12, 12, 6, INK900, STROKE_W) + text(12, 14, MONO, 5, INK900, "M", "middle"),
  "iec:transformer": () => lead("l") + lead("r") + c(9.5, 12, 3.4, INK900, STROKE_W) + c(14.5, 12, 3.4, INK900, STROKE_W),
  "iec:ct": () =>
    lead("l") +
    lead("r") +
    c(12, 12, 4.5, INK900, STROKE_W) +
    path("M8.5 12 A3.5 3.5 0 0 1 15.5 12", INK900, HAIR * 1.5) +
    g(12, 6.5, 12, 8, INK900, HAIR * 1.5),
  "iec:arrester": () =>
    lead("t") +
    lead("b") +
    r(9, 8, 6, 8, INK900, STROKE_W) +
    g(12, 8, 12, 13, INK900, STROKE_W) +
    p(
      [
        [10.6, 13],
        [13.4, 13],
        [12, 15.4],
      ],
      SIGNAL,
      HAIR * 1.5,
      SIGNAL,
    ),
  "iec:earth": () =>
    lead("t") +
    g(12, 8, 12, 13, INK900, STROKE_W) +
    g(6, 13, 18, 13, INK900, STROKE_W) +
    g(8.5, 15.5, 15.5, 15.5, INK900, STROKE_W) +
    g(11, 18, 13, 18, INK900, STROKE_W),
  "iec:battery": () =>
    lead("l") +
    lead("r") +
    g(10, 7, 10, 17, INK900, STROKE_W * 1.6) +
    g(12.5, 9, 12.5, 15, INK900, STROKE_W) +
    g(15, 7, 15, 17, INK900, STROKE_W * 1.6) +
    g(17.5, 9, 17.5, 15, INK900, STROKE_W),
  "iec:lamp": () =>
    lead("l") +
    lead("r") +
    c(12, 12, 5, INK900, STROKE_W) +
    g(8.5, 8.5, 15.5, 15.5, INK900, HAIR * 1.5) +
    g(8.5, 15.5, 15.5, 8.5, INK900, HAIR * 1.5),
  "iec:busbar": () => g(4, 12, 20, 12, INK900, STROKE_W * 3),
  "iec:enclosure": () => r(6, 8, 12, 8, INK900, STROKE_W) + text(12, 13.2, COND, 4.5, INK700, "UPS", "middle"),
};

// ---- dialek isa ---------------------------------------------------------------

type IsaLines = 0 | 1 | 2 | "dash";

/** Gelembung ISA: bentuk = fungsi, garis = lokasi. HS :166-189 */
function isaBubble(shape: "circle" | "hex" | "sq-circle", lines: IsaLines, inner = ""): string {
  const m = 12;
  const parts: string[] = [];
  if (shape === "circle") {
    parts.push(c(m, m, 6, INK900, STROKE_W));
  } else if (shape === "hex") {
    parts.push(
      p(
        [
          [m - 3, m - 5.2],
          [m + 3, m - 5.2],
          [m + 6, m],
          [m + 3, m + 5.2],
          [m - 3, m + 5.2],
          [m - 6, m],
        ],
        INK900,
        STROKE_W,
      ),
    );
  } else {
    parts.push(r(m - 6, m - 6, 12, 12, INK900, STROKE_W));
    parts.push(c(m, m, 6, INK900, STROKE_W));
  }
  if (lines === 1) parts.push(g(m - 6, m + 2.5, m + 6, m + 2.5, INK900, HAIR * 1.5));
  if (lines === 2) {
    parts.push(g(m - 6, m + 1.5, m + 6, m + 1.5, INK900, HAIR * 1.5));
    parts.push(g(m - 6, m + 3.5, m + 6, m + 3.5, INK900, HAIR * 1.5));
  }
  if (lines === "dash") parts.push(g(m - 6, m + 2.5, m + 6, m + 2.5, INK900, HAIR * 1.5, "1.2,1"));
  if (inner) parts.push(inner);
  return parts.join("");
}

/** Badan katup dua segitiga + batang + aktuator. HS :192-205 */
function valve(actuator: "" | "diaphragm" | "motor" | "solenoid"): string {
  const m = 12;
  const body =
    p(
      [
        [m - 5, m - 4.5],
        [m - 5, m + 4.5],
        [m, m],
      ],
      INK900,
      STROKE_W,
    ) +
    p(
      [
        [m + 5, m - 4.5],
        [m + 5, m + 4.5],
        [m, m],
      ],
      INK900,
      STROKE_W,
    );
  const stem = g(m, m - 3, m, m - 6.5, INK900, STROKE_W);
  if (actuator === "diaphragm") {
    return body + stem + path(`M${m - 5} ${m - 6.5} A5 5 0 0 1 ${m + 5} ${m - 6.5}`, INK900, STROKE_W);
  }
  if (actuator === "motor") {
    return body + stem + c(m, m - 9, 2.6, INK900, HAIR * 1.5) + text(m, m - 8, MONO, 3.6, INK900, "M", "middle");
  }
  if (actuator === "solenoid") return body + stem + r(m - 3, m - 11.5, 6, 3, INK900, HAIR * 1.5);
  return body + stem;
}

const ISA: Readonly<Record<string, Draw>> = {
  "isa:field": () => isaBubble("circle", 0),
  "isa:primary": () => isaBubble("circle", 1),
  "isa:auxiliary": () => isaBubble("circle", 2),
  "isa:inaccessible": () => isaBubble("circle", "dash"),
  "isa:shared": () => isaBubble("sq-circle", 0),
  "isa:shared-field": () => isaBubble("sq-circle", 1),
  "isa:computer": () => isaBubble("hex", 0),
  "isa:plc": () => isaBubble("circle", 0, r(9, 9, 6, 6, INK900, HAIR * 1.5)),
  "isa:valve": () => valve(""),
  "isa:valve-diaphragm": () => valve("diaphragm"),
  "isa:valve-motor": () => valve("motor"),
  "isa:valve-solenoid": () => valve("solenoid"),
};

// ---- dialek sec (legenda rumah; SM-03 wajib kepala bukan-standar) -------------

/** Kerucut pandang. HS :225-227 */
function cone(): string {
  return (
    p(
      [
        [12, 12],
        [20, 6],
        [20, 18],
      ],
      SIGNAL,
      HAIR * 1.5,
      SIGNAL,
    ) + text(13.4, 8.4, MONO, 3.4, INK900, "FOV")
  );
}

const SEC: Readonly<Record<string, Draw>> = {
  "sec:camera": () => c(12, 12, 2.6, INK900, STROKE_W, PAPER) + cone(),
  "sec:ptz": () =>
    c(12, 12, 2.6, INK900, STROKE_W, PAPER) +
    cone() +
    g(9.4, 12, 14.6, 12, INK900, HAIR * 1.5) +
    g(12, 9.4, 12, 14.6, INK900, HAIR * 1.5),
  "sec:pir": () =>
    path("M8 16 A6 6 0 0 1 16 16", INK900, STROKE_W) +
    path("M9.6 16 A3.2 3.2 0 0 1 14.4 16", INK900, HAIR * 1.5) +
    c(12, 16, 1.1, INK900, HAIR, PAPER),
  "sec:fence": () =>
    g(6, 16, 18, 8, INK900, STROKE_W) +
    g(8, 17, 10, 15, INK900, HAIR * 1.5) +
    g(12, 13, 14, 11, INK900, HAIR * 1.5) +
    g(16, 9, 18, 7, INK900, HAIR * 1.5),
  "sec:reader": () =>
    r(8, 9, 8, 6, INK900, STROKE_W) + g(12, 15, 12, 18, INK900, HAIR * 1.5) + g(9, 18, 15, 18, INK900, HAIR * 1.5),
  "sec:barrier": () =>
    r(6, 10, 2.4, 8, INK900, HAIR * 1.5) +
    g(8.4, 11, 19, 8.4, ALERT, STROKE_W * 1.4) +
    g(11, 10.2, 12.2, 8.6, ALERT, HAIR * 1.5) +
    g(14, 9.4, 15.2, 7.9, ALERT, HAIR * 1.5),
  "sec:mast": () =>
    g(12, 19, 12, 6, INK900, STROKE_W) +
    g(10, 19, 14, 19, INK900, HAIR * 1.5) +
    g(12, 6, 16, 6, INK900, HAIR * 1.5) +
    c(16.6, 6.6, 1.1, INK900, HAIR, PAPER),
};

// ---- dialek mil ---------------------------------------------------------------

/** Bingkai identitas MIL-STD-2525E. HS :256-272 */
function milFrame(kind: "rect" | "diamond" | "square" | "quatrefoil" | "dome" | "arch"): string {
  const m = 12;
  switch (kind) {
    case "rect":
      return r(5, 8, 14, 8, INK900, STROKE_W);
    case "diamond":
      return p(
        [
          [m, 5.5],
          [18.5, 12],
          [m, 18.5],
          [5.5, 12],
        ],
        INK900,
        STROKE_W,
      );
    case "square":
      return r(6.5, 6.5, 11, 11, INK900, STROKE_W);
    case "quatrefoil":
      return (
        c(10.4, 10.4, 3.2, INK900, STROKE_W) +
        c(13.6, 10.4, 3.2, INK900, STROKE_W) +
        c(10.4, 13.6, 3.2, INK900, STROKE_W) +
        c(13.6, 13.6, 3.2, INK900, STROKE_W)
      );
    case "dome":
      return path("M6 18 A6 6 0 0 1 18 18", INK900, STROKE_W);
    case "arch":
      return path("M6 18 L6 12.5 A8.5 8.5 0 0 1 12 6 A8.5 8.5 0 0 1 18 12.5 L18 18", INK900, STROKE_W);
  }
}

const MIL: Readonly<Record<string, Draw>> = {
  "mil:friend": () => milFrame("rect"),
  "mil:hostile": () => milFrame("diamond"),
  "mil:neutral": () => milFrame("square"),
  "mil:unknown": () => milFrame("quatrefoil"),
  "mil:friend-air": () => milFrame("dome"),
  "mil:hostile-air": () => milFrame("arch"),
};

/** Pustaka per dialek (HS :284). */
export const DIALECT_LIBS: Readonly<Record<SymbolDialect, Readonly<Record<string, Draw>>>> = {
  iec: IEC,
  isa: ISA,
  sec: SEC,
  mil: MIL,
};

/** Catatan kepala lembar per dialek. HS :286-294 */
export const DIALECT_NOTES: Readonly<Record<SymbolDialect, string>> = {
  iec:
    "Geometri mengikuti IEC 60617:2026 DB. Sebelum terbit konstruksi, cocokkan " +
    "setiap simbol ke entri basis data (SM-11).",
  isa:
    "Bentuk sama dengan fungsi; garis sama dengan lokasi (ISA-5.1-2024, " +
    "putusan R-08). Simbol berbayar tidak disalin (SM-12).",
  sec: "Legenda rumah GSP: BUKAN simbol standar. Wajib tercetak pada lembar " + "yang sama dengan gambarnya (SM-03, cek 34).",
  mil:
    "MIL-STD-2525E BASELINE-ONLY ber-flag: cocokkan ke dokumen NATO sebelum " +
    "terbit konstruksi (SM-11, putusan R-10).",
};
