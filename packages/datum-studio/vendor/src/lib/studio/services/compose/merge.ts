/**
 * Penggabungan kiriman v2 ke konten tergabung dokumen (SR-08, I45
 * `mergeSubmission`; blueprint §2.5-§2.6; register §4.5, §7, §9.3, §10).
 *
 * - Dokumen (`studio.doc/v2`): upsert per slot dan per kunci bab; slot/bab yang
 *   tidak disebut tetap (§7.1 butir 5). Kiriman bab: upsert satu kunci. Kiriman
 *   slot: ganti payload satu slot tak-berulang.
 * - Identitas pid (§10): (1) pid klien diklaim lebih dulu (pid aktif bab lain /
 *   pensiun = 422 `PID_CONFLICT`); (2) section ke-i mewarisi pid section ke-i bab
 *   lama (intro = 0); (3) blok ke-j dalam section yang dicocokkan mewarisi pid
 *   blok ke-j lama tanpa memandang tipe; (4) sisanya pid bangkitan; (5) sisa
 *   lama pensiun (dicatat repositori SR-10 dari selisih identitas).
 * - Idempotensi (§9.3, KD-13): lingkup dengan sha tanpa id sama = tidak berubah;
 *   isi lama (beserta pid-nya) dipertahankan.
 * - Galat target ringan yang dapat diputus tanpa DB: `TEMPLATE_MISMATCH`,
 *   `META_CONFLICT`, `ASSET_NOT_FOUND`, `PID_CONFLICT`, plus semua aturan struktur
 *   (`validateStructure`). Kunci advisory, base-check, dan pensiun = SR-13/SR-10.
 * - Meta (IP-66, SR-55 M3): medan yang dikirim mengisi medan dokumen yang KOSONG
 *   (lingkup `meta`, `metaFilled`); `META_CONFLICT` hanya bila kedua sisi terisi dan
 *   berbeda. Medan yang dicerminkan kolom `StudioDocument` (`META_MIRRORED_FIELDS`)
 *   diperbarui pemanggil di transaksi yang sama.
 */
import {
  ASSET_REF_PATTERN,
  type AppendixSlotPayloadV2,
  type AssetInputV2,
  type BlockV2,
  type ChapterV2,
  type ContentSlotPayloadV2,
  type DocMeta,
  type DocMetaV2,
  type ParamMap,
  type PidAllocator,
  type SectionV2,
  type StudioChapterV2,
  type StudioDocV2,
  type StudioDocV2Resolved,
  type StudioIdentityKind,
  type StudioSlotV2,
  type TemplateSlotDef,
} from "../../contract";
import { PARAMS_BY_KEY } from "../../params";
import { composeFail } from "./errors";
import { scopeSha256, stableStringify } from "./hash";
import { defaultChapterPid } from "./pids";
import { compareChapterKeys } from "./snapshot";
import { defaultChapterSlot, isRepeatable, slotLayout, validateStructure } from "./structure";
import type { EmptyDocInput, MergeOptions, MergeResult, StructureInput } from "./types";

const ASSET_REF_RE = new RegExp(ASSET_REF_PATTERN);

type AnySubmission = StudioDocV2 | StudioChapterV2 | StudioSlotV2;
type RepeatablePayload = ContentSlotPayloadV2 | AppendixSlotPayloadV2;

/** Medan meta yang dicerminkan kolom `StudioDocument` (pengisian wajib ikut memperbarui kolomnya). */
export const META_MIRRORED_FIELDS = ["title", "typeCode", "language", "classification", "tier", "docNumber"] as const;

/** Hasil `mergeSubmission` + medan meta yang diisi (dokumen kosong -> nilai kiriman). */
export interface MergeOutcome extends MergeResult {
  metaFilled: string[];
}

function param(params: ParamMap, key: string): unknown {
  return params[key] !== undefined ? params[key] : PARAMS_BY_KEY.get(key)?.default;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}

/**
 * Meta lengkap dokumen baru (§7.2). Medan yang tidak dikirim jatuh ke parameter
 * templat terpatok; `docNumber` dari sekuens HQ (pemanggil), `author` dari
 * `agentId`/requester, `issueDate` = tanggal revisi 1 (Asia/Jakarta, pemanggil).
 */
