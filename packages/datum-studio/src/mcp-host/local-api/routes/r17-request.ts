/**
 * Validasi badan R17 `POST /api/studio/documents/[id]/render` (SR-24;
 * register 03_structural_sections_specs.md §12 R17, blueprint 05 §2.6).
 *
 * Badan: `{ scope: "document" | "chapter" | "slot", key?, formats?, figures?, revisionNo?, agentId? }`.
 * - `key` wajib untuk `chapter`/`slot`, dilarang untuk `document`.
 * - `formats` ⊆ docx/pdf/html, `figures` ⊆ svg/png (tidak peka huruf seperti R07/R09;
 *   dinormalkan ke huruf kecil bentuk `RenderRequestV2`, duplikat dibuang).
 * - `agentId` (aditif, setara R07) hanya untuk identitas pemanggil.
 * - Kunci lain ditolak (`additionalProperties: false`), sejalan dengan kontrak v2.
 * Arti kunci (bab/slot ada atau tidak) diputuskan layanan render (404/422).
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/render/_lib/request.ts, verbatim.
 */
import { RENDER_SCOPE_NAMES, type RenderScopeName } from "@/lib/studio/contract/enums";
import type { ValidationIssue } from "@/lib/studio/contract/types/api";
import type { RenderRequestV2 } from "@/lib/studio/contract";
import { parsePosInt } from "@/lib/studio/http";

/** Permintaan ke layanan `renderScope` (I51): `RenderRequestV2` dengan `scope` wajib. */
export type RenderScopeRequest = Omit<RenderRequestV2, "scope"> & { scope: RenderScopeName };

export type DocFormat = NonNullable<RenderRequestV2["formats"]>[number];
export type FigureFormat = NonNullable<RenderRequestV2["figures"]>[number];

const DOC_FORMATS: readonly DocFormat[] = ["docx", "pdf", "html"];
const FIGURE_FORMATS: readonly FigureFormat[] = ["svg", "png"];
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["scope", "key", "formats", "figures", "revisionNo", "agentId"]);
const KEY_MAX = 80;

export type RenderBodyParse =
  | { ok: true; request: RenderScopeRequest; agentId: string | null }
  | { ok: false; issues: ValidationIssue[] };

function readFormatList<T extends string>(
  raw: unknown,
  pointer: string,
  known: readonly T[],
  issues: ValidationIssue[],
): T[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ pointer, keyword: "type", message: "must be a non-empty array" });
    return undefined;
  }
  const out: T[] = [];
  let bad = false;
  raw.forEach((f, i) => {
    const low = typeof f === "string" ? f.trim().toLowerCase() : "";
    if ((known as readonly string[]).includes(low)) {
      out.push(low as T);
    } else {
      bad = true;
      issues.push({ pointer: `${pointer}/${i}`, keyword: "enum", message: `must be one of ${known.join(", ")}` });
    }
  });
  return bad ? undefined : [...new Set(out)];
}

export function parseRenderBody(b: Record<string, unknown>): RenderBodyParse {
  const issues: ValidationIssue[] = [];

  for (const k of Object.keys(b)) {
    if (!ALLOWED_KEYS.has(k)) {
      issues.push({ pointer: `/${k}`, keyword: "additionalProperties", message: "unknown property" });
    }
  }

  let scope: RenderScopeName | null = null;
  if (b.scope === undefined) {
    issues.push({ pointer: "/scope", keyword: "required", message: `required; one of ${RENDER_SCOPE_NAMES.join(", ")}` });
  } else if (typeof b.scope !== "string" || !(RENDER_SCOPE_NAMES as readonly string[]).includes(b.scope)) {
    issues.push({ pointer: "/scope", keyword: "enum", message: `must be one of ${RENDER_SCOPE_NAMES.join(", ")}` });
  } else {
    scope = b.scope as RenderScopeName;
  }

  let key: string | undefined;
  if (b.key !== undefined) {
    if (typeof b.key !== "string" || b.key.trim().length === 0 || b.key.length > KEY_MAX) {
      issues.push({ pointer: "/key", keyword: "type", message: `must be a non-empty string of at most ${KEY_MAX} characters` });
    } else {
      key = b.key.trim();
    }
  }
  if (scope === "document" && b.key !== undefined) {
    issues.push({ pointer: "/key", keyword: "not", message: "not allowed when scope is document" });
  }
  if ((scope === "chapter" || scope === "slot") && b.key === undefined) {
    issues.push({ pointer: "/key", keyword: "required", message: `required when scope is ${scope}` });
  }

  const formats = readFormatList(b.formats, "/formats", DOC_FORMATS, issues);
  const figures = readFormatList(b.figures, "/figures", FIGURE_FORMATS, issues);

  let revisionNo: number | undefined;
  if (b.revisionNo !== undefined) {
    const n = typeof b.revisionNo === "number" ? parsePosInt(b.revisionNo) : null;
    if (n === null) issues.push({ pointer: "/revisionNo", keyword: "type", message: "must be a positive integer" });
    else revisionNo = n;
  }

  if (b.agentId !== undefined && typeof b.agentId !== "string") {
    issues.push({ pointer: "/agentId", keyword: "type", message: "must be string" });
  }

  if (issues.length > 0 || scope === null) return { ok: false, issues };
  const request: RenderScopeRequest = {
    scope,
    ...(key !== undefined ? { key } : {}),
    ...(formats ? { formats } : {}),
    ...(figures ? { figures } : {}),
    ...(revisionNo !== undefined ? { revisionNo } : {}),
  };
  return { ok: true, request, agentId: typeof b.agentId === "string" ? b.agentId : null };
}
