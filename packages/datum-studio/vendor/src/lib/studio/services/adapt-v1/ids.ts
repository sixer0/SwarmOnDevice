/**
 * services/adapt-v1 — normalisasi pengenal v1 ke pola v2.
 *
 * - `blockId` v1 (bebas, maks 120) → pid C19 `^[a-z0-9][a-z0-9-]{2,63}$`.
 *   camelCase dipecah dengan `-`, huruf kecil, karakter lain jadi `-`. pid unik
 *   per dokumen (M17/M18): id yang tak dapat dinormalisasi atau bertabrakan
 *   dibuang (pid dibangkitkan compose) dan dicatat di REPORT.
 * - Kunci `assets` v1 → C26 `^[a-z0-9][a-z0-9-]{0,63}$` dengan aturan sama;
 *   tabrakan diberi akhiran `-2`, `-3`, ... Rujukan `image.asset` dipetakan ulang.
 */
import { ASSET_KEY_PATTERN, PID_PATTERN } from "@/lib/studio/contract";
import type { AdaptRecorder } from "./report";

const PID_RE = new RegExp(PID_PATTERN);
const ASSET_KEY_RE = new RegExp(ASSET_KEY_PATTERN);

function kebab(raw: string, max: number): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Alokator pid hasil adaptasi (unik lintas bab, section, dan blok satu dokumen). */
export class PidMapper {
  private readonly used = new Set<string>();

  constructor(private readonly rec: AdaptRecorder) {}

  /** `blockId` v1 → `id` v2, atau `undefined` (dibuang + REPORT). */
  map(blockId: unknown): string | undefined {
    if (typeof blockId !== "string" || blockId === "") return undefined;
    const id = PID_RE.test(blockId) ? blockId : kebab(blockId, 64);
    if (!PID_RE.test(id)) {
      this.rec.rename("blockId(invalid,dropped)");
      return undefined;
    }
    if (this.used.has(id)) {
      this.rec.rename("blockId(duplicate,dropped)");
      return undefined;
    }
    this.used.add(id);
    this.rec.rename(id === blockId ? "blockId->id" : "blockId->id(normalized)");
    return id;
  }
}

/** Peta kunci aset v1 → v2 (dibangun sekali dari `document.assets`). */
export function buildAssetKeyMap(keys: readonly string[], rec: AdaptRecorder): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  // Kunci yang sudah sah dipesan lebih dulu agar tidak tergeser akhiran.
  for (const k of keys) if (ASSET_KEY_RE.test(k)) used.add(k);
  for (const k of keys) {
    if (ASSET_KEY_RE.test(k)) {
      out.set(k, k);
      continue;
    }
    const base = kebab(k, 60) || "aset";
    let cand = base;
    for (let n = 2; used.has(cand) || !ASSET_KEY_RE.test(cand); n++) cand = `${base}-${n}`;
    used.add(cand);
    out.set(k, cand);
    rec.rename("assets.key(normalized)");
  }
  return out;
}