export function defaultMeta(
  sent: DocMetaV2 & { title: string },
  params: ParamMap,
  ctx: { author: string; issueDate: string; docNumber?: string },
): DocMeta {
  const meta: DocMeta = {
    title: sent.title,
    rev: str(sent.rev, str(param(params, "doc.revision"), "A")),
    typeCode: str(sent.typeCode, str(param(params, "doc.defaultTypeCode"), "KT")),
    tier: (sent.tier ?? str(param(params, "doc.defaultTier"), "TERBIT")) as DocMeta["tier"],
    classification: str(sent.classification, str(param(params, "classification.level"), "")),
    language: (sent.language ?? str(param(params, "doc.language"), "ID")) as DocMeta["language"],
    author: str(sent.author, ctx.author),
    issueDate: str(sent.issueDate, ctx.issueDate),
  };
  const docNumber = sent.docNumber ?? ctx.docNumber;
  if (docNumber !== undefined) meta.docNumber = docNumber;
  for (const k of ["custodian", "audience", "basis", "subject", "urgency", "issueNumber", "copyControl"] as const) {
    if (sent[k] !== undefined) (meta as unknown as Record<string, unknown>)[k] = sent[k];
  }
  return meta;
}

/** Dokumen kosong berkerangka revisi 1 (§7.1 butir 2; tanpa bab/blok, tanpa salinan parameter). */
export function emptyResolvedDoc(i: EmptyDocInput): StudioDocV2Resolved {
  const doc: StudioDocV2Resolved = { $schema: "studio.doc/v2", template: { ...i.template }, meta: { ...i.meta }, sections: {} };
  if (i.mission) doc.mission = { ...i.mission };
  if (i.docKey !== undefined) doc.docKey = i.docKey;
  if (i.structure) doc.structure = { order: [...i.structure.order] };
  return doc;
}

// ── Identitas pid ────────────────────────────────────────────────────────

function chapterPids(c: ChapterV2 | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.id) out.push(c.id);
  for (const b of c.intro ?? []) if (b.id) out.push(b.id);
  for (const s of c.sections) {
    if (s.id) out.push(s.id);
    for (const b of s.blocks) if (b.id) out.push(b.id);
  }
  return out;
}

/** Semua pid aktif dokumen, per pemilik lingkup (`chapter:<k>`). */
function pidOwners(doc: StudioDocV2Resolved): Map<string, string> {
  const owners = new Map<string, string>();
  for (const payload of Object.values(doc.sections ?? {})) {
    for (const c of (payload as RepeatablePayload).chapters ?? []) for (const p of chapterPids(c)) owners.set(p, `chapter:${c.key}`);
  }
  return owners;
}

interface PidCtx {
  pids: PidAllocator;
  /** pid terpakai dokumen (aktif semua bab + pensiun + yang baru dibagi di kiriman ini). */
  used: Set<string>;
  owners: Map<string, string>;
  retired: ReadonlySet<string>;
}

function fresh(ctx: PidCtx, kind: StudioIdentityKind, hint: string): string {
  for (let guard = 0; guard < 1000; guard++) {
    const pid = ctx.pids.next(kind, hint);
    if (!ctx.used.has(pid)) {
      ctx.used.add(pid);
      return pid;
    }
  }
  return composeFail("BY_CONSTRUCTION_FAILED", "Pembangkit pid tidak menghasilkan pid bebas", { hint });
}

/**
 * Beri pid ke bab kiriman berdasarkan bab lama berkunci sama (§10). Mengembalikan
 * salinan ber-id lengkap; tidak memutasi masukan.
 */
