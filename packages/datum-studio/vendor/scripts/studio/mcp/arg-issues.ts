/**
 * Swarm 1.3.3 row 77 (ST-10): argument issues that name the field that is actually wrong.
 *
 * A tool input schema is a union in several places (an `edits` item is one of seven forms, a block one of eight).
 * Ajv reports every branch of a failed union, so the first lines of the refusal used to be the branches that were
 * never meant ("/ must be string" for a chart block, a long list for one misspelt key). Here every failed union keeps
 * only its closest branch: the one whose own kind matches the value and that has the fewest missing or unknown fields
 * at that level. When the value has the wrong kind for every branch the union becomes one issue at the value itself
 * ("must be object, got string"). A `type` issue also says what was received. Pure: no I/O.
 */
import type { ErrorObject } from "ajv";

/** L-4 (review 13): isu skema yang dikembalikan dibatasi; sisanya hanya dihitung (masukan besar tidak sah tidak menghasilkan MB). */
export const MAX_ARG_ISSUES = 20;

interface ArgIssue {
  pointer: string;
  keyword: string;
  message: string;
}

type Err = Pick<ErrorObject, "instancePath" | "schemaPath" | "keyword" | "message" | "params">;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** Value at a JSON pointer; `{ found: false }` when the path does not exist. */
function valueAt(data: unknown, pointer: string): { found: boolean; value?: unknown } {
  let cur = data;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur) && /^\d+$/.test(key) && Number(key) < cur.length) cur = cur[Number(key)];
    else if (isRec(cur) && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key];
    else return { found: false };
  }
  return { found: true, value: cur };
}

const typesOf = (e: Err): string[] => {
  const t = isRec(e.params) ? e.params.type : undefined;
  return Array.isArray(t) ? t.map(String) : typeof t === "string" ? [t] : [];
};

/**
 * For every failed `anyOf` / `oneOf` (innermost first) keep the issues of its closest branch and drop the union line
 * and the other branches. Issues that belong to no union are kept unchanged and in order.
 */
/** @internal test seam */
export function closestBranchErrors(errors: readonly Err[]): Err[] {
  let list: Err[] = [...errors];
  const unions = list.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf").sort((a, b) => b.schemaPath.length - a.schemaPath.length);
  for (const u of unions) {
    if (!list.includes(u)) continue;
    const prefix = `${u.schemaPath}/`;
    const at = u.instancePath;
    const branches = new Map<string, Err[]>();
    for (const e of list) {
      if (e === u || !e.schemaPath.startsWith(prefix) || !(e.instancePath === at || e.instancePath.startsWith(`${at}/`))) continue;
      const n = e.schemaPath.slice(prefix.length).split("/")[0];
      branches.set(n, [...(branches.get(n) ?? []), e]);
    }
    if (branches.size === 0) continue;
    const inBranch = new Set([...branches.values()].flat());
    const score = (es: Err[]): [number, number, number] => [
      es.some((e) => e.instancePath === at && e.keyword === "type") ? 1 : 0,
      es.filter((e) => e.instancePath === at && (e.keyword === "required" || e.keyword === "additionalProperties")).length,
      es.length,
    ];
    const ranked = [...branches.values()].map((es) => ({ es, s: score(es) })).sort((a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1] || a.s[2] - b.s[2]);
    const best = ranked[0];
    let keep: Err[];
    if (best.s[0] === 1) {
      // The value has the wrong kind for every form: one issue at the value, listing the kinds a form accepts.
      const kinds = [...new Set(ranked.flatMap((r) => r.es.filter((e) => e.instancePath === at && e.keyword === "type").flatMap(typesOf)))];
      keep = [{ instancePath: at, schemaPath: u.schemaPath, keyword: "type", message: `must be ${kinds.join(" or ")}`, params: { type: kinds } }];
    } else keep = best.es;
    const out: Err[] = [];
    for (const e of list) {
      if (e === u) out.push(...keep);
      else if (!inBranch.has(e)) out.push(e);
    }
    list = out;
  }
  return list;
}

/** One issue per line of the refusal: pointer of the offending field, keyword, short message (with the received kind). */
export function argIssues(errors: readonly Err[] | null | undefined, data?: unknown): ArgIssue[] {
  const all = closestBranchErrors(errors ?? []);
  const shown = all.slice(0, MAX_ARG_ISSUES).map((e) => {
    const pointer = e.keyword === "additionalProperties" && isRec(e.params) ? `${e.instancePath}/${String(e.params.additionalProperty)}`.slice(0, 300) : (e.instancePath || "/").slice(0, 300);
    const got = e.keyword === "type" && data !== undefined ? valueAt(data, e.instancePath) : { found: false };
    return { pointer, keyword: e.keyword, message: `${e.message ?? "tidak sah"}${got.found ? `, got ${kindOf(got.value)}` : ""}`.slice(0, 300) };
  });
  if (all.length > MAX_ARG_ISSUES) shown.push({ pointer: "/", keyword: "truncated", message: `${all.length - MAX_ARG_ISSUES} isu skema lain tidak ditampilkan (total ${all.length})` });
  return shown;
}

/** Head line of a refusal: the first issue, and how many more there are. */
export function argIssueLine(issues: readonly ArgIssue[]): string {
  if (issues.length === 0) return "";
  // A pointer may end in a key the caller wrote: only a plain token path is printed in the head line.
  const pointer = /^[/A-Za-z0-9_.-]{1,200}$/.test(issues[0].pointer) ? issues[0].pointer : "(medan di rincian)";
  return `${pointer} ${issues[0].message}${issues.length > 1 ? ` (+${issues.length - 1} isu lain di rincian)` : ""}`;
}
