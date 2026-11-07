/**
 * Pemetaan murni konten v2 tergabung <-> baris struktur (SR-10; register §3.1
 * invarian M14-M17, §4.6 alamat, §10 identitas, KD-09, KD-13).
 *
 * `rowsFromSource` dan `rebuildSource` adalah pasangan invers: untuk sumber
 * tergabung yang sudah berpid, `rebuildSource(envelope, rowsFromSource(...))`
 * menghasilkan JSON kanonik yang sama (dasar cek sha rekonstruksi SC-5).
 *
 * Kontrak bentuk yang dijaga pasangan ini (penting untuk compose SR-08):
 * - slot ada di `source.sections` <=> baris M14 ber-`payload` tidak null
 *   (slot berulang: `{outline?, parts?}`, boleh `{}`), atau slot berulang ber-bab;
 * - `chapters` slot berulang ditulis hanya bila >= 1 bab;
 * - `intro` bab ditulis <=> ada baris M16 `sectionNo = 0` (boleh tanpa blok);
 * - medan pid `id` hanya di bab, section, dan blok tingkat atas. `id` lain
 *   (simpul diagram, entri register sumber, `PartV2.id`) adalah DATA dan tidak
 *   pernah dibuang.
 */
import {
  TABLE_BLOCK_TYPES,
  type BlockV2,
  type ChapterV2,
  type InlineV2,
  type NormBlockV2,
  type PidAllocator,
  type SectionV2,
  type StudioDocV2Resolved,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import type { ContractRecordPayloadV2 } from "../../contract/types/v2/contract";
import { CONTRACT_RECORD_SECTION_TYPE } from "../../registry/contracts";
import { isSlotPayloadFilled } from "../completeness";
import { contractItemTextPlain, contractRecordTextPlain } from "../contracts/text";
import { plainText } from "../ingest/util";
import { sha256Hex, stableStringify } from "../revisions/canonical";
import { chapterPidBase, isValidPid } from "./pid";
import {
  isRepeatableSectionType,
  StructureRowsInvalidError,
  type FillStamp,
  type SlotRowSpec,
  type StructureBlockInternal,
  type StructureBlockRow,
  type StructureChapterRow,
  type StructureRows,
  type StructureSubsectionRow,
} from "./types";

const ASSET_REF_RE = /^sha256:([0-9a-f]{64})$/;
const TABLE_TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);
const FIGURE_TYPES: ReadonlySet<string> = new Set(["chart", "diagram", "image", "symbolSheet"]);

/** Envelope sumber = semua medan `StudioDocV2Resolved` kecuali `sections`. */
export type SourceEnvelope = Omit<StudioDocV2Resolved, "sections">;

type SectionsMap = NonNullable<StudioDocV2Resolved["sections"]>;
type RepeatablePayload = { type: string; outline?: unknown; parts?: unknown; chapters?: ChapterV2[] };

const EMPTY_STAMP: FillStamp = { lastFilledBy: null, lastFilledAt: null, lastFilledRevisionNo: null };

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// Pembuangan pid dan sha lingkup (KD-13)
// ---------------------------------------------------------------------------

/** Blok tanpa medan pid `id` tingkat atas (isi lain apa adanya). */
export function stripBlockId<T extends object>(block: T): Omit<T, "id"> {
  const rest = { ...(block as Record<string, unknown>) };
  delete rest.id;
  return rest as Omit<T, "id">;
}

export function stripSectionIds(s: SectionV2): Omit<SectionV2, "id"> {
  return { title: s.title, blocks: (s.blocks ?? []).map((b) => stripBlockId(b) as BlockV2) };
}

export function stripChapterIds(c: ChapterV2): Omit<ChapterV2, "id"> {
  const rest = { ...(c as unknown as Record<string, unknown>) };
  delete rest.id;
  const out = rest as unknown as Omit<ChapterV2, "id">;
  if (c.intro) out.intro = c.intro.map((b) => stripBlockId(b) as BlockV2);
  out.sections = (c.sections ?? []).map((s) => stripSectionIds(s) as SectionV2);
  return out;
}

/** sha256 heks JSON kanonik (nilai yang sudah tanpa pid). */
export function canonicalSha(v: unknown): string {
  return sha256Hex(stableStringify(v ?? null));
}

