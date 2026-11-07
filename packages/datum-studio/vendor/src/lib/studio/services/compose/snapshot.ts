/**
 * Snapshot `studio.norm/v2` + baris struktur M14-M17 dari konten v2 tergabung
 * (SR-08, I45 `composeV2`; register §4.6, §8.1, §10; blueprint §2.6 butir 5, §2.9).
 *
 * Konvensi unit/blok mengikuti normalisasi v1 (`services/ingest/normalize.ts`)
 * agar perakit DOCX/HTML tidak berubah: unit halaman depan `F:<slotKey>`, unit
 * bagian `P:<n>`, unit bab/lampiran = kunci bab; blok struktural `cover`,
 * `controlSheet`, `toc`, `signatureBlock`, `partDivider`, `chapter`/`appendix`
 * (kepala), `section` (kepala). Tambahan v2: unit `slot` (register sumber,
 * indeks aturan, tanda tangan berdiri sendiri, placeholder draf), blok
 * `sourceRegisterEntry` per entri (`F:<slotKey>/<n>`), `ruleIndex`, `slotPlaceholder`.
 *
 * Alamat: bab `C`, section `C.S`, blok `C.S.P` (intro S = 0). Penomoran artefak
 * PER KUNCI BAB (Tabel C.n, Gambar C.n, Turunan D-C.n): bab tak berurutan tidak
 * saling menggeser; urutan unit = urutan slot, lalu kunci (numerik / huruf).
 *
 * Deterministik: tanpa cap waktu; `snapshotSha256` = sha256(stableStringify(snapshot)).
 */
import {
  ASSET_REF_PATTERN,
  FIGURE_BLOCK_TYPES,
  STUDIO_MAX_BLOCKS_PER_DOC,
  TABLE_BLOCK_TYPES,
  type AppendixSlotPayloadV2,
  type AssetRef,
  type Block,
  type BlockV2,
  type Chapter,
  type ChapterV2,
  type ContentSlotPayloadV2,
  type ContractRecordPayloadV2,
  type ControlSheetPayloadV2,
  type CoverPayloadV2,
  type FlowItem,
  type NormBlockV2,
  type StudioDocV2Resolved,
  type NormSkeletonV2,
  type NormSlotV2,
  type NormUnitKind,
  type NormUnitV2,
  type ParamMap,
  type PartSpec,
  type PartV2,
  type RegisterEntry,
  type SectionSetup,
  type SignaturePayloadV2,
  type SourceRegisterPayloadV2,
  type StudioDocV1,
  type StudioSlotState,
  type TemplateSlotDef,
  type TocPayloadV2,
} from "../../contract";
import { compareChapterKeys, expectedChapterKeys as expectedChapterKeysOf, slotStateOf } from "../completeness";
import { plainText } from "../ingest/util";
import { mapBlock, type BlockCtx } from "./blocks";
import { composeContextOf, type ComposedSnapshotV2 } from "./context";
import { projectContractRecord, resolveContractKind } from "./contract-record";
import { composeFail } from "./errors";
import { coverFront, controlSheetFront, signatureBlock, tocSpec } from "./front";
import { sha256Hex, stableStringify } from "./hash";
import { glyphSet, mapInline, type InlineCtx } from "./inline";
import { attachInternal, computeStructureSha256, rowsFromSource } from "../structure/rows";
import type { SlotRowSpec, StructureRows } from "../structure/types";
import { partPid, seededPidAllocator, slotPid } from "./pids";
import { isRepeatable, slotLayout } from "./structure";
import type { ComposeInput, ComposeResult, ComposeWarning } from "./types";

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);
const FIGURE_TYPES: ReadonlySet<string> = new Set<string>(FIGURE_BLOCK_TYPES);
const ASSET_REF_RE = new RegExp(ASSET_REF_PATTERN);

// SR-55 M6 (FIX-V): urutan kunci bab, kunci bab yang diharapkan (§8.2), dan state slot E29
// (§8.1) SATU SUMBER di layanan kelengkapan murni; compose hanya mengadaptasi bentuk masukan.
export { compareChapterKeys } from "../completeness";

