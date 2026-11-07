/**
 * Validasi struktur §2.7 (SR-08, I45 `validateStructure`; register §6.1, §11.1-§11.2).
 *
 * Dijalankan SESUDAH skema (400), gerbang kepercayaan, dan `ingest.inlineFormat`,
 * SEBELUM aset dan by-construction. Isi kosong bukan galat (INCOMPLETE).
 *
 * Urutan evaluasi dalam langkah struktur (galat pertama dilempar):
 * Kerangka implisit (per tier, §6.3): slotKey implisit registri yang absen =
 * SLOT_FORBIDDEN_FOR_TIER (EC06), bukan SLOT_UNKNOWN (F-069).
 *
 *   A. `structure.order`: SLOT_UNKNOWN -> SLOT_DUPLICATE -> SLOT_FORBIDDEN_FOR_TIER
 *      -> SLOT_REQUIRED_MISSING -> SLOT_POSITION_LOCKED.
 *   B. Per isi slot (`sections`, kiriman bab, kiriman slot), urut kunci kiriman:
 *      SLOT_UNKNOWN (termasuk slot yang di-OMIT) -> SLOT_FORBIDDEN_FOR_TIER
 *      -> SLOT_USE_CHAPTER_ENDPOINT -> SLOT_TYPE_MISMATCH -> SLOT_INPUT_NOT_ACCEPTED
 *      -> SLOT_ITEMS_OUT_OF_RANGE -> CHAPTER_KEY_INVALID -> BLOCK_TYPE_NOT_ADMITTED.
 */
import {
  CHAPTER_KEY_LETTER_PATTERN,
  CHAPTER_KEY_NUMERIC_PATTERN,
  type ChapterV2,
  type StudioTier,
  type TemplateSlotDef,
} from "../../contract";
import { getSectionType } from "../../registry/sections";
import { SLOT_KINDS } from "../../registry/slots";
import { composeFail, listText } from "./errors";
import type { SkeletonInput, StructureInput } from "./types";

const NUMERIC_KEY_RE = new RegExp(CHAPTER_KEY_NUMERIC_PATTERN);
const LETTER_KEY_RE = new RegExp(CHAPTER_KEY_LETTER_PATTERN);

/** slotKey kerangka implisit -> sectionType registri (§6.3: signature -> signatureBlock, content -> chapter, ...). */
const IMPLICIT_SECTION_BY_SLOT_KEY: ReadonlyMap<string, string> = new Map(SLOT_KINDS.map((k) => [k.implicitSlotKey, k.sectionType]));

/** Slot aktif untuk tier: `tiers` kosong atau memuat tier dokumen (§6.1). */
export function isSlotActive(slot: TemplateSlotDef, tier: StudioTier): boolean {
  return slot.tiers.length === 0 || slot.tiers.includes(tier);
}

export function isRepeatable(slot: TemplateSlotDef): boolean {
  return slot.repeatable && (slot.sectionType === "chapter" || slot.sectionType === "appendix");
}

/** Slot kerangka urut `position`. */
export function skeletonSlots(skel: SkeletonInput): TemplateSlotDef[] {
  return [...skel.skeleton.slots].sort((a, b) => a.position - b.position);
}

export interface SlotLayout {
  /** Slot aktif tidak di-OMIT, urut posisi dokumen. */
  ordered: TemplateSlotDef[];
  /** Slot opsional aktif yang di-OMIT `structure`. */
  omitted: TemplateSlotDef[];
  /** Slot tidak aktif untuk tier. */
  inactive: TemplateSlotDef[];
  byKey: ReadonlyMap<string, TemplateSlotDef>;
}

/**
 * Tata letak slot dokumen: urutan = `structure.order` bila ada (slot aktif yang
 * tidak disebut = OMITTED), selain itu urutan kerangka. TIDAK memvalidasi:
 * panggil `validateStructure` lebih dulu.
 */
