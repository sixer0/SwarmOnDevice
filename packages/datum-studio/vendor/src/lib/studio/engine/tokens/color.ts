/**
 * Resolusi token warna (S11, D-31, K-07/KT-09).
 *
 * Nilai warna di registri: hex 6 digit tanpa "#" (kunci `color.interior.*`,
 * `color.wrapper.*`, ...) atau tokenRef (nama token palet: "ink900", "signal",
 * peran "color.role.*", atau token turunan "zebraNN").
 *
 * Token turunan `zebraNN` (kelas T, tanpa ParamDef sendiri; D-31): rona NN %
 * ink900 di atas kertas interior, per kanal `paper + NN/100 x (ink900 - paper)`,
 * dibulatkan ke bilangan bulat terdekat. Nilai dihitung dari parameter aktif,
 * tidak disalin.
 */
import type { Hex } from "../../contract";
import type { ParamMap } from "../../contract";

const HEX_RE = /^#?([0-9A-Fa-f]{6})$/;
const DERIVED_TINT_RE = /^zebra(\d{1,2})$/;
const MAX_DEPTH = 8;

/** Kunci sumber tinta dan kertas untuk token rona turunan. */
export const TINT_INK_KEY = "color.interior.ink900";
export const TINT_PAPER_KEY = "color.interior.paper";

/** Kanonikkan hex: huruf besar, tanpa "#". `undefined` bila bukan hex 6 digit. */
export function normalizeHex(v: unknown): Hex | undefined {
  if (typeof v !== "string") return undefined;
  const m = HEX_RE.exec(v.trim());
  return m ? m[1].toUpperCase() : undefined;
}

function channels(hex: Hex): [number, number, number] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(c: readonly number[]): Hex {
  return c
    .map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Rona `percent` % warna `ink` di atas `paper`, per kanal, dibulatkan. */
export function tintHex(paper: Hex, ink: Hex, percent: number): Hex {
  const p = channels(paper);
  const k = channels(ink);
  const f = percent / 100;
  return toHex(p.map((pc, i) => pc + f * (k[i] - pc)));
}

/** Hitung token turunan `zebraNN`; `undefined` bila tinta/kertas tidak terbaca. */
export function derivedTintHex(p: ParamMap, token: string): Hex | undefined {
  const m = DERIVED_TINT_RE.exec(token);
  if (!m) return undefined;
  const ink = normalizeHex(p[TINT_INK_KEY]);
  const paper = normalizeHex(p[TINT_PAPER_KEY]);
  if (!ink || !paper) return undefined;
  return tintHex(paper, ink, Number(m[1]));
}

/**
 * Selesaikan referensi warna ke hex. Urutan: hex literal -> token turunan
 * `zebraNN` -> kunci penuh (`color.*`) -> palet interior -> palet pembungkus ->
 * peran `color.role.<ref>`. Rujukan berantai diikuti sampai kedalaman 8.
 */
export function resolveColorToken(p: ParamMap, ref: unknown, depth = 0): Hex | undefined {
  if (depth > MAX_DEPTH || typeof ref !== "string" || ref.length === 0) return undefined;
  const hex = normalizeHex(ref);
  if (hex) return hex;
  const tint = derivedTintHex(p, ref);
  if (tint) return tint;
  // Kunci parameter penuh apa pun (mis. `table.zebra.colour`) diikuti nilainya.
  const candidates = ref.startsWith("color.") || ref in p
    ? [ref]
    : [`color.interior.${ref}`, `color.wrapper.${ref}`, `color.brief.${ref}`, `color.role.${ref}`, `color.${ref}`];
  for (const key of candidates) {
    if (!(key in p)) continue;
    const v = p[key];
    const direct = normalizeHex(v);
    if (direct) return direct;
    if (typeof v === "string" && v !== ref) {
      const next = resolveColorToken(p, v, depth + 1);
      if (next) return next;
    }
  }
  return undefined;
}

/**
 * Peta token warna turunan yang dirujuk parameter aktif (selalu memuat
 * `zebra15`, KT-09), mis. `{ zebra15: "D9D9D9" }` untuk palet kanonik.
 */
export function derivedColorTokens(p: ParamMap): Readonly<Record<string, Hex>> {
  const tokens = new Set<string>(["zebra15"]);
  for (const v of Object.values(p)) {
    if (typeof v === "string" && DERIVED_TINT_RE.test(v)) tokens.add(v);
  }
  const out: Record<string, Hex> = {};
  for (const t of [...tokens].sort()) {
    const hex = derivedTintHex(p, t);
    if (hex) out[t] = hex;
  }
  return Object.freeze(out);
}
