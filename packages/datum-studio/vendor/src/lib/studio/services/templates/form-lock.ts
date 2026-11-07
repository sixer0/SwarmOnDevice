/**
 * Swarm form lock for user templates (row 66; masterplan/01_specs_studio_templates.md §3 with the
 * C13 amendment P9/M1/M2 and U16 §U.6/U.7: "Editable = P1-P9 only, plus §3.2-§3.4").
 *
 * Pure module (no I/O). Every caller is treated alike: there is no ADMIN branch (decision C58: the
 * local caller is a non-admin INTERNAL_AGENT, and the DATUM form stays locked for everyone).
 *
 * - `collectParamChanges`: the changed-keys rule widened by C13 M1 (changed value, every key of a new
 *   slot, a key moved between layers, a key unset; from scratch every key).
 * - `paramLockIssues`: P1-P9 per changed key, first failing rule per key (spec §3.1 check order), plus
 *   the C13 M2 unknown-tier rule.
 * - `roleFormatLockIssues`: §3.2 (explicit role formats, template- and slot-level), deny by default.
 * - `skeletonLockIssues`: §3.3 Swarm additions (required slots, locked positions, cover first, labels).
 * - `staticParamLock` / `lintParameterKeys`: the per-key classification printed by the row 66 report
 *   (§3.1 counts, U.1a lint-parameter set).
 *
 * Studio's own `checkTemplateWrite` (skeleton/access.ts) is not called: with the non-admin caller of
 * C58 it refuses every advanced-surface and class-K key (its steps 6-7), which the spec replaces by
 * P3/P5-P9. Studio rules 3-5 (P1-P4) are re-stated here with the same Studio helpers.
 */
import type { ParamValue, StudioTemplateV2, StudioTier, TemplateSlotDef } from "../../contract";
import { STUDIO_TIERS } from "../../contract/enums";
import type { ParamDef } from "../../contract/types/params";
import { effectiveClass, validateParamValue } from "../../engine/tokens/merge";
import { RENDER_LINT_PARAM_KEYS } from "../../engine/lint/render";
import { PARAMS_BY_KEY } from "../../params";
import { LINT_REGISTRY } from "../../registry/lint";
import { CANONICAL_REQUIRED_BY_TIER } from "../../registry/sections";
import { isScopeAllowedInSlot, SLOT_SECTION_TYPES } from "../../registry/slots";
import { categoryOf, type ParamCategoryId } from "../../../../components/studio/template-editor/param-categories";
import { changedFields, isEssentialFieldChange, SLOT_SETUP_KEY, SLOT_SETUP_T_FIELDS, storedSurfaceOf } from "../skeleton/access";
import { flattenSlotParams } from "../skeleton/skeleton";
import { stableStringify } from "./profile";

type ParamRecord = Record<string, ParamValue>;

/** Rules in spec order. `M2` = C13 unknown tier (runs before the tier-dependent rules). */
export type LockRule = "P1" | "M2" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9";

/** Error code per rule (spec §3.1 column "Code"; P3 internal = PARAM_SURFACE_FORBIDDEN). */
export type LockCode = "PARAM_UNKNOWN_KEY" | "PARAM_CLASS_T_READONLY" | "PARAM_SURFACE_FORBIDDEN" | "SLOT_PARAM_SCOPE_INVALID" | "TEMPLATE_FORM_LOCKED" | "SCHEMA_INVALID";

/** Why a key or field counts as changed (C13 M1). */
export type ChangeKind = "changed" | "new-slot" | "moved" | "unset" | "scratch";

export interface ParamLockChange {
  key: string;
  /** New value; undefined = unset. */
  value: ParamValue | undefined;
  /** Value in the base layer; undefined = not set there. */
  previous: ParamValue | undefined;
  kind: ChangeKind;
  /** Owning slot; absent = template-level layer. */
  slot?: { slotKey: string; sectionType: string; admits: readonly string[] };
}