export function slotLayout(skel: SkeletonInput, tier: StudioTier, structure?: { order: string[] }): SlotLayout {
  const slots = skeletonSlots(skel);
  const byKey = new Map(slots.map((s) => [s.slotKey, s]));
  const active = slots.filter((s) => isSlotActive(s, tier));
  const inactive = slots.filter((s) => !isSlotActive(s, tier));
  if (!structure) return { ordered: active, omitted: [], inactive, byKey };
  const ordered = structure.order.map((k) => byKey.get(k)).filter((s): s is TemplateSlotDef => !!s && isSlotActive(s, tier));
  const inOrder = new Set(ordered.map((s) => s.slotKey));
  return { ordered, omitted: active.filter((s) => !inOrder.has(s.slotKey)), inactive, byKey };
}

/** Slot berulang aktif pertama (bawaan `slot` kiriman bab, §2.5). */
export function defaultChapterSlot(layout: SlotLayout): TemplateSlotDef | undefined {
  return layout.ordered.find(isRepeatable);
}

function knownKeys(skel: SkeletonInput): string[] {
  return skeletonSlots(skel).map((s) => s.slotKey);
}

function unknownSlot(skel: SkeletonInput, slotKey: string, pointer: string): never {
  composeFail("SLOT_UNKNOWN", `Slot "${slotKey}" tidak ada di kerangka templat dokumen; pakai salah satu: ${listText(knownKeys(skel))}`, {
    slotKey,
    known: knownKeys(skel),
    pointer,
  });
}

/**
 * Kerangka implisit dibentuk PER TIER (§6.3: kunci `forbidden` atau di luar
 * rencana tier tidak menjadi slot), jadi slotKey implisit registri yang absen
 * dari kerangka itu adalah slot yang tidak aktif untuk tier dokumen, bukan slot
 * asing (F-069, register EC06). Kerangka eksplisit membawa semua slot beserta
 * `tiers`, sehingga absen di sana tetap EC01 SLOT_UNKNOWN.
 */
function implicitInactiveSection(skel: SkeletonInput, slotKey: string): string | undefined {
  if (!skel.implicit || skeletonSlots(skel).some((s) => s.slotKey === slotKey)) return undefined;
  return IMPLICIT_SECTION_BY_SLOT_KEY.get(slotKey);
}

function forbiddenForTierImplicit(slotKey: string, sectionType: string, tier: StudioTier, hint: string): never {
  const def = getSectionType(sectionType);
  // Kerangka implisit tidak membawa rencana tier lain: `activeTiers` = tier aktif registri,
  // tanpa tier dokumen (templat menonaktifkannya untuk tier itu).
  composeFail("SLOT_FORBIDDEN_FOR_TIER", `Slot "${def?.name ?? slotKey}" (${slotKey}) tidak berlaku untuk dokumen ${tier}; ${hint}`, {
    slotKey,
    tier,
    activeTiers: (def?.activeTiers ?? []).filter((t) => t !== tier),
  });
}