export function chapterSha256(c: ChapterV2): string {
  return canonicalSha(stripChapterIds(c));
}

export function sectionSha256(s: SectionV2): string {
  return canonicalSha(stripSectionIds(s));
}

/** sha intro bab = sha daftar blok intro tanpa pid. */
export function introSha256(blocks: readonly BlockV2[]): string {
  return canonicalSha(blocks.map((b) => stripBlockId(b)));
}

// ---------------------------------------------------------------------------
// Penetapan pid yang belum ada (pembantu; pencocokan pewarisan milik submit)
// ---------------------------------------------------------------------------

/**
 * Isi `id` yang absen pada bab/section/blok semua slot berulang (mutasi di
 * tempat) dengan allocator. Pid yang sudah ada dipesan lebih dulu (bila
 * allocator mendukung `reserve`).
 */
export function assignMissingPids(
  sections: SectionsMap | undefined,
  slotTypes: ReadonlyMap<string, string>,
  allocator: PidAllocator & { reserve?: (pid: string) => void },
): void {
  if (!sections) return;
  const repeatables: Array<[string, RepeatablePayload]> = [];
  for (const [slotKey, payload] of Object.entries(sections)) {
    const st = slotTypes.get(slotKey) ?? (payload as { type?: string }).type ?? "";
    if (isRepeatableSectionType(st)) repeatables.push([st, payload as unknown as RepeatablePayload]);
  }
  for (const [, p] of repeatables) {
    for (const c of p.chapters ?? []) {
      if (c.id) allocator.reserve?.(c.id);
      for (const b of c.intro ?? []) if (b.id) allocator.reserve?.(b.id);
      for (const s of c.sections ?? []) {
        if (s.id) allocator.reserve?.(s.id);
        for (const b of s.blocks ?? []) if (b.id) allocator.reserve?.(b.id);
      }
    }
  }
  for (const [st, p] of repeatables) {
    for (const c of p.chapters ?? []) {
      if (!c.id) c.id = allocator.next("CHAPTER", chapterPidBase(st, c.key));
      for (const b of c.intro ?? []) if (!b.id) b.id = allocator.next("BLOCK", "");
      for (const s of c.sections ?? []) {
        if (!s.id) s.id = allocator.next("SUBSECTION", "");
        for (const b of s.blocks ?? []) if (!b.id) b.id = allocator.next("BLOCK", "");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sumber -> baris
// ---------------------------------------------------------------------------

export interface RowsFromSourceInput {
  source: StudioDocV2Resolved;
  /** Slot aktif yang tidak di-OMIT, dengan posisi dokumen (setiap slot mendapat baris M14, D-153). */
  slots: readonly SlotRowSpec[];
  /** Untuk pid baris slot tak-berulang yang tidak diwarisi dari `prev`. */
  allocator: PidAllocator;
  /** Baris revisi sebelumnya: pewarisan pid baris slot per alamat. */
  prev?: StructureRows;
  /** pid -> label artefak dari snapshot compose (diutamakan atas hitungan lokal). */
  numbering?: Readonly<Record<string, string>>;
  /** Isi internal per pid untuk M06 (mis. `snapshot.blocks`). */
  internal?: readonly NormBlockV2[] | ReadonlyMap<string, StructureBlockInternal>;
}

function internalMap(src: RowsFromSourceInput["internal"]): ReadonlyMap<string, StructureBlockInternal> {
  if (!src) return new Map();
  if (src instanceof Map) return src;
  const m = new Map<string, StructureBlockInternal>();
  for (const b of src as readonly NormBlockV2[]) {
    m.set(b.pid ?? b.blockId, { content: b.content, contentSha256: b.contentSha256, textPlain: b.textPlain, type: b.type });
  }
  return m;
}

function assetShaOf(block: Record<string, unknown>, source: StudioDocV2Resolved): string | null {
  if (block.type !== "image" || typeof block.asset !== "string") return null;
  const direct = ASSET_REF_RE.exec(block.asset);
  if (direct) return direct[1];
  const ref = source.assets?.[block.asset]?.assetRef;
  const m = typeof ref === "string" ? ASSET_REF_RE.exec(ref) : null;
  if (m) return m[1];
  throw new StudioEngineError("ASSET_NOT_FOUND", `Aset "${block.asset}" tidak dikenal; kirim di "assets" atau unggah lebih dulu`, {
    asset: block.asset,
  });
}

// ---------------------------------------------------------------------------
// Slot contractRecord (DC-09; register 05 §5.7, KD-34)
// ---------------------------------------------------------------------------

const CONTRACT_RECORD_TYPE: string = CONTRACT_RECORD_SECTION_TYPE;
/** `type` baris M17 butir kontrak `F:<slot>/<n>` (register 05 §5.7). */
export const CONTRACT_ITEM_ROW_TYPE = "contractItem";
const CONTRACT_ITEM_TYPE = CONTRACT_ITEM_ROW_TYPE;

/**
 * Teks polos baris kontrak = I57/I58. Payload yang belum lolos I54 (mis. `reportedAt`
 * tak sah pada jalur yang memanggil sebelum validasi) jatuh ke `plainText` agar
 * pemetaan baris tetap total; gerbang validasi yang menolak payload itu.
 */
function contractTextPlain(project: () => string, raw: unknown): string {
  try {
    return project();
  } catch {
    return plainText(raw);
  }
}

/**
 * Pid butir yang diwarisi per `key` dari baris `contractItem` revisi sebelumnya pada
 * slot yang sama (KD-34). `null` = butir baru. `key` ganda (ditolak I54/EC27) hanya
 * mewarisi sekali, pada kemunculan pertama.
 */
export function inheritItemPids(
  items: ReadonlyArray<{ key?: unknown } | null | undefined>,
  prev: StructureRows | undefined,
  slotKey: string,
): Array<string | null> {
  const byKey = new Map<string, string>();
  for (const b of prev?.blocks ?? []) {
    if (b.chapterKey !== null || b.slotKey !== slotKey || b.type !== CONTRACT_ITEM_TYPE) continue;
    const key = isObj(b.content) ? b.content.key : undefined;
    if (typeof key === "string" && !byKey.has(key)) byKey.set(key, b.pid);
  }
  return items.map((it) => {
    const key = it?.key;
    if (typeof key !== "string") return null;
    const pid = byKey.get(key);
    if (pid === undefined) return null;
    byKey.delete(key);
    return pid;
  });
}

/**
 * Pid butir baru dari allocator (petunjuk = alamat). Pembangkit deterministik
 * berbasis alamat (`slot-<slot>-<n>`, compose tanpa allocator DB) dapat memberi pid
 * yang sudah dipakai butir warisan; saat itu dicoba petunjuk kosong (pid berbenih).
 */
function freshItemPid(allocator: PidAllocator, address: string, taken: ReadonlySet<string>): string {
  let pid = allocator.next("BLOCK", address);
  for (let attempt = 0; taken.has(pid) && attempt < 8; attempt++) pid = allocator.next("BLOCK", "");
  if (taken.has(pid)) throw new StructureRowsInvalidError([`pid allocator returned taken pid ${pid} at ${address}`]);
  return pid;
}

/**
 * Baris M14-M17 untuk satu revisi dari sumber tergabung berpid. Cap pengisi
 * diisi null; pakai `carryFillStamps` untuk mewarisi/menetapkannya.
 */
export function rowsFromSource(input: RowsFromSourceInput): StructureRows {
  const { source, allocator, prev, numbering } = input;
  const internal = internalMap(input.internal);
  const sections = (source.sections ?? {}) as Record<string, unknown>;
  const slots = [...input.slots].sort((a, b) => a.position - b.position);
  const known = new Set(slots.map((s) => s.slotKey));
  for (const k of Object.keys(sections)) {
    if (!known.has(k)) throw new StudioEngineError("SLOT_UNKNOWN", `Slot "${k}" tidak aktif di kerangka dokumen`, { slotKey: k });
  }
  const prevSlotPid = new Map<string, string>();
  for (const b of prev?.blocks ?? []) if (b.chapterKey === null) prevSlotPid.set(b.address, b.pid);

  const out: StructureRows = { sections: [], chapters: [], subsections: [], blocks: [] };
  let ordinal = 0;
  const slotRowPid = (address: string): string => prevSlotPid.get(address) ?? allocator.next("BLOCK", address);
  const requirePid = (pid: string | undefined, where: string): string => {
    if (!pid || !isValidPid(pid)) throw new StructureRowsInvalidError([`pid missing/invalid at ${where} (source not resolved)`]);
    return pid;
  };

  for (const slot of slots) {
    const raw = sections[slot.slotKey];
    if (isRepeatableSectionType(slot.sectionTypeKey)) {
      const p = (raw ?? null) as RepeatablePayload | null;
      const meta = p ? (jsonClone({ outline: p.outline, parts: p.parts }) as Record<string, unknown>) : null;
      const chapters = p?.chapters ?? [];
      out.sections.push({
        ...EMPTY_STAMP,
        slotKey: slot.slotKey,
        sectionTypeKey: slot.sectionTypeKey,
        templateSlotId: slot.templateSlotId,
        position: slot.position,
        filled: chapters.length > 0,
        payload: meta,
        payloadSha256: canonicalSha(meta),
      });
      chapters.forEach((c, ci) => {
        const chapterPid = requirePid(c.id, `${slot.slotKey}/chapter ${c.key}`);
        out.chapters.push({
          ...EMPTY_STAMP,
          slotKey: slot.slotKey,
          chapterKey: c.key,
          pid: chapterPid,
          position: ci + 1,
          partKey: c.partId ?? null,
          title: jsonClone(c.title),
          shortTitle: c.shortTitle ?? null,
          contentSha256: chapterSha256(c),
        });
        const counters = { tabel: 0, gambar: 0, turunan: 0 };
        const label = (b: BlockV2, pid: string): string | null => {
          if (numbering?.[pid]) return numbering[pid];
          if (TABLE_TYPES.has(b.type) && (b as { caption?: unknown }).caption) return `Tabel ${c.key}.${++counters.tabel}`;
          if (FIGURE_TYPES.has(b.type)) return `Gambar ${c.key}.${++counters.gambar}`;
          if (b.type === "derivation") return `Turunan D-${c.key}.${++counters.turunan}`;
          return null;
        };
        const pushBlocks = (blocks: readonly BlockV2[], sectionNo: number) => {
          blocks.forEach((b, bi) => {
            const pid = requirePid(b.id, `${c.key}.${sectionNo}.${bi + 1}`);
            const content = jsonClone(stripBlockId(b));
            const inn = internal.get(pid);
            out.blocks.push({
              slotKey: slot.slotKey,
              chapterKey: c.key,
              sectionNo,
              pid,
              address: `${c.key}.${sectionNo}.${bi + 1}`,
              artifactLabel: label(b, pid),
              ordinal: ++ordinal,
              paraNo: bi + 1,
              type: b.type,
              content,
              textPlain: plainText(content),
              contentSha256: canonicalSha(content),
              assetSha256: assetShaOf(content as Record<string, unknown>, source),
              ...(inn ? { internal: inn } : {}),
            });
          });
        };
        if (c.intro !== undefined) {
          // Intro tidak membawa pid di kontrak; identitas M16-nya dibangkitkan dan
          // diwarisi dari revisi sebelumnya bila bab yang sama punya intro.
          const prevIntro = prev?.subsections.find((s) => s.chapterKey === c.key && s.sectionNo === 0);
          out.subsections.push({
            chapterKey: c.key,
            pid: prevIntro?.pid ?? allocator.next("SUBSECTION", ""),
            sectionNo: 0,
            title: null,
            contentSha256: introSha256(c.intro),
          });
          pushBlocks(c.intro, 0);
        }
        c.sections.forEach((s, si) => {
          out.subsections.push({
            chapterKey: c.key,
            pid: requirePid(s.id, `${c.key}.${si + 1}`),
            sectionNo: si + 1,
            title: jsonClone(s.title),
            contentSha256: sectionSha256(s),
          });
          pushBlocks(s.blocks ?? [], si + 1);
        });
      });
      continue;
    }

    // Slot tak-berulang (KD-09): payload di M14, baris M17 untuk alamat F:.
    const payload = raw === undefined ? null : jsonClone(raw);
    // Aturan `M14.filled` satu sumber dengan kelengkapan (SR-55 M6, FIX-Y).
    const filled = isSlotPayloadFilled(payload);
    out.sections.push({
      ...EMPTY_STAMP,
      slotKey: slot.slotKey,
      sectionTypeKey: slot.sectionTypeKey,
      templateSlotId: slot.templateSlotId,
      position: slot.position,
      filled,
      payload,
      payloadSha256: canonicalSha(payload),
    });
    if (!filled) continue;
    const pushSlotRow = (address: string, type: string, content: unknown, pidOverride?: string): StructureBlockRow => {
      const pid = pidOverride ?? slotRowPid(address);
      const inn = internal.get(pid);
      const row: StructureBlockRow = {
        slotKey: slot.slotKey,
        chapterKey: null,
        sectionNo: null,
        pid,
        address,
        artifactLabel: null,
        ordinal: ++ordinal,
        paraNo: null,
        type,
        content,
        textPlain: plainText(content),
        contentSha256: canonicalSha(content),
        assetSha256: null,
        ...(inn ? { internal: inn } : {}),
      };
      out.blocks.push(row);
      return row;
    };
    const entries = (payload as { entries?: unknown }).entries;
    if (slot.sectionTypeKey === "sourceRegister" && Array.isArray(entries)) {
      entries.forEach((e, i) => pushSlotRow(`F:${slot.slotKey}/${i + 1}`, "sourceRegisterEntry", e));
    } else if (slot.sectionTypeKey === CONTRACT_RECORD_TYPE) {
      // DC-09 (register 05 §5.7, KD-34): `F:<slot>` contractRecord + satu baris contractItem per butir.
      // Pid butir mengikuti `key` lintas revisi, bukan posisi; butir yang hilang dipensiunkan repositori.
      const p = payload as ContractRecordPayloadV2;
      const rec = pushSlotRow(`F:${slot.slotKey}`, CONTRACT_RECORD_TYPE, payload);
      rec.textPlain = contractTextPlain(() => contractRecordTextPlain(p), payload);
      const items = Array.isArray(p.items) ? p.items : [];
      const inherited = inheritItemPids(items, prev, slot.slotKey);
      const taken = new Set<string>([...inherited.filter((x): x is string => x !== null), ...out.blocks.map((b) => b.pid)]);
      items.forEach((it, i) => {
        const address = `F:${slot.slotKey}/${i + 1}`;
        const pid = inherited[i] ?? freshItemPid(allocator, address, taken);
        taken.add(pid);
        const row = pushSlotRow(address, CONTRACT_ITEM_TYPE, jsonClone(it), pid);
        row.textPlain = contractTextPlain(() => contractItemTextPlain(it), it);
      });
    } else {
      pushSlotRow(`F:${slot.slotKey}`, slot.sectionTypeKey, payload);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baris -> sumber
// ---------------------------------------------------------------------------

export interface RebuildSourceOptions {
  /** Dokumen tanpa slot berisi: `omit` (bawaan) membuang `sections`, `object` menulis `{}`. */
  emptySections?: "omit" | "object";
}

/** Bangun ulang `sections` v2 berpid dari baris (urut posisi/nomor/ordinal). */
export function rebuildSections(rows: StructureRows): SectionsMap {
  const sections: Record<string, unknown> = {};
  const chaptersBySlot = new Map<string, StructureChapterRow[]>();
  for (const c of rows.chapters) {
    const list = chaptersBySlot.get(c.slotKey) ?? [];
    list.push(c);
    chaptersBySlot.set(c.slotKey, list);
  }
  const subsByChapter = new Map<string, StructureSubsectionRow[]>();
  for (const s of rows.subsections) {
    const list = subsByChapter.get(s.chapterKey) ?? [];
    list.push(s);
    subsByChapter.set(s.chapterKey, list);
  }
  const blocksBySub = new Map<string, StructureBlockRow[]>();
  for (const b of rows.blocks) {
    if (b.chapterKey === null || b.sectionNo === null) continue;
    const k = `${b.chapterKey}\u0000${b.sectionNo}`;
    const list = blocksBySub.get(k) ?? [];
    list.push(b);
    blocksBySub.set(k, list);
  }
  const blocksOf = (chapterKey: string, sectionNo: number): BlockV2[] =>
    (blocksBySub.get(`${chapterKey}\u0000${sectionNo}`) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((b) => ({ ...(jsonClone(b.content) as object), id: b.pid }) as BlockV2);

  for (const sec of [...rows.sections].sort((a, b) => a.position - b.position)) {
    if (!isRepeatableSectionType(sec.sectionTypeKey)) {
      if (sec.payload !== null && sec.payload !== undefined) sections[sec.slotKey] = jsonClone(sec.payload);
      continue;
    }
    const chapters = (chaptersBySlot.get(sec.slotKey) ?? []).sort((a, b) => a.position - b.position);
    const hasMeta = sec.payload !== null && sec.payload !== undefined;
    if (!hasMeta && chapters.length === 0) continue;
    const obj: Record<string, unknown> = { ...(hasMeta ? (jsonClone(sec.payload) as object) : {}), type: sec.sectionTypeKey };
    if (chapters.length > 0) {
      obj.chapters = chapters.map((c): ChapterV2 => {
        const subs = (subsByChapter.get(c.chapterKey) ?? []).sort((a, b) => a.sectionNo - b.sectionNo);
        const ch: ChapterV2 = { key: c.chapterKey, id: c.pid, title: jsonClone(c.title) as InlineV2, sections: [] };
        if (c.shortTitle !== null) ch.shortTitle = c.shortTitle;
        if (c.partKey !== null) ch.partId = c.partKey;
        for (const s of subs) {
          if (s.sectionNo === 0) ch.intro = blocksOf(c.chapterKey, 0);
          else ch.sections.push({ id: s.pid, title: jsonClone(s.title) as InlineV2, blocks: blocksOf(c.chapterKey, s.sectionNo) });
        }
        return ch;
      });
    }
    sections[sec.slotKey] = obj;
  }
  return sections as SectionsMap;
}

/** Sumber tergabung = envelope + `sections` hasil bangun ulang. */
export function rebuildSource(envelope: SourceEnvelope, rows: StructureRows, opts: RebuildSourceOptions = {}): StudioDocV2Resolved {
  const base = jsonClone(envelope) as StudioDocV2Resolved;
  delete (base as { sections?: unknown }).sections;
  const sections = rebuildSections(rows);
  if (Object.keys(sections).length > 0 || opts.emptySections === "object") base.sections = sections;
  return base;
}

// ---------------------------------------------------------------------------
// Cap pengisi, isi internal, validasi, sha struktur
// ---------------------------------------------------------------------------

/**
 * Tetapkan cap pengisi: slot/bab yang berubah mendapat `stamp`; sisanya
 * mewarisi cap dari `prev` (kunci sama). Slot berulang ikut dicap bila salah
 * satu babnya berubah. Mengembalikan salinan baru.
 */
export function carryFillStamps(
  next: StructureRows,
  prev: StructureRows | null | undefined,
  changed: { slots?: Iterable<string>; chapters?: Iterable<string> },
  stamp: FillStamp,
): StructureRows {
  const changedSlots = new Set(changed.slots ?? []);
  const changedChapters = new Set(changed.chapters ?? []);
  for (const c of next.chapters) if (changedChapters.has(c.chapterKey)) changedSlots.add(c.slotKey);
  const prevSec = new Map((prev?.sections ?? []).map((s) => [s.slotKey, s]));
  const prevCh = new Map((prev?.chapters ?? []).map((c) => [c.chapterKey, c]));
  const pick = (p: FillStamp | undefined): FillStamp =>
    p ? { lastFilledBy: p.lastFilledBy, lastFilledAt: p.lastFilledAt, lastFilledRevisionNo: p.lastFilledRevisionNo } : { ...EMPTY_STAMP };
  return {
    sections: next.sections.map((s) => ({ ...s, ...(changedSlots.has(s.slotKey) ? stamp : pick(prevSec.get(s.slotKey))) })),
    chapters: next.chapters.map((c) => ({ ...c, ...(changedChapters.has(c.chapterKey) ? stamp : pick(prevCh.get(c.chapterKey))) })),
    subsections: next.subsections.map((s) => ({ ...s })),
    blocks: next.blocks.map((b) => ({ ...b })),
  };
}

/** Lekatkan isi internal (M06) dari `snapshot.blocks` per pid. */
export function attachInternal(rows: StructureRows, blocks: readonly NormBlockV2[]): StructureRows {
  const m = internalMap(blocks);
  return { ...rows, blocks: rows.blocks.map((b) => (m.has(b.pid) ? { ...b, internal: m.get(b.pid) } : b)) };
}

/** Invarian baris sebelum tulis (unik, rujukan induk, pola pid). Daftar kosong = sah. */
export function validateRows(rows: StructureRows): string[] {
  const issues: string[] = [];
  const dup = <T>(items: readonly T[], key: (t: T) => string, what: string) => {
    const seen = new Set<string>();
    for (const it of items) {
      const k = key(it);
      if (seen.has(k)) issues.push(`duplicate ${what}: ${k}`);
      seen.add(k);
    }
  };
  dup(rows.sections, (s) => s.slotKey, "section slotKey");
  dup(rows.sections, (s) => String(s.position), "section position");
  dup(rows.chapters, (c) => c.chapterKey, "chapterKey");
  dup(rows.chapters, (c) => `${c.slotKey}#${c.position}`, "chapter position");
  dup(rows.subsections, (s) => `${s.chapterKey}.${s.sectionNo}`, "subsection");
  dup(rows.blocks, (b) => String(b.ordinal), "block ordinal");
  dup(rows.blocks, (b) => b.address, "block address");
  dup([...rows.chapters, ...rows.subsections, ...rows.blocks], (r) => r.pid, "pid");
  const secByKey = new Map(rows.sections.map((s) => [s.slotKey, s]));
  const chapterKeys = new Set(rows.chapters.map((c) => c.chapterKey));
  const subKeys = new Set(rows.subsections.map((s) => `${s.chapterKey}\u0000${s.sectionNo}`));
  for (const c of rows.chapters) {
    const sec = secByKey.get(c.slotKey);
    if (!sec) issues.push(`chapter ${c.chapterKey}: unknown slot ${c.slotKey}`);
    else if (!isRepeatableSectionType(sec.sectionTypeKey)) issues.push(`chapter ${c.chapterKey}: slot ${c.slotKey} not repeatable`);
  }
  for (const s of rows.subsections) if (!chapterKeys.has(s.chapterKey)) issues.push(`subsection ${s.chapterKey}.${s.sectionNo}: unknown chapter`);
  for (const b of rows.blocks) {
    if (!secByKey.has(b.slotKey)) issues.push(`block ${b.address}: unknown slot ${b.slotKey}`);
    if ((b.chapterKey === null) !== (b.sectionNo === null)) issues.push(`block ${b.address}: chapterKey/sectionNo mismatch`);
    if (b.chapterKey !== null && b.sectionNo !== null && !subKeys.has(`${b.chapterKey}\u0000${b.sectionNo}`)) {
      issues.push(`block ${b.address}: unknown subsection ${b.chapterKey}.${b.sectionNo}`);
    }
  }
  for (const r of [...rows.chapters, ...rows.subsections, ...rows.blocks]) {
    if (!isValidPid(r.pid)) issues.push(`invalid pid: ${r.pid}`);
  }
  return issues;
}

/**
 * `structureSha256` (register §4.6): kerangka + urutan/omit slot + outline slot berulang.
 * `slots` = slot kerangka (NormSlotV2) dalam urutan kerangka.
 */
export function computeStructureSha256(
  skeleton: { skeletonSha256: string; slots: ReadonlyArray<{ slotKey: string; position: number; omitted: boolean }> },
  rows: StructureRows,
): string {
  const outlines: Record<string, unknown> = {};
  for (const s of rows.sections) {
    if (!isRepeatableSectionType(s.sectionTypeKey)) continue;
    const o = isObj(s.payload) ? s.payload.outline : undefined;
    outlines[s.slotKey] = o ?? null;
  }
  return canonicalSha({
    skeletonSha256: skeleton.skeletonSha256,
    slots: skeleton.slots.map((s) => ({ slotKey: s.slotKey, position: s.position, omitted: s.omitted })),
    outlines,
  });
}

