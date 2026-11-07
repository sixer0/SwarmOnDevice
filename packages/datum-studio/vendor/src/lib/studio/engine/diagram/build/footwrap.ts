/**
 * Caption/SUMBER diagram berbungkus (FIG-02b2, audit research/18 §6 P2-15). Hanya saat fit aktif
 * dan hanya bila baris tunggal lebih lebar dari lembar (diukur tabel glif `textfit`); selain itu
 * satu baris seperti sebelumnya (byte-identik). Teks tidak pernah dipotong: dibungkus sampai
 * `FOOT_MAX_LINES` baris, sisa kata digabung ke baris terakhir.
 */
import { measure, wrap } from "../../chart/core/textfit";
import { role } from "../core";
import { diagramFitActive } from "../fit/state";

export const FOOT_MAX_LINES = 4;

/** Baris kaki untuk `text` pada peran `roleName` di lembar selebar `W` mm. */
export function footLines(text: string, roleName: "caption" | "source_line", W: number): string[] {
  if (!diagramFitActive()) return [text];
  const pt = role(roleName).size;
  const maxW = W - 0.5;
  if (measure(text, pt) <= maxW) return [text];
  const r = wrap(text, maxW, FOOT_MAX_LINES, { pt });
  // `wrap` tidak memotong teks; pastikan semua kata tetap ada (D-491: multiset teks sama).
  const joined = r.lines.join(" ").replace(/\s+/g, " ").trim();
  return joined === text.replace(/\s+/g, " ").trim() ? r.lines : [text];
}
