/**
 * Op struktur dokumen pada pohon konten (SR-14; register 03 §12 R14, E33,
 * §9.2 baris "Struktur" dan "Meta", KD-08, KD-11).
 *
 * Murni. Mengubah salinan `StudioDocV2Resolved` (urutan slot di
 * `structure.order`, outline, meta, kunci bab, patokan versi templat). Aturan
 * urutan slot (SLOT_UNKNOWN, SLOT_DUPLICATE, SLOT_POSITION_LOCKED,
 * SLOT_REQUIRED_MISSING, SLOT_FORBIDDEN_FOR_TIER, SLOT_TYPE_MISMATCH) ditegakkan
 * `validateStructure` compose (SR-08) setelah op; di sini hanya prasyarat op.
 */
import {
  CHAPTER_KEY_LETTER_PATTERN,
  CHAPTER_KEY_NUMERIC_PATTERN,
  type DocMeta,
  type OutlineEntryV2,
  type StudioDocV2Resolved,
  type StudioSkeletonV1,
  type ValidationIssue,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import type { PatchStructureBody } from "./body";
import { chapterLocs, type RepeatablePayload } from "./tree";

export interface StructureOpContext {
  skeleton: StudioSkeletonV1;
  /** Urutan slot aktif di revisi terbaru (posisi M14). */
  currentOrder: string[];
  isAdmin: boolean;
}

export interface StructureOpOutcome {
  /** Lingkup tata bahasa §9.5. */
  scope: string;
  /** Kunci bab lama -> baru (renumberChapters). */
  chapterKeyMap?: Record<string, string>;
  /** Medan meta yang berubah (setMeta). */
  metaFields?: string[];
  /** versionNo templat baru (templateVersion); pemanggil memuat kerangka versi itu. */
  templateVersionNo?: number;
}

function fail(code: ConstructorParameters<typeof StudioEngineError>[0], message: string, details?: unknown): never {
  throw new StudioEngineError(code, message, details);
}

function noChange(message: string): never {
  const issues: ValidationIssue[] = [{ pointer: "", keyword: "noChange", message }];
  fail("SCHEMA_INVALID", `Tidak ada perubahan: ${message}`, issues);
}

function slotDef(skel: StudioSkeletonV1, slotKey: string) {
  const s = skel.slots.find((x) => x.slotKey === slotKey);
  if (!s) fail("SLOT_UNKNOWN", `Slot ${slotKey} tidak ada di kerangka templat dokumen`, { slotKey, known: skel.slots.map((x) => x.slotKey) });
  return s;
}

function keyPattern(sectionType: string): RegExp {
  return new RegExp(sectionType === "appendix" ? CHAPTER_KEY_LETTER_PATTERN : CHAPTER_KEY_NUMERIC_PATTERN);
}

/** Slot berulang sasaran: `slot` eksplisit (harus berulang) atau slot `chapter` pertama di urutan. */
function repeatableTarget(doc: StudioDocV2Resolved, ctx: StructureOpContext, slot: string | undefined): { slotKey: string; sectionType: string } {
  if (slot) {
    const d = slotDef(ctx.skeleton, slot);
    if (!d.repeatable) {
      fail("SLOT_TYPE_MISMATCH", `Slot ${slot} tidak berulang; op ini hanya untuk slot bab/lampiran`, { slotKey: slot, expected: "chapter|appendix", actual: d.sectionType });
    }
    return { slotKey: slot, sectionType: d.sectionType };
  }
  for (const k of ctx.currentOrder) {
    const d = ctx.skeleton.slots.find((x) => x.slotKey === k);
    if (d?.repeatable && d.sectionType === "chapter") return { slotKey: k, sectionType: d.sectionType };
  }
  fail("SLOT_UNKNOWN", "Dokumen tidak punya slot bab aktif; sebutkan slot", { slotKey: null, known: ctx.skeleton.slots.filter((x) => x.repeatable).map((x) => x.slotKey) });
}

function payloadOf(doc: StudioDocV2Resolved, slotKey: string, sectionType: string): RepeatablePayload {
  const sections = (doc.sections ??= {});
  const cur = sections[slotKey] as RepeatablePayload | undefined;
  if (cur) return cur;
  const created: RepeatablePayload = { type: sectionType === "appendix" ? "appendix" : "chapter" };
  (sections as Record<string, unknown>)[slotKey] = created;
  return created;
}

export function applyStructureOp(doc: StudioDocV2Resolved, body: PatchStructureBody, ctx: StructureOpContext): StructureOpOutcome {
  const order = [...ctx.currentOrder];
  switch (body.op) {
    case "reorder": {
      if (body.order.join("|") === order.join("|")) noChange("urutan slot sama dengan revisi terbaru");
      doc.structure = { order: [...body.order] };
      return { scope: "structure:reorder" };
    }
    case "omitSlot": {
      const d = slotDef(ctx.skeleton, body.slot);
      if (!order.includes(body.slot)) noChange(`slot ${body.slot} sudah tidak aktif (OMITTED)`);
      if (d.required) fail("SLOT_REQUIRED_MISSING", `Slot wajib ${d.label} tidak dapat dihapus`, { missing: [body.slot] });
      doc.structure = { order: order.filter((k) => k !== body.slot) };
      // KD-08: slot OMITTED = tanpa baris M14; isinya tidak dibawa ke revisi baru.
      if (doc.sections) delete (doc.sections as Record<string, unknown>)[body.slot];
      return { scope: "structure:omitSlot" };
    }
    case "restoreSlot": {
      const d = slotDef(ctx.skeleton, body.slot);
      if (order.includes(body.slot)) noChange(`slot ${body.slot} sudah aktif`);
      let at: number;
      if (body.position !== undefined) {
        if (body.position > order.length + 1) {
          fail("SCHEMA_INVALID", `position maksimal ${order.length + 1}`, [{ pointer: "/position", keyword: "maximum", message: `posisi 1..${order.length + 1}` }]);
        }
        at = body.position - 1;
      } else {
        // Posisi bawaan: sebelum slot aktif pertama yang posisi kerangkanya lebih besar.
        const posOf = (k: string) => ctx.skeleton.slots.find((x) => x.slotKey === k)?.position ?? Number.MAX_SAFE_INTEGER;
        at = order.findIndex((k) => posOf(k) > d.position);
        if (at < 0) at = order.length;
      }
      order.splice(at, 0, body.slot);
      doc.structure = { order };
      return { scope: "structure:restoreSlot" };
    }
    case "setOutline": {
      const t = repeatableTarget(doc, ctx, body.slot);
      const payload = payloadOf(doc, t.slotKey, t.sectionType);
      const next = body.outline;
      if (next !== null) {
        const re = keyPattern(t.sectionType);
        const seen = new Set<string>();
        next.forEach((e: OutlineEntryV2, i: number) => {
          if (!re.test(e.key)) fail("CHAPTER_KEY_INVALID", `Kunci outline ${e.key} tidak sesuai pola slot ${t.slotKey}`, { slotKey: t.slotKey, key: e.key, pattern: re.source, pointer: `/outline/${i}/key` });
          if (seen.has(e.key)) fail("SCHEMA_INVALID", `Kunci outline ganda: ${e.key}`, [{ pointer: `/outline/${i}/key`, keyword: "uniqueItems", message: "kunci outline harus unik" }]);
          seen.add(e.key);
        });
      }
      const before = JSON.stringify(payload.outline ?? null);
      if (next === null) delete payload.outline;
      else payload.outline = next;
      if (JSON.stringify(payload.outline ?? null) === before) noChange(`outline slot ${t.slotKey} sama`);
      return { scope: "structure:setOutline" };
    }
    case "setMeta": {
      const meta = doc.meta as DocMeta & Record<string, unknown>;
      const changed: string[] = [];
      for (const [k, v] of Object.entries(body.meta)) {
        if (JSON.stringify(meta[k]) !== JSON.stringify(v)) {
          meta[k] = v;
          changed.push(k);
        }
      }
      if (changed.length === 0) noChange("meta sama dengan revisi terbaru");
      return { scope: "meta", metaFields: changed };
    }
    case "renumberChapters": {
      if (!ctx.isAdmin) fail("FORBIDDEN", "Penomoran ulang kunci bab hanya untuk ADMIN", { op: "renumberChapters" });
      const t = repeatableTarget(doc, ctx, body.slot);
      const re = keyPattern(t.sectionType);
      const payload = payloadOf(doc, t.slotKey, t.sectionType);
      const inSlot = new Set((payload.chapters ?? []).map((c) => c.key));
      const map: Record<string, string> = {};
      for (const [from, to] of Object.entries(body.map)) {
        if (!inSlot.has(from)) fail("ADDRESS_NOT_FOUND", `Bab ${from} tidak ada di slot ${t.slotKey}`, { slotKey: t.slotKey, key: from });
        if (!re.test(to)) fail("CHAPTER_KEY_INVALID", `Kunci bab baru ${to} tidak sesuai pola slot ${t.slotKey}`, { slotKey: t.slotKey, key: to, pattern: re.source });
        if (from !== to) map[from] = to;
      }
      if (Object.keys(map).length === 0) noChange("peta kunci tidak mengubah kunci apa pun");
      // Kunci akhir harus unik lintas semua slot berulang (CHAPTER_KEY_INVALID, EC24).
      const finalKeys = new Map<string, string>();
      for (const c of chapterLocs(doc)) {
        const k = c.slotKey === t.slotKey ? (map[c.chapter.key] ?? c.chapter.key) : c.chapter.key;
        const owner = finalKeys.get(k);
        if (owner) fail("CHAPTER_KEY_INVALID", `Kunci bab ${k} bentrok setelah penomoran ulang (${owner} dan ${c.slotKey})`, { slotKey: c.slotKey, key: k, conflictsWith: owner });
        finalKeys.set(k, c.slotKey);
      }
      for (const c of payload.chapters ?? []) if (map[c.key]) c.key = map[c.key];
      if (Array.isArray(payload.outline)) {
        for (const e of payload.outline as OutlineEntryV2[]) if (map[e.key]) e.key = map[e.key];
      }
      return { scope: "structure:renumberChapters", chapterKeyMap: map };
    }
    case "templateVersion": {
      if (body.versionNo === doc.template.version) noChange(`dokumen sudah berpatokan versi ${body.versionNo}`);
      doc.template = { ...doc.template, version: body.versionNo };
      return { scope: "structure:templateVersion", templateVersionNo: body.versionNo };
    }
  }
}

/** Urutan slot terkini dari pohon (bila `structure.order` ada) atau dari posisi baris M14. */
export function orderFrom(doc: StudioDocV2Resolved, rowOrder: readonly string[]): string[] {
  return doc.structure?.order?.length ? [...doc.structure.order] : [...rowOrder];
}

