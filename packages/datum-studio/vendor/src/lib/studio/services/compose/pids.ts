/**
 * Identitas pid (register §10, KD-22): pembangkit berbenih untuk jalur murni,
 * pid bab bawaan, dan pid struktural slot.
 */
import { PID_ALPHABET, PID_GENERATED_PREFIX, PID_PATTERN, PID_RANDOM_LENGTH, type PidAllocator, type StudioIdentityKind } from "../../contract";
import { sha256Hex } from "./hash";

export const PID_RE = new RegExp(PID_PATTERN);

/** Base32 Crockford huruf kecil (C21) dari heksa; 5 bit per karakter. */
function crockford(hex: string, length: number): string {
  let bits = "";
  for (const h of hex) bits += parseInt(h, 16).toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length && out.length < length; i += 5) out += PID_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/**
 * Pembangkit deterministik (KD-22): `"p-" + crockford(sha256(seed + ":" + ordinal))[0..10]`.
 * `taken` (opsional) dilewati agar tidak bentrok dengan pid yang sudah dipakai.
 */
export function seededPidAllocator(seed: string, taken?: Set<string>): PidAllocator {
  let ordinal = 0;
  return {
    next(_kind: StudioIdentityKind, _hint: string): string {
      void _kind;
      void _hint;
      for (;;) {
        ordinal += 1;
        const pid = PID_GENERATED_PREFIX + crockford(sha256Hex(`${seed}:${ordinal}`), PID_RANDOM_LENGTH);
        if (!taken?.has(pid)) {
          taken?.add(pid);
          return pid;
        }
      }
    },
  };
}

/** Pid bab bawaan (§10): `bab-<k>` / `lamp-<k kecil>`, lalu akhiran `-m` terkecil yang bebas. */
export function defaultChapterPid(sectionType: string, key: string, used: ReadonlySet<string>): string {
  const base = sectionType === "appendix" ? `lamp-${key.toLowerCase()}` : `bab-${key}`;
  if (!used.has(base)) return base;
  for (let m = 2; ; m++) if (!used.has(`${base}-${m}`)) return `${base}-${m}`;
}

/**
 * Pid struktural slot tak-berulang (`slot-<slotKey kecil>`) dan entri register
 * sumber (`slot-<slotKey kecil>-<n>`). Deterministik dari alamat; tidak lewat
 * pembangkit agar rekonstruksi M14-M18 menghasilkan pid yang sama.
 */
export function slotPid(slotKey: string, n?: number): string {
  const base = `slot-${slotKey.toLowerCase()}`;
  return n === undefined ? base : `${base}-${n}`;
}

/** Pid unit bagian (`part-<id kecil>`, mis. `part-p1`). */
export function partPid(partId: string): string {
  return `part-${partId.toLowerCase()}`;
}
