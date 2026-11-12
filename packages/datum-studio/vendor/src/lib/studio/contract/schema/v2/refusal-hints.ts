/**
 * Swarm addition (row 178, gateway_check/16_row177_split_builders_ab.md). Hints for schema refusals, read from the
 * schemas themselves (never typed here, so they cannot drift): the allowed property names of the object an
 * `additionalProperties` error is about, the property set an object-typed value must have, the block types of a
 * discriminator, and where a misplaced field belongs (a field of a child or the parent object). Rows 177 runs had
 * 14-26 refused diagram calls each; agents guessed node/class/edge fields because the refusal named only the field
 * they sent. Nothing is loosened: the schema still refuses the same input, the message now names the fix.
 */
import { commonSchema } from "../common.schema";
import { diagramSchema } from "../diagram.schema";
import { chartSchema } from "../chart.schema";
import { docSchema } from "../doc.schema";
import { imageSchema } from "../image.schema";
import { htmlSchema } from "../html.schema";
import { commonV2Schema } from "./common.schema";
import { docV2Schema } from "./doc.schema";
import { chapterV2Schema } from "./chapter.schema";
import { slotV2Schema } from "./slot.schema";
import { templateV2Schema } from "./template.schema";
import { skeletonV1Schema } from "./skeleton.schema";

/** MCP resource with the diagram block guide (served by the Swarm host, src/mcp-host/diagram-guide.ts). */
export const DIAGRAM_GUIDE_URI = "studio://skema/diagram";

type S = Record<string, unknown>;
const isObj = (x: unknown): x is S => typeof x === "object" && x !== null && !Array.isArray(x);

const ROOTS: ReadonlyMap<string, S> = new Map(
  [commonSchema, diagramSchema, chartSchema, docSchema, imageSchema, htmlSchema, commonV2Schema, docV2Schema, chapterV2Schema, slotV2Schema, templateV2Schema, skeletonV1Schema].map(
    (s) => [String((s as S).$id), s as S] as const,
  ),
);

/**
 * Natural aliases agents sent in the row 146b/177 runs, per object (schema path suffix), with the field that carries
 * that meaning. Only names that are NOT fields of the object; the target must exist in the schema (row 178 test).
 */
export const DIAGRAM_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  edge: { color: "kind", colour: "kind", style: "kind", stroke: "kind", dash: "kind", pattern: "kind", type: "kind", width: "kind", line: "kind" },
  node: { type: "shape", kind: "shape", name: "label", text: "label", title: "label" },
  // Swarm 1.2.6 row 48 (T-11, N-110, 01e §3.2): `direction` is a spec field (row 45), so it leaves this list; the
  // reading-direction aliases (incl. Indonesian `arah`) name it. `layout` still means the family.
  spec: {
    title: "caption",
    name: "caption",
    dir: "direction",
    rankdir: "direction",
    rankDir: "direction",
    orientation: "direction",
    arah: "direction",
    layout: "family",
  },
};

/** Swarm 1.2.6 row 48 (T-11, 01e §3.2/§6.1): extra clause after `for "<alias>" use "direction" (TB, LR)`. */
export const DIRECTION_ALIAS_CLAUSE = "direction berlaku untuk family flow; nilai rankdir TB/LR sama, RL/BT tidak didukung";

function decode(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * ajv gives `#/...` paths relative to the compiled schema of a `$ref` target (e.g. `#/additionalProperties` of a
 * block). `location` is the `$defs` name of common/v2 that the instance sits at (forbidden.ts locateSchemaV2Object);
 * the path is made absolute against it, so the hints below can read the schema node.
 */
export function absoluteSchemaPath(schemaPath: string | undefined, location: string): string {
  if (schemaPath === undefined) return "";
  if (!schemaPath.startsWith("#")) return schemaPath;
  const defs = (commonV2Schema as S).$defs as S | undefined;
  if (defs === undefined || !isObj(defs[location])) return "";
  return `${String((commonV2Schema as S).$id)}#/$defs/${location}${schemaPath.slice(1)}`;
}

/** Schema node at an ajv `schemaPath` (absolute `<id>#/<pointer>` or `#/<pointer>` against `base`). */
export function schemaAtPath(schemaPath: string, base?: S): S | null {
  const hash = schemaPath.indexOf("#");
  const id = hash > 0 ? schemaPath.slice(0, hash) : "";
  const ptr = hash >= 0 ? schemaPath.slice(hash + 1) : schemaPath;
  let node: unknown = id ? ROOTS.get(id) : base;
  if (!isObj(node)) return null;
  for (const seg of ptr.split("/").filter((s) => s.length > 0)) {
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isObj(node)) node = node[decode(seg)];
    else return null;
  }
  return isObj(node) ? node : null;
}