export interface LockIssue {
  rule: LockRule | "R" | "S";
  code: LockCode;
  key: string;
  slotKey?: string;
  /** TEMPLATE_FORM_LOCKED reason: `class-K`, `category:<id>`, `apparatus`, `type:<t>`, `render-internal`, `tier-unknown`, `role-field:<path>`, ... */
  reason?: string;
  message: string;
  pointer: string;
}

// ── Lock vocabulary (spec §3.1) ──────────────────────────────────────────

/** P6: categories of the 3ebe486 `categoryOf` that are the DATUM form. */
export const LOCKED_CATEGORIES: readonly ParamCategoryId[] = ["warna", "tipografi", "halaman-grid", "lint-pemeriksaan"];

/** P6 allow-list: `type.body.align` (both values are DATUM forms). `slot.setup` fields are handled by the essential-field rule. */
export const P6_ALLOW_KEYS: readonly string[] = ["type.body.align"];

/** P7: classification and provenance apparatus, locked by key prefix (a bare entry without a dot also matches the key itself). */
export const APPARATUS_PREFIXES: readonly string[] = [
  "classification.",
  "runningHead.classification.",
  "device.sealBand.",
  "device.registerBlock.",
  "registerBlock.",
  "naming.",
  "doc.urgency",
  "compliance.",
  "photocopy.",
  "jury.",
  "marks.",
  "admiralty.",
  "confidence.",
];

/** P9 (C13 H1 a/b): colour types and object types. */
export const P9_LOCKED_TYPES: readonly string[] = ["hex", "tokenRef", "object", "map"];

/**
 * P9 (row 65 H1 c, defence in depth): renderer-internal prefixes. Every key under them except two is
 * already locked by P3 or by the P9 types; the two extra keys are `render.section.numberSeparator` and
 * `render.docx.pageBackground` (row 66 report).
 */
export const P9_RENDER_PREFIXES: readonly string[] = ["render.docx.", "render.run.", "render.list.", "render.runningHead.", "render.section.", "render.table.layout", "runningHead.ruleColour"];

/** P9 for list/pair/range values: a raw colour literal inside a list reaches `resolveColorToken` as is (row 65 H1 b). */
const COLOUR_LITERAL = /^#[0-9A-Fa-f]{3}$|^#?[0-9A-Fa-f]{6}$|^#?[0-9A-Fa-f]{8}$/;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const same = (a: unknown, b: unknown): boolean => stableStringify(a ?? null) === stableStringify(b ?? null);