function validateOrder(skel: SkeletonInput, tier: StudioTier, order: string[], pointer: string): void {
  const slots = skeletonSlots(skel);
  const byKey = new Map(slots.map((s) => [s.slotKey, s]));
  order.forEach((k, i) => {
    if (!byKey.has(k) && !implicitInactiveSection(skel, k)) unknownSlot(skel, k, `${pointer}/structure/order/${i}`);
  });
  const seen = new Map<string, number>();
  order.forEach((k, i) => {
    const prior = seen.get(k);
    if (prior !== undefined) {
      composeFail("SLOT_DUPLICATE", `Slot "${k}" disebut lebih dari sekali di structure.order; sebutkan setiap slot satu kali`, {
        slotKey: k,
        positions: [prior + 1, i + 1],
      });
    }
    seen.set(k, i);
  });
  for (const k of order) {
    const s = byKey.get(k);
    if (!s) {
      forbiddenForTierImplicit(k, implicitInactiveSection(skel, k) as string, tier, "hapus dari structure.order");
    }
    if (!isSlotActive(s, tier)) {
      composeFail("SLOT_FORBIDDEN_FOR_TIER", `Slot "${s.label}" (${k}) tidak berlaku untuk dokumen ${tier}; hapus dari structure.order`, {
        slotKey: k,
        tier,
        activeTiers: s.tiers,
      });
    }
  }
  const inOrder = new Set(order);
  const missing = slots.filter((s) => s.required && isSlotActive(s, tier) && !inOrder.has(s.slotKey)).map((s) => s.slotKey);
  if (missing.length > 0) {
    const labels = missing.map((k) => byKey.get(k)?.label ?? k);
    composeFail("SLOT_REQUIRED_MISSING", `Slot wajib tidak boleh dihapus: ${listText(labels)}; sertakan di structure.order`, { missing });
  }
  // Kunci posisi (§6.1): himpunan slot sebelum slot terkunci sama dengan di kerangka,
  // dibandingkan pada slot aktif yang hadir di order (slot OMIT tidak menggeser).
  const present = slots.filter((s) => inOrder.has(s.slotKey));
  for (const s of present) {
    if (!s.positionLocked) continue;
    const expectedBefore = present.filter((x) => x.position < s.position).map((x) => x.slotKey);
    const actualBefore = order.slice(0, order.indexOf(s.slotKey));
    const same = expectedBefore.length === actualBefore.length && expectedBefore.every((k) => actualBefore.includes(k));
    if (!same) {
      composeFail("SLOT_POSITION_LOCKED", `Posisi slot "${s.label}" (${s.slotKey}) dikunci templat; kembalikan ke urutan kerangka`, {
        slotKey: s.slotKey,
        expectedBefore,
        actualBefore,
      });
    }
  }
}

function chapterKeyOk(slot: TemplateSlotDef, key: string): boolean {
  return slot.sectionType === "appendix" ? LETTER_KEY_RE.test(key) : NUMERIC_KEY_RE.test(key);
}

function validateChapters(
  slot: TemplateSlotDef,
  chapters: readonly ChapterV2[],
  /** Pointer bab ke-i (larik `chapters` atau `chapter` tunggal). */
  chapterPtr: (i: number) => string,
  keysOtherSlots: ReadonlyMap<string, string>,
): void {
  const seen = new Set<string>();
  chapters.forEach((c, i) => {
    const key = c?.key;
    const ptr = `${chapterPtr(i)}/key`;
    const pattern = slot.sectionType === "appendix" ? CHAPTER_KEY_LETTER_PATTERN : CHAPTER_KEY_NUMERIC_PATTERN;
    if (typeof key !== "string" || !chapterKeyOk(slot, key)) {
      composeFail(
        "CHAPTER_KEY_INVALID",
        slot.sectionType === "appendix"
          ? `Kunci lampiran "${String(key)}" harus satu huruf A..Z`
          : `Kunci bab "${String(key)}" harus bilangan 1..999 tanpa nol di depan`,
        { slotKey: slot.slotKey, key, pattern, pointer: ptr },
      );
    }
    if (seen.has(key)) {
      composeFail("CHAPTER_KEY_INVALID", `Kunci bab "${key}" ganda di slot ${slot.label}; setiap bab berkunci unik`, {
        slotKey: slot.slotKey,
        key,
        pattern,
        pointer: ptr,
      });
    }
    seen.add(key);
    const other = keysOtherSlots.get(key);
    if (other !== undefined) {
      composeFail("CHAPTER_KEY_INVALID", `Kunci bab "${key}" sudah dipakai di slot ${other}; kunci bab unik lintas slot`, {
        slotKey: slot.slotKey,
        key,
        pattern,
        pointer: ptr,
      });
    }
  });
  if (slot.admits.length > 0) {
    const admits = new Set(slot.admits);
    chapters.forEach((c, i) => {
      const check = (blocks: unknown, ptr: string) => {
        (Array.isArray(blocks) ? blocks : []).forEach((b: { type?: unknown }, j: number) => {
          if (b && typeof b.type === "string" && !admits.has(b.type)) {
            composeFail("BLOCK_TYPE_NOT_ADMITTED", `Jenis blok "${b.type}" tidak diterima di slot ${slot.label}; pakai jenis lain`, {
              slotKey: slot.slotKey,
              pointer: `${ptr}/${j}`,
              type: b.type,
            });
          }
        });
      };
      check(c?.intro, `${chapterPtr(i)}/intro`);
      (Array.isArray(c?.sections) ? c.sections : []).forEach((s, k) => check(s?.blocks, `${chapterPtr(i)}/sections/${k}/blocks`));
    });
  }
}

