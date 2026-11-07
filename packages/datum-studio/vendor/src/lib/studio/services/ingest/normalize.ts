/**
 * Normalisasi `studio.doc/v1` -> `studio.norm/v1` (01_specs.md §3.9, §4; S48).
 *
 * Bentuk keluaran (disepakati dengan perakit S20 `engine/docx/assemble/units.ts`,
 * renderer S16 `engine/docx/blocks/structure.ts`, S22 `engine/html/blocks`;
 * siaran D-49/D-50):
 *
 * - Unit (KS-06, konvensi C14): cover `F:cover`, controlSheet `F:controlSheet`,
 *   toc `F:toc`; lalu per bagian: unit `P:n` diikuti bab yang `partId`-nya
 *   (atau `chapterKeys` bagian) menunjuk bagian itu; lalu lampiran. Kunci unit
 *   bab/lampiran = kunci bab (`3`, `A`). `setup.header/footer` absen =
 *   `{ mode: "inherit" }`.
 * - Blok struktural adalah NormBlock: `cover`/`controlSheet` (content =
 *   `FrontPage` UTUH termasuk `body[]`; body TIDAK dipecah, D-46), `toc`
 *   (`TocSpec`), `partDivider` (`PartSpec`), `chapter`/`appendix` (`Chapter`
 *   tanpa `sections`/`intro`), `section` (`Section` tanpa `blocks`),
 *   `signatureBlock` (`SignatureBlock`, alamat `F:signature`).
 * - Blok isi: content = objek blok apa adanya (A9: teks tidak diubah; kapital
 *   hanya lewat properti `caps`). Alamat `C.S.P` (seksi 0 = intro); `spacer`
 *   dan `device` beralamat null dan tidak dihitung P (KS-05).
 * - Penomoran artefak per bab/lampiran (§4.1): tabel ber-caption `Tabel C.n`,
 *   figur ber-caption `Gambar C.n`, turunan `Turunan D-C.n` (atau `id`
 *   eksplisit). Label ditulis ke `NormBlock.artifactLabel` dan `numbering`.
 * - blockId absen diisi `b_` + 16 heks sha256(`docNumber|ordinal`) (§4.2) dan
 *   ditulis balik ke salinan `snapshot.doc` (identitas stabil lintas revisi).
 *   Blok tunggal halaman depan/bagian memakai seed alamat (`docNumber|F:cover`).
 */
import {
  FIGURE_BLOCK_TYPES,
  STUDIO_MAX_BLOCKS_PER_DOC,
  TABLE_BLOCK_TYPES,
  type Chapter,
  type FlowItem,
  type NormBlock,
  type NormDocSnapshot,
  type NormUnit,
  type NormUnitKind,
  type PartSpec,
  type RegisterEntry,
  type Section,
  type SectionSetup,
  type StudioDocV1,
  type ValidationIssue,
} from "../../contract";
import { isObject, joinPointer, plainText, sha256Hex, stableStringify } from "./util";

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);
const FIGURE_TYPES: ReadonlySet<string> = new Set<string>(FIGURE_BLOCK_TYPES);
const CHAPTER_KEY_RE = /^[1-9][0-9]*$/;
const APPENDIX_KEY_RE = /^[A-Z]$/;
const DERIVATION_ID_RE = /^D-(?:[1-9][0-9]*|[A-Z])\.[1-9][0-9]*[a-z]?$/;

export interface NormalizeOptions {
  /** Nomor dokumen final (sekuens HQ, KT-05 c); default `meta.docNumber` atau "". */
  docNumber?: string;
  /** Pointer akar dokumen dalam badan permintaan (mis. "/document"). */
  pointerPrefix?: string;
}

export interface NormalizeResult {
  snapshot: NormDocSnapshot;
  /** Isu struktural (kunci bab ganda, rujukan bagian, blockId ganda, batas C12). */
  issues: ValidationIssue[];
  /** blockId -> JSON Pointer blok di badan permintaan. */
  pointers: Map<string, string>;
}

function blockIdSeed(docNumber: string, seed: string | number): string {
  return `b_${sha256Hex(`${docNumber}|${seed}`).slice(0, 16)}`;
}

function unitSetup(setup: SectionSetup | undefined): NormUnit["setup"] {
  return {
    ...(setup ?? {}),
    header: setup?.header ?? { mode: "inherit" },
    footer: setup?.footer ?? { mode: "inherit" },
  };
}

function appendixLetter(i: number): string | null {
  return i >= 0 && i < 26 ? String.fromCharCode(65 + i) : null;
}