function seg(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function prefixHit(key: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find((p) => (p.endsWith(".") ? key.startsWith(p) : key === p || key.startsWith(`${p}.`)));
}

function isTier(v: unknown): v is StudioTier {
  return typeof v === "string" && (STUDIO_TIERS as readonly string[]).includes(v);
}

/**
 * Tier used by the lock (spec §3.3 "the template's artifact.tier (default TERBIT)"). `known: false`
 * when the template layer sets a value outside STUDIO_TIERS (C13 M2).
 */
export function templateTierOf(tpl: Pick<StudioTemplateV2, "essentials" | "advanced">): { tier: StudioTier; known: boolean } {
  const layer = { ...(tpl.essentials ?? {}), ...(tpl.advanced ?? {}) } as ParamRecord;
  if (!has(layer, "artifact.tier")) return { tier: "TERBIT", known: true };
  const v = layer["artifact.tier"];
  return isTier(v) ? { tier: v, known: true } : { tier: "TERBIT", known: false };
}

// ── Changed keys (C13 M1) ────────────────────────────────────────────────

/** Layer Studio itself stores a key in (`storedSurfaceOf`, the partition `getTemplateV2` returns). */
function canonicalLayer(key: string, value: ParamValue): string {
  return storedSurfaceOf(key, value) === "essential" ? "e" : "a";
}

/**
 * Changed keys of `candidate` against `base` (null = from scratch: every key counts). Per layer:
 * template level (essentials ∪ advanced), and per slot matched by `slotKey` with the same
 * `sectionType` (a slot that is new, or whose section type changed, is checked in full). A key
 * moved between `essentials` and `advanced` counts even with an equal value. Keys of a removed slot
 * are not counts: the scope disappears with the slot, and slot removal is ruled by §3.3.
 */
export function collectParamChanges(base: StudioTemplateV2 | null, candidate: StudioTemplateV2): ParamLockChange[] {
  const out: ParamLockChange[] = [];
  const layerDiff = (
    prev: Pick<TemplateSlotDef, "essentials" | "advanced"> | undefined,
    next: Pick<TemplateSlotDef, "essentials" | "advanced">,
    slot: ParamLockChange["slot"] | undefined,
    whole: ChangeKind | null,
  ) => {
    // The value that renders is the flat layer: Studio's own flattening (template: advanced wins,
    // duplicates refused by the schema; slot: objects in both layers merge shallowly, advanced wins).
    const pf = prev ? flatOf(prev, slot !== undefined) : {};
    const nf = flatOf(next, slot !== undefined);
    for (const key of [...new Set([...Object.keys(pf), ...Object.keys(nf)])].sort()) {
      const prevIn = prev ? placementOf(prev, key) : "";
      const nextIn = placementOf(next, key);
      const previous = has(pf, key) ? pf[key] : undefined;
      const value = has(nf, key) ? nf[key] : undefined;
      const kind: ChangeKind | null =
        whole !== null
          ? value === undefined
            ? null
            : whole
          : value === undefined
            ? previous === undefined
              ? null
              : "unset"
            : previous === undefined || !same(previous, value)
              ? "changed"
              : prevIn !== nextIn && nextIn !== canonicalLayer(key, value)
                ? "moved"
                : null;
      if (kind === null) continue;
      out.push({ key, value, previous: whole !== null ? undefined : previous, kind, ...(slot ? { slot } : {}) });
    }
  };
  layerDiff(base ?? undefined, candidate, undefined, base ? null : "scratch");
  const baseSlots = new Map((base?.skeleton.slots ?? []).map((s) => [s.slotKey, s]));
  for (const s of candidate.skeleton.slots) {
    const prev = baseSlots.get(s.slotKey);
    const matched = prev && prev.sectionType === s.sectionType ? prev : undefined;
    const slot = { slotKey: s.slotKey, sectionType: s.sectionType, admits: s.admits ?? [] };
    layerDiff(matched, s, slot, base === null ? "scratch" : matched ? null : "new-slot");
  }
  return out;
}

function flatOf(l: Pick<TemplateSlotDef, "essentials" | "advanced">, slotLevel: boolean): ParamRecord {
  if (slotLevel) return flattenSlotParams(l) as ParamRecord;
  return { ...(l.essentials ?? {}), ...(l.advanced ?? {}) } as ParamRecord;
}

/** "e", "a" or "ea" (a slot key in both layers, merged by `flattenSlotParams`). */
function placementOf(l: Pick<TemplateSlotDef, "essentials" | "advanced">, key: string): string {
  return `${has(l.essentials ?? {}, key) ? "e" : ""}${has(l.advanced ?? {}, key) ? "a" : ""}`;
}

// ── P1-P9 per changed key ────────────────────────────────────────────────

const RULE_ORDER: readonly LockIssue["rule"][] = ["P1", "M2", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "R", "S"];

function where(c: Pick<ParamLockChange, "key" | "slot">): string {
  return c.slot ? `slot ${c.slot.slotKey}: ${c.key}` : c.key;
}

function pointerOf(c: Pick<ParamLockChange, "key" | "slot">): string {
  return c.slot ? `/template/skeleton/slots/${seg(c.slot.slotKey)}/${seg(c.key)}` : `/template/${seg(c.key)}`;
}

/** First failing rule for one changed key, or null when the change is allowed. */
export function paramLockIssue(c: ParamLockChange, tier: { tier: StudioTier; known: boolean }): LockIssue | null {
  const base = { key: c.key, pointer: pointerOf(c), ...(c.slot ? { slotKey: c.slot.slotKey } : {}) };
  const def = PARAMS_BY_KEY.get(c.key);
  // P1
  if (!def) return { ...base, rule: "P1", code: "PARAM_UNKNOWN_KEY", message: `Parameter tidak dikenal: ${where(c)}` };
  const v = c.value !== undefined ? c.value : c.previous;
  // M2: never consult effectiveClass with an undefined tier; the tier value itself fails P8.
  if (!tier.known && c.key !== "artifact.tier") {
    return { ...base, rule: "M2", code: "TEMPLATE_FORM_LOCKED", reason: "tier-unknown", message: `${where(c)} terkunci: tier templat tidak dikenal` };
  }
  const cls = v === undefined ? def.class : effectiveClass(def, v, tier.known ? tier.tier : undefined);
  // P2
  if (cls === "T") return { ...base, rule: "P2", code: "PARAM_CLASS_T_READONLY", message: `${where(c)} dihitung mesin dan tidak dapat ditimpa` };
  if (c.key === SLOT_SETUP_KEY) {
    const tFields = (changedFields(c.previous, c.value) ?? []).filter((f) => SLOT_SETUP_T_FIELDS.includes(f));
    if (tFields.length > 0) return { ...base, rule: "P2", code: "PARAM_CLASS_T_READONLY", message: `${where(c)}.${tFields.join(", .")} diturunkan dan tidak dapat ditimpa` };
  }
  // P3 (no ADMIN exception: a user template is never a preset)
  if (def.surface === "derived") return { ...base, rule: "P3", code: "PARAM_CLASS_T_READONLY", reason: "surface-derived", message: `${where(c)} lapis turunan tidak dapat ditimpa` };
  if (def.surface === "internal") return { ...base, rule: "P3", code: "PARAM_SURFACE_FORBIDDEN", reason: "surface-internal", message: `${where(c)} lapis internal tidak dapat diubah` };
  // P4
  if (c.slot && !isScopeAllowedInSlot(def.scope as Parameters<typeof isScopeAllowedInSlot>[0], c.slot)) {
    return { ...base, rule: "P4", code: "SLOT_PARAM_SCOPE_INVALID", message: `${where(c)} (cakupan ${String(def.scope)}) tidak berlaku untuk slot ini` };
  }
  // P5: class K, also a B value raised to K by a floor (effectiveClass)
  if (cls === "K") return { ...base, rule: "P5", code: "TEMPLATE_FORM_LOCKED", reason: "class-K", message: `${where(c)} adalah bentuk DATUM (kelas K) dan terkunci` };
  const essentialField = c.key === SLOT_SETUP_KEY && isEssentialFieldChange(c.key, c.previous, c.value);
  // P6
  const category = categoryOf(def);
  if (LOCKED_CATEGORIES.includes(category) && !P6_ALLOW_KEYS.includes(c.key) && !essentialField) {
    return { ...base, rule: "P6", code: "TEMPLATE_FORM_LOCKED", reason: `category:${category}`, message: `${where(c)} termasuk kategori ${category} (bentuk DATUM) dan terkunci` };
  }
  // P7
  if (prefixHit(c.key, APPARATUS_PREFIXES)) {
    return { ...base, rule: "P7", code: "TEMPLATE_FORM_LOCKED", reason: "apparatus", message: `${where(c)} adalah aparatus klasifikasi/provenans dan terkunci` };
  }
  // P8 (an unset reverts to the inherited value, which is valid by construction)
  if (c.value !== undefined) {
    const bad = validateParamValue(def, c.value);
    if (bad) return { ...base, rule: "P8", code: "SCHEMA_INVALID", message: `Nilai ${where(c)} tidak sah: ${bad}` };
  }
  // P9
  const p9 = p9Reason(def, c, essentialField);
  if (p9) return { ...base, rule: "P9", code: "TEMPLATE_FORM_LOCKED", reason: p9, message: `${where(c)} terkunci (${p9}): nilainya mencapai DOCX/HTML tanpa pemeriksaan bentuk` };
  return null;
}

function p9Reason(def: ParamDef, c: ParamLockChange, essentialField: boolean): string | null {
  if (P9_LOCKED_TYPES.includes(def.type) && !essentialField) return `type:${def.type}`;
  if (prefixHit(c.key, P9_RENDER_PREFIXES)) return "render-internal";
  if (def.type === "list" || def.type === "pair" || def.type === "range") {
    const items = Array.isArray(c.value) ? c.value : [];
    if (items.some((x) => x !== null && typeof x === "object")) return `type:${def.type}:nested`;
    if (items.some((x) => typeof x === "string" && COLOUR_LITERAL.test(x.trim()))) return `type:${def.type}:colour`;
  }
  return null;
}

/** All issues for a change set, sorted by rule order then key. */
export function paramLockIssues(changes: readonly ParamLockChange[], tier: { tier: StudioTier; known: boolean }): LockIssue[] {
  return changes.flatMap((c) => {
    const i = paramLockIssue(c, tier);
    return i ? [i] : [];
  });
}

// ── Role formats (§3.2) ──────────────────────────────────────────────────

/** Sub-objects whose whole value is locked (provenance colours). */
const ROLE_LOCKED_FIELDS = ["glyphRun", "labelRunByMark"];
const RUN_FACE_ROLES = ["serif", "condensed", "mono"];
const TWIP_FIELDS = ["spacingBeforeTw", "spacingAfterTw", "indLeftTw", "indRightTw", "indHangingTw", "indFirstLineTw"];
/** Editable leaves validated only by the Studio schema (booleans and enums). */
const ROLE_FREE_FIELDS = ["keepNext", "keepLines", "pageBreakBefore", "widowControl", "b", "i", "caps", "smallCaps", "u", "vertAlign"];
/** tabs.posTw bound: the A4 long edge in twips (spec §3.2 gives 0-2880 for spacing and indents only). */
const TAB_POS_MAX_TW = 16838;

type Leaf = { path: string[]; value: unknown };

function leaves(v: unknown, path: string[] = []): Leaf[] {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0 && path.length > 0) return [];
    return entries.flatMap(([k, x]) => leaves(x, [...path, k]));
  }
  return [{ path, value: v }];
}

