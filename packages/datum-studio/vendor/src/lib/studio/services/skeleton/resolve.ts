/**
 * Resolusi nilai efektif per slot (SR-06; register §13.5 urutan 1-8, §15.1
 * `ResolvedSlot`, D-165, D-169, permintaan SR-60 di file_requests.md).
 *
 * Jalur berlapis (`opts.layers` terisi; dipakai layanan DB):
 *   (1) default registri <- (2) preset (rantai `baseVersionId`, dilipat) <-
 *   (3-4) override templat (esensial + lanjutan) <- (5-6) parameter slot (M11
 *   esensial + lanjutan) -> (7) fase lapis turunan beracuan (`deriveLayered`,
 *   dipanggil SEKALI; sematan preset `pinPolicy: "reference"` bawaan D-169) ->
 *   (8) kelas T dihitung ulang (`deriveAll` di dalam `deriveLayered`).
 *   Lapis 3/4 dan 5/6 berisi kunci yang lapisnya berbeda (satu kunci satu lapis),
 *   sehingga penggabungan datar per tingkat setara dengan urutan register.
 *
 * Jalur cepat (tanpa `layers`; dipakai CLI tanpa DB atau pemanggil yang hanya
 * memegang `ResolvedTemplate`): `tpl.params` sudah memuat lapis 1-4 + turunan.
 * Kunci slot hanya bercakupan slot/section (kenop fase lapis semuanya cakupan
 * `document`), sehingga fase lapis TIDAK dijalankan ulang (tidak idempoten);
 * cukup timpa kunci slot lalu `computeDerivedWith` (idempoten) + skala tab R-30
 * terhadap bentang templat (mis. `page.orientation` landscape per slot).
 *
 * Format peran: roleFormats slot (M12) <- roleFormats templat (sudah memuat
 * preset) <- turunan katalog (dibaca renderer lewat `resolveRoleFormat`).
 *
 * Modul murni: tanpa I/O.
 */
import type { ParamDef, ParamIssue, ParamMap, ParamValue, ResolvedSlot, ResolvedTemplate, RoleFormatMap, StudioTier, TemplateSlotDef } from "../../contract";
import { computeDerivedWith, type DeriveContext, deriveLayered, type PinPolicy } from "../../engine/tokens";
import { applySpanScaledSubfields, LAYER_KNOB } from "../../engine/tokens/layer";
import { mergeLayers } from "../../engine/tokens/merge";
import { ALL_PARAMS } from "../../params";
import { validateRoleFormats } from "../templates/profile";
import { flattenSlotParams, isSlotActive } from "./skeleton";

export const SLOT_PLACEHOLDER_KEY = "slot.placeholderText";
export const SLOT_PLACEHOLDER_DEFAULT = "[{label} belum diisi]";

/** Lapis sumber untuk resolusi berlapis penuh. */
export interface SlotParamLayers {
  /** Lapis 2: override rantai versi preset/dasar dilipat (akar -> induk). */
  preset: ParamMap;
  /** Lapis 3-4: override milik versi templat (DB `overrides` = esensial ∪ lanjutan). */
  template: ParamMap;
}

export interface ResolveSlotOptions {
  /** Bila diisi: resolusi berlapis penuh (fase lapis sekali). Selain itu jalur cepat dari `tpl.params`. */
  layers?: SlotParamLayers;
  /** Bawaan "reference" (D-169). */
  pinPolicy?: PinPolicy;
  ctx?: DeriveContext;
  registry?: readonly ParamDef[];
}

export interface ResolvedSlotDetailed {
  slot: ResolvedSlot;
  /** Kunci tersimpan yang tidak diterapkan (tak dikenal, kelas T, nilai tidak sah) atau peringatan resolusi. */
  issues: ParamIssue[];
}

const LAYER_KNOBS: ReadonlySet<string> = new Set(Object.values(LAYER_KNOB));

function freeze(p: Record<string, ParamValue>): ParamMap {
  return Object.freeze(p);
}

