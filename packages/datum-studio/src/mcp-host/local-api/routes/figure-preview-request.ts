/**
 * FIG-03b — validasi badan `POST /api/studio/documents/[id]/figures/preview`.
 *
 * Badan `{ pid? | address?, block?, revisionNo?, svg?, agentId? }` (kunci lain ditolak):
 * - tepat satu dari `pid`/`address` ATAU `block`, atau `block` + salah satunya (blok inline dirender di
 *   posisi sasaran: parameter slot dan label `Gambar n.m` sasaran dipakai);
 * - `pid` = C19 `PID_PATTERN`; `address` = tata bahasa §4.1 (blok `3.1.4` atau `Gambar 3.1`);
 * - `block` = fragmen v2 `chart`/`diagram`, divalidasi skema kontrak v2 yang sama dengan R16 (`validateBlockV2`);
 * - `svg: true` = sertakan SVG mentah di jawaban (bawaan tidak: hasil kecil).
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/figures/preview/_lib/request.ts, verbatim.
 */
import { PID_PATTERN, type BlockV2, type ValidationIssue } from "@/lib/studio/contract";
import { formatAddress, parseAddress } from "@/lib/studio/contract/address";
import { parsePosInt } from "@/lib/studio/http";
import { validateBlockV2 } from "@/lib/studio/services/revisions/v2/body";

// Row 165C (F56-3): `standalone` (the original's apparatus "figure" mode) and `png` (a 300 dpi PNG of that figure).
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["pid", "address", "block", "revisionNo", "svg", "agentId", "standalone", "png"]);
const PID_RE = new RegExp(PID_PATTERN);

export interface PreviewRequest {
  pid?: string;
  address?: string;
  block?: BlockV2;
  revisionNo?: number;
  svg: boolean;
  agentId: string | null;
  /** Row 165C (F56-3): diagram drawn as a stand-alone figure: caption, KUNCI and SUMBER inside the SVG. */
  standalone: boolean;
  /** Row 165C (F56-3): also a 300 dpi PNG of the stand-alone figure (needs `standalone`). */
  png: boolean;
}

export type PreviewParse = { ok: true; value: PreviewRequest } | { ok: false; issues: ValidationIssue[] };

export function parsePreviewBody(b: Record<string, unknown>): PreviewParse {
  const issues: ValidationIssue[] = [];
  const push = (pointer: string, keyword: string, message: string) => issues.push({ pointer, keyword, message });
  for (const k of Object.keys(b)) if (!ALLOWED_KEYS.has(k)) push(`/${k}`, "additionalProperties", "unknown property");

  const out: PreviewRequest = { svg: b.svg === true, agentId: typeof b.agentId === "string" ? b.agentId : null, standalone: b.standalone === true, png: b.png === true };
  if (b.pid !== undefined) {
    if (typeof b.pid === "string" && PID_RE.test(b.pid)) out.pid = b.pid;
    else push("/pid", "pattern", `must match ${PID_PATTERN}`);
  }
  if (b.address !== undefined) {
    const parsed = typeof b.address === "string" && b.address.length <= 600 ? parseAddress(b.address) : null;
    if (parsed && (parsed.kind === "block" || parsed.kind === "artifact")) out.address = formatAddress(parsed);
    else push("/address", "pattern", "must be a block address (3.1.4) or figure label (Gambar 3.1)");
  }
  if (b.pid !== undefined && b.address !== undefined) push("/address", "not", "give pid or address, not both");
  if (b.block !== undefined) {
    const t = typeof b.block === "object" && b.block !== null && !Array.isArray(b.block) ? (b.block as { type?: unknown }).type : undefined;
    if (t !== "chart" && t !== "diagram") push("/block/type", "enum", "must be chart or diagram");
    else {
      const bad = validateBlockV2(b.block, "/block");
      if (bad.length > 0) issues.push(...bad);
      else out.block = b.block as BlockV2;
    }
  }
  if (b.pid === undefined && b.address === undefined && b.block === undefined) push("/pid", "required", "give pid, address, or block");
  if (b.revisionNo !== undefined) {
    const n = typeof b.revisionNo === "number" ? parsePosInt(b.revisionNo) : null;
    if (n === null) push("/revisionNo", "type", "must be a positive integer");
    else out.revisionNo = n;
  }
  if (b.svg !== undefined && typeof b.svg !== "boolean") push("/svg", "type", "must be boolean");
  if (b.agentId !== undefined && typeof b.agentId !== "string") push("/agentId", "type", "must be string");
  // Row 165C (F56-3): stand-alone figure options.
  if (b.standalone !== undefined && typeof b.standalone !== "boolean") push("/standalone", "type", "must be boolean");
  if (b.png !== undefined && typeof b.png !== "boolean") push("/png", "type", "must be boolean");
  if (b.png === true && b.standalone !== true) push("/png", "dependencies", "png needs standalone: true");
  if (b.standalone === true && out.block !== undefined && out.block.type !== "diagram") push("/standalone", "enum", "standalone is for a diagram block");
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}