function leafMap(v: unknown): Map<string, Leaf> {
  return new Map(leaves(v ?? {}).map((l) => [l.path.join("."), l]));
}

function intIn(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** Reason a changed role-format leaf is refused, or null. `baseValue` = the base effective value at that path. */
function roleLeafProblem(path: readonly string[], value: unknown, baseValue: unknown): string | null {
  const field = path[path.length - 1];
  if (ROLE_LOCKED_FIELDS.includes(path[0])) return `role-field:${path[0]}`;
  if (path.includes("color")) return "role-field:color";
  if (path.includes("shading")) return "role-field:shading";
  if (path.includes("borders")) return "role-field:borders";
  if (field === "face") return "role-field:face";
  if (value === undefined) return null;
  if (field === "faceRole") return typeof value === "string" && RUN_FACE_ROLES.includes(value) ? null : "role-field:faceRole";
  if (field === "jc") return value === "left" || value === "both" || same(value, baseValue) ? null : "role-field:jc";
  if (field === "szHalfPt") return intIn(value, 11, 104) ? null : "role-range:szHalfPt";
  if (TWIP_FIELDS.includes(field)) return intIn(value, 0, 2880) ? null : `role-range:${field}`;
  if (field === "lineTw") return intIn(value, 200, 720) ? null : "role-range:lineTw";
  if (field === "spacingTw") return intIn(value, -100, 200) ? null : "role-range:spacingTw";
  if (field === "tabs") {
    const ok = Array.isArray(value) && value.length <= 32 && value.every((t) => t !== null && typeof t === "object" && intIn((t as { posTw?: unknown }).posTw, 0, TAB_POS_MAX_TW));
    return ok ? null : "role-range:tabs";
  }
  if (ROLE_FREE_FIELDS.includes(field)) return null;
  // Deny by default: lineRule, outlineLvl, marginsTw, vAlign, widthTw and any field not listed in §3.2.
  return `role-field:${path.join(".")}`;
}

/**
 * Changed leaves of one role-format map (`base` and `candidate` are role -> format; `standard` is the
 * value a role falls back to, i.e. the preset's role formats for the template level). A leaf whose
 * new value equals the standard value, or that is removed, reverts to the DATUM standard and is
 * allowed; every other changed leaf must pass `roleLeafProblem`.
 */
function roleMapIssues(base: Record<string, unknown>, candidate: Record<string, unknown>, standard: Record<string, unknown>, at: { slotKey?: string; pointer: string }): LockIssue[] {
  const out: LockIssue[] = [];
  for (const role of [...new Set([...Object.keys(base), ...Object.keys(candidate)])].sort()) {
    const b = leafMap(has(base, role) ? base[role] : standard[role]);
    const n = leafMap(has(candidate, role) ? candidate[role] : standard[role]);
    const s = leafMap(standard[role]);
    for (const p of [...new Set([...b.keys(), ...n.keys()])].sort()) {
      const nv = n.get(p)?.value;
      const bv = b.get(p)?.value;
      if (same(nv, bv)) continue;
      if (nv === undefined || (s.has(p) && same(nv, s.get(p)?.value))) continue;
      const path = (n.get(p) ?? b.get(p))!.path;
      const problem = roleLeafProblem(path, nv, bv);
      if (problem) {
        out.push({
          rule: "R",
          code: "TEMPLATE_FORM_LOCKED",
          key: `${role}.${p}`,
          ...(at.slotKey ? { slotKey: at.slotKey } : {}),
          reason: problem,
          message: `roleFormats ${at.slotKey ? `slot ${at.slotKey} ` : ""}${role}.${p} terkunci (${problem})`,
          pointer: `${at.pointer}/${seg(role)}/${path.map(seg).join("/")}`,
        });
      }
    }
  }
  return out;
}

/** §3.2 for the template-level role formats and every slot's role formats. */
export function roleFormatLockIssues(base: StudioTemplateV2 | null, candidate: StudioTemplateV2, presetRoleFormats: Record<string, unknown>): LockIssue[] {
  const out = roleMapIssues((base?.roleFormats ?? {}) as Record<string, unknown>, (candidate.roleFormats ?? {}) as Record<string, unknown>, presetRoleFormats, { pointer: "/template/roleFormats" });
  const baseSlots = new Map((base?.skeleton.slots ?? []).map((s) => [s.slotKey, s]));
  for (const s of candidate.skeleton.slots) {
    const prev = baseSlots.get(s.slotKey);
    const matched = prev && prev.sectionType === s.sectionType ? prev : undefined;
    out.push(...roleMapIssues((matched?.roleFormats ?? {}) as Record<string, unknown>, (s.roleFormats ?? {}) as Record<string, unknown>, {}, { slotKey: s.slotKey, pointer: `/template/skeleton/slots/${seg(s.slotKey)}/roleFormats` }));
  }
  return out;
}

// ── Skeleton (§3.3 Swarm additions; Studio's validateSkeleton runs separately) ──

/** Slot section types that a tier requires (CANONICAL_REQUIRED_BY_TIER ∩ SLOT_SECTION_TYPES). */
export function requiredSlotTypes(tier: StudioTier): string[] {
  return CANONICAL_REQUIRED_BY_TIER[tier].filter((t) => (SLOT_SECTION_TYPES as readonly string[]).includes(t));
}

function labelProblem(label: unknown): string | null {
  if (typeof label !== "string") return "label harus string";
  if (label.normalize("NFC") !== label) return "label harus NFC";
  if (label.length < 1 || label.length > 120) return "label 1-120 karakter";
  if (label.trimEnd().endsWith("?")) return "label tidak boleh diakhiri tanda tanya";
  if (label.includes("—")) return "label tidak boleh memuat em-dash";
  return null;
}

/**
 * §3.3: a slot type the tier requires, present and required in the base, stays present and required;
 * a `positionLocked` base slot keeps its key, position and lock; `cover` stays at position 1; a new or
 * changed label is NFC, 1-120 characters, without a trailing `?` or an em-dash. `base` null = the
 * reference skeleton (datum-kanonik) for a template made from scratch.
 */
export function skeletonLockIssues(base: Pick<StudioTemplateV2, "skeleton"> | null, candidate: StudioTemplateV2, tier: StudioTier): LockIssue[] {
  const out: LockIssue[] = [];
  const slots = candidate.skeleton.slots;
  const baseSlots = base?.skeleton.slots ?? [];
  const lock = (key: string, reason: string, message: string, pointer: string, slotKey?: string): void => {
    out.push({ rule: "S", code: "TEMPLATE_FORM_LOCKED", key, reason, message, pointer, ...(slotKey ? { slotKey } : {}) });
  };
  for (const t of requiredSlotTypes(tier)) {
    const inBase = baseSlots.some((s) => s.sectionType === t && s.required);
    if (inBase && !slots.some((s: TemplateSlotDef) => s.sectionType === t && s.required)) {
      lock(t, "slot-required", `slot berjenis ${t} wajib untuk tier ${tier} dan harus tetap ada dengan required: true`, "/template/skeleton/slots");
    }
  }
  for (const b of baseSlots.filter((s) => s.positionLocked)) {
    const c = slots.find((s) => s.slotKey === b.slotKey);
    if (!c || c.position !== b.position || !c.positionLocked || c.sectionType !== b.sectionType) {
      lock(b.slotKey, "slot-position-locked", `slot ${b.slotKey} terkunci posisinya (${b.position}) dan harus tetap ada`, `/template/skeleton/slots/${seg(b.slotKey)}`, b.slotKey);
    }
  }
  const cover = slots.find((s) => s.sectionType === "cover");
  if (cover && cover.position !== 1) lock(cover.slotKey, "cover-first", "slot sampul harus berada di posisi 1", `/template/skeleton/slots/${seg(cover.slotKey)}/position`, cover.slotKey);
  const baseLabel = new Map(baseSlots.map((s) => [s.slotKey, s.label]));
  for (const s of slots) {
    if (baseLabel.get(s.slotKey) === s.label) continue;
    const p = labelProblem(s.label);
    if (p) lock(s.slotKey, "slot-label", `label slot ${s.slotKey}: ${p}`, `/template/skeleton/slots/${seg(s.slotKey)}/label`, s.slotKey);
  }
  return out;
}

/** Sort issues by rule order (spec §3.1), then key; the first issue's code is the response code. */
export function sortLockIssues(issues: readonly LockIssue[]): LockIssue[] {
  return [...issues].sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) || a.key.localeCompare(b.key));
}