/** Bab yang diharapkan (§8.2) untuk slot kerangka: delegasi `completeness.expectedChapterKeys`. */
export function expectedChapterKeys(slot: Pick<TemplateSlotDef, "sectionType">, outline: readonly { key: string }[] | undefined, presentKeys: readonly string[]): { expected: string[]; source: "outline" | "contiguous" } {
  return expectedChapterKeysOf(slot.sectionType, outline, presentKeys);
}

/**
 * State slot §8.1 dari slot kerangka + payload sumber (tanpa penulis/waktu): delegasi
 * `completeness.slotStateOf` (tabel §8.1, urutan dan kunci bab yang diharapkan satu sumber).
 *
 * `filled` slot berulang = ada bab (sama dengan `M14.filled`). `filled` slot tak-berulang =
 * payload ada (bukan `isSlotPayloadFilled`/`M14.filled`): snapshot tersimpan memakai aturan
 * ini dan `snapshotSha256` revisi lama harus tetap terekonstruksi (D-258). Beda hanya untuk
 * payload berisi `type` saja (mis. `{ type: "toc" }`: snapshot FILLED, laporan AUTO_READY);
 * penyeragaman menunggu keputusan perbaikan data revisi lama (FIX-V, needs-review).
 */
export function slotState(slot: TemplateSlotDef, payload: unknown, omitted: boolean, contractKind?: string): StudioSlotState {
  if (omitted) return "OMITTED";
  const repeatable = isRepeatable(slot);
  const p = repeatable ? (payload as ContentSlotPayloadV2 | AppendixSlotPayloadV2 | undefined) : undefined;
  const chapterKeys = (p?.chapters ?? []).map((c) => c.key);
  return slotStateOf({
    sectionType: slot.sectionType,
    required: slot.required,
    repeatable,
    contentMode: slot.contentMode,
    minItems: slot.minItems ?? null,
    omitted: false,
    filled: repeatable ? chapterKeys.length > 0 : payload !== undefined && payload !== null,
    ...(p?.outline !== undefined ? { outline: p.outline } : {}),
    chapterKeys,
    // DC-WIRE (D-386, 05 §6.5): absen = non-kontrak (state, dan snapshotSha256, tidak berubah).
    ...(contractKind ? { slotKey: slot.slotKey, contractKind } : {}),
  });
}

function unitSetup(v: unknown): NormUnitV2["setup"] {
  const s = v && typeof v === "object" && !Array.isArray(v) ? ({ ...(v as Record<string, unknown>) } as SectionSetup & Record<string, unknown>) : ({} as SectionSetup);
  // Kenop slot `startOnNewPage`/`runningHead` (SlotSetup, D-165) dibaca perakit dari
  // `RenderContext.slots`; `pageSizeTw` bukan milik slot (KD-25).
  const rec = s as Record<string, unknown>;
  delete rec.startOnNewPage;
  delete rec.runningHead;
  delete rec.pageSizeTw;
  return { ...s, header: s.header ?? { mode: "inherit" }, footer: s.footer ?? { mode: "inherit" } };
}

interface Emit {
  units: NormUnitV2[];
  blocks: NormBlockV2[];
  numbering: Record<string, string>;
  warnings: ComposeWarning[];
  ordinal: number;
  pids: Map<string, string>;
}

/** Semua pid bab/section/blok sumber (dipesan agar pid bangkitan tidak bentrok). */
function collectSourcePids(src: StudioDocV2Resolved): string[] {
  const out: string[] = [];
  for (const payload of Object.values(src.sections ?? {})) {
    for (const c of (payload as { chapters?: ChapterV2[] }).chapters ?? []) {
      if (c.id) out.push(c.id);
      for (const b of c.intro ?? []) if (b.id) out.push(b.id);
      for (const sec of c.sections ?? []) {
        if (sec.id) out.push(sec.id);
        for (const b of sec.blocks ?? []) if (b.id) out.push(b.id);
      }
    }
  }
  return out;
}

/** `F:<slotKey>[/n]` -> pid struktural deterministik. */
function slotPidOfAddress(address: string): string {
  const m = /^F:([^/]+)(?:\/(\d+))?$/.exec(address);
  return m ? slotPid(m[1], m[2] !== undefined ? Number(m[2]) : undefined) : slotPid(address.replace(/[^a-zA-Z0-9]/g, ""));
}