/** blockId eksplisit pada bab, seksi, dan blok isi (aliran intro/seksi). */
function collectExplicitIds(doc: StudioDocV1): Set<string> {
  const ids = new Set<string>();
  const add = (o: unknown) => {
    if (isObject(o) && typeof o.blockId === "string" && o.blockId !== "") ids.add(o.blockId);
  };
  for (const c of [...(Array.isArray(doc.chapters) ? doc.chapters : []), ...(Array.isArray(doc.appendices) ? doc.appendices : [])]) {
    add(c);
    (Array.isArray(c?.intro) ? c.intro : []).forEach(add);
    for (const s of Array.isArray(c?.sections) ? c.sections : []) {
      add(s);
      (Array.isArray(s?.blocks) ? s.blocks : []).forEach(add);
    }
  }
  return ids;
}

/** Normalisasi lengkap dengan isu dan peta pointer (dipakai ingest). */
export function normalizeDocument(input: StudioDocV1, opts: NormalizeOptions = {}): NormalizeResult {
  // Salinan dalam: blockId ditulis balik tanpa memutasi masukan pemanggil.
  const doc = structuredClone(input);
  const prefix = opts.pointerPrefix ?? "";
  const docNumber = opts.docNumber ?? doc.meta?.docNumber ?? "";
  if (opts.docNumber) doc.meta.docNumber = opts.docNumber;

  const units: NormUnit[] = [];
  const blocks: NormBlock[] = [];
  const numbering: Record<string, string> = {};
  const issues: ValidationIssue[] = [];
  const pointers = new Map<string, string>();
  const seenIds = new Map<string, string>();
  let ordinal = 0;

  const addUnit = (kind: NormUnitKind, key: string, setup: SectionSetup | undefined) => {
    units.push({ kind, key, setup: unitSetup(setup) });
  };

  const push = (b: Omit<NormBlock, "ordinal" | "textPlain" | "contentSha256">, pointer: string) => {
    const prior = seenIds.get(b.blockId);
    if (prior !== undefined) {
      issues.push({ pointer, keyword: "uniqueBlockId", message: `blockId "${b.blockId}" ganda (pertama di ${prior})` });
    } else {
      seenIds.set(b.blockId, pointer);
    }
    pointers.set(b.blockId, pointer);
    const nb: NormBlock = {
      ...b,
      ordinal: ordinal,
      textPlain: plainText(b.content),
      contentSha256: sha256Hex(stableStringify(b.content)),
    };
    if (nb.artifactLabel === undefined) delete nb.artifactLabel;
    blocks.push(nb);
  };

  // blockId eksplisit yang sudah ada (mis. dicap revisi sebelumnya) tidak boleh
  // ditabrak seed ordinal blok sisipan: seed bertabrakan diberi akhiran.
  const explicitIds = collectExplicitIds(doc);
  /** Pastikan blockId pada objek berpemilik medan blockId; ditulis balik ke doc. */
  const ensureId = (holder: { blockId?: string }): string => {
    ordinal += 1;
    if (typeof holder.blockId !== "string" || holder.blockId === "") {
      let id = blockIdSeed(docNumber, ordinal);
      for (let k = 1; explicitIds.has(id); k++) id = blockIdSeed(docNumber, `${ordinal}|${k}`);
      explicitIds.add(id);
      holder.blockId = id;
    }
    return holder.blockId;
  };
  const singletonId = (address: string): string => {
    ordinal += 1;
    return blockIdSeed(docNumber, address);
  };

  // ── Halaman depan ──────────────────────────────────────────────────────
  const front = doc.front ?? {};
  let signaturePlaced = false;
  const placeSignature = (unitKey: string) => {
    if (!front.signature || signaturePlaced) return;
    signaturePlaced = true;
    push(
      { blockId: singletonId("F:signature"), address: "F:signature", unitKey, type: "signatureBlock", content: front.signature },
      joinPointer(prefix, "front", "signature"),
    );
  };

  if (front.cover) {
    addUnit("cover", "F:cover", front.cover.setup);
    push(
      { blockId: singletonId("F:cover"), address: "F:cover", unitKey: "F:cover", type: "cover", content: front.cover },
      joinPointer(prefix, "front", "cover"),
    );
  }
  if (front.controlSheet) {
    addUnit("controlSheet", "F:controlSheet", front.controlSheet.setup);
    push(
      {
        blockId: singletonId("F:controlSheet"),
        address: "F:controlSheet",
        unitKey: "F:controlSheet",
        type: "controlSheet",
        content: front.controlSheet,
      },
      joinPointer(prefix, "front", "controlSheet"),
    );
    placeSignature("F:controlSheet");
  } else if (front.cover) {
    placeSignature("F:cover");
  }
  if (front.toc) {
    addUnit("toc", "F:toc", front.toc.setup);
    push(
      { blockId: singletonId("F:toc"), address: "F:toc", unitKey: "F:toc", type: "toc", content: front.toc },
      joinPointer(prefix, "front", "toc"),
    );
  }

  // ── Kunci bab dan lampiran ─────────────────────────────────────────────
  const chapters = Array.isArray(doc.chapters) ? doc.chapters : [];
  const appendices = Array.isArray(doc.appendices) ? doc.appendices : [];
  const chapterKeys: string[] = [];
  const keyOwner = new Map<string, string>();
  chapters.forEach((c, i) => {
    const key = typeof c.key === "string" && c.key !== "" ? c.key : String(i + 1);
    const ptr = joinPointer(prefix, "chapters", i, "key");
    if (!CHAPTER_KEY_RE.test(key)) issues.push({ pointer: ptr, keyword: "chapterKey", message: `Kunci bab "${key}" harus bilangan bulat positif` });
    if (keyOwner.has(key)) issues.push({ pointer: ptr, keyword: "uniqueKey", message: `Kunci bab "${key}" ganda (pertama di ${keyOwner.get(key)})` });
    else keyOwner.set(key, joinPointer(prefix, "chapters", i));
    chapterKeys.push(key);
  });
  const appendixKeys: string[] = [];
  appendices.forEach((a, i) => {
    const fallback = appendixLetter(i);
    const key = typeof a.key === "string" && a.key !== "" ? a.key : (fallback ?? String(i + 1));
    const ptr = joinPointer(prefix, "appendices", i, "key");
    if (!APPENDIX_KEY_RE.test(key)) issues.push({ pointer: ptr, keyword: "appendixKey", message: `Kunci lampiran "${key}" harus satu huruf A..Z` });
    if (keyOwner.has(key)) issues.push({ pointer: ptr, keyword: "uniqueKey", message: `Kunci lampiran "${key}" ganda (pertama di ${keyOwner.get(key)})` });
    else keyOwner.set(key, joinPointer(prefix, "appendices", i));
    appendixKeys.push(key);
  });

  // ── Keanggotaan bab pada bagian (C14) ──────────────────────────────────
  const parts = Array.isArray(doc.parts) ? doc.parts : [];
  const partIndexById = new Map<string, number>();
  parts.forEach((p, i) => {
    if (partIndexById.has(p.id)) {
      issues.push({ pointer: joinPointer(prefix, "parts", i, "id"), keyword: "uniqueKey", message: `Id bagian "${p.id}" ganda` });
    } else {
      partIndexById.set(p.id, i);
    }
    (Array.isArray(p.chapterKeys) ? p.chapterKeys : []).forEach((k, j) => {
      if (!chapterKeys.includes(k)) {
        issues.push({
          pointer: joinPointer(prefix, "parts", i, "chapterKeys", j),
          keyword: "reference",
          message: `Bagian "${p.id}" merujuk bab "${k}" yang tidak ada`,
        });
      }
    });
  });
  const chapterPart: Array<number | null> = chapters.map((c, i) => {
    if (typeof c.partId === "string") {
      const idx = partIndexById.get(c.partId);
      if (idx === undefined) {
        issues.push({
          pointer: joinPointer(prefix, "chapters", i, "partId"),
          keyword: "reference",
          message: `Bab "${chapterKeys[i]}" merujuk bagian "${c.partId}" yang tidak ada`,
        });
        return null;
      }
      return idx;
    }
    const idx = parts.findIndex((p) => Array.isArray(p.chapterKeys) && p.chapterKeys.includes(chapterKeys[i]));
    return idx >= 0 ? idx : null;
  });

  // ── Aliran isi bab/lampiran ────────────────────────────────────────────
  const emitFlow = (items: FlowItem[] | undefined, chap: string, unitKey: string, sectionNo: number, basePtr: string, counters: { t: number; g: number; d: number }) => {
    let p = 0;
    (Array.isArray(items) ? items : []).forEach((item, k) => {
      const ptr = joinPointer(basePtr, k);
      if (!isObject(item)) return;
      if (item.type === "spacer" || item.type === "device") {
        ordinal += 1;
        push({ blockId: blockIdSeed(docNumber, ordinal), address: null, unitKey, type: item.type, content: item }, ptr);
        return;
      }
      p += 1;
      const id = ensureId(item as { blockId?: string });
      let label: string | undefined;
      const hasCaption = isObject((item as { caption?: unknown }).caption);
      if (TABLE_TYPES.has(item.type) && hasCaption) label = `Tabel ${chap}.${++counters.t}`;
      else if (FIGURE_TYPES.has(item.type) && hasCaption) label = `Gambar ${chap}.${++counters.g}`;
      else if (item.type === "derivation") {
        counters.d += 1;
        const explicit = (item as { id?: unknown }).id;
        label = `Turunan ${typeof explicit === "string" && DERIVATION_ID_RE.test(explicit) ? explicit : `D-${chap}.${counters.d}`}`;
      }
      if (label !== undefined) numbering[id] = label;
      push({ blockId: id, address: `${chap}.${sectionNo}.${p}`, artifactLabel: label, unitKey, type: item.type, content: item }, ptr);
    });
  };

  const emitChapter = (c: Chapter, key: string, kind: "chapter" | "appendix", ptr: string) => {
    addUnit(kind, key, c.setup);
    const id = ensureId(c);
    // Kepala saja: seksi dan blok adalah NormBlock terpisah (S16/S22).
    const head: Partial<Chapter> = { ...c };
    delete head.sections;
    delete head.intro;
    push({ blockId: id, address: key, unitKey: key, type: kind, content: head }, ptr);
    const counters = { t: 0, g: 0, d: 0 };
    emitFlow(c.intro, key, key, 0, joinPointer(ptr, "intro"), counters);
    (Array.isArray(c.sections) ? c.sections : []).forEach((s: Section, j) => {
      const sPtr = joinPointer(ptr, "sections", j);
      const sid = ensureId(s);
      const sHead: Partial<Section> = { ...s };
      delete sHead.blocks;
      push({ blockId: sid, address: `${key}.${j + 1}`, unitKey: key, type: "section", content: sHead }, sPtr);
      emitFlow(s.blocks, key, key, j + 1, joinPointer(sPtr, "blocks"), counters);
    });
  };

  const emitPart = (i: number) => {
    const part: PartSpec = parts[i];
    const key = `P:${i + 1}`;
    addUnit("part", key, part.setup);
    push({ blockId: singletonId(key), address: key, unitKey: key, type: "partDivider", content: part }, joinPointer(prefix, "parts", i));
  };

  // Bab tanpa bagian sebelum bab berbagian pertama -> di depan; sisanya sesudah bagian.
  const firstParted = chapterPart.findIndex((p) => p !== null);
  const leading: number[] = [];
  const trailing: number[] = [];
  chapters.forEach((_, i) => {
    if (chapterPart[i] !== null) return;
    if (firstParted === -1 || i < firstParted) leading.push(i);
    else trailing.push(i);
  });
  for (const i of leading) emitChapter(chapters[i], chapterKeys[i], "chapter", joinPointer(prefix, "chapters", i));
  parts.forEach((_, pi) => {
    if (partIndexById.get(parts[pi].id) !== pi) return; // id ganda: hanya yang pertama
    emitPart(pi);
    chapters.forEach((c, i) => {
      if (chapterPart[i] === pi) emitChapter(c, chapterKeys[i], "chapter", joinPointer(prefix, "chapters", i));
    });
  });
  for (const i of trailing) emitChapter(chapters[i], chapterKeys[i], "chapter", joinPointer(prefix, "chapters", i));
  appendices.forEach((a, i) => emitChapter(a, appendixKeys[i], "appendix", joinPointer(prefix, "appendices", i)));

  // Tanda tangan tanpa halaman depan: akhir unit terakhir.
  if (front.signature && !signaturePlaced && units.length > 0) placeSignature(units[units.length - 1].key);

  const contentBlocks = blocks.filter((b) => b.address !== null).length;
  if (contentBlocks > STUDIO_MAX_BLOCKS_PER_DOC) {
    issues.push({ pointer: prefix, keyword: "maxLimit", message: `Dokumen memuat ${contentBlocks} blok beralamat; maks ${STUDIO_MAX_BLOCKS_PER_DOC}` });
  }

  const register: Record<string, RegisterEntry> = isObject(doc.register) ? { ...doc.register } : {};
  const snapshot: NormDocSnapshot = { schema: "studio.norm/v1", doc, units, blocks, numbering, register };
  return { snapshot, issues, pointers };
}