// ── Static classification (row 66 report: §3.1 counts, U.1a) ───────────

export type StaticLock = "editable" | "P2" | "P3" | "P5" | "P6" | "P7" | "P9";

/**
 * Which rule locks a key for a plain (template-level) write of its default value at TERBIT. Value-
 * dependent rules (P4 slot scope, P8 range, K floors on other values, P9 list colour literals) are not
 * static and are not reported here.
 */
export function staticParamLock(def: ParamDef): StaticLock {
  const v = def.default as ParamValue;
  const cls = v === undefined || v === null ? def.class : effectiveClass(def, v, "TERBIT");
  if (cls === "T") return "P2";
  if (def.surface === "derived" || def.surface === "internal") return "P3";
  if (cls === "K") return "P5";
  if (LOCKED_CATEGORIES.includes(categoryOf(def)) && !P6_ALLOW_KEYS.includes(def.key) && def.key !== SLOT_SETUP_KEY) return "P6";
  if (prefixHit(def.key, APPARATUS_PREFIXES)) return "P7";
  if (prefixHit(def.key, P9_RENDER_PREFIXES) || (P9_LOCKED_TYPES.includes(def.type) && def.key !== SLOT_SETUP_KEY)) return "P9";
  return "editable";
}

/** U.1a lint-parameter set: render-lint limit keys plus every `paramRef` of LINT_REGISTRY. */
export function lintParameterKeys(): string[] {
  const keys = new Set<string>(Object.values(RENDER_LINT_PARAM_KEYS).flat());
  for (const d of LINT_REGISTRY) {
    const ref = (d as { paramRef?: unknown }).paramRef;
    if (typeof ref === "string" && ref.length > 0) keys.add(ref);
  }
  return [...keys].sort();
}