function requirePid(id: string | undefined, where: string): string {
  if (typeof id !== "string" || id === "") {
    composeFail("BY_CONSTRUCTION_FAILED", `${where} belum punya pid; gabungkan kiriman lewat mergeSubmission sebelum compose`, { where });
  }
  return id;
}

/**
 * Susun snapshot `studio.norm/v2` dan baris struktur dari konten v2 tergabung.
 * Prasyarat: `validateStructure` lulus dan setiap bab/section/blok ber-`id`.
 */
export function composeV2(input: ComposeInput): ComposeResult {
  const src = input.source;
  const tier = input.tier ?? src.meta.tier;
  const layout = slotLayout(input.skeleton, tier, src.structure);
  const paramsOf = (slotKey: string): ParamMap => input.slotParams?.[slotKey] ?? input.params;
  const glyphs = glyphSet(input.params["render.run.symbolGlyphs"]);
  const inlineCtx: InlineCtx = { glyphs };
  const classification = src.meta.classification;

  const e: Emit = {
    units: [],
    blocks: [],
    numbering: {},
    warnings: [],
    ordinal: 0,
    pids: new Map(),
  };

  // ── Baris M14-M17 (pemilik bentuk: repositori SR-10 `rowsFromSource`) ──
  // Pid baris slot `F:` dan intro bab berasal dari baris (diwarisi `prevRows`);
  // tanpa pembangkit pemanggil: `slot-<slotKey>[-n]` untuk alamat F:, sisanya berbenih.
  const slotSpecs: SlotRowSpec[] = layout.ordered.map((s, i) => ({
    slotKey: s.slotKey,
    sectionTypeKey: s.sectionType,
    templateSlotId: input.skeleton.templateSlotIds?.[s.slotKey] ?? null,
    position: i + 1,
  }));
  const taken = new Set<string>(collectSourcePids(src));
  const seeded = seededPidAllocator(`${src.template.slug}:${src.docKey ?? src.meta.docNumber ?? src.meta.title}`, taken);
  const allocator = input.pids ?? {
    next: (kind: Parameters<typeof seeded.next>[0], hint: string) => (hint.startsWith("F:") ? slotPidOfAddress(hint) : seeded.next(kind, hint)),
  };
  let rows: StructureRows = rowsFromSource({ source: src, slots: slotSpecs, allocator, ...(input.prevRows ? { prev: input.prevRows } : {}) });
  const rowPidOf = new Map(rows.blocks.filter((b) => b.chapterKey === null).map((b) => [b.address, b.pid]));

  // ── Aset: kunci kiriman -> AssetRef internal (mesin membaca doc.assets[key]) ──
  const assets: Record<string, AssetRef> = {};
  const shaOfKey = new Map<string, string>();
  const registerAsset = (key: string, ref: string): void => {
    const sha = ref.slice("sha256:".length).toLowerCase();
    const info = input.assets?.[sha];
    const a: AssetRef = { kind: "raster", mime: info?.mime ?? "image/png", sha256: sha };
    if (info?.relPath) a.path = info.relPath.replace(/^assets\//, "");
    if (info?.widthPx) a.widthPx = info.widthPx;
    if (info?.heightPx) a.heightPx = info.heightPx;
    if (!info) e.warnings.push({ code: "ASSET_INFO_MISSING", message: `Metadata aset ${key} (${sha.slice(0, 12)}) tidak diberikan; MIME dianggap image/png` });
    assets[key] = a;
    shaOfKey.set(key, sha);
  };
  for (const [key, v] of Object.entries(src.assets ?? {})) registerAsset(key, v.assetRef);
  const assetKey = (asset: string): string => {
    if (ASSET_REF_RE.test(asset)) {
      const key = `ref-${asset.slice(7, 23)}`;
      if (!assets[key]) registerAsset(key, asset);
      return key;
    }
    if (!assets[asset]) {
      composeFail("ASSET_NOT_FOUND", `Gambar merujuk aset "${asset}" yang tidak ada di assets; unggah atau sertakan asetnya`, { asset });
    }
    return asset;
  };

  const docV1: StudioDocV1 = {
    $schema: "studio.doc/v1",
    template: { ...src.template },
    meta: { ...src.meta },
    register: { ...(src.register ?? {}) },
    front: {},
    parts: [],
    chapters: [],
    appendices: [],
    assets,
  };
  if (src.mission) docV1.mission = { ...src.mission };
  if (src.x) docV1.x = { ...src.x };

  const claimPid = (pid: string, owner: string): void => {
    const prior = e.pids.get(pid);
    if (prior !== undefined) {
      composeFail("PID_CONFLICT", `pid "${pid}" dipakai dua kali (${prior} dan ${owner}); setiap bab, section, dan blok ber-id unik`, { pid, ownerScope: prior });
    }
    e.pids.set(pid, owner);
  };

  const addUnit = (kind: NormUnitKind, key: string, slot: TemplateSlotDef, extra?: { placeholder?: boolean }) => {
    const u: NormUnitV2 = { kind, key, setup: unitSetup(paramsOf(slot.slotKey)["slot.setup"]), slotKey: slot.slotKey, sectionType: slot.sectionType };
    if (extra?.placeholder) u.placeholder = true;
    e.units.push(u);
  };

  /** `textPlain` eksplisit hanya untuk blok berproyeksi teks tetap (contractRecord/contractItem, §5.7 register 05). */
  const pushBlock = (b: Omit<NormBlockV2, "ordinal" | "textPlain" | "contentSha256"> & { textPlain?: string }): NormBlockV2 => {
    e.ordinal += 1;
    const nb: NormBlockV2 = { ...b, ordinal: e.ordinal, textPlain: b.textPlain ?? plainText(b.content), contentSha256: sha256Hex(stableStringify(b.content)) };
    if (nb.artifactLabel === undefined) delete nb.artifactLabel;
    if (nb.assetSha256 === undefined) delete nb.assetSha256;
    e.blocks.push(nb);
    return nb;
  };

  /** Pid blok struktural slot: pid baris M17 bila slot terisi, selain itu `slot-<slotKey>[-n]`. */
  const structPid = (slotKey: string, address: string, n?: number): string => {
    const pid = rowPidOf.get(address) ?? slotPid(slotKey, n);
    claimPid(pid, `slot:${slotKey}`);
    return pid;
  };

  // ── Tanda tangan: penempatan dari kenop slot (R-42, bawaan inControlSheet) ──
  const sigSlot = layout.ordered.find((s) => s.sectionType === "signatureBlock");
  const sigPayload = sigSlot ? (src.sections?.[sigSlot.slotKey] as SignaturePayloadV2 | undefined) : undefined;
  const sigPlacement = sigSlot ? paramsOf(sigSlot.slotKey)["slot.placement"] ?? "inControlSheet" : undefined;
  const willHaveUnit = (s: TemplateSlotDef): boolean => {
    const p = src.sections?.[s.slotKey];
    return p !== undefined || s.contentMode !== "INPUT";
  };
  let sigHost: string | undefined;
  if (sigSlot && sigPayload && sigPlacement === "inControlSheet") {
    const cs = layout.ordered.find((s) => s.sectionType === "controlSheet" && willHaveUnit(s));
    const cv = layout.ordered.find((s) => s.sectionType === "cover" && willHaveUnit(s));
    sigHost = (cs ?? cv)?.slotKey;
  }
  let sigEmitted = false;
  const emitSignature = (unitKey: string) => {
    if (!sigSlot || !sigPayload || sigEmitted) return;
    sigEmitted = true;
    const content = signatureBlock(sigPayload, inlineCtx);
    docV1.front = { ...docV1.front, signature: content };
    const address = `F:${sigSlot.slotKey}`;
    const pid = structPid(sigSlot.slotKey, address);
    pushBlock({ blockId: pid, pid, slotKey: sigSlot.slotKey, address, unitKey, type: "signatureBlock", content });
  };

  // ── Bab dan lampiran ──────────────────────────────────────────────────
  // IMPL-W4: penghitung label Tabel/Gambar/Turunan per label sumber (bab berlabel sama, mis. FM.1..FM.3 = "FM", berbagi).
  const sourceCounters = new Map<string, { t: number; g: number; d: number }>();
  /**
   * `sourceLabel` (IMPL-W4, outline `label`): penomoran sumber. Judul bab dan section dicetak apa adanya (kicker kosong
   * eksplisit, nomor section kosong eksplisit), label artefak = `Tabel <label>.n`. Absen = perilaku lama (byte-identik).
   */
  const emitChapter = (slot: TemplateSlotDef, c: ChapterV2, kind: "chapter" | "appendix", sourceLabel?: string): Chapter => {
    const slotKey = slot.slotKey;
    const key = c.key;
    const cpid = requirePid(c.id, `Bab ${key}`);
    claimPid(cpid, `chapter:${key}`);
    const bctx: BlockCtx = { glyphs, params: paramsOf(slotKey), classification, assetKey };
    addUnit(kind, key, slot);
    const head: Chapter = { key, blockId: cpid, title: mapInline(c.title, inlineCtx), sections: [] };
    if (c.partId !== undefined) head.partId = c.partId;
    if (c.shortTitle !== undefined) head.runningHeadTitle = c.shortTitle;
    if (sourceLabel !== undefined) head.kicker = { text: "" };
    const headContent: Partial<Chapter> = { ...head };
    delete headContent.sections;
    pushBlock({ blockId: cpid, pid: cpid, slotKey, address: key, unitKey: key, type: kind, content: headContent });

    const lk = sourceLabel ?? key;
    let counters = { t: 0, g: 0, d: 0 };
    if (sourceLabel !== undefined) {
      counters = sourceCounters.get(sourceLabel) ?? counters;
      sourceCounters.set(sourceLabel, counters);
    }
    const flow = (items: readonly BlockV2[] | undefined, sectionNo: number): FlowItem[] => {
      const out: FlowItem[] = [];
      (items ?? []).forEach((b, k) => {
        const p = k + 1;
        const pid = requirePid(b.id, `Blok ${key}.${sectionNo}.${p}`);
        claimPid(pid, `chapter:${key}`);
        let label: string | undefined;
        const hasCaption = (b as { caption?: unknown }).caption !== undefined;
        if (TABLE_TYPES.has(b.type) && hasCaption) label = `Tabel ${lk}.${++counters.t}`;
        else if (FIGURE_TYPES.has(b.type) && hasCaption) label = `Gambar ${lk}.${++counters.g}`;
        else if (b.type === "derivation") label = `Turunan D-${lk}.${++counters.d}`;
        if (label !== undefined) e.numbering[pid] = label;
        const internal: Block = mapBlock(b, pid, { ...bctx, artifactLabel: label });
        out.push(internal);
        const assetSha = b.type === "image" ? shaOfKey.get(assetKey(b.asset)) : undefined;
        const address = `${key}.${sectionNo}.${p}`;
        pushBlock({ blockId: pid, pid, slotKey, address, artifactLabel: label, unitKey: key, type: b.type, content: internal, assetSha256: assetSha });
      });
      return out;
    };

    const full: Chapter = { ...head };
    if (c.intro && c.intro.length > 0) full.intro = flow(c.intro, 0);
    full.sections = c.sections.map((s, j) => {
      const sectionNo = j + 1;
      const spid = requirePid(s.id, `Section ${key}.${sectionNo}`);
      claimPid(spid, `chapter:${key}`);
      const sHead: { blockId: string; title: ReturnType<typeof mapInline>; number?: string } = { blockId: spid, title: mapInline(s.title, inlineCtx) };
      if (sourceLabel !== undefined) sHead.number = "";
      pushBlock({ blockId: spid, pid: spid, slotKey, address: `${key}.${sectionNo}`, unitKey: key, type: "section", content: sHead });
      return { ...sHead, blocks: flow(s.blocks, sectionNo) };
    });
    return full;
  };

  const emitContentSlot = (slot: TemplateSlotDef, payload: ContentSlotPayloadV2 | AppendixSlotPayloadV2 | undefined) => {
    const chapters = [...(payload?.chapters ?? [])].sort((a, b) => compareChapterKeys(a.key, b.key));
    if (slot.sectionType === "appendix") {
      // Review 15 F10: label penomoran sumber hanya berlaku di slot bab; di lampiran diabaikan dengan peringatan.
      const ignored = ((payload as AppendixSlotPayloadV2 | undefined)?.outline ?? []).filter((o) => typeof o.label === "string" && o.label !== "").map((o) => o.key);
      if (ignored.length > 0) e.warnings.push({ code: "OUTLINE_LABEL_IGNORED", message: `label penomoran sumber di outline lampiran ${slot.slotKey} diabaikan (hanya slot bab): ${ignored.join(", ")}` });
      chapters.forEach((c) => docV1.appendices?.push(emitChapter(slot, c, "appendix")));
      return;
    }
    const parts: PartV2[] = (payload as ContentSlotPayloadV2 | undefined)?.parts ?? [];
    const partIdx = new Map(parts.map((p, i) => [p.id, i]));
    const partOf = (c: ChapterV2): number | null => (c.partId !== undefined && partIdx.has(c.partId) ? (partIdx.get(c.partId) as number) : null);
    const firstParted = chapters.findIndex((c) => partOf(c) !== null);
    const leading = chapters.filter((c, i) => partOf(c) === null && (firstParted === -1 || i < firstParted));
    const trailing = chapters.filter((c, i) => partOf(c) === null && firstParted !== -1 && i > firstParted);
    const sourceLabels = new Map<string, string>();
    for (const o of (payload as ContentSlotPayloadV2 | undefined)?.outline ?? []) if (typeof o.label === "string" && o.label !== "") sourceLabels.set(o.key, o.label);
    // Review 15 F10: label yatim (kunci outline tanpa bab) tidak boleh diam-diam diwarisi bab baru tanpa jejak.
    const orphans = [...sourceLabels.keys()].filter((k) => !chapters.some((c) => c.key === k));
    if (orphans.length > 0) e.warnings.push({ code: "OUTLINE_LABEL_ORPHAN", message: `label penomoran sumber di outline ${slot.slotKey} tanpa bab: ${orphans.join(", ")}` });
    const push = (c: ChapterV2) => docV1.chapters.push(emitChapter(slot, c, "chapter", sourceLabels.get(c.key)));
    leading.forEach(push);
    parts.forEach((p, pi) => {
      if (partIdx.get(p.id) !== pi) return;
      const key = `P:${pi + 1}`;
      const members = chapters.filter((c) => partOf(c) === pi);
      // Label "Bagian I" dibangkitkan mesin (wrapper/pages.ts) dari id bila kosong.
      const spec: PartSpec = { id: p.id, label: { text: "" }, title: mapInline(p.title, inlineCtx), chapterKeys: members.map((c) => c.key) };
      if (p.lede) spec.lede = mapInline(p.lede, inlineCtx);
      docV1.parts?.push(spec);
      addUnit("part", key, slot);
      pushBlock({ blockId: partPid(p.id), pid: partPid(p.id), slotKey: slot.slotKey, address: key, unitKey: key, type: "partDivider", content: spec });
      members.forEach(push);
    });
    trailing.forEach(push);
  };

  // ── Slot urut posisi dokumen ──────────────────────────────────────────
  const omittedKeys = new Set(layout.omitted.map((s) => s.slotKey));
  const states = new Map<string, StudioSlotState>();
  layout.ordered.forEach((slot) => {
    const k = slot.slotKey;
    const payload = src.sections?.[k];
    const state = slotState(slot, payload, false, input.contractKind);
    states.set(k, state);
    const fKey = `F:${k}`;
    const placeholder = () => {
      if (!input.draft || state !== "EMPTY" || !slot.required) return;
      addUnit("slot", fKey, slot, { placeholder: true });
      const tpl = paramsOf(k)["slot.placeholderText"];
      const text = (typeof tpl === "string" ? tpl : "[{label} belum diisi]").replace(/\{label\}/g, slot.label);
      const pid = structPid(k, fKey);
      pushBlock({ blockId: pid, pid, slotKey: k, address: null, unitKey: fKey, type: "slotPlaceholder", content: { text } });
    };

    switch (slot.sectionType) {
      case "cover": {
        if (payload === undefined && slot.contentMode === "INPUT") return placeholder();
        const fp = coverFront(payload as CoverPayloadV2 | undefined, src.meta, inlineCtx, paramsOf(k));
        if (k === "cover" || !docV1.front?.cover) docV1.front = { ...docV1.front, cover: fp };
        addUnit("cover", fKey, slot);
        const pid = structPid(k, fKey);
        pushBlock({ blockId: pid, pid, slotKey: k, address: fKey, unitKey: fKey, type: "cover", content: fp });
        if (sigHost === k) emitSignature(fKey);
        return;
      }
      case "controlSheet": {
        if (payload === undefined && slot.contentMode === "INPUT") return placeholder();
        const fp = controlSheetFront(payload as ControlSheetPayloadV2 | undefined, slot, { glyphs, params: paramsOf(k), classification }, src.meta.language);
        docV1.front = { ...docV1.front, controlSheet: fp };
        addUnit("controlSheet", fKey, slot);
        const pid = structPid(k, fKey);
        pushBlock({ blockId: pid, pid, slotKey: k, address: fKey, unitKey: fKey, type: "controlSheet", content: fp });
        if (sigHost === k) emitSignature(fKey);
        return;
      }
      case "signatureBlock": {
        if (!sigPayload) return placeholder();
        if (sigHost !== undefined) return; // dirender di unit induk
        addUnit("slot", fKey, slot);
        emitSignature(fKey);
        return;
      }
      case "toc": {
        const ts = tocSpec(payload as TocPayloadV2 | undefined, inlineCtx, paramsOf(k));
        docV1.front = { ...docV1.front, toc: ts };
        addUnit("toc", fKey, slot);
        const pid = structPid(k, fKey);
        pushBlock({ blockId: pid, pid, slotKey: k, address: fKey, unitKey: fKey, type: "toc", content: ts });
        return;
      }
      case "sourceRegister": {
        const p = payload as SourceRegisterPayloadV2 | undefined;
        if (!p || p.entries.length === 0) return placeholder();
        addUnit("slot", fKey, slot);
        p.entries.forEach((entry, i) => {
          const n = i + 1;
          const content: Record<string, unknown> = { id: entry.id, citation: mapInline(entry.citation, inlineCtx) };
          if (entry.kind !== undefined) content.kind = entry.kind;
          if (entry.url !== undefined) content.url = entry.url;
          if (entry.accessed !== undefined) content.accessed = entry.accessed;
          const address = `${fKey}/${n}`;
          const pid = structPid(k, address, n);
          pushBlock({ blockId: pid, pid, slotKey: k, address, unitKey: fKey, type: "sourceRegisterEntry", content });
        });
        return;
      }
      case "ruleIndex": {
        addUnit("slot", fKey, slot);
        const pid = structPid(k, fKey);
        pushBlock({ blockId: pid, pid, slotKey: k, address: fKey, unitKey: fKey, type: "ruleIndex", content: { mode: "auto" } });
        return;
      }
      case "contractRecord": {
        // DC-10 (register 05 §5.7, BA-10): unit interior F:<slotKey> + butir F:<slotKey>/<n>.
        const p = payload as ContractRecordPayloadV2 | undefined;
        if (p === undefined || p === null) return placeholder();
        const def = resolveContractKind(src.template.slug, input.contractKind);
        addUnit("slot", fKey, slot);
        const recordPid = structPid(k, fKey);
        const itemPids = (p.items ?? []).map((_, i) => structPid(k, `${fKey}/${i + 1}`, i + 1));
        const proj = projectContractRecord(p, def, { record: recordPid, items: itemPids }, inlineCtx);
        pushBlock({ blockId: recordPid, pid: recordPid, slotKey: k, address: fKey, unitKey: fKey, type: "contractRecord", content: proj.record.content, textPlain: proj.record.textPlain });
        proj.items.forEach((it, i) => {
          const pid = itemPids[i];
          pushBlock({ blockId: pid, pid, slotKey: k, address: `${fKey}/${i + 1}`, unitKey: fKey, type: "contractItem", content: it.content, textPlain: it.textPlain });
        });
        return;
      }
      case "chapter":
      case "appendix": {
        const rp = payload as ContentSlotPayloadV2 | AppendixSlotPayloadV2 | undefined;
        if (!rp?.chapters || rp.chapters.length === 0) return placeholder();
        emitContentSlot(slot, rp);
        return;
      }
      default:
        composeFail("BY_CONSTRUCTION_FAILED", `Jenis slot "${slot.sectionType}" tidak dikenal`, { slotKey: k });
    }
  });
  // Induk tanda tangan tidak menghasilkan unit (mis. slot terkunci kosong): berdiri sendiri.
  if (sigSlot && sigPayload && !sigEmitted) {
    addUnit("slot", `F:${sigSlot.slotKey}`, sigSlot);
    emitSignature(`F:${sigSlot.slotKey}`);
  }

  const contentBlocks = e.blocks.filter((b) => b.address !== null).length;
  if (contentBlocks > STUDIO_MAX_BLOCKS_PER_DOC) {
    e.warnings.push({ code: "MAX_BLOCKS", message: `Dokumen memuat ${contentBlocks} blok beralamat; maks ${STUDIO_MAX_BLOCKS_PER_DOC}` });
  }

  // ── Kerangka snapshot ────────────────────────────────────────────────
  const positionOf = new Map(layout.ordered.map((s, i) => [s.slotKey, i + 1]));
  const allSlots = [...input.skeleton.skeleton.slots].sort((a, b) => a.position - b.position);
  const slots: NormSlotV2[] = allSlots.map((s) => {
    const activeSlot = !layout.inactive.some((x) => x.slotKey === s.slotKey);
    const omitted = omittedKeys.has(s.slotKey);
    return {
      slotKey: s.slotKey,
      sectionType: s.sectionType,
      label: s.label,
      position: positionOf.get(s.slotKey) ?? 0,
      required: s.required,
      repeatable: isRepeatable(s),
      contentMode: s.contentMode,
      active: activeSlot,
      omitted,
      state: states.get(s.slotKey) ?? "OMITTED",
    };
  });
  const skeleton: NormSkeletonV2 = {
    templateVersionId: input.skeleton.templateVersionId,
    skeletonSha256: input.skeleton.skeletonSha256,
    implicit: input.skeleton.implicit,
    slots,
  };

  // Review 15 F1: label artefak wajib unik (FigureStore DOCX dan alamat label memakai label sebagai kunci). Hanya bisa
  // bertabrakan bila penomoran sumber dipakai (bab berlabel L + bab/lampiran tanpa label berkunci L).
  if (sourceCounters.size > 0) {
    const seen = new Map<string, string>();
    for (const [pid, label] of Object.entries(e.numbering)) {
      const prior = seen.get(label);
      if (prior !== undefined) composeFail("BY_CONSTRUCTION_FAILED", `Label artefak "${label}" ganda (blok ${prior} dan ${pid}): label penomoran sumber outline bertabrakan dengan kunci bab/lampiran tanpa label; beri label pada semua bab atau pilih label lain`, { label, pids: [prior, pid] });
      seen.set(label, pid);
    }
  }
  const register: Record<string, RegisterEntry> = { ...(src.register ?? {}) };
  const snapshot: ComposedSnapshotV2 = {
    schema: "studio.norm/v2",
    doc: docV1,
    source: src,
    skeleton,
    units: e.units,
    blocks: e.blocks,
    numbering: e.numbering,
    register,
    // (+) konteks compose ulang (SC-5); lihat ./context.
    compose: composeContextOf(input, tier),
  };
  // Isi internal M06 dan label artefak dari snapshot (sumber tunggal penomoran).
  rows = attachInternal(rows, e.blocks);
  rows = { ...rows, blocks: rows.blocks.map((b) => (b.chapterKey === null ? b : { ...b, artifactLabel: e.numbering[b.pid] ?? null })) };
  const structureSha256 = computeStructureSha256(skeleton, rows);
  return { snapshot, rows, structureSha256, snapshotSha256: sha256Hex(stableStringify(snapshot)), warnings: e.warnings };
}