function assignChapterPids(c: ChapterV2, old: ChapterV2 | undefined, slot: TemplateSlotDef, ctx: PidCtx): ChapterV2 {
  const scope = `chapter:${c.key}`;
  const oldSet = new Set(chapterPids(old));
  const claimed = new Set<string>();
  const claimExplicit = (id: string) => {
    if (claimed.has(id)) composeFail("PID_CONFLICT", `pid "${id}" dipakai dua kali di bab ${c.key}; setiap section dan blok ber-id unik`, { pid: id, ownerScope: scope });
    if (!oldSet.has(id)) {
      const owner = ctx.owners.get(id);
      if (owner !== undefined && owner !== scope) composeFail("PID_CONFLICT", `pid "${id}" sudah milik ${owner}; pakai pid lain atau hapus id`, { pid: id, ownerScope: owner });
      if (ctx.retired.has(id)) composeFail("PID_CONFLICT", `pid "${id}" sudah dipensiunkan dan tidak dapat dipakai ulang`, { pid: id, ownerScope: "retired" });
      if (ctx.used.has(id) && owner === undefined) composeFail("PID_CONFLICT", `pid "${id}" sudah dipakai dokumen ini`, { pid: id, ownerScope: "document" });
    }
    claimed.add(id);
    ctx.used.add(id);
  };

  // (1) pid klien eksplisit.
  if (c.id) claimExplicit(c.id);
  for (const b of c.intro ?? []) if (b.id) claimExplicit(b.id);
  for (const s of c.sections) {
    if (s.id) claimExplicit(s.id);
    for (const b of s.blocks) if (b.id) claimExplicit(b.id);
  }

  const out: ChapterV2 = structuredClone(c);
  if (!out.id) {
    if (old?.id && !claimed.has(old.id)) out.id = old.id;
    else out.id = defaultChapterPid(slot.sectionType, c.key, ctx.used);
    claimed.add(out.id);
    ctx.used.add(out.id);
  }

  const inherit = (blocks: BlockV2[], oldBlocks: readonly BlockV2[] | undefined, hint: string) => {
    blocks.forEach((b, j) => {
      if (b.id) return;
      const candidate = oldBlocks?.[j]?.id;
      if (candidate && !claimed.has(candidate)) {
        b.id = candidate;
        claimed.add(candidate);
        ctx.used.add(candidate);
      } else {
        b.id = fresh(ctx, "BLOCK", `${hint}.${j + 1}`);
        claimed.add(b.id);
      }
    });
  };

  // (2) section ke-i; (3) blok ke-j dalam section yang dicocokkan; (4) bangkitan.
  if (out.intro) inherit(out.intro, old?.intro, `${c.key}.0`);
  out.sections.forEach((s: SectionV2, i) => {
    let match: SectionV2 | undefined;
    if (s.id) {
      match = old?.sections.find((os) => os.id === s.id);
    } else {
      const candidate = old?.sections[i];
      if (candidate?.id && !claimed.has(candidate.id)) {
        s.id = candidate.id;
        claimed.add(candidate.id);
        ctx.used.add(candidate.id);
        match = candidate;
      } else {
        s.id = fresh(ctx, "SUBSECTION", `${c.key}.${i + 1}`);
        claimed.add(s.id);
      }
    }
    inherit(s.blocks, match?.blocks, `${c.key}.${i + 1}`);
  });
  return out;
}

/**
 * D-252 (O-1 SR-44): kepemilikan pid klien eksplisit divalidasi SEBELUM cek idempoten
 * sha (§10 butir 1). Aturan sama dengan `claimExplicit` di `assignChapterPids`, tanpa
 * mutasi konteks: pid milik bab lain / pensiun / sudah dipakai = 422 `PID_CONFLICT`,
 * juga bila isi bab identik (sha tanpa id sama).
 */
function assertExplicitPidsOwned(c: ChapterV2, old: ChapterV2 | undefined, ctx: PidCtx): void {
  const scope = `chapter:${c.key}`;
  const oldSet = new Set(chapterPids(old));
  const seen = new Set<string>();
  for (const id of chapterPids(c)) {
    if (seen.has(id)) composeFail("PID_CONFLICT", `pid "${id}" dipakai dua kali di bab ${c.key}; setiap section dan blok ber-id unik`, { pid: id, ownerScope: scope });
    seen.add(id);
    if (oldSet.has(id)) continue;
    const owner = ctx.owners.get(id);
    if (owner !== undefined && owner !== scope) composeFail("PID_CONFLICT", `pid "${id}" sudah milik ${owner}; pakai pid lain atau hapus id`, { pid: id, ownerScope: owner });
    if (ctx.retired.has(id)) composeFail("PID_CONFLICT", `pid "${id}" sudah dipensiunkan dan tidak dapat dipakai ulang`, { pid: id, ownerScope: "retired" });
    if (ctx.used.has(id) && owner === undefined) composeFail("PID_CONFLICT", `pid "${id}" sudah dipakai dokumen ini`, { pid: id, ownerScope: "document" });
  }
}

// ── Pemeriksaan ringan target ────────────────────────────────────────────