function resolve(node: unknown, root: S | undefined): S | null {
  if (!isObj(node)) return null;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    return schemaAtPath(ref, ref.startsWith("#") ? root : undefined);
  }
  return node;
}

function rootOf(schemaPath: string): S | undefined {
  const hash = schemaPath.indexOf("#");
  return hash > 0 ? ROOTS.get(schemaPath.slice(0, hash)) : undefined;
}

/** Agent-settable property names of an object schema (`not: {}` = internal, never listed). */
export function propertyNames(node: S | null): string[] {
  if (node === null || !isObj(node.properties)) return [];
  return Object.entries(node.properties as S)
    .filter(([, v]) => !(isObj(v) && isObj(v.not) && Object.keys(v.not).length === 0))
    .map(([k]) => k);
}

function objectKind(path: string): "edge" | "node" | "class" | "zone" | "spec" | "block" | null {
  if (path.endsWith("/properties/edges/items")) return "edge";
  if (path.endsWith("/properties/nodes/items")) return "node";
  if (path.endsWith("/properties/class")) return "class";
  if (path.endsWith("/properties/zones/items")) return "zone";
  if (path.endsWith("/$defs/DiagramSpecV2")) return "spec";
  if (path.endsWith("/$defs/DiagramV2")) return "block";
  return null;
}

/** True for a schema path inside a diagram block / spec (the diagram guide applies). */
export function isDiagramPath(schemaPath: string): boolean {
  return /\/\$defs\/Diagram(V2|SpecV2)\b|studio\.diagram\/v1/.test(schemaPath);
}

function enumText(node: S | null): string {
  if (node === null) return "";
  if (Array.isArray(node.enum)) return ` (${(node.enum as unknown[]).map(String).join(", ")})`;
  return "";
}

/**
 * Hint for an `additionalProperties` error: allowed names of that object, plus where the field belongs when it is a
 * field of a child object (e.g. node `col` -> `class.col`, block `nodes` -> `spec.nodes`), of the parent object (class
 * `shape` -> the node), or a known alias (edge `color` -> `kind`).
 */
export function additionalPropertyHint(schemaPath: string, field: string): string {
  const objPath = schemaPath.replace(/\/additionalProperties$/, "");
  const root = rootOf(schemaPath);
  const node = schemaAtPath(objPath);
  const allowed = propertyNames(node);
  if (allowed.length === 0) return "";
  const parts = [`allowed here: ${allowed.join(", ")}`];
  const kind = objectKind(objPath);
  // A field of a child object (one level down, through $ref; array items skipped).
  for (const p of allowed) {
    const child = resolve((node?.properties as S)[p], root);
    if (child !== null && propertyNames(child).includes(field)) {
      parts.push(`"${field}" belongs in ${p}: ${p}.${field}`);
      return parts.join("; ");
    }
  }
  // A field of the parent object (class -> node, node/edge -> spec).
  const up = /\/properties\/[^/]+(\/items)?$/.exec(objPath);
  if (up !== null) {
    const parent = schemaAtPath(objPath.slice(0, up.index));
    if (propertyNames(parent).includes(field)) {
      parts.push(`"${field}" belongs one level up (${objectKind(objPath.slice(0, up.index)) ?? "parent object"}), not here`);
      return parts.join("; ");
    }
  }
  const alias = kind !== null ? DIAGRAM_ALIASES[kind]?.[field] : undefined;
  if (alias !== undefined) {
    if (alias === "caption") parts.push(`"${field}" is not a diagram field: the title is the block's caption`);
    else parts.push(`for "${field}" use "${alias}"${enumText(resolve((node?.properties as S)[alias], root))}`);
    if (alias === "direction") parts.push(DIRECTION_ALIAS_CLAUSE);
  }
  return parts.join("; ");
}

/** Hint for `type: object` errors: the fields that object takes. */
export function objectTypeHint(schemaPath: string): string {
  const node = schemaAtPath(schemaPath.replace(/\/type$/, ""));
  const names = propertyNames(node);
  return names.length > 0 ? `{${names.join(", ")}}` : "";
}

/** Allowed `type` values of a discriminated union (ajv `discriminator` error). */
export function discriminatorValues(schemaPath: string, tag: string): string[] {
  const root = rootOf(schemaPath);
  const node = schemaAtPath(schemaPath.replace(/\/discriminator$/, ""));
  if (node === null || !Array.isArray(node.oneOf)) return [];
  const out: string[] = [];
  for (const b of node.oneOf as unknown[]) {
    const r = resolve(b, root);
    const t = r !== null && isObj(r.properties) ? ((r.properties as S)[tag] as S | undefined) : undefined;
    if (isObj(t) && typeof t.const === "string") out.push(t.const);
  }
  return out;
}