function payloadType(p: unknown): string | undefined {
  return p && typeof p === "object" && typeof (p as { type?: unknown }).type === "string" ? (p as { type: string }).type : undefined;
}

/** Medan isi yang dikirim ke slot AUTO (selain `type`); MIXED toc menerima `entries`. */
function autoInputFields(slot: TemplateSlotDef, payload: Record<string, unknown>): string[] {
  const fields = Object.keys(payload).filter((k) => k !== "type");
  if (slot.contentMode === "AUTO") return fields;
  if (slot.contentMode === "MIXED" && (slot.sectionType === "toc" || slot.sectionType === "ruleIndex")) {
    return fields.filter((k) => !(slot.sectionType === "toc" && k === "entries"));
  }
  return [];
}

function checkSlotContent(
  skel: SkeletonInput,
  tier: StudioTier,
  layout: SlotLayout,
  slotKey: string,
  payload: unknown,
  via: "doc" | "slot" | "chapter",
  pointer: string,
  input: StructureInput,
): TemplateSlotDef {
  const slot = layout.byKey.get(slotKey);
  if (!slot) {
    const inactive = implicitInactiveSection(skel, slotKey);
    if (inactive) forbiddenForTierImplicit(slotKey, inactive, tier, "jangan kirim isinya");
    unknownSlot(skel, slotKey, pointer);
  }
  if (!isSlotActive(slot, tier)) {
    composeFail("SLOT_FORBIDDEN_FOR_TIER", `Slot "${slot.label}" (${slotKey}) tidak berlaku untuk dokumen ${tier}; jangan kirim isinya`, {
      slotKey,
      tier,
      activeTiers: slot.tiers,
    });
  }
  if (layout.omitted.some((s) => s.slotKey === slotKey)) {
    composeFail(
      "SLOT_UNKNOWN",
      `Slot "${slot.label}" (${slotKey}) dihapus dari dokumen lewat structure; pulihkan dulu (structure restoreSlot) atau jangan kirim isinya`,
      { slotKey, known: layout.ordered.map((s) => s.slotKey), omitted: true, pointer },
    );
  }
  const repeatable = isRepeatable(slot);
  if (via === "slot" && repeatable) {
    composeFail("SLOT_USE_CHAPTER_ENDPOINT", `Slot "${slot.label}" berisi bab; kirim per bab lewat POST /api/studio/chapters`, {
      slotKey,
      use: "POST /api/studio/chapters",
    });
  }
  if (via === "chapter" && !repeatable) {
    composeFail("SLOT_TYPE_MISMATCH", `Slot "${slot.label}" bukan slot bab; kirim isinya lewat POST /api/studio/slots`, {
      slotKey,
      expected: slot.sectionType,
      actual: "chapter",
    });
  }
  if (via !== "chapter") {
    const actual = payloadType(payload);
    if (actual !== slot.sectionType) {
      composeFail("SLOT_TYPE_MISMATCH", `Isi slot "${slot.label}" harus bertipe "${slot.sectionType}", bukan "${String(actual)}"`, {
        slotKey,
        expected: slot.sectionType,
        actual: actual ?? null,
      });
    }
    if (!repeatable && payload && typeof payload === "object") {
      const fields = autoInputFields(slot, payload as Record<string, unknown>);
      if (fields.length > 0) {
        composeFail("SLOT_INPUT_NOT_ACCEPTED", `Slot "${slot.label}" dibangkitkan otomatis; hapus medan ${listText(fields)}`, {
          slotKey,
          contentMode: slot.contentMode,
          fields,
        });
      }
    }
  }
  if (repeatable) {
    const count = input.chapterCounts?.[slotKey];
    const sent = via === "chapter" ? 1 : Array.isArray((payload as { chapters?: unknown })?.chapters) ? (payload as { chapters: unknown[] }).chapters.length : 0;
    const n = count ?? sent;
    if (slot.maxItems !== undefined && slot.maxItems !== null && n > slot.maxItems) {
      composeFail("SLOT_ITEMS_OUT_OF_RANGE", `Slot "${slot.label}" paling banyak ${slot.maxItems} bab; kini ${n}`, {
        slotKey,
        maxItems: slot.maxItems,
        count: n,
      });
    }
  }
  return slot;
}

