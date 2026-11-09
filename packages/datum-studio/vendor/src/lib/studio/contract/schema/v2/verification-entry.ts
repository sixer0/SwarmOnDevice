/**
 * Swarm addition (row 207, 1.2.3 patch, defect HB-2). Keys of a `controlSheet.verificationChain` entry
 * (`VerificationEntryV2`) and the mapping of the names agents send onto them.
 *
 * The control sheet of the built-in templates prints LAPIS / METODE / OBJEK / HASIL (manual form, R-69), while the slot
 * schema documented only `{ layer, role, name, date }`: a documented write was accepted and printed three empty
 * columns. The entry now also takes `method`, `object`, `result`; the printed column names (ID and EN, any case) are
 * aliases mapped to those keys before validation, and any other key is refused with a message listing the accepted
 * keys. Nothing is loosened: the schema itself still refuses unknown keys (additionalProperties false).
 * Pure: no I/O. Called by the R13 slot route, the R08 dry run and the MCP `studio_slot_fill` tool.
 */
import type { ValidationIssue } from "../../types/api";

/** Canonical keys, in print order (LAPIS, METODE, OBJEK, HASIL, then the documented sign-off keys). */
export const VERIFICATION_ENTRY_KEYS = ["layer", "method", "object", "result", "role", "name", "date"] as const;
export type VerificationEntryKey = (typeof VERIFICATION_ENTRY_KEYS)[number];

/** Printed ID column names (manual form C07 and machine form) -> canonical key. EN column names are the keys. */
export const VERIFICATION_ENTRY_ALIASES: Readonly<Record<string, VerificationEntryKey>> = {
  lapis: "layer",
  metode: "method",
  objek: "object",
  hasil: "result",
  peran: "role",
  nama: "name",
  tanggal: "date",
};

const CANONICAL: ReadonlySet<string> = new Set(VERIFICATION_ENTRY_KEYS);

/** Key as sent -> canonical key (case and surrounding spaces ignored), or null when not accepted. */
export function verificationEntryKey(sent: string): VerificationEntryKey | null {
  const k = sent.trim().toLowerCase();
  if (CANONICAL.has(k)) return k as VerificationEntryKey;
  return VERIFICATION_ENTRY_ALIASES[k] ?? null;
}

/** The accepted-keys sentence used in refusals and in the guide. */
export const VERIFICATION_ENTRY_KEYS_TEXT =
  `accepted keys: ${VERIFICATION_ENTRY_KEYS.join(", ")} ` +
  `(also the printed column names ${Object.keys(VERIFICATION_ENTRY_ALIASES).join(", ")} / Layer, Method, Object, Result, any case)`;

const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface ControlSheetKeyResult {
  /** refusals (unknown key, one column given twice with different values); empty = accepted. */
  issues: ValidationIssue[];
  /** aliases mapped, as `pointer: sent -> canonical`. */
  mapped: string[];
}

/** Map the entry keys of one `verificationChain` list in place (TableV2 form and non-lists are left as they are). */
function normalizeChain(chain: unknown, pointer: string, out: ControlSheetKeyResult): void {
  if (!Array.isArray(chain)) return;
  chain.forEach((entry, i) => {
    if (!isObj(entry)) return;
    const next: Record<string, unknown> = {};
    const from: Record<string, string> = {};
    let refused = false;
    for (const [sent, value] of Object.entries(entry)) {
      const key = verificationEntryKey(sent);
      if (key === null) {
        out.issues.push({
          pointer: `${pointer}/${i}/${ptr(sent)}`,
          keyword: "additionalProperties",
          message: `verificationChain entry key "${sent}" is not accepted; ${VERIFICATION_ENTRY_KEYS_TEXT}`,
        });
        refused = true;
        continue;
      }
      if (key in next && JSON.stringify(next[key]) !== JSON.stringify(value)) {
        out.issues.push({
          pointer: `${pointer}/${i}/${ptr(sent)}`,
          keyword: "additionalProperties",
          message: `verificationChain entry gives column "${key}" twice ("${from[key]}" and "${sent}") with different values; send it once. ${VERIFICATION_ENTRY_KEYS_TEXT}`,
        });
        refused = true;
        continue;
      }
      if (sent !== key) out.mapped.push(`${pointer}/${i}: ${sent} -> ${key}`);
      next[key] = value;
      from[key] = sent;
    }
    if (refused) return;
    for (const k of Object.keys(entry)) delete entry[k];
    for (const k of VERIFICATION_ENTRY_KEYS) if (k in next) entry[k] = next[k];
  });
}

/**
 * Map verificationChain entry keys in place in a slot submission (`{ payload }`), a document (`{ sections:
 * { controlSheet } }`) or a bare controlSheet payload. `prefix` = pointer of `body` in the request.
 */
export function normalizeControlSheetKeys(body: unknown, prefix = ""): ControlSheetKeyResult {
  const out: ControlSheetKeyResult = { issues: [], mapped: [] };
  if (!isObj(body)) return out;
  if (body.type === "controlSheet") normalizeChain(body.verificationChain, `${prefix}/verificationChain`, out);
  if (isObj(body.payload) && body.payload.type === "controlSheet") normalizeChain(body.payload.verificationChain, `${prefix}/payload/verificationChain`, out);
  if (isObj(body.sections) && isObj(body.sections.controlSheet)) normalizeChain(body.sections.controlSheet.verificationChain, `${prefix}/sections/controlSheet/verificationChain`, out);
  return out;
}