function slotPointer(slotKey: string, key: string): string {
  return `/slots/${slotKey}/params/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** Peta kesalahan mergeLayers (pointer /overrides/…) dipetakan ke pointer slot bila kunci milik slot. */
function relabel(errors: readonly ParamIssue[], slotKeys: ReadonlySet<string>, slotKey: string): ParamIssue[] {
  return errors.map((e) =>
    e.pointer?.startsWith("/overrides/") && slotKeys.has(e.key) ? { ...e, pointer: slotPointer(slotKey, e.key) } : e,
  );
}

function placeholderOf(params: ParamMap, label: string): string {
  const raw = params[SLOT_PLACEHOLDER_KEY];
  const text = typeof raw === "string" ? raw : SLOT_PLACEHOLDER_DEFAULT;
  return text.split("{label}").join(label);
}

function roleFormatsOf(tpl: Pick<ResolvedTemplate, "roleFormats">, slot: TemplateSlotDef, issues: ParamIssue[]): RoleFormatMap {
  if (!slot.roleFormats || Object.keys(slot.roleFormats).length === 0) return tpl.roleFormats;
  const r = validateRoleFormats(slot.roleFormats, `/slots/${slot.slotKey}/roleFormats`);
  issues.push(...r.issues);
  return Object.freeze({ ...tpl.roleFormats, ...r.roleFormats });
}

/**
 * I44 `resolveSlotParams` dengan isu: nilai efektif satu slot. `presetPins` =
 * kunci yang disematkan versi preset (jalur berlapis; bawaan = kunci
 * `layers.preset`). Tidak melempar: kunci tersimpan yang tidak sah dilewati dan
 * dilaporkan di `issues` (pemanggil mencatatnya).
 */
export function resolveSlotParamsDetailed(
  tpl: Pick<ResolvedTemplate, "params" | "roleFormats">,
  slot: TemplateSlotDef,
  presetPins?: ReadonlySet<string>,
  opts: ResolveSlotOptions = {},
): ResolvedSlotDetailed {
  const registry = opts.registry ?? ALL_PARAMS;
  const ctx = opts.ctx ?? {};
  const slotParams = flattenSlotParams(slot);
  const slotKeys = new Set(Object.keys(slotParams));
  const issues: ParamIssue[] = [];
  let params: ParamMap;

  if (opts.layers) {
    const { preset, template } = opts.layers;
    const overrides = { ...template, ...slotParams };
    const reference = mergeLayers({ base: preset, overrides: {}, registry });
    const { merged, errors } = mergeLayers({ base: preset, overrides, registry });
    issues.push(...relabel(errors, slotKeys, slot.slotKey));
    const rejected = new Set(errors.filter((e) => e.pointer?.startsWith("/overrides/")).map((e) => e.key));
    const rejectedBase = new Set(errors.filter((e) => e.pointer?.startsWith("/base/")).map((e) => e.key));
    const explicit = Object.keys(overrides).filter((k) => !rejected.has(k));
    const pinned = presetPins ? [...presetPins] : Object.keys(preset).filter((k) => !rejectedBase.has(k));
    params = freeze(deriveLayered({ reference: reference.merged, merged, explicit, pinned, registry, pinPolicy: opts.pinPolicy, ctx }));
  } else if (slotKeys.size === 0) {
    params = tpl.params;
  } else {
    const { merged, errors } = mergeLayers({ base: tpl.params, overrides: slotParams, registry });
    issues.push(...relabel(errors.filter((e) => e.pointer?.startsWith("/overrides/")), slotKeys, slot.slotKey));
    const rejected = new Set(errors.filter((e) => e.pointer?.startsWith("/overrides/")).map((e) => e.key));
    const explicit = [...slotKeys].filter((k) => !rejected.has(k));
    for (const k of explicit) {
      if (LAYER_KNOBS.has(k)) {
        issues.push({
          key: k,
          code: "SCHEMA_INVALID",
          message: `Kenop ${k} di slot ${slot.slotKey} butuh resolusi berlapis (layers); jalur cepat tidak menskalakan turunannya`,
          pointer: slotPointer(slot.slotKey, k),
        });
      }
    }
    const derived = computeDerivedWith(merged, ctx, registry);
    params = freeze(applySpanScaledSubfields({ ...derived }, tpl.params, explicit));
  }

  const resolved: ResolvedSlot = {
    slotKey: slot.slotKey,
    sectionType: slot.sectionType,
    label: slot.label,
    params,
    roleFormats: roleFormatsOf(tpl, slot, issues),
    placeholderText: placeholderOf(params, slot.label),
  };
  return { slot: resolved, issues };
}

/** I44 `resolveSlotParams(tpl, slot, presetPins)` (register §15). */
export function resolveSlotParams(
  tpl: Pick<ResolvedTemplate, "params" | "roleFormats">,
  slot: TemplateSlotDef,
  presetPins?: ReadonlySet<string>,
  opts: ResolveSlotOptions = {},
): ResolvedSlot {
  return resolveSlotParamsDetailed(tpl, slot, presetPins, opts).slot;
}

/**
 * Nilai efektif semua slot satu kerangka (bila `tier` diisi: hanya slot aktif
 * untuk tier itu) -> peta untuk `RenderContext.slots` / `PureRenderOptions.slots`.
 */
export function resolveSkeletonSlots(
  tpl: Pick<ResolvedTemplate, "params" | "roleFormats">,
  slots: readonly TemplateSlotDef[],
  presetPins?: ReadonlySet<string>,
  opts: ResolveSlotOptions & { tier?: StudioTier } = {},
): { slots: ReadonlyMap<string, ResolvedSlot>; issues: ParamIssue[] } {
  const out = new Map<string, ResolvedSlot>();
  // Isu lapis templat (mis. override lama yang kini kelas T) sama untuk setiap slot: dicatat sekali.
  const issues = new Map<string, ParamIssue>();
  for (const slot of [...slots].sort((a, b) => a.position - b.position)) {
    if (opts.tier && !isSlotActive(slot, opts.tier)) continue;
    const r = resolveSlotParamsDetailed(tpl, slot, presetPins, opts);
    out.set(slot.slotKey, r.slot);
    for (const i of r.issues) issues.set(`${i.code}|${i.key}|${i.pointer ?? ""}`, i);
  }
  return { slots: out, issues: [...issues.values()] };
}