/** Kunci bab per slot berulang lain (cek bentrok lintas slot). */
function otherSlotKeys(input: StructureInput, slotKey: string, sentBySlot: ReadonlyMap<string, readonly string[]>, labels: ReadonlyMap<string, TemplateSlotDef>): Map<string, string> {
  const out = new Map<string, string>();
  const add = (sk: string, keys: readonly string[]) => {
    if (sk === slotKey) return;
    for (const k of keys) out.set(k, labels.get(sk)?.label ?? sk);
  };
  for (const [sk, keys] of Object.entries(input.existingChapterKeys ?? {})) add(sk, keys);
  for (const [sk, keys] of sentBySlot) add(sk, keys);
  return out;
}

/**
 * Validasi struktur kiriman terhadap kerangka versi templat dokumen dan tier.
 * Melempar `StudioEngineError` 422 (`SLOT_*`, `BLOCK_TYPE_NOT_ADMITTED`,
 * `CHAPTER_KEY_INVALID`) pada galat pertama; tidak mengembalikan apa pun bila sah.
 */
export function validateStructure(skel: SkeletonInput, tier: StudioTier, input: StructureInput, opts: { checkOrder?: boolean } = {}): void {
  const pointer = input.pointer ?? "";
  if (input.structure && opts.checkOrder !== false) validateOrder(skel, tier, input.structure.order, pointer);
  const layout = slotLayout(skel, tier, input.structure);

  // Kunci bab yang dikirim per slot (untuk bentrok lintas slot dalam satu kiriman).
  const sentBySlot = new Map<string, string[]>();
  for (const [sk, p] of Object.entries(input.sections ?? {})) {
    const ch = (p as { chapters?: unknown })?.chapters;
    if (Array.isArray(ch)) sentBySlot.set(sk, ch.map((c) => String((c as { key?: unknown })?.key)));
  }

  for (const [slotKey, payload] of Object.entries(input.sections ?? {})) {
    const ptr = `${pointer}/sections/${slotKey}`;
    const slot = checkSlotContent(skel, tier, layout, slotKey, payload, "doc", ptr, input);
    if (isRepeatable(slot)) {
      const chapters = (payload as { chapters?: ChapterV2[] }).chapters ?? [];
      validateChapters(slot, chapters, (i) => `${ptr}/chapters/${i}`, otherSlotKeys(input, slotKey, sentBySlot, layout.byKey));
    }
  }

  if (input.chapter) {
    const slotKey = input.chapter.slot ?? defaultChapterSlot(layout)?.slotKey;
    if (slotKey === undefined) {
      composeFail("SLOT_TYPE_MISMATCH", "Templat dokumen tidak punya slot bab aktif; bab tidak dapat dikirim", {
        slotKey: null,
        expected: "chapter",
        actual: null,
      });
    }
    const slot = checkSlotContent(skel, tier, layout, slotKey, input.chapter.chapter, "chapter", `${pointer}/slot`, input);
    validateChapters(slot, [input.chapter.chapter], () => `${pointer}/chapter`, otherSlotKeys(input, slotKey, sentBySlot, layout.byKey));
  }

  if (input.slot) {
    checkSlotContent(skel, tier, layout, input.slot.slot, input.slot.payload, "slot", `${pointer}/slot`, input);
  }
}
