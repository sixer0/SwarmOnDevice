/**
 * Penelusur dan penyunting pohon konten `StudioDocV2Resolved` per pid (SR-14;
 * register 03_structural_sections_specs.md §10 "Sunting per pid", blueprint §2.6).
 *
 * Murni (tanpa DB). Pohon dibangun ulang dari baris revisi dasar (SR-10
 * `rebuildSource`, semua node ber-id); op dijalankan pada salinannya. Lokasi:
 * - CHAPTER  = `sections[slotKey].chapters[i]` (slot berulang `chapter`/`appendix`);
 * - SUBSECTION = `chapter.sections[i]` (sectionNo = i + 1; intro = 0 tanpa medan id);
 * - BLOCK    = `chapter.intro[j]` (sectionNo 0) atau `chapter.sections[i].blocks[j]`.
 */
import type { BlockV2, ChapterV2, SectionV2, StudioDocV2Resolved } from "../../../contract";

export interface RepeatablePayload {
  type: "chapter" | "appendix";
  chapters?: ChapterV2[];
  outline?: unknown;
  parts?: unknown;
}

export interface ChapterLoc {
  slotKey: string;
  payload: RepeatablePayload;
  index: number;
  chapter: ChapterV2;
}

export interface SectionLoc extends ChapterLoc {
  /** 1-based (intro tidak beridentitas di pohon). */
  sectionNo: number;
  sectionIndex: number;
  section: SectionV2;
}

export interface BlockLoc extends ChapterLoc {
  /** 0 = intro bab. */
  sectionNo: number;
  container: BlockV2[];
  blockIndex: number;
  block: BlockV2;
}

function isRepeatable(p: unknown): p is RepeatablePayload {
  if (!p || typeof p !== "object") return false;
  const t = (p as { type?: unknown }).type;
  return t === "chapter" || t === "appendix";
}

/** Slot berulang dokumen (urutan kunci objek `sections`). */
export function repeatableSlots(doc: StudioDocV2Resolved): Array<[string, RepeatablePayload]> {
  const out: Array<[string, RepeatablePayload]> = [];
  for (const [k, p] of Object.entries(doc.sections ?? {})) if (isRepeatable(p)) out.push([k, p]);
  return out;
}

export function* chapterLocs(doc: StudioDocV2Resolved): Generator<ChapterLoc> {
  for (const [slotKey, payload] of repeatableSlots(doc)) {
    const list = payload.chapters ?? [];
    for (let i = 0; i < list.length; i++) yield { slotKey, payload, index: i, chapter: list[i] };
  }
}

export function findChapterByKey(doc: StudioDocV2Resolved, key: string): ChapterLoc | null {
  for (const c of chapterLocs(doc)) if (c.chapter.key === key) return c;
  return null;
}

export function locateChapter(doc: StudioDocV2Resolved, pid: string): ChapterLoc | null {
  for (const c of chapterLocs(doc)) if (c.chapter.id === pid) return c;
  return null;
}

export function locateSection(doc: StudioDocV2Resolved, pid: string): SectionLoc | null {
  for (const c of chapterLocs(doc)) {
    const secs = c.chapter.sections ?? [];
    for (let i = 0; i < secs.length; i++) {
      if (secs[i].id === pid) return { ...c, sectionNo: i + 1, sectionIndex: i, section: secs[i] };
    }
  }
  return null;
}

export function locateBlock(doc: StudioDocV2Resolved, pid: string): BlockLoc | null {
  for (const c of chapterLocs(doc)) {
    const intro = c.chapter.intro ?? [];
    for (let j = 0; j < intro.length; j++) {
      if (intro[j].id === pid) return { ...c, sectionNo: 0, container: intro, blockIndex: j, block: intro[j] };
    }
    const secs = c.chapter.sections ?? [];
    for (let i = 0; i < secs.length; i++) {
      const blocks = secs[i].blocks ?? [];
      for (let j = 0; j < blocks.length; j++) {
        if (blocks[j].id === pid) return { ...c, sectionNo: i + 1, container: blocks, blockIndex: j, block: blocks[j] };
      }
    }
  }
  return null;
}

/** Larik blok untuk (bab, sectionNo); intro dibuat bila belum ada. null bila section tidak ada. */
export function blockContainer(chapter: ChapterV2, sectionNo: number, create = false): BlockV2[] | null {
  if (sectionNo === 0) {
    if (!chapter.intro) {
      if (!create) return null;
      chapter.intro = [];
    }
    return chapter.intro;
  }
  const sec = chapter.sections?.[sectionNo - 1];
  return sec ? sec.blocks : null;
}

/** Semua `id` eksplisit di dalam subpohon bab/section/blok (urutan kemunculan). */
export function collectIds(node: ChapterV2 | SectionV2 | BlockV2 | null | undefined): string[] {
  const out: string[] = [];
  if (!node || typeof node !== "object") return out;
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  push((node as { id?: unknown }).id);
  const ch = node as Partial<ChapterV2>;
  for (const b of ch.intro ?? []) push(b.id);
  const sections = (node as Partial<ChapterV2>).sections;
  if (Array.isArray(sections)) {
    for (const s of sections) {
      push(s.id);
      for (const b of s.blocks ?? []) push(b.id);
    }
  }
  const blocks = (node as Partial<SectionV2>).blocks;
  if (Array.isArray(blocks)) for (const b of blocks) push(b.id);
  return out;
}

/** Salinan dalam lewat JSON (pohon konten adalah data JSON murni). */
export function cloneTree<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