function checkTemplate(current: StudioDocV2Resolved, sent: { slug: string; version?: number } | undefined): void {
  if (!sent) return;
  if (sent.slug !== current.template.slug || (sent.version !== undefined && sent.version !== current.template.version)) {
    composeFail(
      "TEMPLATE_MISMATCH",
      `Dokumen memakai templat ${current.template.slug} versi ${current.template.version}; kirim tanpa template atau dengan templat yang sama`,
      { pinned: { slug: current.template.slug, versionNo: current.template.version }, sent },
    );
  }
}

function isEmptyMetaValue(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * IP-66 (SR-55 M3): konflik hanya bila medan dokumen TERISI dan berbeda dari kiriman;
 * medan dokumen kosong (absen/null/"") diisi nilai kiriman. Mengembalikan medan yang diisi.
 */
function checkMeta(current: StudioDocV2Resolved, sent: DocMetaV2 | undefined): string[] {
  if (!sent) return [];
  const fields: Record<string, { current: unknown; sent: unknown }> = {};
  const filled: string[] = [];
  for (const [k, v] of Object.entries(sent)) {
    if (v === undefined) continue;
    const cur = (current.meta as unknown as Record<string, unknown>)[k];
    if (isEmptyMetaValue(cur)) {
      if (!isEmptyMetaValue(v)) filled.push(k);
      continue;
    }
    if (stableStringify(cur) !== stableStringify(v)) fields[k] = { current: cur, sent: v };
  }
  if (Object.keys(fields).length > 0) {
    composeFail("META_CONFLICT", `Meta kiriman berbeda dari dokumen (${Object.keys(fields).join(", ")}); ubah meta lewat PATCH structure {op: setMeta}`, { fields });
  }
  return filled;
}

function resolveAssets(sub: AnySubmission, opts: MergeOptions): Record<string, { assetRef: string }> {
  const out: Record<string, { assetRef: string }> = {};
  for (const [key, a] of Object.entries(sub.assets ?? {})) {
    const input = a as AssetInputV2;
    let ref: string | undefined;
    if ("assetRef" in input) ref = input.assetRef;
    else if (opts.resolveAsset) ref = opts.resolveAsset(key, input);
    if (!ref || !ASSET_REF_RE.test(ref)) {
      composeFail("ASSET_NOT_FOUND", `Aset "${key}" belum tersimpan; unggah lewat POST /api/studio/assets lalu kirim assetRef`, { asset: key, pointer: `/assets/${key}` });
    }
    if (opts.knownAssetSha && !opts.knownAssetSha.has(ref.slice(7))) {
      composeFail("ASSET_NOT_FOUND", `assetRef aset "${key}" tidak dikenal; unggah dulu lewat POST /api/studio/assets`, { asset: key, pointer: `/assets/${key}` });
    }
    out[key] = { assetRef: ref };
  }
  return out;
}

/** Setiap blok gambar di bab yang berubah merujuk aset yang ada. */
function checkImageAssets(chapters: Array<{ chapter: ChapterV2; pointer: string }>, assets: Record<string, { assetRef: string }>, opts: MergeOptions): void {
  for (const { chapter, pointer } of chapters) {
    const visit = (blocks: readonly BlockV2[] | undefined, ptr: string) => {
      (blocks ?? []).forEach((b, j) => {
        if (b.type !== "image") return;
        const p = `${ptr}/${j}/asset`;
        if (ASSET_REF_RE.test(b.asset)) {
          if (opts.knownAssetSha && !opts.knownAssetSha.has(b.asset.slice(7))) {
            composeFail("ASSET_NOT_FOUND", `Gambar merujuk aset ${b.asset.slice(0, 19)}… yang belum diunggah`, { asset: b.asset, pointer: p });
          }
        } else if (!assets[b.asset]) {
          composeFail("ASSET_NOT_FOUND", `Gambar merujuk aset "${b.asset}" yang tidak ada di assets; sertakan asetnya`, { asset: b.asset, pointer: p });
        }
      });
    };
    visit(chapter.intro, `${pointer}/intro`);
    chapter.sections.forEach((s, i) => visit(s.blocks, `${pointer}/sections/${i}/blocks`));
  }
}

function isDoc(sub: AnySubmission): sub is StudioDocV2 {
  return sub.$schema === "studio.doc/v2";
}
function isChapter(sub: AnySubmission): sub is StudioChapterV2 {
  return sub.$schema === "studio.chapter/v2";
}

/**
 * Gabungkan kiriman v2 ke konten tergabung `current` (revisi terbaru). Murni:
 * `current` tidak dimutasi. Melempar galat struktur/target terstruktur (§2.7).
 */
export function mergeSubmission(current: StudioDocV2Resolved, sub: AnySubmission, opts: MergeOptions): MergeOutcome {
  checkTemplate(current, (sub as { template?: { slug: string; version?: number } }).template);
  const sentMeta = (sub as { meta?: DocMetaV2 }).meta;
  const metaFilled = checkMeta(current, sentMeta);

  const structure = isDoc(sub) && sub.structure ? sub.structure : current.structure;
  const layout = slotLayout(opts.skeleton, opts.tier, structure);
  const existing: Record<string, string[]> = {};
  for (const [k, p] of Object.entries(current.sections ?? {})) {
    const ch = (p as RepeatablePayload).chapters;
    if (Array.isArray(ch)) existing[k] = ch.map((c) => c.key);
  }

  // Jumlah bab sesudah penggabungan per slot berulang (cek maxItems).
  const counts: Record<string, number> = {};
  const countAfter = (slotKey: string, keys: readonly string[]) => {
    counts[slotKey] = new Set([...(existing[slotKey] ?? []), ...keys]).size;
  };
  const chapterSlotKey = isChapter(sub) ? (sub.slot ?? defaultChapterSlot(layout)?.slotKey) : undefined;
  if (isDoc(sub)) {
    for (const [k, p] of Object.entries(sub.sections ?? {})) {
      const ch = (p as RepeatablePayload).chapters;
      if (Array.isArray(ch)) countAfter(k, ch.map((c) => c.key));
    }
  } else if (isChapter(sub) && chapterSlotKey !== undefined) {
    countAfter(chapterSlotKey, [sub.chapter.key]);
  }

  const sInput: StructureInput = { chapterCounts: counts, existingChapterKeys: existing };
  if (isDoc(sub)) {
    if (sub.structure) sInput.structure = sub.structure;
    else if (current.structure) sInput.structure = current.structure;
    if (sub.sections) sInput.sections = sub.sections as Record<string, unknown>;
  } else {
    if (current.structure) sInput.structure = current.structure;
    if (isChapter(sub)) {
      sInput.chapter = { chapter: sub.chapter, ...(sub.slot !== undefined ? { slot: sub.slot } : {}) };
      sInput.pointer = "";
    } else {
      sInput.slot = { slot: sub.slot, payload: sub.payload };
    }
  }
  // Urutan tersimpan menentukan slot OMIT (isi ke slot OMIT = SLOT_UNKNOWN); aturan
  // urutan (SLOT_DUPLICATE, ..._LOCKED) dicek ulang hanya bila kiriman membawa structure.
  validateStructure(opts.skeleton, opts.tier, sInput, { checkOrder: isDoc(sub) && !!sub.structure });

  const doc: StudioDocV2Resolved = structuredClone(current);
  doc.sections = doc.sections ?? {};
  const scopes: string[] = [];
  let changed = false;
  const pidCtx: PidCtx = {
    pids: opts.pids,
    used: new Set([...pidOwners(current).keys(), ...(opts.retiredPids ?? [])]),
    owners: pidOwners(current),
    retired: opts.retiredPids ?? new Set(),
  };

  // Meta isi-bila-kosong (lingkup `meta`).
  if (metaFilled.length > 0 && sentMeta) {
    const next = { ...(doc.meta as unknown as Record<string, unknown>) };
    for (const k of metaFilled) next[k] = structuredClone((sentMeta as unknown as Record<string, unknown>)[k]);
    doc.meta = next as unknown as DocMeta;
    scopes.push("meta");
    changed = true;
  }

  // Struktur.
  if (isDoc(sub) && sub.structure && stableStringify(sub.structure) !== stableStringify(current.structure ?? null)) {
    doc.structure = { order: [...sub.structure.order] };
    scopes.push("structure:reorder");
    changed = true;
  }

  // Aset dan register.
  const sentAssets = resolveAssets(sub, opts);
  let assetsChanged = false;
  for (const [k, v] of Object.entries(sentAssets)) {
    if (doc.assets?.[k]?.assetRef !== v.assetRef) {
      doc.assets = { ...(doc.assets ?? {}), [k]: v };
      assetsChanged = true;
    }
  }
  for (const [k, v] of Object.entries(sub.register ?? {})) {
    if (stableStringify(doc.register?.[k] ?? null) !== stableStringify(v)) {
      doc.register = { ...(doc.register ?? {}), [k]: v };
      scopes.push(`register:${k}`);
      changed = true;
    }
  }
  if (isDoc(sub) && sub.x !== undefined && stableStringify(sub.x) !== stableStringify(current.x ?? null)) {
    doc.x = structuredClone(sub.x);
    scopes.push("document");
    changed = true;
  }

  const touchedChapters: Array<{ chapter: ChapterV2; pointer: string }> = [];
  const upsertChapter = (slot: TemplateSlotDef, c: ChapterV2, pointer: string) => {
    const payload = (doc.sections?.[slot.slotKey] as RepeatablePayload | undefined) ?? ({ type: slot.sectionType } as RepeatablePayload);
    const chapters = [...(payload.chapters ?? [])];
    const idx = chapters.findIndex((x) => x.key === c.key);
    const old = idx >= 0 ? chapters[idx] : undefined;
    assertExplicitPidsOwned(c, old, pidCtx);
    if (old && scopeSha256(old) === scopeSha256(c)) return; // tidak berubah: pid lama tetap
    const next = assignChapterPids(c, old, slot, pidCtx);
    for (const p of chapterPids(next)) pidCtx.owners.set(p, `chapter:${c.key}`);
    if (idx >= 0) chapters[idx] = next;
    else chapters.push(next);
    chapters.sort((a, b) => compareChapterKeys(a.key, b.key));
    doc.sections = { ...doc.sections, [slot.slotKey]: { ...payload, chapters } as RepeatablePayload };
    touchedChapters.push({ chapter: c, pointer });
    scopes.push(`chapter:${c.key}`);
    changed = true;
  };
  const replaceSlot = (slotKey: string, payload: unknown) => {
    if (scopeSha256(doc.sections?.[slotKey] ?? null) === scopeSha256(payload)) return;
    doc.sections = { ...doc.sections, [slotKey]: structuredClone(payload) as NonNullable<StudioDocV2Resolved["sections"]>[string] };
    scopes.push(`slot:${slotKey}`);
    changed = true;
  };

  if (isDoc(sub)) {
    for (const [slotKey, payload] of Object.entries(sub.sections ?? {})) {
      const slot = layout.byKey.get(slotKey) as TemplateSlotDef;
      if (!isRepeatable(slot)) {
        replaceSlot(slotKey, payload);
        continue;
      }
      const rp = payload as RepeatablePayload;
      const cur = (doc.sections?.[slotKey] as RepeatablePayload | undefined) ?? ({ type: slot.sectionType } as RepeatablePayload);
      const metaNext = { ...cur } as RepeatablePayload & { parts?: unknown };
      let metaChanged = false;
      if (rp.outline !== undefined && stableStringify(rp.outline) !== stableStringify(cur.outline ?? null)) {
        metaNext.outline = structuredClone(rp.outline);
        metaChanged = true;
      }
      const parts = (rp as ContentSlotPayloadV2).parts;
      if (parts !== undefined && stableStringify(parts) !== stableStringify((cur as ContentSlotPayloadV2).parts ?? null)) {
        (metaNext as ContentSlotPayloadV2).parts = structuredClone(parts);
        metaChanged = true;
      }
      if (metaChanged || doc.sections?.[slotKey] === undefined) {
        doc.sections = { ...doc.sections, [slotKey]: metaNext };
        if (metaChanged) {
          scopes.push(`slot:${slotKey}`);
          changed = true;
        }
      }
      (rp.chapters ?? []).forEach((c, i) => upsertChapter(slot, c, `/sections/${slotKey}/chapters/${i}`));
    }
  } else if (isChapter(sub)) {
    upsertChapter(layout.byKey.get(chapterSlotKey as string) as TemplateSlotDef, sub.chapter, "/chapter");
  } else {
    replaceSlot(sub.slot, sub.payload);
  }

  checkImageAssets(touchedChapters, doc.assets ?? {}, opts);
  if (assetsChanged && !changed) {
    scopes.push("document");
    changed = true;
  } else if (assetsChanged) {
    changed = true;
  }
  return { doc, scopes, changed, metaFilled };
}
