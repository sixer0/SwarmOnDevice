/**
 * engine/symbols — terminal sambungan (`ports_in_mm`) per simbol (S31, I21).
 *
 * Sumber: RL `scripts/datum_symbols.py:490-551` (koordinat unit 0..1, origin
 * kiri-atas) dipetakan ke petak HS CELL x CELL mm lewat `Box(0, 0, 24, 24).p`
 * (RL :89-90). Urutan nama port mengikuti urutan dict sumber.
 */
import { CELL } from "./primitives";

type UnitPorts = ReadonlyArray<readonly [name: string, u: number, v: number]>;

const V: UnitPorts = [
  ["in", 0.5, 0.0],
  ["out", 0.5, 1.0],
];
const H: UnitPorts = [
  ["in", 0.0, 0.5],
  ["out", 1.0, 0.5],
];
const BOTH: UnitPorts = [
  ["in", 0.5, 0.0],
  ["out", 0.5, 1.0],
  ["left", 0.0, 0.5],
  ["right", 1.0, 0.5],
];
const IN_ONLY: UnitPorts = [["in", 0.5, 0.0]];

/** RL SYMBOLS[..]["ports"] (:494-551). */
export const UNIT_PORTS: Readonly<Record<string, UnitPorts>> = {
  "iec:breaker": V,
  "iec:disconnector": V,
  "iec:contactor": V,
  "iec:switch": V,
  "iec:changeover": BOTH,
  "iec:fuse": V,
  "iec:generator": V,
  "iec:motor": V,
  "iec:transformer": V,
  "iec:ct": BOTH,
  "iec:arrester": V,
  "iec:earth": IN_ONLY,
  "iec:battery": V,
  "iec:lamp": V,
  "iec:busbar": H,
  "iec:enclosure": V,
  "isa:field": BOTH,
  "isa:primary": BOTH,
  "isa:auxiliary": BOTH,
  "isa:inaccessible": BOTH,
  "isa:shared": BOTH,
  "isa:shared-field": BOTH,
  "isa:computer": BOTH,
  "isa:plc": BOTH,
  "isa:valve": H,
  "isa:valve-diaphragm": H,
  "isa:valve-motor": H,
  "isa:valve-solenoid": H,
  "sec:camera": BOTH,
  "sec:ptz": BOTH,
  "sec:pir": BOTH,
  "sec:fence": H,
  "sec:reader": BOTH,
  "sec:barrier": H,
  "sec:mast": BOTH,
  "mil:friend": BOTH,
  "mil:hostile": BOTH,
  "mil:neutral": BOTH,
  "mil:unknown": BOTH,
  "mil:friend-air": BOTH,
  "mil:hostile-air": BOTH,
};

/** Port absolut mm di petak simbol 24 x 24 mm (salinan baru tiap panggilan). */
export function portsMm(id: string): Array<{ name: string; x: number; y: number }> {
  const unit = UNIT_PORTS[id] ?? [];
  return unit.map(([name, u, v]) => ({ name, x: u * CELL, y: v * CELL }));
}
